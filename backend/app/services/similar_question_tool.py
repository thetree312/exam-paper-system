import logging

import re

from typing import Any, Dict, List, Optional, Sequence



from fastapi import HTTPException



from .agent_service import AgentService





logger = logging.getLogger("agent.similar_tool")





def _strip_answer_and_analysis(content: str) -> str:

    """Deprecated: legacy sanitizer for free-form content.



    为了获得可预测的行为，SimilarQuestionTool 现在只接受结构化题目 schema，

    不再尝试对自由文本做“尽力清洗”。该函数保留仅为兼容旧代码引用，

    但不再在执行路径中调用。

    """



    return content





def _extract_solution_payload(item: Dict[str, Any]) -> Optional[Dict[str, str]]:

    """Return sanitized solution payload for front-end display."""



    sol = item.get("solution")

    if not isinstance(sol, dict):

        return None

    final_answer = sol.get("final_answer") or sol.get("finalAnswer") or sol.get("answer")

    analysis = sol.get("analysis") or sol.get("explanation")

    cleaned: Dict[str, str] = {}

    if isinstance(final_answer, str) and final_answer.strip():

        cleaned["finalAnswer"] = final_answer.strip()

    if isinstance(analysis, str) and analysis.strip():

        text = analysis.strip()

        # 为避免命题过程或冗长说明污染前端展示，这里对解析长度做软上限截断。

        max_len = 600

        if len(text) > max_len:

            logger.info(

                "similar_tool.analysis_truncated original_len=%s max_len=%s preview=%s",

                len(text),

                max_len,

                text[:160],

            )

            text = text[:max_len].rstrip() + "…"

        cleaned["analysis"] = text

    return cleaned or None





def _build_student_content_from_variant(item: Dict[str, Any]) -> str:

    """Compose student-facing question content from a structured variant.



    约定：

    - item.stem: 题干文本（不含标准答案/解析）。

    - item.options: 选项数组，可以为空（开放题型）。



    这里显式只用 stem + options 生成 content，完全忽略 solution/analysis，

    确保学生界面永远不会因为模型的解析文本而被污染。

    """



    stem = str(item.get("stem") or "").strip()

    options_raw = item.get("options")

    options: List[str] = []

    if isinstance(options_raw, list):

        for opt in options_raw:

            if not isinstance(opt, str):

                continue

            text = opt.strip()

            if text:

                options.append(text)



    parts: List[str] = []

    if stem:

        parts.append(stem)

    if options:

        parts.append("\n".join(options))



    content = "\n".join(parts).strip()

    return content





class SimilarQuestionTool:

    """Executes plan(s) produced by上游 Agent to overwrite or insert questions."""



    def __init__(self, svc: AgentService) -> None:

        self.svc = svc



    def execute_plans(

        self,

        *,

        plans: Sequence[Dict[str, Any]],

        tenant_id: int,

        document_id: int,

        run_id: str,

        request_label: str | None = None,

    ) -> List[Dict[str, Any]]:

        """Execute one or more plans emitted by solver Agent."""



        events: List[Dict[str, Any]] = []

        label = (request_label or "")[:120]

        for plan in plans:

            try:

                mode = str(plan.get("mode", "")).strip()

            except Exception:

                mode = ""

            if not mode:

                logger.info("similar_tool.skip_plan_missing_mode plan=%s", plan)

                continue



            if mode == "similar_overwrite":

                event = self._handle_overwrite(

                    plan=plan,

                    tenant_id=tenant_id,

                    document_id=document_id,

                    run_id=run_id,

                    latest_user_message=label,

                )

                if event:

                    events.append(event)

                continue



            if mode == "from_content_no_overwrite":

                insert_events = self._handle_insert(

                    plan=plan,

                    tenant_id=tenant_id,

                    document_id=document_id,

                    run_id=run_id,

                    latest_user_message=label,

                    note_source=plan.get("note_source"),

                )

                events.extend(insert_events)

                continue



            logger.info("similar_tool.unsupported_mode mode=%s plan=%s", mode, plan)



        return events



    def _handle_overwrite(

        self,

        *,

        plan: Dict[str, Any],

        tenant_id: int,

        document_id: int,

        run_id: str,

        latest_user_message: str,

    ) -> Optional[Dict[str, Any]]:

        target_index = plan.get("target_sequence_index")

        replacement = plan.get("replacement_question") or {}

        solution_payload = _extract_solution_payload(replacement)



        # 只接受结构化 schema：必须提供 stem

        if not isinstance(replacement, dict) or not replacement.get("stem"):

            logger.info("similar_tool.overwrite_invalid_schema plan=%s", plan)

            return None

        content = _build_student_content_from_variant(replacement)

        if target_index is None or content == "":

            logger.info("similar_tool.overwrite_missing_fields plan=%s", plan)

            return None



        # 优先使用 base_question_id 精确定位题目，避免依赖可能漂移或不存在的 sequence_index

        base_q: Optional[Question] = None

        raw_base_id = plan.get("base_question_id")

        if isinstance(raw_base_id, int):

            try:

                base_q = self.svc.get_question_by_id(

                    tenant_id=tenant_id,

                    document_id=document_id,

                    question_id=raw_base_id,

                )

            except HTTPException as exc:

                logger.info(

                    "similar_tool.overwrite_base_id_not_found id=%s error=%s", raw_base_id, exc.detail

                )



        if base_q is not None:

            question = base_q

        else:

            try:

                question = self.svc.get_question_by_sequence(

                    tenant_id=tenant_id,

                    document_id=document_id,

                    sequence_index=int(target_index),

                )

            except HTTPException as exc:

                logger.info("similar_tool.question_not_found seq=%s error=%s", target_index, exc.detail)

                return None



        legend_images = replacement.get("legend_images")

        if legend_images is not None and not isinstance(legend_images, list):

            legend_images = []

        origin_meta = {

            "requestLabel": latest_user_message[:120],

            "agentRunId": run_id,

        }

        question = self.svc.append_question_version(

            question=question,

            new_content=content,

            new_legend_images=legend_images,

            origin=origin_meta,

        )

        version_history = list(question.versions or [])

        version_count = 1 + len(version_history)

        logger.info(

            "similar_tool.overwrite_success run_id=%s question_id=%s sequence=%s content_preview=%s",

            run_id,

            question.id,

            question.sequence_index,

            content[:120],

        )

        event = {

            "action": "question.replace",

            "target": {

                "questionId": question.id,

                "sequenceIndex": question.sequence_index,

                "groupId": question.group_id or question.id,

            },

            "payload": {

                "mode": "similar_overwrite",

                "newContent": content,

                "legendImages": legend_images or [],

                "origin": origin_meta,

                "versionCount": version_count,

                "currentVersionIndex": 0,

                "versions": version_history,

                "solution": solution_payload,

                "ui": {

                    "shinyOverlay": True,

                    "answerModeReset": True,

                },

            },

        }

        return event



    def _handle_insert(

        self,

        *,

        plan: Dict[str, Any],

        tenant_id: int,

        document_id: int,

        run_id: str,

        latest_user_message: str,

        note_source: Optional[Dict[str, Any]] = None,

    ) -> List[Dict[str, Any]]:

        new_questions = plan.get("new_questions")

        if not isinstance(new_questions, list):

            logger.info("similar_tool.insert_missing_questions plan=%s", plan)

            return []



        # 判断当前文档是否已存在任何题目

        has_existing_questions = self.svc.has_any_question(

            tenant_id=tenant_id,

            document_id=document_id,

        )



        # 对于已有题目的试卷：

        #   - 必须通过 base_question_id 精确锚定一张卡片，

        #   - 明确约定“在该卡片内插入类似题”，

        #   - 禁止仅凭 target_sequence_index 猜测插入位置，以避免串卡/错挂。

        # 对于完全空白的试卷：

        #   - 允许不提供 base_question_id，直接按新卡片顺序插入，

        #   - 此时 group_id 由 insert_question 自行回填为新题 id。



        raw_base_id = plan.get("base_question_id")

        after_index: Optional[int] = None

        base_group_id: Optional[int] = None

        base_question_id: Optional[int] = None



        if has_existing_questions:

            if isinstance(raw_base_id, int):

                try:

                    base_q = self.svc.get_question_by_id(

                        tenant_id=tenant_id,

                        document_id=document_id,

                        question_id=raw_base_id,

                    )

                    base_question_id = base_q.id

                    base_group_id = base_q.group_id or base_q.id

                    # 插入位置默认紧跟在原题之后

                    after_index = base_q.sequence_index

                except HTTPException as exc:

                    logger.info(

                        "similar_tool.insert_base_id_not_found id=%s error=%s", raw_base_id, exc.detail

                    )



            # 在非空试卷上，如果仍然无法解析出稳定的 base_question_id，则整条插入计划作废，

            # 避免误把类似题挂到错误的卡片上。

            if base_group_id is None:

                logger.info(

                    "similar_tool.insert_skip_without_base tenant=%s document=%s plan=%s",

                    tenant_id,

                    document_id,

                    plan,

                )

                return []

        else:

            # 空白试卷：允许不指定 base，允许通过 target_sequence_index 控制插入位置，

            # 但不做分组锚定，交由 insert_question 自动为新题生成独立卡片。

            if plan.get("target_sequence_index") is not None:

                try:

                    after_index = int(plan["target_sequence_index"])

                except (TypeError, ValueError):

                    after_index = None



        note_source_clean: Optional[Dict[str, Any]] = None

        if isinstance(note_source, dict) and note_source:

            note_source_clean = {

                key: note_source[key]

                for key in ("document_id", "file_id", "title", "block_index", "snippet", "pages", "block_range", "context")

                if key in note_source and note_source[key] is not None

            }



        events: List[Dict[str, Any]] = []

        current_after = after_index

        for item in new_questions[:3]:

            if not isinstance(item, dict) or not item.get("stem"):

                logger.info("similar_tool.insert_skip_invalid_item item=%s", item)

                continue

            content = _build_student_content_from_variant(item)

            if not content:

                logger.info("similar_tool.insert_empty_content_from_variant item=%s", item)

                continue

            legend_images = item.get("legend_images") if isinstance(item, dict) else None

            if legend_images is not None and not isinstance(legend_images, list):

                legend_images = []

            insert_origin = {

                "requestLabel": latest_user_message[:120],

                "agentRunId": run_id,

            }

            if base_question_id is not None:

                insert_origin["baseQuestionId"] = base_question_id

            question = self.svc.insert_question(

                tenant_id=tenant_id,

                document_id=document_id,

                content=content,

                legend_images=legend_images,

                page=None,

                after_sequence_index=current_after,

                group_id=base_group_id,

            )

            current_after = question.sequence_index

            version_history: List[dict] = []

            if note_source_clean:

                note_meta = dict(note_source_clean)

                note_meta["questionId"] = question.id

                note_meta["sequenceIndex"] = question.sequence_index

            else:

                note_meta = None

            solution_payload = _extract_solution_payload(item) or None

            events.append(

                {

                    "action": "question.insert",

                    "target": {

                        "questionId": question.id,

                        "sequenceIndex": question.sequence_index,

                        "groupId": question.group_id or question.id,

                    },

                    "payload": {

                        "mode": "from_content_no_overwrite",

                        "content": content,

                        "legendImages": legend_images or [],

                        "origin": insert_origin,

                        "versionCount": 1,

                        "currentVersionIndex": 0,

                        "versions": version_history,

                        "solution": solution_payload,

                        "ui": {

                            # 类似题插入：在 UI 上仍然需要突出提示

                            "shinyOverlay": True,

                            "answerModeReset": False,

                            # 告知前端该新题是基于哪一题生成的变体，便于在同一卡片内分页展示

                            "variantOfQuestionId": base_question_id,

                        },

                        "noteSource": note_meta,

                    },

                }

            )

        logger.info(

            "similar_tool.insert_success run_id=%s count=%s after_index=%s",

            run_id,

            len(events),

            after_index,

        )

        return events

