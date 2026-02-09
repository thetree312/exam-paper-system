import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Document, ExtractionSession
from .service import GlmOcrService


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/glm-ocr", tags=["glm-ocr"])


class GlmImportResponse(BaseModel):
    document_id: int
    question_ids: list[int]


@router.post("/sessions/{session_id}/import", response_model=GlmImportResponse)
async def import_exam_from_session(
    session_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    force_refresh: bool = Query(False, description="是否强制刷新 GLM-OCR 缓存"),
    db: Session = Depends(get_db),
) -> GlmImportResponse:
    """使用 GLM-OCR 对指定 ExtractionSession 进行版面解析并导入题目。

    - 通过 session_id 找到对应的文件
    - 调用 GLM-OCR layout_parsing 接口
    - 为该会话创建或复用 Document
    - 调用 GlmOcrService.import_exam_as_questions 将整份试卷导入为题目
    """

    session = (
        db.query(ExtractionSession)
        .filter(
            ExtractionSession.id == session_id,
            ExtractionSession.tenant_id == tenant_id,
        )
        .first()
    )
    if session is None:
        raise HTTPException(status_code=404, detail="ExtractionSession 不存在或不属于该租户")

    file = session.file
    if file is None:
        raise HTTPException(status_code=400, detail="该会话未绑定源文件，无法执行 GLM-OCR")

    # 复用或创建 Document：优先按 session 绑定，其次按 file 复用
    document = (
        db.query(Document)
        .filter(
            Document.tenant_id == tenant_id,
            Document.session_id == session.id,
        )
        .first()
    )

    if document is None:
        document = (
            db.query(Document)
            .filter(
                Document.tenant_id == tenant_id,
                Document.file_id == file.id,
            )
            .order_by(Document.id.desc())
            .first()
        )

    if document is None:
        document = Document(
            tenant_id=tenant_id,
            owner_user_id=user_id,
            file_id=file.id,
            session_id=session.id,
            title=file.original_name or "未命名试卷",
            status="draft",
        )
        db.add(document)
        db.flush()

    service = GlmOcrService()
    logger.info(
        "[glm_ocr.import] tenant=%s user=%s session=%s file_id=%s force=%s",
        tenant_id,
        user_id,
        session.id,
        file.id,
        force_refresh,
    )

    glm_result, _ = await service.call_layout_parsing(
        db,
        file=file,
        tenant_id=tenant_id,
        document=document,
        force_refresh=force_refresh,
    )
    service.dump_glm_result(glm_result=glm_result, tenant_id=tenant_id, document=document)

    questions = service.import_exam_as_questions(
        db=db,
        tenant_id=tenant_id,
        document_id=document.id,
        glm_result=glm_result,
    )

    logger.info(
        "[glm_ocr.import] done tenant=%s user=%s session=%s document_id=%s questions=%s",
        tenant_id,
        user_id,
        session.id,
        document.id,
        [q.id for q in questions],
    )

    return GlmImportResponse(
        document_id=document.id,
        question_ids=[q.id for q in questions],
    )


@router.get("/crops/{document_id}/{filename}")
async def get_glm_crop_image(document_id: int, filename: str):
    """返回 GLM-OCR 生成的局部裁剪图片。

    路径与 GlmOcrService._crop_block_to_file 中的保存规则保持一致：
    backend_root/glm_crops/doc_{document_id}/{filename}
    """

    backend_root = Path(__file__).resolve().parents[2]
    crops_dir = backend_root / "glm_crops" / f"doc_{document_id}"
    target_path = (crops_dir / filename).resolve()

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="裁剪图片不存在")

    return FileResponse(path=str(target_path), media_type="image/png")
