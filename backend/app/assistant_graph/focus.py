from __future__ import annotations

import json
from typing import Any, Iterable, List, Tuple

from .runtime import logger
from .state import AgentMessageEntry
from ..services.qwen_client import QwenClient
from ..services.question_vector_service import QuestionVectorService


_DEF_MAX_ACTIVE = 3
_DEF_MAX_RECENT = 16
_MAX_CANDIDATE_QUESTIONS = 24
_PREVIEW_MAX_LEN = 80


def _latest_user(dialogue_window: List[AgentMessageEntry]) -> str:
    for msg in reversed(dialogue_window or []):
        if msg.get("role") == "user":
            return str(msg.get("content") or "")
    return ""


def _build_dialogue_snippet(dialogue_window: List[AgentMessageEntry], max_turns: int = 6) -> str:
    if not dialogue_window:
        return ""
    lines: list[str] = []
    window = dialogue_window[-max_turns:]
    for msg in window:
        role = msg.get("role")
        content = str(msg.get("content") or "").strip()
        if not content:
            continue
        if role == "user":
            prefix = "学生"
        elif role == "assistant":
            prefix = "助手"
        else:
            prefix = "系统"
        lines.append(f"{prefix}: {content}")
    return "\n".join(lines)


def _collect_candidate_questions(
    snapshot_items: list,
    preferred_ids: Iterable[int],
    max_candidates: int,
) -> list[dict[str, Any]]:
    # 建立 id -> item 映射
    id_to_item: dict[int, dict[str, Any]] = {}
    for item in snapshot_items or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "question":
            continue
        try:
            qid = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        id_to_item[qid] = item

    ordered_ids: list[int] = []
    seen: set[int] = set()

    # 先把偏好 id（active + recent）按顺序放入
    for raw in preferred_ids:
        try:
            qid = int(raw)
        except (TypeError, ValueError):
            continue
        if qid in seen or qid not in id_to_item:
            continue
        ordered_ids.append(qid)
        seen.add(qid)

    # 再用 sequence_index 排序补充其余题目
    remaining: list[tuple[int, int]] = []
    for qid, item in id_to_item.items():
        if qid in seen:
            continue
        seq_raw = item.get("sequence_index")
        try:
            seq = int(seq_raw) if seq_raw is not None else 10**9
        except (TypeError, ValueError):
            seq = 10**9
        remaining.append((seq, qid))
    remaining.sort(key=lambda x: x[0])
    for _seq, qid in remaining:
        if len(ordered_ids) >= max_candidates:
            break
        ordered_ids.append(qid)

    candidates: list[dict[str, Any]] = []
    for qid in ordered_ids[:max_candidates]:
        item = id_to_item.get(qid)
        if not item:
            continue
        seq_raw = item.get("sequence_index")
        display_index: int | None
        try:
            display_index = int(seq_raw) + 1 if seq_raw is not None else None
        except (TypeError, ValueError):
            display_index = None
        content = str(item.get("content") or "").strip().splitlines()[0]
        preview = content[:_PREVIEW_MAX_LEN]
        candidates.append(
            {
                "question_id": qid,
                "display_index": display_index,
                "sequence_index": seq_raw,
                "short_preview": preview,
            }
        )

    return candidates


def _extract_json_object(text: str) -> dict[str, Any] | None:
    """尽量从模型输出中提取一个 JSON 对象，不做 schema 校验。"""
    if not text:
        return None
    text = text.strip()
    # 去掉 ```json 包裹
    if text.startswith("```"):
        parts = text.split("```", 2)
        if len(parts) >= 2:
            text = parts[1]
    text = text.strip()
    # 直接尝试整体解析
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:  # noqa: BLE001
        pass
    # 退而求其次，在字符串中查找第一个 '{' 和最后一个 '}'
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    snippet = text[start : end + 1]
    try:
        obj = json.loads(snippet)
        if isinstance(obj, dict):
            return obj
    except Exception:  # noqa: BLE001
        return None
    return None


def _normalize_id_list(raw: Any) -> list[int]:
    result: list[int] = []
    if not isinstance(raw, list):
        return result
    for v in raw:
        try:
            qid = int(v)
        except (TypeError, ValueError):
            continue
        if qid not in result:
            result.append(qid)
    return result


def compute_focus_workset(
    *,
    tenant_id: int | None,
    document_id: int | None,
    snapshot_items: list,
    dialogue_window: List[AgentMessageEntry],
    active_question_ids: list | None,
    recent_question_ids: list | None,
    max_active: int | None = None,
    max_recent: int | None = None,
) -> Tuple[list[int], list[int]]:
    """基于自然语言+pgvector，agentic 地决定题目工作集。

    - 不做任何“第几题→ID”的规则映射；
    - 只把题目候选（question_id + 简短 preview）暴露给模型，由模型选出要 focus 的 question_id；
    - 通过 pgvector 做相似题扩展，仍然保持常数级 active_question_ids。
    """

    max_active = max_active or _DEF_MAX_ACTIVE
    max_recent = max_recent or _DEF_MAX_RECENT

    current_active = _normalize_id_list(active_question_ids or [])
    current_recent = _normalize_id_list(recent_question_ids or [])

    # 基于当前工作集优先级收集候选题目
    preferred_ids: list[int] = []
    preferred_ids.extend(current_active)
    for qid in current_recent:
        if qid not in preferred_ids:
            preferred_ids.append(qid)

    candidates = _collect_candidate_questions(
        snapshot_items=snapshot_items,
        preferred_ids=preferred_ids,
        max_candidates=_MAX_CANDIDATE_QUESTIONS,
    )
    candidate_id_set = {c["question_id"] for c in candidates}

    if not candidates:
        # 没有题目候选，直接截断原来的工作集
        fallback_active = current_active[:max_active]
        fallback_recent = (fallback_active + current_recent)[:max_recent]
        return fallback_active, fallback_recent

    latest_user = _latest_user(dialogue_window)
    dialogue_snippet = _build_dialogue_snippet(dialogue_window)

    context_obj: dict[str, Any] = {
        "latest_user": latest_user,
        "dialogue_snippet": dialogue_snippet,
        "current_active_question_ids": current_active,
        "current_recent_question_ids": current_recent,
        "max_active": max_active,
        "candidates": candidates,
    }

    messages: List[dict] = [
        {
            "role": "system",
            "content": (
                "你是题目 focus 策略子代理，不直接回答学生问题。\n"
                "你的任务是：根据学生最近的自然语言输入和题目列表，\n"
                "决定下一轮应该重点关注哪些题目 question_id。\n"
                "要求：\n"
                "1. 只能在给定 candidates 里的 question_id 中选择，不要编造新的题目；\n"
                "2. 如果学生没有明确指向具体题目，可以保持当前的 active_question_ids 不变；\n"
                "3. 尽量把学生提到的题目排在前面，如果有需要相似练习，可以指出要基于哪些题目做相似题扩展；\n"
                "4. 严格只输出 JSON 对象，不要输出任何多余文字。\n"
                "JSON schema:\n"
                "{\n"
                "  \"active_question_ids\": [int, ...],  # 下一轮要 focus 的题目 ID 列表，长度不要超过 max_active;\n"
                "  \"expand_from_question_ids\": [int, ...],  # 如果需要基于某些题目找相似题，在这里列出其 question_id；\n"
                "  \"reason\": \"string\"  # 简要中文理由\n"
                "}\n"
            ),
        },
        {
            "role": "user",
            "content": "下面是当前对话和题目候选，请根据说明返回 JSON：\n"
            + json.dumps(context_obj, ensure_ascii=False),
        },
    ]

    new_active: list[int] = []
    expand_from: list[int] = []

    try:
        client = QwenClient(max_output_tokens=512)
        reply, usage = client.chat(messages)
        logger.info(
            "assistant.focus.reply tenant=%s user=%s usage=%s preview=%s",
            tenant_id,
            None,
            usage,
            str(reply or "")[:160],
        )
        obj = _extract_json_object(reply)
        if obj is not None:
            raw_active = obj.get("active_question_ids")
            raw_expand = obj.get("expand_from_question_ids")
            cand_active = _normalize_id_list(raw_active)
            cand_expand = _normalize_id_list(raw_expand)

            # 只保留出现在 candidates 里的题目
            for qid in cand_active:
                if qid in candidate_id_set and qid not in new_active:
                    new_active.append(qid)
                    if len(new_active) >= max_active:
                        break

            for qid in cand_expand:
                if qid in candidate_id_set and qid not in expand_from:
                    expand_from.append(qid)

    except Exception as exc:  # noqa: BLE001
        logger.exception("assistant.focus.inference_failed error=%s", exc)

    # 如果模型没有给出有效的新 active，则回退到当前工作集（截断到 max_active）
    if not new_active:
        fallback_active = []
        for qid in current_active:
            if qid in candidate_id_set and qid not in fallback_active:
                fallback_active.append(qid)
                if len(fallback_active) >= max_active:
                    break
        if not fallback_active:
            # 再退一步，用 recent 兜底
            for qid in current_recent:
                if qid in candidate_id_set and qid not in fallback_active:
                    fallback_active.append(qid)
                    if len(fallback_active) >= max_active:
                        break
        new_active = fallback_active

    # 基于 pgvector 做少量相似题扩展，仍然保持常数级
    if tenant_id is not None and document_id is not None and new_active:
        base_for_vector: list[int] = expand_from or new_active
        try:
            qv = QuestionVectorService()
            similar_ids = qv.get_similar_questions(
                tenant_id=int(tenant_id),
                document_id=int(document_id),
                base_question_ids=base_for_vector,
                per_base_limit=max_active,
                max_total=max_active * 2,
            )
            for qid in similar_ids:
                if qid in candidate_id_set and qid not in new_active:
                    new_active.append(qid)
                    if len(new_active) >= max_active:
                        break
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "assistant.focus.vector_expand_failed tenant=%s document=%s error=%s",
                tenant_id,
                document_id,
                exc,
            )

    # 截断 active，保证常数级
    new_active = new_active[:max_active]

    # 更新 recent：active 在前，后面接原 recent 的 LRU，去重并截断
    new_recent: list[int] = []
    for qid in new_active:
        if qid not in new_recent:
            new_recent.append(qid)
    for qid in current_recent:
        if qid not in new_recent:
            new_recent.append(qid)
        if len(new_recent) >= max_recent:
            break

    return new_active, new_recent
