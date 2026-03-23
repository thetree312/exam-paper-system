from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ...config import get_settings
from ..bailian_file_service import BailianFileService
from ..qwen_client import QwenClient, QwenRequestError
from .generation import (
    align_draft_to_outline,
    build_document_from_draft,
    build_expand_messages,
    build_expand_response_format,
    build_file_outline_generation_messages,
    build_outline_generation_messages,
    build_outline_merge_messages,
    evaluate_draft_hard_quality,
    parse_generated_draft,
    parse_generated_outline,
    render_block_source,
    render_question_source,
)
from .repository import MindMapRepository
from .schemas import DocOutline, MindMapDocument, MindMapDraft, MindMapMode, QualityReport, dump_document_json

logger = logging.getLogger("mindmap.service")


class MindMapService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = MindMapRepository(db)
        self.bailian_files = BailianFileService(db)

    def get_current(
        self,
        *,
        tenant_id: int,
        workroom_id: int,
        source_type: str,
        source_id: int,
        source_ids: list[int] | None = None,
        kind: str = "knowledge",
        mode: str = "knowledge_structure",
    ) -> MindMapDocument:
        normalized_source_id, _normalized_source_ids, source_signature = self._normalize_sources(
            source_type=source_type,
            source_id=source_id,
            source_ids=source_ids,
        )
        record = self.repo.get_active_map(
            tenant_id=tenant_id,
            workroom_id=workroom_id,
            source_type=source_type,
            source_id=normalized_source_id,
            source_signature=source_signature,
            kind=self._resolve_kind(kind, mode),
        )
        if record is None:
            raise HTTPException(status_code=404, detail="Mindmap not found")
        return self._hydrate(record.graph_json, fallback_id=record.id, fallback_version=record.version)

    def generate(
        self,
        *,
        tenant_id: int,
        user_id: int | None,
        workroom_id: int,
        source_type: str,
        source_id: int,
        source_ids: list[int] | None = None,
        kind: str = "knowledge",
        mode: str = "knowledge_structure",
        force: bool = False,
    ) -> MindMapDocument:
        normalized_source_id, normalized_source_ids, source_signature = self._normalize_sources(
            source_type=source_type,
            source_id=source_id,
            source_ids=source_ids,
        )
        effective_kind = self._resolve_kind(kind, mode)
        logger.info(
            "mindmap.generate.start tenant_id=%s workroom_id=%s source_type=%s source_id=%s source_count=%s kind=%s mode=%s force=%s",
            tenant_id,
            workroom_id,
            source_type,
            source_id,
            len(normalized_source_ids) or 1,
            kind,
            mode,
            force,
        )
        if not force:
            existing = self.repo.get_active_map(
                tenant_id=tenant_id,
                workroom_id=workroom_id,
                source_type=source_type,
                source_id=normalized_source_id,
                source_signature=source_signature,
                kind=effective_kind,
            )
            if existing is not None:
                hydrated = self._hydrate(existing.graph_json, fallback_id=existing.id, fallback_version=existing.version)
                if not self._should_regenerate_existing(hydrated):
                    logger.info(
                        "mindmap.generate.cache_hit tenant_id=%s workroom_id=%s source_type=%s source_id=%s mindmap_id=%s version=%s generated_by=%s",
                        tenant_id,
                        workroom_id,
                        source_type,
                        source_id,
                        hydrated.id,
                        hydrated.version,
                        hydrated.meta.generatedBy,
                    )
                    return hydrated
                logger.info(
                    "mindmap.generate.cache_stale tenant_id=%s workroom_id=%s source_type=%s source_id=%s mindmap_id=%s version=%s",
                    tenant_id,
                    workroom_id,
                    source_type,
                    source_id,
                    hydrated.id,
                    hydrated.version,
                )

        generated = self._build_from_source(
            tenant_id=tenant_id,
            source_type=source_type,
            source_id=normalized_source_id,
            source_ids=normalized_source_ids,
            source_signature=source_signature,
            mode=mode,
        )
        record = self.repo.create_map_version(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            source_type=source_type,
            source_id=normalized_source_id,
            source_signature=source_signature,
            kind=effective_kind,
            title=generated.title,
            graph_json=dump_document_json(generated),
        )
        self.db.commit()
        self.db.refresh(record)
        logger.info(
            "mindmap.generate.saved tenant_id=%s workroom_id=%s source_type=%s source_id=%s mindmap_id=%s version=%s generated_by=%s mode=%s",
            tenant_id,
            workroom_id,
            source_type,
            source_id,
            record.id,
            record.version,
            generated.meta.generatedBy,
            mode,
        )
        return self._hydrate(record.graph_json, fallback_id=record.id, fallback_version=record.version)

    def save(
        self,
        *,
        tenant_id: int,
        user_id: int | None,
        workroom_id: int,
        mindmap_id: int,
        document: MindMapDocument,
    ) -> MindMapDocument:
        record = self.repo.update_map_content(
            tenant_id=tenant_id,
            workroom_id=workroom_id,
            mindmap_id=mindmap_id,
            graph_json=dump_document_json(document),
            title=document.title,
        )
        if record is None:
            raise HTTPException(status_code=404, detail="Mindmap not found")
        if user_id is not None and record.created_by_user_id is None:
            record.created_by_user_id = user_id
        self.db.commit()
        self.db.refresh(record)
        return self._hydrate(record.graph_json, fallback_id=record.id, fallback_version=record.version)

    def _build_from_source(
        self,
        *,
        tenant_id: int,
        source_type: str,
        source_id: int,
        source_ids: list[int] | None,
        source_signature: str | None,
        mode: str,
    ) -> MindMapDocument:
        if source_type == "exam_document":
            document = self.repo.get_document(tenant_id=tenant_id, document_id=source_id)
            if document is None:
                raise HTTPException(status_code=404, detail="Document not found")

            questions = self.repo.list_document_questions(tenant_id=tenant_id, document_id=source_id)
            title = document.title or f"Document {document.id}"
            question_items = [
                {
                    "id": item.id,
                    "sequence_index": item.sequence_index,
                    "page": item.page,
                    "content": item.content,
                }
                for item in questions
            ]
            has_question_refs = bool(question_items)
            blocks = self._document_blocks(document)
            payload = self._generate_two_stage_for_document(
                tenant_id=tenant_id,
                local_file_id=int(document.file_id) if getattr(document, "file_id", None) else None,
                title=title,
                source_type=source_type,
                source_id=source_id,
                source_ids=[],
                source_signature=source_signature,
                mode=mode,
                source_text=render_question_source(title, question_items) if question_items else render_block_source(title, blocks),
                has_question_refs=has_question_refs,
                questions=question_items,
                source_count=1,
            )
            logger.info(
                "mindmap.generate.document_two_stage tenant_id=%s document_id=%s question_count=%s block_count=%s mode=%s",
                tenant_id,
                source_id,
                len(question_items),
                len(blocks),
                mode,
            )
            return MindMapDocument.model_validate(payload)

        if source_type == "uploaded_file":
            normalized_ids = [int(item) for item in (source_ids or []) if int(item) > 0]
            if len(normalized_ids) > 1:
                payload = self._generate_multi_file_mindmap(
                    tenant_id=tenant_id,
                    file_ids=normalized_ids,
                    source_type=source_type,
                    source_signature=source_signature or self._build_source_signature(source_type, normalized_ids),
                    mode=mode,
                )
                return MindMapDocument.model_validate(payload)

            file_obj = self.repo.get_file(tenant_id=tenant_id, file_id=source_id)
            if file_obj is None:
                raise HTTPException(status_code=404, detail="File not found")
            payload = self._generate_with_llm_from_file(
                tenant_id=tenant_id,
                local_file_id=int(file_obj.id),
                title=file_obj.original_name or f"File {file_obj.id}",
                source_type=source_type,
                source_id=source_id,
                source_ids=[],
                source_signature=source_signature,
                mode=mode,
                has_question_refs=False,
                questions=[],
            )
            logger.info(
                "mindmap.generate.file_two_stage tenant_id=%s file_id=%s mode=%s generated_by=%s",
                tenant_id,
                source_id,
                mode,
                payload.get("meta", {}).get("generatedBy"),
            )
            return MindMapDocument.model_validate(payload)

        raise HTTPException(status_code=400, detail="Unsupported source_type")

    @staticmethod
    def _resolve_kind(kind: str, mode: str) -> str:
        return f"{kind}:{mode}"

    def _normalize_sources(
        self,
        *,
        source_type: str,
        source_id: int,
        source_ids: list[int] | None,
    ) -> tuple[int, list[int], str | None]:
        normalized_ids = sorted({int(item) for item in (source_ids or []) if int(item) > 0})
        if source_type != "uploaded_file" or len(normalized_ids) <= 1:
            return int(source_id), normalized_ids, None
        return 0, normalized_ids, self._build_source_signature(source_type, normalized_ids)

    @staticmethod
    def _build_source_signature(source_type: str, source_ids: list[int]) -> str:
        normalized_ids = sorted({int(item) for item in source_ids if int(item) > 0})
        return f"{source_type}:{','.join(str(item) for item in normalized_ids)}"

    def _document_blocks(self, document: Any) -> list[dict[str, Any]]:
        if getattr(document, "file_id", None):
            blocks = self.repo.list_file_blocks(tenant_id=int(document.tenant_id), file_id=int(document.file_id))
            if blocks:
                return [{"page": block.page_num, "text": block.content} for block in blocks]

        raw_ocr_md = str(getattr(document, "ocr_md_cache", "") or "").strip()
        if raw_ocr_md:
            try:
                parsed = json.loads(raw_ocr_md)
                if isinstance(parsed, list):
                    blocks = []
                    for index, item in enumerate(parsed[:24]):
                        if isinstance(item, dict):
                            text = item.get("text") or item.get("md") or item.get("content") or ""
                            page = item.get("page") or item.get("page_num") or index + 1
                        else:
                            text = str(item)
                            page = index + 1
                        blocks.append({"page": page, "text": text})
                    return blocks
            except Exception:
                return [{"page": 1, "text": raw_ocr_md}]

        return []

    def _generate_with_llm_from_file(
        self,
        *,
        tenant_id: int,
        local_file_id: int,
        title: str,
        source_type: str,
        source_id: int,
        source_ids: list[int],
        source_signature: str | None,
        mode: str,
        has_question_refs: bool,
        questions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        try:
            return self._generate_two_stage_for_document(
                tenant_id=tenant_id,
                local_file_id=local_file_id,
                title=title,
                source_type=source_type,
                source_id=source_id,
                source_ids=source_ids,
                source_signature=source_signature,
                mode=mode,
                source_text="",
                has_question_refs=has_question_refs,
                questions=questions,
                source_count=max(len(source_ids), 1),
            )
        except Exception:
            logger.exception(
                "mindmap.llm_file_generation_failed source_type=%s source_id=%s local_file_id=%s title=%s mode=%s",
                source_type,
                source_id,
                local_file_id,
                title,
                mode,
            )
            raise HTTPException(status_code=502, detail="Mindmap generation from uploaded file failed")

    def _generate_two_stage_for_document(
        self,
        *,
        tenant_id: int,
        local_file_id: int | None,
        title: str,
        source_type: str,
        source_id: int,
        source_ids: list[int],
        source_signature: str | None,
        mode: str,
        source_text: str,
        has_question_refs: bool,
        questions: list[dict[str, Any]],
        source_count: int,
    ) -> dict[str, Any]:
        settings = get_settings()
        mode_name = self._normalize_mode(mode)
        extra_fields: dict[str, Any] = {}

        if local_file_id is not None:
            outline_reply, outline, extra_fields = self._generate_outline_from_uploaded_file(
                tenant_id=tenant_id,
                local_file_id=local_file_id,
                title=title,
                source_type=source_type,
                source_id=source_id,
                mode=mode_name,
            )
        else:
            if not source_text.strip():
                raise HTTPException(status_code=422, detail="Mindmap source text is empty")
            outline_client = QwenClient(
                model=settings.alibaba_model_qwen_flash,
                max_output_tokens=8000,
            )
            outline_messages = build_outline_generation_messages(
                title=title,
                source_text=source_text,
                source_type=source_type,
                source_id=source_id,
                mode=mode_name,
            )
            logger.info(
                "mindmap.outline.text_start model=%s source_type=%s source_id=%s mode=%s source_chars=%s",
                settings.alibaba_model_qwen_flash,
                source_type,
                source_id,
                mode_name,
                len(source_text),
            )
            outline_reply = self._chat_messages(client=outline_client, messages=outline_messages)

        self._persist_debug_artifact(
            prefix="mindmap_outline_raw_reply",
            source_type=source_type,
            source_id=source_id,
            content=outline_reply,
        )
        if local_file_id is None:
            outline = parse_generated_outline(
                outline_reply,
                fallback_title=title,
                fallback_mode=mode_name,
            )
        self._persist_debug_artifact(
            prefix="mindmap_outline",
            source_type=source_type,
            source_id=source_id,
            content=json.dumps(outline.model_dump(mode="json"), ensure_ascii=False, indent=2),
        )
        logger.info(
            "mindmap.outline.validated source_type=%s source_id=%s mode=%s topic_count=%s%s",
            source_type,
            source_id,
            mode_name,
            len(outline.topics or []),
            self._format_extra_log_fields(extra_fields),
        )

        return self._expand_outline_with_quality_gate(
            title=title,
            outline=outline,
            source_type=source_type,
            source_id=source_id,
            source_ids=source_ids,
            source_signature=source_signature,
            mode=mode_name,
            has_question_refs=has_question_refs,
            questions=questions,
            source_count=max(source_count, 1),
            expand_model=settings.alibaba_model_qwen_mindmap_expand,
        )

    def _generate_multi_file_mindmap(
        self,
        *,
        tenant_id: int,
        file_ids: list[int],
        source_type: str,
        source_signature: str,
        mode: str,
    ) -> dict[str, Any]:
        settings = get_settings()
        mode_name = self._normalize_mode(mode)
        jobs: list[dict[str, Any]] = []
        for index, file_id in enumerate(file_ids):
            file_obj = self.repo.get_file(tenant_id=tenant_id, file_id=file_id)
            if file_obj is None:
                raise HTTPException(status_code=404, detail=f"File {file_id} not found")
            jobs.append(
                {
                    "index": index,
                    "file_id": int(file_obj.id),
                    "title": file_obj.original_name or f"File {file_obj.id}",
                }
            )

        if not jobs:
            raise HTTPException(status_code=422, detail="No source files available for mindmap generation")

        outlines: list[tuple[DocOutline, str, list[int]]] = []
        max_workers = min(max(1, int(settings.mindmap_outline_concurrency)), len(jobs))
        futures = {}
        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="mindmap-outline") as executor:
            for job in jobs:
                future = executor.submit(
                    self._generate_outline_from_uploaded_file,
                    tenant_id=tenant_id,
                    local_file_id=job["file_id"],
                    title=job["title"],
                    source_type=source_type,
                    source_id=job["file_id"],
                    mode=mode_name,
                )
                futures[future] = job

            for future in as_completed(futures):
                job = futures[future]
                outline_reply, outline, _extra_fields = future.result()
                outlines.append((outline, job["title"], [job["file_id"]]))
                self._persist_debug_artifact(
                    prefix="mindmap_outline_raw_reply",
                    source_type=source_type,
                    source_id=job["file_id"],
                    content=outline_reply,
                )
                self._persist_debug_artifact(
                    prefix="mindmap_outline",
                    source_type=source_type,
                    source_id=job["file_id"],
                    content=json.dumps(outline.model_dump(mode="json"), ensure_ascii=False, indent=2),
                )

        outlines.sort(key=lambda item: file_ids.index(item[2][0]))
        merged_title, merged_outline, merged_ids = self._merge_outline_batches(
            items=outlines,
            source_type=source_type,
            mode=mode_name,
        )
        self._persist_debug_artifact(
            prefix="mindmap_outline_merged",
            source_type=source_type,
            source_id=0,
            content=json.dumps(merged_outline.model_dump(mode="json"), ensure_ascii=False, indent=2),
        )
        return self._expand_outline_with_quality_gate(
            title=merged_title,
            outline=merged_outline,
            source_type=source_type,
            source_id=0,
            source_ids=merged_ids,
            source_signature=source_signature,
            mode=mode_name,
            has_question_refs=False,
            questions=[],
            source_count=len(file_ids),
            expand_model=settings.alibaba_model_qwen_mindmap_expand,
        )

    def _generate_outline_from_uploaded_file(
        self,
        *,
        tenant_id: int,
        local_file_id: int,
        title: str,
        source_type: str,
        source_id: int,
        mode: MindMapMode,
    ) -> tuple[str, DocOutline, dict[str, Any]]:
        settings = get_settings()
        current_mapping = None
        for attempt in range(2):
            mapping = current_mapping or self.bailian_files.ensure_uploaded(
                tenant_id=tenant_id,
                local_file_id=local_file_id,
                purpose="file-extract",
            )
            should_release = True
            try:
                extra_fields = {"local_file_id": local_file_id, "bailian_file_id": mapping.bailian_file_id}
                logger.info(
                    "mindmap.outline.file_start model=%s source_type=%s source_id=%s local_file_id=%s bailian_file_id=%s mode=%s",
                    settings.alibaba_model_qwen_long,
                    source_type,
                    source_id,
                    local_file_id,
                    mapping.bailian_file_id,
                    mode,
                )
                reply = self._chat_messages(
                    client=QwenClient(model=settings.alibaba_model_qwen_long, max_output_tokens=8000),
                    messages=build_file_outline_generation_messages(
                        title=title,
                        bailian_file_id=mapping.bailian_file_id,
                        source_type=source_type,
                        source_id=source_id,
                        mode=mode,
                    ),
                )
                outline = parse_generated_outline(reply, fallback_title=title, fallback_mode=mode)
                return reply, outline, extra_fields
            except QwenRequestError as exc:
                if attempt == 0 and self._is_invalid_remote_file_error(exc):
                    logger.warning(
                        "mindmap.outline.file_invalid source_type=%s source_id=%s local_file_id=%s bailian_file_id=%s mode=%s retrying_upload=true",
                        source_type,
                        source_id,
                        local_file_id,
                        mapping.bailian_file_id,
                        mode,
                    )
                    current_mapping = self.bailian_files.reupload_mapping(record=mapping)
                    should_release = False
                    continue
                raise
            finally:
                if should_release and mapping.deleted_at is None and mapping.status != "deleted":
                    self.bailian_files.release_mapping(record=mapping, remote_delete=True)

        raise HTTPException(status_code=502, detail="Mindmap outline generation from uploaded file failed")

    def _merge_outline_batches(
        self,
        *,
        items: list[tuple[DocOutline, str, list[int]]],
        source_type: str,
        mode: MindMapMode,
    ) -> tuple[str, DocOutline, list[int]]:
        settings = get_settings()
        current = list(items)
        round_index = 1
        while len(current) > 1:
            next_round: list[tuple[DocOutline, str, list[int]]] = []
            for start in range(0, len(current), 8):
                chunk = current[start : start + 8]
                if len(chunk) == 1:
                    next_round.append(chunk[0])
                    continue
                chunk_outlines = [item[0] for item in chunk]
                chunk_titles = [item[1] for item in chunk]
                chunk_ids = [source_id for item in chunk for source_id in item[2]]
                merged_title = self._compose_merged_title(chunk_titles)
                merge_reply = self._chat_messages(
                    client=QwenClient(model=settings.alibaba_model_qwen_long, max_output_tokens=8000),
                    messages=build_outline_merge_messages(
                        title=merged_title,
                        outlines=chunk_outlines,
                        source_type=source_type,
                        source_ids=chunk_ids,
                        mode=mode,
                    ),
                )
                merged_outline = parse_generated_outline(
                    merge_reply,
                    fallback_title=merged_title,
                    fallback_mode=mode,
                )
                logger.info(
                    "mindmap.outline.merge round=%s chunk_size=%s merged_topic_count=%s mode=%s",
                    round_index,
                    len(chunk),
                    len(merged_outline.topics or []),
                    mode,
                )
                next_round.append((merged_outline, merged_title, chunk_ids))
            current = next_round
            round_index += 1
        return current[0][1], current[0][0], current[0][2]

    def _expand_outline_with_quality_gate(
        self,
        *,
        title: str,
        outline: DocOutline,
        source_type: str,
        source_id: int,
        source_ids: list[int],
        source_signature: str | None,
        mode: MindMapMode,
        has_question_refs: bool,
        questions: list[dict[str, Any]],
        source_count: int,
        expand_model: str,
    ) -> dict[str, Any]:
        settings = get_settings()
        node_budget = self._node_budget(source_count)
        retry_limit = max(1, int(settings.mindmap_expand_retry_limit))
        retry_feedback: str | None = None
        last_report: QualityReport | None = None

        for attempt in range(1, retry_limit + 1):
            expand_reply = self._chat_messages(
                client=QwenClient(model=expand_model, max_output_tokens=8000),
                messages=build_expand_messages(
                    title=title,
                    outline=outline,
                    source_type=source_type,
                    source_id=source_id,
                    has_question_refs=has_question_refs,
                    mode=mode,
                    node_budget=node_budget,
                    retry_feedback=retry_feedback,
                ),
                response_format=build_expand_response_format(),
                temperature=0.0,
                top_p=0.3,
            )
            self._persist_debug_artifact(
                prefix=f"mindmap_raw_reply_attempt_{attempt}",
                source_type=source_type,
                source_id=source_id,
                content=expand_reply,
            )
            draft = parse_generated_draft(expand_reply, fallback_title=title)
            draft = align_draft_to_outline(
                title=title,
                outline=outline,
                draft=draft,
            )
            self._persist_debug_artifact(
                prefix=f"mindmap_draft_attempt_{attempt}",
                source_type=source_type,
                source_id=source_id,
                content=json.dumps(draft.model_dump(mode="json"), ensure_ascii=False, indent=2),
            )
            report = evaluate_draft_hard_quality(outline=outline, draft=draft)
            last_report = report
            self._persist_debug_artifact(
                prefix=f"mindmap_quality_attempt_{attempt}",
                source_type=source_type,
                source_id=source_id,
                content=json.dumps(report.model_dump(mode="json"), ensure_ascii=False, indent=2),
            )
            logger.info(
                "mindmap.quality attempt=%s source_type=%s source_id=%s mode=%s total=%.3f coverage=%.3f duplication=%.3f depth=%.3f granularity=%.3f alignment=%.3f passed=%s",
                attempt,
                source_type,
                source_id,
                mode,
                report.totalScore,
                report.coverageScore,
                report.duplicationScore,
                report.depthScore,
                report.granularityScore,
                report.modeAlignmentScore,
                report.passed,
            )
            if report.passed:
                document, binding_stats = build_document_from_draft(
                    draft=draft,
                    title=title,
                    source_type=source_type,
                    source_id=source_id,
                    source_ids=source_ids,
                    source_signature=source_signature,
                    mode=mode,
                    questions=questions,
                )
                logger.info(
                    "mindmap.binding.summary source_type=%s source_id=%s has_question_refs=%s node_count=%s hinted_nodes=%s bound_ref_count=%s unresolved_hint_count=%s mode=%s",
                    source_type,
                    source_id,
                    document.meta.hasQuestionRefs,
                    binding_stats["node_count"],
                    binding_stats["hinted_nodes"],
                    binding_stats["bound_ref_count"],
                    binding_stats["unresolved_hint_count"],
                    mode,
                )
                logger.info(
                    "mindmap.expand.success source_type=%s source_id=%s mode=%s root_topic=%s branch_count=%s attempt=%s",
                    source_type,
                    source_id,
                    mode,
                    document.root.topic,
                    len(document.root.children or []),
                    attempt,
                )
                return dump_document_json(document)
            retry_feedback = report.retryPrompt or self._summarize_quality_issues(report)

        raise HTTPException(
            status_code=502,
            detail=f"Mindmap structure validation failed: {last_report.retryPrompt if last_report and last_report.retryPrompt else 'generated draft does not match outline'}",
        )

    def _chat_messages(
        self,
        *,
        client: QwenClient,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None = None,
        temperature: float = 0.2,
        top_p: float = 0.8,
    ) -> str:
        reply, _usage = client.chat(
            messages,
            temperature=temperature,
            top_p=top_p,
            response_format=response_format,
        )
        return reply

    @staticmethod
    def _normalize_mode(mode: str) -> MindMapMode:
        return mode if mode in ("knowledge_structure", "exam_review") else "knowledge_structure"

    @staticmethod
    def _is_invalid_remote_file_error(exc: Exception) -> bool:
        if not isinstance(exc, QwenRequestError):
            return False
        response_text = (exc.response_text or str(exc) or "").lower()
        return "invalid file" in response_text

    @staticmethod
    def _node_budget(source_count: int) -> int:
        if source_count <= 1:
            return 36
        if source_count <= 10:
            return 72
        return 120

    @staticmethod
    def _compose_merged_title(titles: list[str]) -> str:
        preview = " / ".join(item for item in titles[:3] if item)
        if len(titles) > 3:
            return f"{preview} 等{len(titles)}份文档"
        return preview or "Merged Mindmap Sources"

    @staticmethod
    def _summarize_quality_issues(report: QualityReport) -> str:
        if not report.issues:
            return "Improve topic coverage, reduce duplication, and make sibling nodes more consistent in abstraction."
        summaries = [issue.message.strip() for issue in report.issues[:3] if issue.message.strip()]
        return " ; ".join(summaries) if summaries else "Improve structural quality and mode alignment."

    @staticmethod
    def _format_extra_log_fields(extra_fields: dict[str, Any] | None) -> str:
        if not extra_fields:
            return ""
        return "".join(f" {key}={value}" for key, value in extra_fields.items())

    def _persist_debug_artifact(
        self,
        *,
        prefix: str,
        source_type: str,
        source_id: int,
        content: str | None,
    ) -> None:
        if not content:
            return
        try:
            logs_dir = Path(__file__).resolve().parents[2] / "logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
            extension = "txt" if prefix.endswith("raw_reply") else "json"
            target = logs_dir / f"{prefix}_{source_type}_{source_id}_{timestamp}.{extension}"
            target.write_text(content, encoding="utf-8")
            logger.info("mindmap.llm.raw_saved path=%s", target)
        except Exception:
            logger.exception(
                "mindmap.debug_artifact_save_failed prefix=%s source_type=%s source_id=%s",
                prefix,
                source_type,
                source_id,
            )

    @staticmethod
    def _should_regenerate_existing(document: MindMapDocument) -> bool:
        if document.meta.generatedBy != "system":
            return False
        root_children = document.root.children or []
        if not root_children:
            return True
        placeholder_topics = 0
        placeholder_summaries = 0
        for child in root_children:
            topic = (child.topic or "").strip().lower()
            summary = (child.summary or "").strip().lower()
            if topic.startswith("page ") or topic.startswith("snippet "):
                placeholder_topics += 1
            if "source snippets" in summary or "linked questions" in summary or "question nodes" in summary:
                placeholder_summaries += 1
        return placeholder_topics == len(root_children) or placeholder_summaries == len(root_children)

    @staticmethod
    def _hydrate(graph_json: dict[str, Any], *, fallback_id: int, fallback_version: int) -> MindMapDocument:
        data = dict(graph_json or {})
        data["id"] = int(fallback_id)
        data["version"] = int(fallback_version)
        return MindMapDocument.model_validate(data)
