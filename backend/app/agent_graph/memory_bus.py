from __future__ import annotations

import json
from typing import List

from .helpers import _append_token_usage_event, _trim_text
from .prompt_slots import _latest_user_from_dialogue
from .runtime import SKILL_MANAGER, logger
from ..services.qwen_client import QwenClient
from .stream_registry import _get_base_messages
from .token_utils import SOFT_TOKEN_LIMIT, _estimate_tokens_for_messages
from .types import AgentMessageEntry, AgentState, _extract_role_content


def _build_doc_context(document_title: str | None, question_contexts: list | None) -> str | None:
    lines: List[str] = []
    if document_title:
        lines.append(f"当前试卷标题：{document_title}")
    if not question_contexts:
        return "\n".join(lines) if lines else None

    lines.append("以下题目信息由系统按需载入，代表当前对话显式引用的题目：")
    for ctx in question_contexts:
        if not isinstance(ctx, dict):
            continue
        display_idx = ctx.get("display_index")
        seq_idx = ctx.get("sequence_index")
        question_id = ctx.get("question_id")
        page = ctx.get("page")
        label_bits: List[str] = []
        if display_idx:
            label_bits.append(f"题目 #{display_idx}")
        if seq_idx is not None:
            label_bits.append(f"sequence_index={seq_idx}")
        if question_id is not None:
            label_bits.append(f"question_id={question_id}")
        if page is not None:
            label_bits.append(f"page={page}")
        label = "｜".join(label_bits) if label_bits else "题目"
        content = (ctx.get("content") or "").strip()
        lines.append(f"- {label}")
        if content:
            lines.append(f"  题干：{_trim_text(content, 800)}")
        student_answer = ctx.get("student_answer")
        if student_answer:
            lines.append(f"  学生作答：{_trim_text(str(student_answer), 200)}")
        grading = ctx.get("grading") or {}
        judgement = grading.get("judgement")
        predicted = grading.get("predicted_answer")
        if judgement:
            summary = f"  批改结果：{judgement}"
            if predicted:
                summary += f"，参考答案：{_trim_text(str(predicted), 120)}"
            lines.append(summary)
        if ctx.get("has_vision_asset"):
            lines.append("  图像提示：该题包含图例，请结合视觉摘要或必要时请求视觉理解。")

    return "\n".join(lines)


def _split_rounds(messages: List[AgentMessageEntry]) -> List[List[AgentMessageEntry]]:
    rounds: list[list[AgentMessageEntry]] = []
    current: list[AgentMessageEntry] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role, _content = _extract_role_content(msg)
        if role not in ("system", "user", "assistant"):
            continue
        current.append(msg)
        if role == "assistant":
            rounds.append(current)
            current = []
    if current:
        rounds.append(current)
    return rounds


def _format_dialogue_for_summary(messages: List[AgentMessageEntry], *, max_chars: int = 8000) -> str:
    lines: list[str] = []
    total_len = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role, content = _extract_role_content(msg)
        if role not in ("user", "assistant"):
            continue
        text = (content or "").strip()
        if not text:
            continue
        line = f"{role}: {text}"
        if total_len + len(line) > max_chars:
            break
        lines.append(line)
        total_len += len(line) + 1
    return "\n".join(lines)


def _merge_session_profile(base: dict | None, patch: dict | None) -> dict:
    if not isinstance(base, dict):
        base = {}
    if not isinstance(patch, dict):
        return base

    if "session_anchors" in patch:
        try:
            logger.warning(
                "agent.graph.memory_bus.patch_ignored_session_anchors tenant=%s user=%s",
                base.get("tenant_id"),
                base.get("user_id"),
            )
        except Exception:  # noqa: BLE001
            logger.warning("agent.graph.memory_bus.patch_ignored_session_anchors")
        patch = {k: v for k, v in patch.items() if k != "session_anchors"}

    merged = dict(base)

    def _merge_dict(key: str) -> None:
        src = base.get(key)
        upd = patch.get(key)
        if isinstance(src, dict) and isinstance(upd, dict):
            tmp = dict(src)
            tmp.update(upd)
            merged[key] = tmp
        elif upd is not None:
            merged[key] = upd

    for k in ("preferences", "constraints", "progress", "mastery_full", "error_patterns"):
        _merge_dict(k)

    for k, v in patch.items():
        if k in ("preferences", "constraints", "progress", "mastery_full", "error_patterns"):
            continue
        merged[k] = v
    return merged


def _prepare_message_windows(
    messages: List[AgentMessageEntry],
    *,
    keep_rounds: int = 6,
    dialogue_rounds_limit: int = 2,
) -> tuple[list[AgentMessageEntry], list[AgentMessageEntry], list[list[AgentMessageEntry]]]:
    all_rounds = _split_rounds(messages)
    if not all_rounds:
        trimmed = messages
        old_rounds: list[list[AgentMessageEntry]] = []
        dialogue_rounds = [messages] if messages else []
    else:
        if len(all_rounds) <= keep_rounds:
            keep = all_rounds
            old_rounds = []
        else:
            keep = all_rounds[-keep_rounds:]
            old_rounds = all_rounds[:-keep_rounds]
        trimmed = []
        for r in keep:
            trimmed.extend(r)

        window_rounds = all_rounds[-dialogue_rounds_limit:] if len(all_rounds) >= dialogue_rounds_limit else all_rounds
        dialogue_rounds = window_rounds

    dialogue_window: list[AgentMessageEntry] = []
    for r in dialogue_rounds:
        for m in r:
            if isinstance(m, dict):
                dialogue_window.append(m)
    return trimmed, dialogue_window, old_rounds


def _merge_session_state_patch(state: AgentState, session_profile: dict | None) -> tuple[dict, bool]:
    base = dict(session_profile) if isinstance(session_profile, dict) else {}

    session_state_existing = state.get("session_state")
    if isinstance(session_state_existing, dict):
        tmp = dict(base)
        for key, value in session_state_existing.items():
            if key == "session_anchors":
                continue
            tmp[key] = value
        base = tmp

    patch = state.get("session_state_patch")
    if isinstance(patch, dict) and patch:
        if "session_anchors" in patch:
            logger.warning(
                "agent.graph.memory_bus.state_patch_ignored_session_anchors tenant=%s user=%s",
                state.get("tenant_id"),
                state.get("user_id"),
            )
            patch = {k: v for k, v in patch.items() if k != "session_anchors"}

        merged = _merge_session_profile(base, patch)
        logger.info(
            "agent.graph.memory_bus.session_state_patch_merged tenant=%s user=%s patch_keys=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            list(patch.keys()),
        )
        return merged, True
    return base, False


def _run_history_summarizer(
    *,
    state: AgentState,
    session_state: dict,
    history_summary: str,
    old_rounds: list[list[AgentMessageEntry]],
) -> tuple[str, dict, int | None] | None:
    if not old_rounds:
        return None
    old_messages: list[AgentMessageEntry] = []
    for r in old_rounds:
        old_messages.extend(r)
    old_dialogue = _format_dialogue_for_summary(old_messages)
    ctx = {
        "session_profile": json.dumps(session_state, ensure_ascii=False),
        "history_summary": history_summary or "",
    }
    logger.info(
        "agent.graph.memory_bus.compress_start tenant=%s user=%s old_rounds=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        len(old_rounds),
    )
    try:
        summary_raw, usage = SKILL_MANAGER.run_inference(
            agent="context",
            name="session_summarizer",
            context=ctx,
            conversation_snippet=old_dialogue,
            client_factory=QwenClient,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "agent.graph.memory_bus.compress_failed tenant=%s user=%s error=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            exc,
        )
        return None

    if not isinstance(summary_raw, dict) or not summary_raw:
        logger.warning(
            "agent.graph.memory_bus.compress_empty tenant=%s user=%s",
            state.get("tenant_id"),
            state.get("user_id"),
        )
        return None

    new_history_summary = summary_raw.get("history_summary") or history_summary
    patch = summary_raw.get("session_profile_patch")
    merged_state = _merge_session_profile(session_state, patch)
    return new_history_summary, merged_state, usage


def _build_entity_context(state: AgentState) -> str:
    doc_title = state.get("document_title")
    current_doc_id = state.get("document_id")

    question_contexts = state.get("question_contexts") or []
    if isinstance(question_contexts, list) and question_contexts:
        logger.info(
            "agent.graph.entity_context.use_current_context doc_id=%s question_count=%s",
            current_doc_id,
            len(question_contexts),
        )
        try:
            return _build_doc_context(doc_title, question_contexts) or ""
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "agent.graph.entity_context.build_failed doc_id=%s stage=%s error=%s",
                current_doc_id,
                "question_contexts",
                exc,
            )
            raise

    anchors = state.get("session_anchors")
    if not isinstance(anchors, list):
        anchors = []
    active_entities = state.get("active_entities")
    if not isinstance(active_entities, list):
        active_entities = []

    selected_question_ids: set[int] = set()

    if active_entities and anchors:
        for ent_id in active_entities:
            for anchor in anchors:
                if not isinstance(anchor, dict):
                    continue
                if anchor.get("id") != ent_id:
                    continue
                if anchor.get("type") != "question":
                    continue
                if current_doc_id is not None and anchor.get("document_id") != current_doc_id:
                    continue
                qid = anchor.get("question_id")
                if isinstance(qid, int):
                    selected_question_ids.add(qid)

    if not selected_question_ids and anchors:
        for anchor in reversed(anchors):
            if not isinstance(anchor, dict):
                continue
            if anchor.get("type") != "question":
                continue
            if current_doc_id is not None and anchor.get("document_id") != current_doc_id:
                continue
            qid = anchor.get("question_id")
            if isinstance(qid, int):
                selected_question_ids.add(qid)
                break

    if not selected_question_ids:
        logger.info(
            "agent.graph.entity_context.no_selected_questions doc_id=%s anchors=%s active_entities=%s",
            current_doc_id,
            [a.get("id") for a in anchors if isinstance(a, dict)],
            list(active_entities),
        )
        try:
            return _build_doc_context(doc_title, []) or ""
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "agent.graph.entity_context.build_failed doc_id=%s stage=%s error=%s",
                current_doc_id,
                "empty_context",
                exc,
            )
            raise

    snapshot_questions = state.get("snapshot_questions") or []
    q_index_map = state.get("question_index_map") or {}
    id_to_meta = q_index_map.get("id_to_meta") or {}

    rebuilt_contexts: list[dict] = []
    for q in snapshot_questions:
        if not isinstance(q, dict):
            continue
        qid = q.get("id")
        if not isinstance(qid, int) or qid not in selected_question_ids:
            continue
        meta = id_to_meta.get(qid) or {}
        content = (q.get("content") or "").strip()
        grading = {}
        judgement = q.get("grading_judgement")
        predicted = q.get("grading_predicted_answer")
        if judgement or predicted:
            if judgement:
                grading["judgement"] = judgement
            if predicted:
                grading["predicted_answer"] = predicted

        ctx: dict = {
            "question_id": qid,
            "sequence_index": q.get("sequence_index"),
            "display_index": meta.get("display_index"),
            "page": q.get("page"),
            "content": content,
            "student_answer": q.get("student_answer"),
            "grading": grading,
            "has_vision_asset": bool(q.get("legend_images")),
            "legend_images": q.get("legend_images"),
        }
        rebuilt_contexts.append(ctx)

    logger.info(
        "agent.graph.entity_context.rebuilt doc_id=%s selected_qids=%s rebuilt_count=%s snapshot_total=%s",
        current_doc_id,
        list(selected_question_ids),
        len(rebuilt_contexts),
        len(snapshot_questions),
    )
    try:
        return _build_doc_context(doc_title, rebuilt_contexts) or ""
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "agent.graph.entity_context.build_failed doc_id=%s stage=%s error=%s",
            current_doc_id,
            "rebuilt_contexts",
            exc,
        )
        raise


def memory_bus_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    base_messages = _get_base_messages(state) or state.get("messages") or []
    if not base_messages:
        new_state = dict(state)
        new_state.setdefault("dialogue_window", [])
        session_state = new_state.get("session_state")
        if not isinstance(session_state, dict):
            profile = new_state.get("session_profile") or {}
            session_state = dict(profile) if isinstance(profile, dict) else {}
            new_state["session_state"] = session_state
        return new_state

    trimmed_messages, dialogue_window, old_rounds = _prepare_message_windows(base_messages)
    total_tokens = _estimate_tokens_for_messages(base_messages)
    short_tokens = _estimate_tokens_for_messages(trimmed_messages)

    new_state = dict(state)
    history_summary = state.get("history_summary") or ""
    session_profile = state.get("session_profile") or {}
    if not isinstance(session_profile, dict):
        session_profile = {}

    anchors_in_profile = None
    if isinstance(session_profile, dict):
        anchors_in_profile = session_profile.get("session_anchors")
    logger.info(
        "agent.graph.memory_bus.session_profile_debug tenant=%s user=%s doc_id=%s profile_keys=%s anchor_count=%s anchor_ids=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        state.get("document_id"),
        list(session_profile.keys()) if isinstance(session_profile, dict) else [],
        len(anchors_in_profile) if isinstance(anchors_in_profile, list) else 0,
        [a.get("id") for a in anchors_in_profile[:5]] if isinstance(anchors_in_profile, list) else [],
    )

    session_state, patch_consumed = _merge_session_state_patch(state, session_profile)

    anchors_in_state = None
    if isinstance(session_state, dict):
        anchors_in_state = session_state.get("session_anchors")
    logger.info(
        "agent.graph.memory_bus.session_state_debug tenant=%s user=%s doc_id=%s state_keys=%s anchor_count=%s anchor_ids=%s patch_consumed=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        state.get("document_id"),
        list(session_state.keys()) if isinstance(session_state, dict) else [],
        len(anchors_in_state) if isinstance(anchors_in_state, list) else 0,
        [a.get("id") for a in anchors_in_state[:5]] if isinstance(anchors_in_state, list) else [],
        patch_consumed,
    )

    if patch_consumed:
        new_state["session_state_patch"] = None

    history_result = None
    if total_tokens > SOFT_TOKEN_LIMIT and old_rounds:
        history_result = _run_history_summarizer(
            state=state,
            session_state=session_state,
            history_summary=history_summary,
            old_rounds=old_rounds,
        )

    if history_result:
        new_history_summary, merged_state, summary_usage = history_result
        new_state["history_summary"] = new_history_summary
        new_state["session_profile"] = merged_state
        new_state["session_state"] = merged_state
        if isinstance(summary_usage, int):
            new_state = _append_token_usage_event(
                new_state,
                node="memory_bus.summarizer",
                model=None,
                usage=summary_usage,
                meta={"skill": "session_summarizer"},
            )
        logger.info(
            "agent.graph.memory_bus.compress_ok tenant=%s user=%s summary_len=%s state_keys=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            len(new_history_summary or ""),
            list(merged_state.keys()),
        )
    else:
        new_state["session_state"] = session_state
        logger.info(
            "agent.graph.memory_bus.tokens total=%s short_window=%s kept_rounds=%s patch_consumed=%s",
            total_tokens,
            short_tokens,
            len(dialogue_window) // 2,
            patch_consumed,
        )

    final_session_state = new_state.get("session_state")
    if isinstance(final_session_state, dict):
        anchors_in_state = final_session_state.get("session_anchors")
        if isinstance(anchors_in_state, list):
            new_state["session_anchors"] = anchors_in_state

    new_state["messages"] = trimmed_messages
    new_state["dialogue_window"] = dialogue_window

    anchors = new_state.get("session_anchors")
    if not isinstance(anchors, list):
        new_state["session_anchors"] = []
        anchors = new_state["session_anchors"]
    active_entities = new_state.get("active_entities")
    if not isinstance(active_entities, list):
        new_state["active_entities"] = []
        active_entities = new_state["active_entities"]

    logger.info(
        "agent.graph.memory_bus.anchors_for_context tenant=%s user=%s doc_id=%s anchors=%s active_entities=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        state.get("document_id"),
        [a.get("id") for a in anchors] if isinstance(anchors, list) else None,
        list(active_entities) if isinstance(active_entities, list) else None,
    )

    entity_context = _build_entity_context(new_state)
    new_state["doc_context"] = entity_context

    return new_state


__all__ = ["memory_bus_node"]
