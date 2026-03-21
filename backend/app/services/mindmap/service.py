from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ...config import get_settings
from ..bailian_file_service import BailianFileService
from ..qwen_client import QwenClient
from .generation import (
    build_document_from_draft,
    build_document_from_blocks,
    build_file_generation_messages,
    build_document_from_questions,
    build_generation_messages,
    parse_generated_draft,
    render_block_source,
    render_question_source,
)
from .repository import MindMapRepository
from .schemas import MindMapDocument, dump_document_json

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
        kind: str = "knowledge",
    ) -> MindMapDocument:
        record = self.repo.get_active_map(
            tenant_id=tenant_id,
            workroom_id=workroom_id,
            source_type=source_type,
            source_id=source_id,
            kind=kind,
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
        kind: str = "knowledge",
        force: bool = False,
    ) -> MindMapDocument:
        logger.info(
            "mindmap.generate.start tenant_id=%s workroom_id=%s source_type=%s source_id=%s kind=%s force=%s",
            tenant_id,
            workroom_id,
            source_type,
            source_id,
            kind,
            force,
        )
        if not force:
            existing = self.repo.get_active_map(
                tenant_id=tenant_id,
                workroom_id=workroom_id,
                source_type=source_type,
                source_id=source_id,
                kind=kind,
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
            source_id=source_id,
        )
        record = self.repo.create_map_version(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            source_type=source_type,
            source_id=source_id,
            kind=kind,
            title=generated.title,
            graph_json=dump_document_json(generated),
        )
        self.db.commit()
        self.db.refresh(record)
        logger.info(
            "mindmap.generate.saved tenant_id=%s workroom_id=%s source_type=%s source_id=%s mindmap_id=%s version=%s generated_by=%s",
            tenant_id,
            workroom_id,
            source_type,
            source_id,
            record.id,
            record.version,
            generated.meta.generatedBy,
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

    def _build_from_source(self, *, tenant_id: int, source_type: str, source_id: int) -> MindMapDocument:
        if source_type == "exam_document":
            document = self.repo.get_document(tenant_id=tenant_id, document_id=source_id)
            if document is None:
                raise HTTPException(status_code=404, detail="Document not found")
            questions = self.repo.list_document_questions(tenant_id=tenant_id, document_id=source_id)
            title = document.title or f"Document {document.id}"
            if questions:
                question_items = [
                    {
                        "id": item.id,
                        "sequence_index": item.sequence_index,
                        "page": item.page,
                        "content": item.content,
                    }
                    for item in questions
                ]
                payload = self._generate_with_llm(
                    title=title,
                    source_type=source_type,
                    source_id=source_id,
                    source_text=render_question_source(title, question_items),
                    has_question_refs=True,
                    questions=question_items,
                ) or build_document_from_questions(
                    title=title,
                    source_type=source_type,
                    source_id=source_id,
                    questions=question_items,
                )
                logger.info(
                    "mindmap.generate.document_questions tenant_id=%s document_id=%s question_count=%s mode=%s",
                    tenant_id,
                    source_id,
                    len(question_items),
                    "llm" if payload.get("meta", {}).get("generatedBy") == "llm" else "fallback",
                )
            else:
                blocks = self._document_blocks(document)
                payload = self._generate_with_llm(
                    title=title,
                    source_type=source_type,
                    source_id=source_id,
                    source_text=render_block_source(title, blocks),
                    has_question_refs=False,
                    questions=[],
                ) or build_document_from_blocks(
                    title=title,
                    source_type=source_type,
                    source_id=source_id,
                    blocks=blocks,
                )
                logger.info(
                    "mindmap.generate.document_blocks tenant_id=%s document_id=%s block_count=%s mode=%s",
                    tenant_id,
                    source_id,
                    len(blocks),
                    "llm" if payload.get("meta", {}).get("generatedBy") == "llm" else "fallback",
                )
            return MindMapDocument.model_validate(payload)

        if source_type == "uploaded_file":
            file_obj = self.repo.get_file(tenant_id=tenant_id, file_id=source_id)
            if file_obj is None:
                raise HTTPException(status_code=404, detail="File not found")
            blocks = [
                {"page": block.page_num, "text": block.content}
                for block in self.repo.list_file_blocks(tenant_id=tenant_id, file_id=source_id)
            ]
            payload = self._generate_with_llm_from_file(
                tenant_id=tenant_id,
                local_file_id=int(file_obj.id),
                title=file_obj.original_name or f"File {file_obj.id}",
                source_type=source_type,
                source_id=source_id,
                has_question_refs=False,
                questions=[],
            )
            logger.info(
                "mindmap.generate.file_blocks tenant_id=%s file_id=%s block_count=%s mode=%s",
                tenant_id,
                source_id,
                len(blocks),
                payload.get("meta", {}).get("generatedBy"),
            )
            return MindMapDocument.model_validate(payload)

        raise HTTPException(status_code=400, detail="Unsupported source_type")

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

    def _generate_with_llm(
        self,
        *,
        title: str,
        source_type: str,
        source_id: int,
        source_text: str,
        has_question_refs: bool,
        questions: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        if not source_text.strip():
            logger.warning(
                "mindmap.llm.skip_empty_source source_type=%s source_id=%s title=%s",
                source_type,
                source_id,
                title,
            )
            return None
        try:
            settings = get_settings()
            client = QwenClient(
                model=settings.alibaba_model_qwen_flash,
                max_output_tokens=8000,
            )
            logger.info(
                "mindmap.llm.start model=%s source_type=%s source_id=%s title=%s source_chars=%s has_question_refs=%s",
                settings.alibaba_model_qwen_flash,
                source_type,
                source_id,
                title,
                len(source_text),
                has_question_refs,
            )
            messages = build_generation_messages(
                title=title,
                source_text=source_text,
                source_type=source_type,
                source_id=source_id,
                has_question_refs=has_question_refs,
            )
            return self._generate_from_messages(
                title=title,
                source_type=source_type,
                source_id=source_id,
                questions=questions,
                messages=messages,
                model_name=settings.alibaba_model_qwen_flash,
                success_log_name="mindmap.llm.success",
            )
        except Exception:
            logger.exception(
                "mindmap.llm_generation_failed source_type=%s source_id=%s title=%s",
                source_type,
                source_id,
                title,
            )
            return None

    def _generate_with_llm_from_file(
        self,
        *,
        tenant_id: int,
        local_file_id: int,
        title: str,
        source_type: str,
        source_id: int,
        has_question_refs: bool,
        questions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        try:
            settings = get_settings()
            mapping = self.bailian_files.ensure_uploaded(
                tenant_id=tenant_id,
                local_file_id=local_file_id,
                purpose="file-extract",
            )
            client = QwenClient(
                model=settings.alibaba_model_qwen_long,
                max_output_tokens=8000,
            )
            logger.info(
                "mindmap.llm.file_start model=%s source_type=%s source_id=%s local_file_id=%s bailian_file_id=%s has_question_refs=%s",
                settings.alibaba_model_qwen_long,
                source_type,
                source_id,
                local_file_id,
                mapping.bailian_file_id,
                has_question_refs,
            )
            messages = build_file_generation_messages(
                title=title,
                bailian_file_id=mapping.bailian_file_id,
                source_type=source_type,
                source_id=source_id,
                has_question_refs=has_question_refs,
            )
            payload = self._generate_from_messages(
                title=title,
                source_type=source_type,
                source_id=source_id,
                questions=questions,
                messages=messages,
                model_name=settings.alibaba_model_qwen_long,
                success_log_name="mindmap.llm.file_success",
                extra_success_fields={
                    "local_file_id": local_file_id,
                    "bailian_file_id": mapping.bailian_file_id,
                },
                client=client,
            )
            return payload
        except Exception:
            logger.exception(
                "mindmap.llm_file_generation_failed source_type=%s source_id=%s local_file_id=%s title=%s",
                source_type,
                source_id,
                local_file_id,
                title,
            )
            raise HTTPException(status_code=502, detail="Mindmap generation from uploaded file failed")

    def _generate_from_messages(
        self,
        *,
        title: str,
        source_type: str,
        source_id: int,
        questions: list[dict[str, Any]],
        messages: list[dict[str, str]],
        model_name: str,
        success_log_name: str,
        extra_success_fields: dict[str, Any] | None = None,
        client: QwenClient | None = None,
    ) -> dict[str, Any]:
        llm_client = client or QwenClient(
            model=model_name,
            max_output_tokens=8000,
        )
        reply, _usage = llm_client.chat(messages, temperature=0.2, top_p=0.8)
        self._persist_debug_artifact(
            prefix="mindmap_raw_reply",
            source_type=source_type,
            source_id=source_id,
            content=reply,
        )
        draft = parse_generated_draft(
            reply,
            fallback_title=title,
        )
        self._persist_debug_artifact(
            prefix="mindmap_draft",
            source_type=source_type,
            source_id=source_id,
            content=json.dumps(draft.model_dump(mode="json"), ensure_ascii=False, indent=2),
        )
        logger.info(
            "mindmap.draft.validated source_type=%s source_id=%s root_topic=%s branch_count=%s",
            source_type,
            source_id,
            draft.root.topic,
            len(draft.root.children or []),
        )
        document, binding_stats = build_document_from_draft(
            draft=draft,
            title=title,
            source_type=source_type,
            source_id=source_id,
            questions=questions,
        )
        logger.info(
            "mindmap.binding.summary source_type=%s source_id=%s has_question_refs=%s node_count=%s hinted_nodes=%s bound_ref_count=%s unresolved_hint_count=%s",
            source_type,
            source_id,
            document.meta.hasQuestionRefs,
            binding_stats["node_count"],
            binding_stats["hinted_nodes"],
            binding_stats["bound_ref_count"],
            binding_stats["unresolved_hint_count"],
        )
        logger.info(
            "%s model=%s source_type=%s source_id=%s reply_chars=%s root_topic=%s branch_count=%s%s",
            success_log_name,
            model_name,
            source_type,
            source_id,
            len(reply or ""),
            document.root.topic,
            len(document.root.children or []),
            self._format_extra_log_fields(extra_success_fields),
        )
        return dump_document_json(document)

    @staticmethod
    def _format_extra_log_fields(extra_fields: dict[str, Any] | None) -> str:
        if not extra_fields:
            return ""
        parts = []
        for key, value in extra_fields.items():
            parts.append(f" {key}={value}")
        return "".join(parts)

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
            logger.exception("mindmap.debug_artifact_save_failed prefix=%s source_type=%s source_id=%s", prefix, source_type, source_id)

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
