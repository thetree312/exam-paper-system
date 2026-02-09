from __future__ import annotations







import json



import re



import time



from typing import List







from ..helpers import _append_token_usage_event, _latest_user_snapshot_from_state, _trim_text



from ..prompt_slots import _build_slot_prompt



from ..prompts import SOLVER_BASE_PROMPT



from ..runtime import SKILL_MANAGER, logger



from ...services.qwen_client import QwenClient



from ..stream_registry import _get_stream_handler



from ..token_utils import HARD_TOKEN_LIMIT, _estimate_tokens_for_messages



from ..types import AgentMessageEntry, AgentState, _build_default_intent, _normalize_skill_tags



from .solver_context import prepare_solver_context_bundle











def solver_reply_node(state: AgentState) -> AgentState:



    if state.get("skip_model"):



        return state







    client = QwenClient()



    bundle = state.get("solver_context_bundle")



    if not isinstance(bundle, dict):



        bundle = prepare_solver_context_bundle(state)







    doc_ctx_raw = bundle.get("doc_context_raw") or state.get("doc_context") or ""



    doc_ctx_text = bundle.get("doc_context_text") or doc_ctx_raw or "（当前未注入题干）"



    base_intent = _build_default_intent(state.get("task_intent"))



    task_types = base_intent.get("task_type") or ["explain"]







    tool_summaries = state.get("tool_summaries") or []



    tool_summary_chars = sum(len(item) for item in tool_summaries if isinstance(item, str))



    ag_ui_events_full = state.get("ag_ui_events")



    ag_ui_event_count = len(ag_ui_events_full) if isinstance(ag_ui_events_full, list) else 0



    ag_ui_prompt_events = state.get("ag_ui_prompt_events") or []



    ag_ui_event_chars = 0



    ag_ui_preview: str | None = None



    if isinstance(ag_ui_prompt_events, list) and ag_ui_prompt_events:



        try:



            ag_ui_event_chars = len(json.dumps(ag_ui_prompt_events, ensure_ascii=False))



            ag_ui_preview = json.dumps(ag_ui_prompt_events[:2], ensure_ascii=False)



        except TypeError:



            ag_ui_event_chars = 0



            ag_ui_preview = str(ag_ui_prompt_events[:2])







    full_snapshot = state.get("snapshot_questions")



    focus_qid = state.get("supervisor_focus_question_id")



    snapshot_for_prompt: list | None = None



    if isinstance(full_snapshot, list) and full_snapshot:



        base_items: list = []



        new_items: list = []



        for item in full_snapshot:



            if not isinstance(item, dict):



                continue



            qid = item.get("id")



            if isinstance(qid, int):



                if isinstance(focus_qid, int) and qid == focus_qid:



                    base_items.append(item)



            else:



                new_items.append(item)







        if isinstance(focus_qid, int):



            combined: list = []



            if base_items:



                combined.extend(base_items)



            if new_items:



                combined.extend(new_items)



            snapshot_for_prompt = combined or full_snapshot



        else:



            snapshot_for_prompt = new_items or full_snapshot



    else:



        snapshot_for_prompt = full_snapshot if isinstance(full_snapshot, list) else []







    snapshot_questions = snapshot_for_prompt



    snapshot_question_count = len(snapshot_questions) if isinstance(snapshot_questions, list) else 0



    snapshot_question_chars = 0



    snapshot_preview: str | None = None



    if isinstance(snapshot_questions, list) and snapshot_questions:



        try:



            snapshot_question_chars = len(json.dumps(snapshot_questions, ensure_ascii=False))



            snapshot_preview = json.dumps(snapshot_questions[:2], ensure_ascii=False)



        except TypeError:



            snapshot_question_chars = 0



            snapshot_preview = str(snapshot_questions[:2])







    skill_tags = _normalize_skill_tags(task_types)



    skill_tags.discard("practice")



    skill_tags.discard("similar_overwrite")



    skill_tags.discard("from_content_no_overwrite")







    primary_questions = base_intent.get("primary_questions") or []



    primary_label = ", ".join(str(item) for item in primary_questions) or "未指定"



    history_summary = bundle.get("history_summary_text") or state.get("history_summary") or ""



    session_view_json = bundle.get("reply_session_view_json") or json.dumps(



        bundle.get("reply_session_view") or {}, ensure_ascii=False



    )



    instruction_ctx = dict(bundle.get("reply_instruction_base") or {})



    instruction_ctx.setdefault("doc_context", doc_ctx_text)



    instruction_ctx.setdefault("vision_summary", bundle.get("vision_summary_text") or "（无视觉摘要）")



    instruction_ctx.setdefault("history_summary", history_summary)



    instruction_ctx["primary_questions"] = primary_label



    batch_cfg_for_reply = state.get("batch_config")



    if isinstance(batch_cfg_for_reply, dict) and batch_cfg_for_reply:



        instruction_ctx["batch_config"] = json.dumps(batch_cfg_for_reply, ensure_ascii=False)



    instruction_ctx.setdefault("session_profile", session_view_json)



    instruction_ctx.setdefault("session_state_view", session_view_json)







    active_skills, skill_messages = SKILL_MANAGER.render_instructions(



        agent="solver",



        tags=list(skill_tags or ["explain"]),



        context=instruction_ctx,



    )







    slot_payload: dict[str, List[AgentMessageEntry]] = {}



    if skill_messages:



        slot_payload["skill_instruction"] = list(skill_messages)



    slot_payload["session_state_update_instruction"] = [



        {



            "role": "system",



            "content": (



                "【会话状态更新协议】\n"



                "在本轮对话结束后，如果你观察到学生的知识掌握、错误模式、学习偏好等方面有新的信息，"



                "请在回复末尾用 JSON 代码块标记更新内容：\n"



                "```session_state_patch\n"



                "{\n"



                '  "mastery_full": {"知识点A": "已掌握", "知识点B": "需加强"},\n'



                '  "learning_style": "偏好图像化解释"\n'



                "}\n"



                "```\n"



                "如果没有新增信息，请显式回复“不需更新会话状态”。"



            ),



        }



    ]







    state_for_prompt = dict(state)



    state_for_prompt["doc_context"] = doc_ctx_raw



    if isinstance(snapshot_questions, list):



        state_for_prompt["snapshot_questions"] = snapshot_questions



    if isinstance(ag_ui_prompt_events, list):



        state_for_prompt["ag_ui_events"] = ag_ui_prompt_events



    messages = _build_slot_prompt(



        state=state_for_prompt,



        node_name="solver_reply",



        instruction=SOLVER_BASE_PROMPT,



        slot_payload=slot_payload,



        token_limit=min(HARD_TOKEN_LIMIT, 8000),



    )



    dialogue_snippet = bundle.get("dialogue_snippet") or ""



    logger.info(



        "agent.graph.solver_reply.context_summary tenant=%s user=%s doc_ctx_chars=%s history_chars=%s dialogue_chars=%s tool_summary_count=%s tool_summary_chars=%s ag_ui_events=%s ag_ui_chars=%s snapshot_questions=%s snapshot_chars=%s",



        state.get("tenant_id"),



        state.get("user_id"),



        len(doc_ctx_text),



        len(history_summary),



        len(dialogue_snippet),



        len(tool_summaries),



        tool_summary_chars,



        ag_ui_event_count,



        ag_ui_event_chars,



        snapshot_question_count,



        snapshot_question_chars,



    )



    logger.info(



        "agent.graph.solver_reply.doc_context_full tenant=%s user=%s doc_context=%s",



        state.get("tenant_id"),



        state.get("user_id"),



        doc_ctx_text,



    )



    if history_summary:



        logger.info(



            "agent.graph.solver_reply.history_summary_full tenant=%s user=%s history=%s",



            state.get("tenant_id"),



            state.get("user_id"),



            history_summary,



        )



    if dialogue_snippet:



        logger.info(



            "agent.graph.solver_reply.dialogue_full tenant=%s user=%s dialogue=%s",



            state.get("tenant_id"),



            state.get("user_id"),



            dialogue_snippet,



        )



    if tool_summaries:



        logger.info(



            "agent.graph.solver_reply.tool_summary_full tenant=%s user=%s summaries=%s",



            state.get("tenant_id"),



            state.get("user_id"),



            tool_summaries,



        )



    if ag_ui_preview:



        logger.info(



            "agent.graph.solver_reply.ag_ui_full tenant=%s user=%s ag_ui_events=%s",



            state.get("tenant_id"),



            state.get("user_id"),



            ag_ui_events,



        )



    if snapshot_preview:



        logger.info(



            "agent.graph.solver_reply.snapshot_full tenant=%s user=%s snapshot_questions=%s",



            state.get("tenant_id"),



            state.get("user_id"),



            snapshot_questions,



        )







    logger.info(



        "agent.graph.solver_reply.messages tenant=%s user=%s messages=%s",



        state.get("tenant_id"),



        state.get("user_id"),



        messages,



    )







    handler = _get_stream_handler(state)



    llm_start_ts = time.time()



    reply_usage: int | None = None







    estimated_tokens = _estimate_tokens_for_messages(messages)



    if estimated_tokens > HARD_TOKEN_LIMIT:



        logger.warning(



            "agent.graph.solver_reply.context_over_hard_limit tenant=%s user=%s estimated_tokens=%s hard_limit=%s",



            state.get("tenant_id"),



            state.get("user_id"),



            estimated_tokens,



            HARD_TOKEN_LIMIT,



        )







    logger.info(



        "agent.graph.solver_reply.llm_start tenant=%s user=%s message_count=%s has_tool_summaries=%s est_tokens=%s",



        state.get("tenant_id"),



        state.get("user_id"),



        len(messages),



        bool(tool_summaries),



        estimated_tokens,



    )







    stream_started = False



    reply_parts: List[str] = []



    try:



        for delta in client.chat_stream(messages):



            if not stream_started:



                stream_started = True



                logger.info(



                    "agent.graph.solver_reply.llm_first_delta tenant=%s user=%s",



                    state.get("tenant_id"),



                    state.get("user_id"),



                )



            if handler and delta:



                handler({"type": "delta", "role": "assistant", "delta": delta})



            if delta:



                reply_parts.append(str(delta))



    except Exception as exc:  # noqa: BLE001



        logger.exception("solver_reply_node.failed tenant=%s user=%s", state.get("tenant_id"), state.get("user_id"))



        reply = f"Agent 内部错误：{exc}"



    else:



        reply = "".join(reply_parts)



    finally:



        llm_duration = time.time() - llm_start_ts



        reply_usage = client.last_usage_total_tokens



        logger.info(



            "agent.graph.solver_reply.llm_done tenant=%s user=%s first_delta=%s duration_ms=%.2f",



            state.get("tenant_id"),



            state.get("user_id"),



            stream_started,



            llm_duration * 1000,



        )







    reply_preview = _trim_text(reply, 200)



    latest_user_snapshot = _latest_user_snapshot_from_state(state)







    session_state_patch: dict | None = None



    clean_reply = reply



    patch_pattern = r"```session_state_patch\s*\n(.*?)\n```"



    match = re.search(patch_pattern, reply, re.DOTALL | re.IGNORECASE)



    if match:



        patch_json = match.group(1).strip()



        try:



            session_state_patch = json.loads(patch_json)



            clean_reply = re.sub(patch_pattern, "", reply, flags=re.DOTALL | re.IGNORECASE).strip()



            logger.info(



                "agent.graph.solver_reply.session_state_patch_extracted tenant=%s user=%s patch_keys=%s",



                state.get("tenant_id"),



                state.get("user_id"),



                list(session_state_patch.keys()) if isinstance(session_state_patch, dict) else [],



            )



        except Exception as exc:  # noqa: BLE001



            logger.warning(



                "agent.graph.solver_reply.session_state_patch_parse_failed tenant=%s user=%s error=%s",



                state.get("tenant_id"),



                state.get("user_id"),



                exc,



            )



            session_state_patch = None







    logger.info(



        "agent.graph.solver_reply.reply_full tenant=%s user=%s reply=%s latest_user=%s has_tool_summaries=%s has_patch=%s",



        state.get("tenant_id"),



        state.get("user_id"),



        reply,



        latest_user_snapshot,



        bool(tool_summaries),



        bool(session_state_patch),



    )







    new_state = dict(state)



    new_state["messages"] = [{"role": "assistant", "content": clean_reply}]



    new_state["assistant_reply"] = clean_reply



    if isinstance(snapshot_questions, list):



        new_state["snapshot_questions"] = snapshot_questions



    new_state["ag_ui_prompt_events"] = []



    if isinstance(reply_usage, int):



        new_state = _append_token_usage_event(



            new_state,



            node="solver.reply",



            model=getattr(client, "model", None),



            usage=reply_usage,



            meta={"stream": True},



        )



    if session_state_patch:



        new_state["session_state_patch"] = session_state_patch







    return new_state











__all__ = ["solver_reply_node"]



