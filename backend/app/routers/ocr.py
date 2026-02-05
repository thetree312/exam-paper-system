from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import logging

from ..db import get_db
from ..schemas import OcrRequest, OcrResponse, OcrItem
from ..services.ocr_service import OcrService


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ocr", tags=["ocr"])


@router.post("/extract", response_model=OcrResponse)
async def extract_ocr(
    payload: OcrRequest,
    db: Session = Depends(get_db),
):
    service = OcrService()
    if not payload.regions:
        raise HTTPException(status_code=400, detail="regions 不能为空")

    logger.info(
        "[ocr.extract] session_id=%s regions=%s",
        payload.session_id,
        [r.dict() for r in payload.regions],
    )

    texts = service.ocr_for_session(db, payload.session_id, payload.regions)
    items = [OcrItem(region_index=i, text=t) for i, t in enumerate(texts)]
    return OcrResponse(session_id=payload.session_id, items=items)
