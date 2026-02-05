from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas import (
    TranslationLookupRequest,
    TranslationLookupResponse,
    TranslationQuotaInfo,
    TranslationScope,
    TranslationWordPayload,
)
from ..services.agent_service import AgentService
from ..services.translation_quota import QuotaExceeded, TranslationQuotaManager
from ..services.translation_service import (
    TranslationResult,
    TranslationService,
    TranslationServiceError,
)


router = APIRouter(prefix="/api/translation", tags=["translation"])
logger = logging.getLogger("translation")
_translation_service = TranslationService()
_quota_manager = TranslationQuotaManager()


def _build_quota_info(status) -> TranslationQuotaInfo:
    return TranslationQuotaInfo(
        limit=status.limit,
        remaining=status.remaining,
        reset_at=status.reset_at,
    )


def _build_response_payload(
    result: TranslationResult,
    scope: TranslationScope,
    quota: TranslationQuotaInfo | None,
) -> TranslationLookupResponse:
    word_payload = None
    if scope == TranslationScope.word:
        word_payload = TranslationWordPayload(
            phonetic=result.phonetic,
            translation=result.word_translation,
            example=result.example,
            lemma=result.lemma,
            morphology=result.morphology,
            forms=result.forms or [],
            senses=result.senses or [],
        )
    return TranslationLookupResponse(
        translation=result.translation,
        word=word_payload,
        quota=quota,
    )


@router.post("/lookup", response_model=TranslationLookupResponse)
def lookup_translation(
    payload: TranslationLookupRequest,
    db: Session = Depends(get_db),
):
    agent_service = AgentService(db)
    is_subscriber = agent_service.has_active_subscription(payload.tenant_id)

    quota_info: TranslationQuotaInfo | None = None
    if is_subscriber:
        quota_info = TranslationQuotaInfo(limit=None, remaining=None, reset_at=None)
    else:
        try:
            quota_status = _quota_manager.consume(payload.user_id)
            quota_info = _build_quota_info(quota_status)
        except QuotaExceeded as exc:
            quota_payload = _build_quota_info(exc.status)
            raise HTTPException(
                status_code=429,
                detail={
                    "message": "免费版每小时仅支持 20 次翻译，请稍后再试或升级订阅",
                    "quota": quota_payload.dict(),
                },
            ) from exc

    try:
        result = _translation_service.translate(payload.text, payload.scope)
    except TranslationServiceError as exc:
        logger.exception("translation failed tenant=%s user=%s", payload.tenant_id, payload.user_id)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _build_response_payload(result, payload.scope, quota_info)
