from datetime import datetime
import hashlib
import os
from pathlib import Path
import logging

from fastapi import (
    APIRouter,
    Depends,
    File as UploadFileType,
    HTTPException,
    UploadFile,
    Form,
    Query,
)
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import File, ExtractionSession
from ..schemas import (
    FileUploadResponse,
    KbManifestBlockOut,
    KbManifestChunkOut,
    KbManifestJobOut,
    KbManifestLayoutPageOut,
    KbManifestResponse,
    KbManifestSourceOut,
    KbManifestUnitOut,
    SessionStatusResponse,
    WorkroomFileTabOut,
)
from ..services.workroom import WorkroomService


logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api/files", tags=["files"])


ALLOWED_TYPES = {
    "image": ("image/",),
    "pdf": ("application/pdf",),
    "word": (
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
}


def _render_pdf_previews(pdf_path: Path) -> list[Path]:
    """Render all pages of a PDF to PNG and return the PNG paths."""
    try:
        import fitz  # type: ignore
    except ImportError as e:  # pragma: no cover - runtime environment issue
        raise RuntimeError("PyMuPDF 未安装，请在后端环境运行 'pip install pymupdf'") from e

    doc = fitz.open(pdf_path)
    try:
        if doc.page_count == 0:
            raise RuntimeError("PDF 文件没有页面")

        zoom = 2.0
        mat = fitz.Matrix(zoom, zoom)
        png_paths: list[Path] = []

        for page_index in range(doc.page_count):
            page = doc.load_page(page_index)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            png_path = pdf_path.with_suffix(f".page{page_index + 1}.png")
            pix.save(str(png_path))
            png_paths.append(png_path)

        return png_paths
    finally:
        doc.close()


def _render_word_previews(word_path: Path) -> list[Path]:
    """Convert Word to PDF then render all pages to PNG and return the PNG paths."""
    try:
        from docx2pdf import convert as docx2pdf_convert  # type: ignore
    except ImportError as e:  # pragma: no cover - runtime environment issue
        raise RuntimeError(
            "docx2pdf 未安装，请在后端环境运行 'pip install docx2pdf'（需要安装 Microsoft Word）"
        ) from e

    pdf_path = word_path.with_suffix(".pdf")
    # 这里会调用本机的 Microsoft Word（Windows）进行转换
    docx2pdf_convert(str(word_path), str(pdf_path))
    return _render_pdf_previews(pdf_path)


@router.post("/upload-image", response_model=FileUploadResponse)
async def upload_image(
    tenant_id: int = Form(...),
    user_id: int = Form(...),
    workroom_id: int | None = Form(default=None),
    file: UploadFile = UploadFileType(...),
    db: Session = Depends(get_db),
):
    logger.info(
        "[upload_image] tenant=%s user=%s filename=%s content_type=%s",
        tenant_id,
        user_id,
        file.filename,
        file.content_type,
    )

    content_type = (file.content_type or "").lower()
    if not content_type:
        logger.warning("[upload_image] missing content_type for filename=%s", file.filename)
        raise HTTPException(status_code=400, detail="无法识别文件类型")

    if content_type.startswith(ALLOWED_TYPES["image"][0]):
        source_type = "image"
    elif content_type in ALLOWED_TYPES["pdf"]:
        source_type = "pdf"
    elif content_type in ALLOWED_TYPES["word"]:
        if not settings.enable_word_uploads:
            logger.warning(
                "[upload_image] word uploads disabled tenant=%s user=%s filename=%s",
                tenant_id,
                user_id,
                file.filename,
            )
            raise HTTPException(status_code=400, detail="Word 文件上传已暂时禁用")
        source_type = "word"
    else:
        raise HTTPException(status_code=400, detail="只支持图片、PDF 或 Word 上传")

    backend_root = Path(__file__).resolve().parents[2]
    upload_dir = backend_root / "uploads" / str(tenant_id)
    upload_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    safe_name = file.filename or "image"
    storage_name = f"{timestamp}_{safe_name}"
    storage_path = upload_dir / storage_name

    content = await file.read()
    content_hash = hashlib.sha256(content).hexdigest()
    with storage_path.open("wb") as f:
        f.write(content)

    rel_path = os.path.relpath(storage_path, backend_root)

    db_file = File(
        tenant_id=tenant_id,
        uploader_id=user_id,
        original_name=file.filename or storage_name,
        storage_path=str(rel_path).replace("\\", "/"),
        preview_path=None,
        mime_type=content_type,
        file_size=len(content),
        source_type=source_type,
        status=1,
        content_hash=content_hash,
    )
    db.add(db_file)
    db.flush()

    session = ExtractionSession(
        tenant_id=tenant_id,
        user_id=user_id,
        file_id=db_file.id,
        workroom_id=workroom_id,
        status="pending",
    )
    db.add(session)
    db.commit()

    if workroom_id is not None:
        try:
            svc = WorkroomService(db)
            svc.bind_source_file(
                tenant_id=int(tenant_id),
                user_id=int(user_id),
                workroom_id=int(workroom_id),
                file_id=int(db_file.id),
            )
            svc.update_runtime_state(
                tenant_id=int(tenant_id),
                user_id=int(user_id),
                workroom_id=int(workroom_id),
                values={
                    "active_file_id": int(db_file.id),
                    "active_session_id": int(session.id),
                    "active_extraction_session_id": int(session.id),
                },
            )
        except Exception:
            logger.exception("[upload_image] failed to bind file into workroom")

    # 异步生成预览图，避免在上传请求中阻塞
    try:
        from ..tasks import generate_previews_for_session

        generate_previews_for_session.delay(session.id)
    except Exception:
        logger.exception("[upload_image] failed to enqueue preview generation task")

    logger.info(
        "[upload_image] success tenant=%s user=%s file_id=%s session_id=%s",
        tenant_id,
        user_id,
        db_file.id,
        session.id,
    )

    return FileUploadResponse(
        file_id=db_file.id,
        session_id=session.id,
        preview_url=None,
        preview_pages=[],
    )


def _detect_page_count(file: File, backend_root: Path) -> int:
    """Detect how many preview pages exist on disk for the given file.

    For images we return 1. For PDFs/Word, previews follow the pattern
    "name.page{n}.ext" as generated by _render_pdf_previews / _render_word_previews.
    """

    if file.source_type == "image":
        return 1

    if not file.preview_path:
        return 0

    preview_rel = Path(str(file.preview_path).replace("\\", "/"))
    preview_abs = (backend_root / preview_rel).resolve()
    if not preview_abs.exists():
        return 0

    if ".page" not in preview_rel.name:
        return 1

    try:
        prefix, suffix = preview_rel.name.rsplit(".page", 1)
        _page_id, ext = suffix.split(".", 1)
    except ValueError:
        return 1

    page_count = 0
    while True:
        candidate = preview_abs.with_name(f"{prefix}.page{page_count + 1}.{ext}")
        if not candidate.exists():
            break
        page_count += 1
    return page_count


def _derive_ingestion_status(
    *,
    db: Session,
    session: ExtractionSession,
    file: File,
) -> str:
    session_status = str(session.status or "pending").strip().lower() or "pending"
    if session_status in {"pending", "processing", "failed"}:
        return session_status
    if session_status != "done":
        return session_status

    detected_page_count = _detect_page_count(file, Path(__file__).resolve().parents[2])
    page_count = int(detected_page_count or 0)
    if page_count <= 0:
        return "processing"

    source_row = db.execute(
        text(
            """
            SELECT status
            FROM kb_sources
            WHERE tenant_id = :tenant_id
              AND user_id = :user_id
              AND file_id = :file_id
              AND ((workroom_id IS NULL AND :workroom_id IS NULL) OR workroom_id = :workroom_id)
            ORDER BY id DESC
            LIMIT 1
            """
        ),
        {
            "tenant_id": int(session.tenant_id),
            "user_id": int(session.user_id),
            "file_id": int(file.id),
            "workroom_id": int(session.workroom_id) if session.workroom_id is not None else None,
        },
    ).mappings().first()
    if not source_row:
        return "preview_ready"

    source_status = str(source_row.get("status") or "").strip().lower()
    if source_status == "ready":
        return "kb_ready"
    if source_status == "failed":
        return "degraded_ready"
    if source_status in {"processing", "layout_scheduling", "layout_queued", "layout_running", "embedding"}:
        return "layout_running"
    return "preview_ready"

    rel = Path(file.preview_path)
    name = rel.name
    if ".page" not in name:
        return 1

    base, suffix = name.rsplit(".page", 1)
    if "." not in suffix:
        return 1

    _page_str, ext = suffix.split(".", 1)
    pattern = f"{base}.page*.{ext}"
    folder = backend_root / rel.parent
    try:
        matches = list(folder.glob(pattern))
        return len(matches)
    except FileNotFoundError:
        return 0


@router.get("/preview/{file_id}")
async def get_file_preview(
    file_id: int,
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
):
    file = db.query(File).filter(File.id == file_id).first()
    if not file:
        raise HTTPException(status_code=404, detail="文件不存在")

    backend_root = Path(__file__).resolve().parents[2]
    rel_path = file.preview_path or file.storage_path

    target_rel_path = rel_path
    if page > 1:
        # For multi-page previews, generated files follow ".page{n}.png" naming
        stem = Path(rel_path)
        name = stem.name
        if ".page" in name:
            base, suffix = name.rsplit(".page", 1)
            if "." in suffix:
                page_id, ext = suffix.split(".", 1)
                target_rel_path = str(
                    (stem.parent / f"{base}.page{page}.{ext}").as_posix()
                )
            else:
                target_rel_path = rel_path
        else:
            if page != 1:
                raise HTTPException(status_code=404, detail="指定页不存在")

    abs_path = backend_root / target_rel_path
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="预览文件不存在")

    media_type = "image/png"
    if not file.preview_path or file.preview_path == file.storage_path:
        media_type = file.mime_type

    return FileResponse(path=str(abs_path), media_type=media_type)


@router.get("/{file_id}/kb-manifest", response_model=KbManifestResponse)
def get_file_kb_manifest(file_id: int, db: Session = Depends(get_db)) -> KbManifestResponse:
    file = db.query(File).filter(File.id == file_id).first()
    if not file:
        raise HTTPException(status_code=404, detail="file not found")

    source_row = db.execute(
        text(
            """
            SELECT id, status, title
            FROM kb_sources
            WHERE file_id = :file_id
            ORDER BY id DESC
            LIMIT 1
            """
        ),
        {"file_id": int(file_id)},
    ).mappings().first()
    if not source_row:
        return KbManifestResponse(file_id=int(file_id))

    source_id = int(source_row["id"])

    job_rows = db.execute(
        text(
            """
            SELECT stage, status
            FROM kb_ingest_jobs
            WHERE source_id = :source_id
            ORDER BY id ASC
            """
        ),
        {"source_id": source_id},
    ).mappings().all()

    layout_rows = db.execute(
        text(
            """
            SELECT page_no, status, blocks_json
            FROM file_page_layout_cache
            WHERE file_id = :file_id
            ORDER BY page_no ASC
            """
        ),
        {"file_id": int(file_id)},
    ).mappings().all()

    unit_rows = db.execute(
        text(
            """
            SELECT id, unit_key, unit_type, page_no_start, title, text_content, primary_image_path, metadata_json
            FROM kb_units
            WHERE source_id = :source_id
            ORDER BY id ASC
            """
        ),
        {"source_id": source_id},
    ).mappings().all()

    chunk_rows = db.execute(
        text(
            """
            SELECT id, chunk_type, page_no, content, metadata_json
            FROM kb_chunks
            WHERE source_id = :source_id
            ORDER BY id ASC
            """
        ),
        {"source_id": source_id},
    ).mappings().all()

    layout_pages: list[KbManifestLayoutPageOut] = []
    for row in layout_rows:
        raw_blocks = row.get("blocks_json") if isinstance(row.get("blocks_json"), list) else []
        blocks = [
            KbManifestBlockOut(
                page_no=int(block.get("page_no") or row.get("page_no") or 0),
                layout_unit_key=str(block.get("layout_unit_key") or "").strip() or None,
                block_label=str(block.get("block_label") or "").strip() or None,
                bbox_norm=block.get("bbox_norm") if isinstance(block.get("bbox_norm"), dict) else None,
            )
            for block in raw_blocks
            if isinstance(block, dict)
        ]
        layout_pages.append(
            KbManifestLayoutPageOut(
                page_no=int(row.get("page_no") or 0),
                status=str(row.get("status") or ""),
                blocks=blocks,
            )
        )

    units = [
        KbManifestUnitOut(
            id=int(row["id"]),
            unit_key=str(row.get("unit_key") or ""),
            unit_type=str(row.get("unit_type") or ""),
            page_no_start=int(row["page_no_start"]) if row.get("page_no_start") is not None else None,
            title=str(row.get("title") or "").strip() or None,
            excerpt=str(row.get("text_content") or "").strip()[:180] or None,
            primary_image_path=str(row.get("primary_image_path") or "").strip() or None,
            bbox_norm=(row.get("metadata_json") or {}).get("bbox_norm")
            if isinstance(row.get("metadata_json"), dict)
            else None,
        )
        for row in unit_rows
    ]

    chunks = [
        KbManifestChunkOut(
            id=int(row["id"]),
            chunk_type=str(row.get("chunk_type") or ""),
            page_no=int(row["page_no"]) if row.get("page_no") is not None else None,
            excerpt=str(row.get("content") or "").strip()[:180] or None,
            bbox_norm=(row.get("metadata_json") or {}).get("bbox_norm")
            if isinstance(row.get("metadata_json"), dict)
            else None,
        )
        for row in chunk_rows
    ]

    return KbManifestResponse(
        file_id=int(file_id),
        source=KbManifestSourceOut(
            id=source_id,
            status=str(source_row.get("status") or ""),
            title=str(source_row.get("title") or "").strip() or None,
        ),
        jobs=[
            KbManifestJobOut(stage=str(row.get("stage") or ""), status=str(row.get("status") or ""))
            for row in job_rows
        ],
        layout_pages=layout_pages,
        units=units,
        chunks=chunks,
    )


@router.get("/session/{session_id}", response_model=SessionStatusResponse)
def get_session_status(session_id: int, db: Session = Depends(get_db)) -> SessionStatusResponse:
    """Return current status and preview pages for a given ExtractionSession.

    This is used by the frontend to poll until previews are ready.
    """

    session = db.query(ExtractionSession).filter(ExtractionSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")

    file = session.file
    backend_root = Path(__file__).resolve().parents[2]

    preview_url: str | None = None
    preview_pages: list[str] = []

    if session.status == "done":
        detected_page_count = _detect_page_count(file, backend_root)
        page_count = int(detected_page_count or 0)
        if page_count > 0:
            preview_url = f"/api/files/preview/{file.id}"
            preview_pages = [
                f"/api/files/preview/{file.id}?page={idx + 1}"
                for idx in range(page_count)
            ]
    ingestion_status = _derive_ingestion_status(db=db, session=session, file=file)

    return SessionStatusResponse(
        session_id=session.id,
        file_id=file.id,
        status=session.status,
        ingestion_status=ingestion_status,
        preview_url=preview_url,
        preview_pages=preview_pages,
    )


@router.get("/workroom/{workroom_id}/tabs", response_model=list[WorkroomFileTabOut])
def list_workroom_tabs(
    workroom_id: int,
    tenant_id: int = Query(...),
    user_id: int = Query(...),
    db: Session = Depends(get_db),
) -> list[WorkroomFileTabOut]:
    """Return latest extraction session per file bound to current workroom.

    Used by frontend to rehydrate preview tabs after leaving and re-entering a workroom.
    """
    rows = db.execute(
        text(
            """
            WITH latest_sessions AS (
                SELECT
                    es.id AS session_id,
                    es.file_id,
                    es.status,
                    ROW_NUMBER() OVER (PARTITION BY es.file_id ORDER BY es.id DESC) AS rn
                FROM extraction_sessions es
                WHERE es.tenant_id = :tenant_id
                  AND es.user_id = :user_id
                  AND es.workroom_id = :workroom_id
            )
            SELECT
                ls.session_id,
                ls.file_id,
                ls.status,
                f.original_name,
                f.source_type
            FROM latest_sessions ls
            JOIN files f ON f.id = ls.file_id
            JOIN workroom_source_bindings wb
              ON wb.file_id = ls.file_id
             AND wb.workroom_id = :workroom_id
             AND wb.tenant_id = :tenant_id
             AND wb.user_id = :user_id
             AND wb.is_active = TRUE
            WHERE ls.rn = 1
            ORDER BY ls.session_id ASC
            """
        ),
        {"tenant_id": tenant_id, "user_id": user_id, "workroom_id": workroom_id},
    ).mappings().all()

    backend_root = Path(__file__).resolve().parents[2]
    out: list[WorkroomFileTabOut] = []
    for row in rows:
        session_id = int(row["session_id"])
        file_id = int(row["file_id"])
        status = str(row["status"] or "pending")
        source_type = str(row.get("source_type") or "").strip() or None

        preview_url: str | None = None
        preview_pages: list[str] = []
        file = db.query(File).filter(File.id == file_id).first()
        if status == "done":
            if file is not None:
                page_count = _detect_page_count(file, backend_root)
                if page_count > 0:
                    preview_url = f"/api/files/preview/{file_id}"
                    preview_pages = [
                        f"/api/files/preview/{file_id}?page={idx + 1}"
                        for idx in range(page_count)
                    ]
        if file is None:
            file = db.query(File).filter(File.id == file_id).first()
        ingestion_status = status
        if file is not None:
            session_like = ExtractionSession(
                id=session_id,
                tenant_id=tenant_id,
                user_id=user_id,
                file_id=file_id,
                workroom_id=workroom_id,
                status=status,
            )
            ingestion_status = _derive_ingestion_status(db=db, session=session_like, file=file)

        out.append(
            WorkroomFileTabOut(
                file_id=file_id,
                session_id=session_id,
                name=str(row.get("original_name") or f"source-{file_id}"),
                source_type=source_type,
                status=status,
                ingestion_status=ingestion_status,
                preview_url=preview_url,
                preview_pages=preview_pages,
            )
        )
    return out
