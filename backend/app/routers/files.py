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
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import File, ExtractionSession
from ..schemas import FileUploadResponse, SessionStatusResponse


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
        status="pending",
    )
    db.add(session)
    db.commit()

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
        page_count = _detect_page_count(file, backend_root)
        if page_count > 0:
            preview_url = f"/api/files/preview/{file.id}"
            preview_pages = [
                f"/api/files/preview/{file.id}?page={idx + 1}"
                for idx in range(page_count)
            ]

    return SessionStatusResponse(
        session_id=session.id,
        file_id=file.id,
        status=session.status,
        preview_url=preview_url,
        preview_pages=preview_pages,
    )
