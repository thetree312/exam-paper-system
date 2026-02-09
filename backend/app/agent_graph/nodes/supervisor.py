from __future__ import annotations



import json

import re

import time

from typing import List



from ..helpers import _append_token_usage_event, _trim_text

from ..prompt_slots import _dialogue_window_snippet, _latest_user_from_dialogue, _session_state_view

from ..runtime import SKILL_MANAGER, logger

from ...services.qwen_client import QwenClient

from ..stream_registry import _get_stream_handler

from ..types import AgentState, _build_default_intent





def supervisor_node(state: AgentState) -> AgentState:

    if state.get("skip_model"):

        return state



    doc_ctx = state.get("doc_context") or ""

    new_state = dict(state)



    dialogue_snippet = _dialogue_window_snippet(new_state.get("dialogue_window"))

    history_summary = new_state.get("history_summary") or ""

    session_view = _session_state_view(new_state, "supervisor")

    intent_context = {

        "doc_context": doc_ctx or "（当前未注入题干）",

        "batch_config": state.get("batch_config") or {},

        "history_summary": history_summary,

        "session_state_view": session_view,

    }



    logger.info(

        "agent.graph.supervisor.intent_context tenant=%s user=%s intent_context=%s dialogue_snippet=%s",

        state.get("tenant_id"),

        state.get("user_id"),

        intent_context,

        dialogue_snippet,

    )



    plan_raw, plan_usage = SKILL_MANAGER.run_inference(

        agent="supervisor",

        name="supervisor_router",

        context=intent_context,

        conversation_snippet=dialogue_snippet,

        client_factory=QwenClient,

    )



    plan: dict = plan_raw if isinstance(plan_raw, dict) else {}

    last_user = _latest_user_from_dialogue(state.get("dialogue_window") or []) or ""

    try:

        plan_json = json.dumps(plan, ensure_ascii=False)

    except (TypeError, ValueError):

        plan_json = str(plan)



    logger.info(

        "agent.graph.supervisor.raw_plan plan=%s last_user=%s plan_usage=%s",

        plan_json,

        last_user or "",

        plan_usage,

    )



    solver_instruction = plan.get("solver_instruction") or last_user or "请结合试卷快照和对话内容，帮助用户完成当前任务。"

    reply_outline = plan.get("reply_outline")

    focus_idx = plan.get("focus_sequence_index")

    try:

        focus_idx = int(focus_idx) if focus_idx is not None else None

    except (TypeError, ValueError):

        focus_idx = None



    if focus_idx is None:

        q_ctx_list = state.get("question_contexts") or []

        if isinstance(q_ctx_list, list) and len(q_ctx_list) == 1:

            only_ctx = q_ctx_list[0]

            if isinstance(only_ctx, dict):

                seq_val = only_ctx.get("sequence_index")

                try:

                    focus_idx = int(seq_val) if seq_val is not None else None

                except (TypeError, ValueError):

                    focus_idx = None



    if focus_idx is None and last_user:

        match = re.search(r"@题目(\d+)", last_user)

        if match:

            try:

                focus_idx = int(match.group(1)) - 1

            except (TypeError, ValueError):

                focus_idx = None



    require_vision = bool(plan.get("require_vision", False))

    focus_vision_list = state.get("vision_focus_questions") or []

    if focus_vision_list:

        if not require_vision:

            logger.info(

                "agent.graph.supervisor auto_require_vision tenant=%s user=%s question_ids=%s",

                state.get("tenant_id"),

                state.get("user_id"),

                [ctx.get("question_id") for ctx in focus_vision_list if isinstance(ctx, dict)],

            )

        require_vision = True



    expected_new_questions_raw = plan.get("expected_new_question_count")

    expected_new_questions: int | None = None

    try:

        if expected_new_questions_raw is not None:

            expected_new_questions = int(expected_new_questions_raw)

    except (TypeError, ValueError):

        expected_new_questions = None



    plan_needs_practice = bool(plan.get("needs_practice"))

    raw_flag = plan.get("similar_question_tool_needed")

    if raw_flag is not None:

        supervisor_allow_tools = bool(raw_flag)

    else:

        if plan_needs_practice and (

            not isinstance(expected_new_questions, int) or expected_new_questions > 0

        ):

            supervisor_allow_tools = True

        else:

            supervisor_allow_tools = False



    direct_reply_flag = bool(plan.get("direct_reply", False))

    direct_reply_message = plan.get("direct_reply_message")

    if not isinstance(direct_reply_message, str):

        direct_reply_message = None



    supervisor_payload = {

        "solver_instruction": solver_instruction,

        "reply_outline": reply_outline,

        "focus_sequence_index": focus_idx,

        "require_vision": require_vision,

        "context_notes": plan.get("context_notes"),

        "expected_new_question_count": expected_new_questions,

        "direct_reply": direct_reply_flag,

        "direct_reply_message": direct_reply_message,

    }



    intent_raw = plan.get("task_intent") if isinstance(plan.get("task_intent"), dict) else None

    intent_payload = _build_default_intent(intent_raw)

    if plan_needs_practice:

        intent_payload["needs_practice"] = True

        if "practice" not in intent_payload.get("task_type", []):

            intent_payload.setdefault("task_type", []).append("practice")

    needs_grading = bool(plan.get("needs_grading"))

    if needs_grading:

        intent_payload["needs_grading"] = True

        if "grading" not in intent_payload.get("task_type", []):

            intent_payload.setdefault("task_type", []).append("grading")

    needs_followup = bool(plan.get("needs_followup"))

    if needs_followup:

        intent_payload["needs_followup"] = True

    primary_questions = plan.get("primary_questions")

    if isinstance(primary_questions, list) and primary_questions:

        intent_payload["primary_questions"] = primary_questions

    intent_notes = plan.get("intent_notes")

    if isinstance(intent_notes, str):

        intent_payload["notes"] = intent_notes[:120]



    supervisor_text = json.dumps(supervisor_payload, ensure_ascii=False)



    focus_qid = None

    if focus_idx is not None:

        q_ctx_list = state.get("question_contexts") or []

        if isinstance(q_ctx_list, list):

            for ctx in q_ctx_list:

                if not isinstance(ctx, dict):

                    continue

                seq_val = ctx.get("sequence_index")

                try:

                    seq_int = int(seq_val) if seq_val is not None else None

                except (TypeError, ValueError):

                    seq_int = None

                if seq_int != focus_idx:

                    continue

                qid_val = ctx.get("question_id")

                if isinstance(qid_val, int):

                    focus_qid = qid_val

                    break



    if focus_qid is None and focus_idx is not None:

        questions = state.get("snapshot_questions") or []

        for q in questions:

            if not isinstance(q, dict):

                continue

            if q.get("sequence_index") != focus_idx:

                continue

            focus_qid = q.get("id")

            break



    batch_required_flag = bool(plan.get("batch_config_required") or plan.get("need_batch_config"))

    missing_fields = plan.get("batch_config_missing_fields")

    if not isinstance(missing_fields, list):

        missing_fields = []

    missing_fields = [str(f) for f in missing_fields if isinstance(f, (str, int))]

    reason = plan.get("batch_config_reason")

    if not isinstance(reason, str):

        reason = None



    logger.info(

        (

            "agent.graph.supervisor directive=%s focus_seq=%s focus_qid=%s outline=%s "

            "require_vision=%s expected_new_q=%s batch_required=%s missing_fields=%s reason=%s"

        ),

        supervisor_payload.get("solver_instruction"),

        focus_idx,

        focus_qid,

        supervisor_payload.get("reply_outline"),

        require_vision,

        expected_new_questions,

        batch_required_flag,

        missing_fields,

        reason,

    )



    new_state["batch_config_missing_fields"] = missing_fields

    new_state["batch_config_reason"] = reason

    new_state["supervisor_directive"] = supervisor_payload.get("solver_instruction")

    new_state["supervisor_focus_index"] = focus_idx

    new_state["supervisor_payload"] = supervisor_payload

    new_state["supervisor_focus_question_id"] = focus_qid

    new_state.setdefault("pending_tool_calls", [])

    new_state["solver_reply_outline"] = supervisor_payload.get("reply_outline")

    new_state["batch_config_required"] = batch_required_flag

    new_state["supervisor_allow_tools"] = supervisor_allow_tools

    new_state["supervisor_expected_new_questions"] = expected_new_questions

    new_state["task_intent"] = intent_payload



    anchors = new_state.get("session_anchors")

    if not isinstance(anchors, list):

        anchors = []



    tenant_id = state.get("tenant_id")

    document_id = state.get("document_id")

    updated_entity_ids: list[str] = []



    def _upsert_question_anchor(question_id: int | None, sequence_index: int | None) -> None:

        if not isinstance(question_id, int):

            return

        anchor_id = f"question:{tenant_id}:{document_id}:{question_id}"

        payload = {

            "id": anchor_id,

            "type": "question",

            "question_id": question_id,

            "document_id": document_id,

            "sequence_index": sequence_index,

            "last_active_ts": time.time(),

        }

        for idx, item in enumerate(anchors):

            if not isinstance(item, dict):

                continue

            if item.get("id") == anchor_id:

                merged = dict(item)

                merged.update(payload)

                anchors[idx] = merged

                break

        else:

            anchors.append(payload)

        updated_entity_ids.append(anchor_id)



    if focus_qid is not None:

        _upsert_question_anchor(focus_qid, focus_idx)



    q_ctx_list = state.get("question_contexts") or []

    if isinstance(q_ctx_list, list):

        for ctx in q_ctx_list:

            if not isinstance(ctx, dict):

                continue

            qid_val = ctx.get("question_id")

            seq_val = ctx.get("sequence_index")

            if isinstance(qid_val, int):

                _upsert_question_anchor(qid_val, seq_val if isinstance(seq_val, int) else None)



    new_state["session_anchors"] = anchors

    if updated_entity_ids:

        new_state["active_entities"] = updated_entity_ids



    session_state = new_state.get("session_state")

    if not isinstance(session_state, dict):

        session_state = {}

    merged_session_state = dict(session_state)

    merged_session_state["session_anchors"] = anchors

    new_state["session_state"] = merged_session_state



    handler = _get_stream_handler(state)

    logger.info(

        "agent.graph.batch_config.trigger missing_fields=%s reason=%s",

        missing_fields,

        reason,

    )

    if handler:

        handler(

            {

                "type": "debug",

                "role": "system",

                "delta": f"\n\n【Supervisor 指令】\n{supervisor_text}",

            }

        )



    if isinstance(plan_usage, int):

        new_state = _append_token_usage_event(

            new_state,

            node="supervisor.intent",

            model=None,

            usage=plan_usage,

            meta={"skill": "supervisor_router"},

        )



    return new_state





__all__ = ["supervisor_node"]

