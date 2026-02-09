from __future__ import annotations



import json

import time

from typing import Any, List



from ..helpers import _append_token_usage_event, _latest_user_snapshot_from_state, _safe_json_loads, _trim_text

from ..prompt_slots import _build_slot_prompt

from ..prompts import get_solver_base_prompt

from ..runtime import SKILL_MANAGER, logger

from ...services.qwen_client import QwenClient

from ..stream_registry import _get_stream_handler

from ..token_utils import HARD_TOKEN_LIMIT, _estimate_tokens_for_messages

from ..types import AgentMessageEntry, AgentState, _build_default_intent, _normalize_skill_tags

from .solver_context import prepare_solver_context_bundle





MAX_SOLVER_TOOL_FEEDBACK = 1


def _coerce_int_value(value: Any) -> int | None:
    """Convert numeric strings to int, otherwise return None."""

    if isinstance(value, int):
        return value
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        try:
            return int(value)
        except ValueError:
            return None
    try:
        return int(value)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        return None


def _normalize_tool_plan_numeric_fields(plan: dict) -> None:
    """Ensure critical numeric fields are ints before downstream processing."""

    for key in ("base_question_id", "target_sequence_index", "sequence_index"):
        if key in plan:
            coerced = _coerce_int_value(plan.get(key))
            if coerced is not None:
                plan[key] = coerced
            else:
                plan.pop(key, None)





def solver_node(state: AgentState) -> AgentState:

    if state.get("skip_model"):

        return state



    client = QwenClient()

    bundle = state.get("solver_context_bundle")

    if not isinstance(bundle, dict):

        bundle = prepare_solver_context_bundle(state)



    doc_ctx_raw = bundle.get("doc_context_raw") or state.get("doc_context") or ""

    doc_ctx_text = bundle.get("doc_context_text") or doc_ctx_raw or "（当前未注入题干）"

    history_summary = bundle.get("history_summary_text") or state.get("history_summary") or ""

    dialogue_snippet = bundle.get("dialogue_snippet") or ""

    intent_context = dict(bundle.get("intent_context") or {})



    base_intent = _build_default_intent(

        state.get("task_intent") if isinstance(state.get("task_intent"), dict) else None

    )

    task_types = base_intent.get("task_type")

    if not isinstance(task_types, list) or not task_types:

        task_types = ["explain"]

        base_intent["task_type"] = task_types



    skill_tags = _normalize_skill_tags(task_types)

    if base_intent.get("needs_practice"):

        skill_tags.add("practice")

    if base_intent.get("needs_grading"):

        skill_tags.add("grading")

    if base_intent.get("needs_followup"):

        skill_tags.add("needs_confirmation")



    session_view_json = bundle.get("intent_session_view_json") or json.dumps(intent_context.get("session_profile") or {}, ensure_ascii=False)

    primary_questions = base_intent.get("primary_questions") or []

    primary_label = ", ".join(str(item) for item in primary_questions) or "未指定"

    batch_cfg = state.get("batch_config") if state.get("batch_config_required") else None

    instruction_ctx = dict(bundle.get("instruction_base") or {})

    instruction_ctx.setdefault("doc_context", doc_ctx_text)

    instruction_ctx.setdefault("vision_summary", bundle.get("vision_summary_text") or "（无视觉摘要）")

    instruction_ctx["primary_questions"] = primary_label

    if isinstance(batch_cfg, dict) and batch_cfg:

        instruction_ctx["batch_config"] = json.dumps(batch_cfg, ensure_ascii=False)

    instruction_ctx.setdefault("history_summary", history_summary)

    instruction_ctx.setdefault("session_profile", session_view_json)

    instruction_ctx.setdefault("session_state_view", session_view_json)



    # 渐进式披露：默认只注入各技能的短摘要，避免在每轮对话中反复携带完整长模板。

    active_skills, skill_messages = SKILL_MANAGER.render_instructions(

        agent="solver",

        tags=list(skill_tags),

        context=instruction_ctx,

        mode="summary",

    )



    # 仅当 Supervisor 明确允许、批量配置就绪且预计新增题量 > 0 时才准备工具

    expected_new_questions = state.get("supervisor_expected_new_questions")

    supervisor_allow_tools = bool(state.get("supervisor_allow_tools"))

    batch_required = bool(state.get("batch_config_required"))

    batch_cfg_ready = state.get("batch_config") if batch_required else None

    ready_for_tools = (not batch_required) or (isinstance(batch_cfg_ready, dict) and bool(batch_cfg_ready))



    allow_tools = False

    if supervisor_allow_tools and ready_for_tools and base_intent.get("needs_practice"):

        if isinstance(expected_new_questions, int) and expected_new_questions > 0:

            allow_tools = True



    # practice 技能的完整文档只在允许工具时注入，避免纯讲解轮携带 schema

    if allow_tools:

        practice_full = SKILL_MANAGER.render_instruction_by_name(

            agent="solver",

            name="solver_practice_structured",

            context=instruction_ctx,

            mode="full",

        )

        if practice_full:

            skill_messages.append({"role": "system", "content": practice_full})

            if "solver_practice_structured" not in active_skills:

                active_skills.append("solver_practice_structured")



    slot_payload: dict[str, List[str | AgentMessageEntry]] = {}

    if skill_messages:

        slot_payload["skill_instruction"] = list(skill_messages)

    logger.info(

        "agent.graph.solver.slot_payload tenant=%s user=%s payload=%s",

        state.get("tenant_id"),

        state.get("user_id"),

        slot_payload,

    )



    tool_error = state.get("tool_error")

    tool_error_detail = state.get("tool_error_detail")

    tool_retries = state.get("tool_retry_count") or 0

    if tool_error:

        detail_text = f" 详细信息：{tool_error_detail}" if tool_error_detail else ""

        slot_payload.setdefault("tool_feedback", []).append(

            {

                "role": "system",

                "content": (

                    "【工具执行反馈】上一轮 SimilarQuestionTool 执行失败，"

                    f"原因：{tool_error}。{detail_text}这是第 {tool_retries} 次尝试，请根据该错误信息调整你的工具调用计划，"

                    "必要时可以选择不再调用该工具，仅给出解释或替代性方案。"

                ),

            }

        )



    if isinstance(batch_cfg, dict) and batch_cfg:

        bits: List[str] = ["【批量出题配置】"]

        count = batch_cfg.get("count")

        difficulty = batch_cfg.get("difficulty")

        similarity = batch_cfg.get("similarity")

        if count is not None:

            bits.append(f"- 题目数量：{count} 道（请尽量严格按此数量生成，不要超出卡片容量上限）")

        if difficulty:

            bits.append(f"- 难度偏好：{difficulty}")

        if similarity:

            bits.append(f"- 与原题相似度：{similarity}")

        bits.append("请在规划和调用 SimilarQuestionTool 时严格遵守上述约束，不要随意更改题目数量或难度等级。")

        slot_payload.setdefault("batch_config", []).append({"role": "system", "content": "\n".join(bits)})



    expected_new = state.get("supervisor_expected_new_questions")

    if isinstance(expected_new, int) and expected_new > 0:

        slot_payload.setdefault("expected_new_questions", []).append(

            {

                "role": "system",

                "content": (

                    f"【Supervisor 预估本轮新增练习题数量】当前规划预计新增约 {expected_new} 道练习题。"

                    "当你需要调用 SimilarQuestionTool 生成练习时，请以此数量为主要参考，不要显著超出。"

                ),

            }

        )



    note_focus_meta = state.get("note_focus")

    note_context_text = state.get("note_context_text")

    if note_focus_meta or note_context_text:

        lines: List[str] = ["【笔记/文档上下文】"]

        if note_focus_meta:

            meta_bits: List[str] = []

            if note_focus_meta.get("title"):

                meta_bits.append(f"来源：{note_focus_meta['title']}")

            if note_focus_meta.get("document_id"):

                meta_bits.append(f"document_id={note_focus_meta['document_id']}")

            if note_focus_meta.get("file_id"):

                meta_bits.append(f"file_id={note_focus_meta['file_id']}")

            if note_focus_meta.get("pages"):

                meta_bits.append(f"页码范围：{note_focus_meta['pages']}")

            if note_focus_meta.get("block_range"):

                meta_bits.append(f"区块索引：{note_focus_meta['block_range']}")

            if meta_bits:

                lines.append("；".join(meta_bits))

            snippet = note_focus_meta.get("snippet")

            if snippet:

                lines.append(f"用户高亮片段：{snippet}")

        if note_context_text:

            lines.append("扩展上下文：")

            lines.append(note_context_text.strip())

        lines.append(

            "上述文本可能不属于现有题库，请基于其含义解释、出题或生成练习。"

            "如果需要生成新的练习题，务必引用该上下文的概念与细节。"

        )

        slot_payload.setdefault("note_context", []).append({"role": "system", "content": "\n".join(lines)})



    supervisor_instruction = state.get("supervisor_directive")

    if supervisor_instruction:

        slot_payload.setdefault("supervisor_instruction", []).append(

            {"role": "system", "content": f"Supervisor 指令：{supervisor_instruction}"}

        )

    if state.get("solver_reply_outline"):

        slot_payload.setdefault("reply_outline", []).append(

            {"role": "system", "content": f"请遵循以下提纲：\n{state['solver_reply_outline']}"}

        )

    focus_sequence_index = state.get("supervisor_focus_index")

    focus_question_id = state.get("supervisor_focus_question_id")

    if focus_sequence_index is not None:

        if focus_question_id is not None:

            focus_text = (

                f"重点关注 sequence_index={focus_sequence_index}, question_id={focus_question_id} 的题目。"

                "如果你调用 SimilarQuestionTool 生成类似题，必须仅基于这道题，且在 TOOL_CALL JSON 中显式填写 "

                f'"base_question_id": {focus_question_id} 和 "target_sequence_index": {focus_sequence_index}。'

            )

        else:

            focus_text = f"重点关注 sequence_index={focus_sequence_index} 的题目。"

        slot_payload.setdefault("focus_instruction", []).append({"role": "system", "content": focus_text})



    state_for_prompt = dict(state)

    state_for_prompt["doc_context"] = doc_ctx_raw

    base_prompt = get_solver_base_prompt(state.get("preferred_language"))

    messages = _build_slot_prompt(

        state=state_for_prompt,

        node_name="solver",

        instruction=base_prompt,

        slot_payload=slot_payload,

        token_limit=min(HARD_TOKEN_LIMIT, 8000),

    )

    logger.info(

        "agent.graph.solver.messages tenant=%s user=%s messages=%s",

        state.get("tenant_id"),

        state.get("user_id"),

        messages,

    )



    expected_new_questions = state.get("supervisor_expected_new_questions")

    supervisor_allow_tools = bool(state.get("supervisor_allow_tools"))

    batch_required = bool(state.get("batch_config_required"))

    batch_cfg_ready = state.get("batch_config") if batch_required else None

    ready_for_tools = (not batch_required) or (isinstance(batch_cfg_ready, dict) and bool(batch_cfg_ready))



    allow_tools = False

    if supervisor_allow_tools and ready_for_tools and base_intent.get("needs_practice"):

        if isinstance(expected_new_questions, int) and expected_new_questions > 0:

            allow_tools = True

    logger.info(

        "agent.graph.solver.tool_gate tenant=%s user=%s supervisor_allow=%s ready_for_tools=%s "

        "needs_practice=%s expected_new=%s allow_tools=%s batch_required=%s batch_ready=%s",

        state.get("tenant_id"),

        state.get("user_id"),

        supervisor_allow_tools,

        ready_for_tools,

        base_intent.get("needs_practice"),

        expected_new_questions,

        allow_tools,

        batch_required,

        bool(batch_cfg_ready),

    )



    tool_calls: List[dict] = []

    reply: str = ""

    tools: List[dict] = []

    if allow_tools:

        tools = [
            {
                "type": "function",
                "function": {
                    "name": "similar_question_planner",
                    "description": (
                        "规划如何调用 SimilarQuestionTool 来改写或插入题目，"
                        " 并严格遵守题量、题型、难度与相似度等批量配置。"
                        " 当需要生成类似题或批量练习时，请调用本工具并在 plans 数组中给出计划。"
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "plans": {
                                "type": "array",
                                "description": "要执行的题目修改/插入计划列表。",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "mode": {
                                            "type": "string",
                                            "enum": [
                                                "similar_overwrite",
                                                "from_content_no_overwrite",
                                            ],
                                            "description": "题目改写模式。",
                                        },
                                        "question_type": {
                                            "type": "string",
                                            "description": "当批量配置给出题型时，必须与之完全一致，例如 填空题/单选题。",
                                        },
                                        "difficulty": {
                                            "type": "string",
                                            "description": "题目难度标签（easy/medium/hard 等）。",
                                        },
                                        "similarity": {
                                            "type": "string",
                                            "description": "与原题的相似度偏好（high/medium/low）。",
                                        },
                                        "new_questions": {
                                            "type": "array",
                                            "description": "当 mode 为 from_content_no_overwrite 时新增的题目列表。",
                                        },
                                    },
                                },
                            }
                        },
                        "required": ["plans"],
                    },
                },
            }
        ]



    def _invoke_solver_llm(

        prompt_messages: List[AgentMessageEntry],

        *,

        tool_handler,

        tag: str,

        enable_stream: bool,

    ) -> tuple[str, List[dict], int | None, bool]:

        reply_local: str = ""

        tool_calls_local: List[dict] = []

        usage_local: int | None = None

        estimated_tokens = _estimate_tokens_for_messages(

            [

                {"role": m.get("role"), "content": m.get("content")}

                if isinstance(m, dict)

                else m

                for m in prompt_messages

            ]

        )

        if estimated_tokens > HARD_TOKEN_LIMIT:

            logger.warning(

                "agent.graph.solver.context_over_hard_limit tenant=%s user=%s estimated_tokens=%s hard_limit=%s tag=%s",

                state.get("tenant_id"),

                state.get("user_id"),

                estimated_tokens,

                HARD_TOKEN_LIMIT,

                tag,

            )

        logger.info(

            "agent.graph.solver.llm_start tenant=%s user=%s use_tools=%s message_count=%s tag=%s",

            state.get("tenant_id"),

            state.get("user_id"),

            bool(tools),

            len(prompt_messages),

            tag,

        )

        stream_started_local = False

        llm_start_ts_local = time.time()

        try:

            if tools:

                stream, result = client.chat_with_tools_stream(

                    prompt_messages,

                    tools=tools,

                    tool_choice={"type": "function", "function": {"name": "similar_question_planner"}},

                )



                for delta in stream:

                    if not stream_started_local:

                        stream_started_local = True

                        logger.info(

                            "agent.graph.solver.llm_first_delta tenant=%s user=%s use_tools=%s tag=%s",

                            state.get("tenant_id"),

                            state.get("user_id"),

                            True,

                            tag,

                        )

                    if delta and enable_stream and tool_handler:

                        tool_handler({"type": "delta", "role": "assistant", "delta": delta})

                    if delta:

                        logger.debug(

                            "agent.graph.solver.plan_delta tenant=%s user=%s snippet=%s tag=%s",

                            state.get("tenant_id"),

                            state.get("user_id"),

                            _trim_text(str(delta), 120),

                            tag,

                        )



                reply_parts = result.get("content_parts") or []

                if isinstance(reply_parts, list):

                    reply_local = "".join(str(p) for p in reply_parts)



                raw_tool_calls = result.get("tool_calls") or []

                if isinstance(raw_tool_calls, list):

                    for tc in raw_tool_calls:

                        if not isinstance(tc, dict):

                            continue

                        fn = tc.get("function") or {}

                        if fn.get("name") != "similar_question_planner":

                            continue

                        args_raw = fn.get("arguments") or "{}"

                        args = _safe_json_loads(str(args_raw))

                        plans_val = args.get("plans") if isinstance(args, dict) else None

                        if isinstance(plans_val, list):

                            for plan in plans_val:

                                if isinstance(plan, dict):

                                    _normalize_tool_plan_numeric_fields(plan)

                                    tool_calls_local.append(plan)



                usage_local = (result or {}).get("usage")  # type: ignore[name-defined]

            else:
                logger.info(
                    "agent.graph.solver.skip_llm_no_tools tenant=%s user=%s needs_practice=%s tag=%s",
                    state.get("tenant_id"),
                    state.get("user_id"),
                    base_intent.get("needs_practice"),
                    tag,
                )

        except Exception as exc:  # noqa: BLE001

            logger.exception(

                "solver_node.failed tenant=%s user=%s tag=%s",

                state.get("tenant_id"),

                state.get("user_id"),

                tag,

            )

            reply_local = f"Agent 内部错误：{exc}"

            tool_calls_local = []

        finally:

            llm_duration_local = time.time() - llm_start_ts_local

            logger.info(

                "agent.graph.solver.llm_done tenant=%s user=%s use_tools=%s first_delta=%s duration_ms=%.2f tag=%s",

                state.get("tenant_id"),

                state.get("user_id"),

                bool(tools),

                stream_started_local,

                llm_duration_local * 1000,

                tag,

            )

        return reply_local, tool_calls_local, usage_local, bool(tools)



    handler = _get_stream_handler(state)

    reply, tool_calls, plan_usage, _ = _invoke_solver_llm(

        messages,

        tool_handler=handler,

        tag="initial",

        enable_stream=True,

    )



    if not (reply or "").strip() and not tool_calls and allow_tools:

        logger.error(

            "agent.graph.solver empty_reply_and_no_tool_calls tenant=%s user=%s use_tools=%s",

            state.get("tenant_id"),

            state.get("user_id"),

            bool(tools),

        )



    supervisor_directive = state.get("supervisor_directive") or ""

    reply_preview = _trim_text(reply, 200)

    latest_user_snapshot = _trim_text(_latest_user_snapshot_from_state(state), 160)

    logger.info(

        "agent.graph.solver plan_has_tool_calls=%s tool_call_count=%s supervisor_directive=%s latest_user=%s reply_preview=%s active_skills=%s task_intent=%s",

        bool(tool_calls),

        len(tool_calls),

        _trim_text(supervisor_directive, 160),

        latest_user_snapshot,

        reply_preview,

        active_skills,

        base_intent,

    )

    if not tool_calls and allow_tools:

        logger.info(

            "agent.graph.solver tool_calls_empty allow_tools=True reason=no_valid_plan pending_tool_calls=%s",

            state.get("pending_tool_calls"),

        )



    new_state = dict(state)

    if not tool_calls and allow_tools:

        feedback_count = state.get("solver_tool_feedback_count") or 0

        if feedback_count < MAX_SOLVER_TOOL_FEEDBACK:

            feedback_messages = list(messages)

            feedback_reason = "missing_tool_call"

            feedback_messages.append(

                {

                    "role": "system",

                    "content": (

                        "⚠️ 你刚才的回复没有包含任何 similar_question_planner 的 tool_calls。"

                        " 请立即按照要求输出包含 `plans` 数组的 JSON；如果确实不需要出题，请明确说明原因。"

                    ),

                }

            )

            if reply:

                feedback_messages.append({"role": "assistant", "content": reply})

            if tool_calls:

                feedback_messages.append(

                    {

                        "role": "tool",

                        "name": "similar_question_planner",

                        "content": "工具执行失败：未收到计划，请返回正确的 JSON。",

                    }

                )

            logger.warning(

                "agent.graph.solver.feedback_start tenant=%s user=%s count=%s reason=%s",

                state.get("tenant_id"),

                state.get("user_id"),

                feedback_count,

                feedback_reason,

            )

            retry_reply, retry_tool_calls, retry_usage, _ = _invoke_solver_llm(

                feedback_messages,

                tool_handler=None,

                tag="feedback",

                enable_stream=False,

            )

            if retry_tool_calls:

                logger.info(

                    "agent.graph.solver.feedback_resolved tenant=%s user=%s plans=%s",

                    state.get("tenant_id"),

                    state.get("user_id"),

                    len(retry_tool_calls),

                )

                reply = retry_reply or reply

                tool_calls = retry_tool_calls

                plan_usage = retry_usage or plan_usage

                state_retry_count = feedback_count + 1

            else:

                logger.warning(

                    "agent.graph.solver.feedback_abandon tenant=%s user=%s",

                    state.get("tenant_id"),

                    state.get("user_id"),

                )

                state_retry_count = feedback_count + 1

                new_state_feedback_reason = "empty_tool_call_after_feedback"

                state_retry_reason = new_state_feedback_reason

            new_state = dict(state)

            new_state["solver_tool_feedback_count"] = feedback_count + 1

            if tool_calls:

                new_state["solver_tool_feedback_reason"] = None

            else:

                new_state["solver_tool_feedback_reason"] = "empty_tool_call_after_feedback"

            state = new_state

    if isinstance(plan_usage, int):

        new_state = _append_token_usage_event(

            new_state,

            node="solver.plan",

            model=getattr(client, "model", None),

            usage=plan_usage,

            meta={"use_tools": bool(tools)},

        )

    new_state["pending_tool_calls"] = tool_calls

    new_state["task_intent"] = base_intent

    new_state["active_skills"] = active_skills

    new_state["tool_error"] = None

    new_state["doc_context"] = doc_ctx_raw

    return new_state





__all__ = ["solver_node"]

