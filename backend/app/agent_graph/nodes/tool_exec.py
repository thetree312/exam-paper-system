from __future__ import annotations



import uuid

from typing import List



from ...db import SessionLocal

from ..helpers import _latest_user_snapshot_from_state, _trim_text

from ..runtime import logger

from ...services.agent_service import AgentService

from ...services.similar_question_tool import SimilarQuestionTool

from ..stream_registry import _get_stream_handler

from ..types import AgentState





def _summarize_events(events: List[dict]) -> List[str]:

    summaries: List[str] = []

    for ev in events:

        action = ev.get("action")

        payload = ev.get("payload") or {}

        target = ev.get("target") or {}

        seq = target.get("sequenceIndex")

        qid = target.get("questionId")

        locator = []

        if seq is not None:

            locator.append(f"sequence_index={seq}")

        if qid is not None:

            locator.append(f"question_id={qid}")

        label = "，".join(locator) or "未知题目"



        title_prefix = ""

        annotation: list[str] = []

        if action == "question.replace":

            title_prefix = "[题目替换]"

        elif action == "question.insert":

            title_prefix = "[题目插入]"



        if not title_prefix:

            continue



        solution = payload.get("solution") or {}

        if isinstance(solution, dict):

            final_answer = solution.get("finalAnswer") or solution.get("final_answer")

            analysis = solution.get("analysis")

            if isinstance(final_answer, str) and final_answer.strip():

                annotation.append(f"答案 {final_answer.strip()}")

            if isinstance(analysis, str) and analysis.strip():

                annotation.append(f"解析：{_trim_text(analysis, 120)}")

        if not annotation:

            content_snippet = (payload.get("content") or "").strip()

            if content_snippet:

                annotation.append(_trim_text(content_snippet, 80))



        summary_note = "｜".join(annotation) if annotation else "已生成新题"

        summaries.append(f"{title_prefix} {label}｜{summary_note}")

    return summaries





def _build_prompt_events(events: List[dict]) -> List[dict]:

    prompt_events: list[dict] = []

    for ev in events:

        if not isinstance(ev, dict):

            continue

        target = ev.get("target") or {}

        prompt_events.append(

            {

                "action": ev.get("action"),

                "question_id": target.get("questionId"),

                "sequence_index": target.get("sequenceIndex"),

                "group_id": target.get("groupId"),

            }

        )

    return prompt_events





def tool_exec_node(state: AgentState) -> AgentState:

    document_id = state.get("document_id")

    if not document_id:

        return state



    raw_plans = state.get("pending_tool_calls") or []

    plan_preview = []

    for idx, plan in enumerate(raw_plans[:2]):

        if isinstance(plan, dict):

            mode = plan.get("mode")

            target = plan.get("target_sequence_index") or plan.get("sequence_index")

            plan_preview.append({"idx": idx, "mode": mode, "target_seq": target})

    if not raw_plans:

        logger.info(

            "agent.graph.tool_exec.skip document_id=%s reason=no_pending_tool_calls",

            document_id,

        )

        new_state = dict(state)

        new_state["tool_error"] = None

        new_state["tool_error_detail"] = None

        return new_state



    logger.info(

        "agent.graph.tool_exec.enter document_id=%s raw_plan_count=%s plan_preview=%s batch_config=%s max_batch_hint=%s",

        document_id,

        len(raw_plans),

        plan_preview,

        state.get("batch_config_required"),

        state.get("batch_config"),

    )

    note_focus = state.get("note_focus")

    note_context_text = (state.get("note_context_text") or "").strip()

    note_payload: dict | None = None

    if note_focus or note_context_text:

        note_payload = {}

        if isinstance(note_focus, dict):

            note_payload.update(note_focus)

        if note_context_text:

            note_payload["context"] = note_context_text

    batch_cfg = state.get("batch_config")

    max_batch: int | None = None

    if isinstance(batch_cfg, dict):

        raw_count = batch_cfg.get("count")

        try:

            if raw_count is not None:

                max_batch = int(raw_count)

        except (TypeError, ValueError):  # noqa: BLE001

            max_batch = None

    if max_batch is not None:

        if max_batch < 1:

            max_batch = 1

        if max_batch > 5:

            max_batch = 5



    plans: list[dict] = []

    plan_errors: list[str] = []

    focus_seq = state.get("supervisor_focus_index")

    focus_qid = state.get("supervisor_focus_question_id")

    for idx, plan in enumerate(raw_plans):

        if not isinstance(plan, dict):

            plan_errors.append(f"plan[{idx}] 不是对象")

            continue

        plan_copy = dict(plan)

        mode = plan_copy.get("mode")

        if not isinstance(mode, str) or mode not in {"similar_overwrite", "from_content_no_overwrite"}:

            plan_errors.append(f"plan[{idx}] 缺少有效的 mode 字段")

            continue

        if (

            note_payload

            and plan_copy.get("mode") == "from_content_no_overwrite"

            and not isinstance(plan_copy.get("base_question_id"), int)

        ):

            plan_copy.setdefault("note_source", note_payload)



        if isinstance(focus_qid, int):

            plan_copy["base_question_id"] = focus_qid

        if isinstance(focus_seq, int):

            plan_copy["target_sequence_index"] = focus_seq



        if max_batch is not None and plan_copy.get("mode") == "from_content_no_overwrite":

            new_qs = plan_copy.get("new_questions")

            if isinstance(new_qs, list) and new_qs:

                plan_copy["new_questions"] = new_qs[:max_batch]



        if mode == "similar_overwrite":

            replacement = plan_copy.get("replacement_question")

            if not isinstance(replacement, dict):

                plan_errors.append(f"plan[{idx}] 缺少 replacement_question")

                continue

            if not str(replacement.get("stem") or "").strip():

                plan_errors.append(f"plan[{idx}] replacement_question.stem 为空")

                continue

        elif mode == "from_content_no_overwrite":

            new_qs = plan_copy.get("new_questions")

            if not isinstance(new_qs, list) or not new_qs:

                plan_errors.append(f"plan[{idx}] new_questions 为空")

                continue

            filtered_qs = []

            for q_idx, item in enumerate(new_qs):

                if not isinstance(item, dict):

                    plan_errors.append(f"plan[{idx}].new_questions[{q_idx}] 不是对象")

                    continue

                if not str(item.get("stem") or "").strip():

                    plan_errors.append(f"plan[{idx}].new_questions[{q_idx}] stem 为空")

                    continue

                filtered_qs.append(item)

            if not filtered_qs:

                plan_errors.append(f"plan[{idx}] new_questions 经过校验后为空")

                continue

            plan_copy["new_questions"] = filtered_qs



        plans.append(plan_copy)

    if not plans:

        logger.warning(

            "agent.graph.tool_exec.no_valid_plans raw_plan_count=%s errors=%s",

            len(raw_plans),

            "; ".join(plan_errors)[:600] if plan_errors else "无",

        )

        new_state = dict(state)

        new_state["tool_error"] = "invalid_tool_plan"

        detail = "; ".join(plan_errors) if plan_errors else "solver 未提供可执行的计划"

        new_state["tool_error_detail"] = detail

        new_state["tool_retry_count"] = (state.get("tool_retry_count") or 0) + 1

        return new_state



    logger.info(

        "agent.graph.tool_exec.valid_plans document_id=%s count=%s modes=%s",

        document_id,

        len(plans),

        [p.get("mode") for p in plans],

    )

    run_id = state.get("run_id") or uuid.uuid4().hex



    events: list[dict]

    db = SessionLocal()

    error_detail: str | None = None

    try:

        svc = AgentService(db)

        tool = SimilarQuestionTool(svc)

        events = tool.execute_plans(

            plans=plans,

            tenant_id=state["tenant_id"],

            document_id=document_id,

            run_id=run_id,

            request_label=_latest_user_snapshot_from_state(state),

        )

    except Exception as exc:  # noqa: BLE001

        logger.exception("tool_exec_node.failed tenant=%s user=%s", state.get("tenant_id"), state.get("user_id"))

        events = []

        error_msg = f"tool_execution_failed: {exc}"

        error_detail = str(exc)

    finally:

        db.close()



    logger.info(

        "agent.graph.tool_exec.events document_id=%s event_count=%s events=%s",

        document_id,

        len(events),

        events,

    )



    updated_snapshot = [dict(q) for q in (state.get("snapshot_questions") or []) if isinstance(q, dict)]

    latest_replaced = state.get("latest_replaced_question")

    for event in events:

        action = event.get("action")

        target = event.get("target") or {}

        payload = event.get("payload") or {}

        seq = target.get("sequenceIndex")

        if action == "question.replace" and seq is not None and 0 <= seq < len(updated_snapshot):

            content = payload.get("newContent")

            versions = payload.get("versions")

            if content:

                try:

                    item = updated_snapshot[seq]

                    if isinstance(item, dict):

                        item["content"] = content

                        if versions is not None:

                            item["versions"] = versions

                except Exception:  # noqa: BLE001

                    logger.warning("tool_exec.snapshot_update_failed seq=%s", seq)

            latest_replaced = {

                "question_id": target.get("questionId"),

                "sequence_index": seq,

                "content": content,

            }

        elif action == "question.insert":

            content = payload.get("content")

            if content:

                versions = payload.get("versions")

                insert_index = (

                    seq + 1 if isinstance(seq, int) and 0 <= seq < len(updated_snapshot) else len(updated_snapshot)

                )

                updated_snapshot.insert(

                    insert_index,

                    {

                        "sequence_index": insert_index,

                        "page": None,

                        "content": content,

                        "versions": versions if versions is not None else [],

                    },

                )



    summaries = _summarize_events(events)

    prompt_events = _build_prompt_events(events)

    if summaries:

        logger.info(

            "agent.graph.tool_exec.summaries document_id=%s summaries=%s",

            document_id,

            summaries,

        )

    handler = _get_stream_handler(state)

    if handler:

        for event in events:

            handler({"type": "ag_ui", "event": event})



    new_state = dict(state)

    new_state["ag_ui_events"] = events

    new_state["ag_ui_prompt_events"] = prompt_events

    new_state["tool_summaries"] = summaries

    new_state["snapshot_questions"] = updated_snapshot

    new_state["latest_replaced_question"] = latest_replaced

    new_state["pending_tool_calls"] = []

    new_state["run_id"] = run_id

    # 批量出题配置属于一次性上下文，执行完成后必须清空，避免后续
    # 回合在没有用户授权的情况下继续沿用旧配置触发工具。
    new_state["batch_config"] = None
    new_state["batch_config_required"] = False
    new_state["batch_config_missing_fields"] = []
    new_state["batch_config_reason"] = None
    new_state["supervisor_expected_new_questions"] = 0
    new_state["supervisor_allow_tools"] = False

    if events:

        new_state["tool_error"] = None

        new_state["tool_error_detail"] = None

    else:

        if "error_msg" in locals():

            new_state["tool_error"] = error_msg

        else:

            new_state["tool_error"] = "tool_no_effect"

        detail = error_detail or "; ".join(plan_errors) if plan_errors else None

        if not detail:

            detail = "SimilarQuestionTool 未生成任何事件，可能是 replacement_question 或 new_questions 不符合结构化要求。"

        new_state["tool_error_detail"] = detail

        new_state["tool_retry_count"] = (state.get("tool_retry_count") or 0) + 1

    return new_state





__all__ = ["tool_exec_node"]

