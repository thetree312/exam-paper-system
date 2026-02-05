from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import logging

from ..db import get_db
from ..schemas import LegendRequest, LegendResponse
from ..services.legend_service import LegendService


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/legend", tags=["legend"])


@router.post("/extract", response_model=LegendResponse)
async def extract_legend(
    payload: LegendRequest,
    db: Session = Depends(get_db),
):
    if not payload.legends:
        raise HTTPException(status_code=400, detail="legends 不能为空")

    service = LegendService()
    logger.info(
        "[legend.extract] session_id=%s legends=%s",
        payload.session_id,
        [r.dict() for r in payload.legends],
    )

    images = service.extract_legends(db, payload.session_id, payload.legends)
    return LegendResponse(images=images)
