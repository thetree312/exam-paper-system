from __future__ import annotations

import json
import hashlib
from typing import Any, List

from ...db import SessionLocal
from ...services.agent_service import AgentService
from ...services.question_service import QuestionService
from ...services.question_vector_service import QuestionVectorService
from ..runtime import logger
from ..state import AgentState


def get_question_resolver_tool_def() -> dict:
    """返回收敛后的题目工具定义（内部固定 show->describe 流程）。"""

    return {
        "type": "function",
        "function": {
            "name": "resolve_questions",
            "description": (
                "题目解析大工具（内部固定流程：先show_question_catalog，再describe_questions）。\n"
                "- 你无需分两次调用，直接传自然定位信息（例如第N题对应的 display_indices）即可；\n"
                "- 工具内部会完成目录版本读取、序号映射、题目详情获取与可选相似题补充；\n"
                "- 返回结果可直接用于最终回答，避免输出中间行动话术。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "直接指定题目 ID。",
                    },
                    "sequence_indices": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "题目顺序索引（严格 0-based）。",
                    },
                    "display_indices": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "题面显示编号（严格 1-based）。",
                    },
                    "similar_to_question_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "以这些题目为基准补充相似题。",
                    },
                    "similar_to_sequence_indices": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "以这些序号对应的题目为基准补充相似题。",
                    },
                    "similar_to_display_indices": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "以这些显示编号对应的题目为基准补充相似题。",
                    },
                    "catalog_only": {
                        "type": "boolean",
                        "description": "仅返回目录，不返回题目详情。",
                    },
                    "catalog_limit": {
                        "type": "integer",
                        "description": "目录预览条数，建议 <= 100。",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多返回题目数量，建议不超过 8。",
                    },
                    "expected_catalog_version": {
                        "type": "integer",
                        "description": "调用方认为当前目录版本；不一致时返回 stale_catalog。",
                    },
                },
            },
        },
    }


def get_question_catalog_tool_def() -> dict:
    """兼容旧调用方：现在返回收敛后的 resolve_questions。"""

    return get_question_resolver_tool_def()


def get_question_retrieval_tool_def() -> dict:
    """兼容旧调用方：现在返回收敛后的 resolve_questions。"""

    return get_question_resolver_tool_def()


def _normalize_int_list(raw: Any) -> list[int]:
    ids: list[int] = []
    if not isinstance(raw, list):
        return ids
    for v in raw:
        try:
            i = int(v)
        except (TypeError, ValueError):
            continue
        if i not in ids:
            ids.append(i)
    return ids


def _build_question_index(snapshot_items: list) -> tuple[dict[int, dict[str, Any]], dict[int, int]]:
    """基于 snapshot_items 构建 id -> item / seq -> id 映射。"""

    id_to_item: dict[int, dict[str, Any]] = {}
    seq_to_id: dict[int, int] = {}

    for item in snapshot_items or []:
        if not isinstance(item, dict) or item.get("type") != "question":
            continue
        qid = item.get("id")
        try:
            q_int = int(qid)
        except (TypeError, ValueError):
            continue
        id_to_item[q_int] = item
        seq_raw = item.get("sequence_index")
        try:
            seq_int = int(seq_raw) if seq_raw is not None else None
        except (TypeError, ValueError):
            seq_int = None
        if seq_int is not None and seq_int not in seq_to_id:
            seq_to_id[seq_int] = q_int

    return id_to_item, seq_to_id


def _catalog_rows_to_seq_map(rows: list[dict]) -> dict[int, int]:
    seq_to_id: dict[int, int] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            qid = int(row.get("question_id"))
            seq = int(row.get("sequence_index"))
        except (TypeError, ValueError):
            continue
        if seq not in seq_to_id:
            seq_to_id[seq] = qid
    return seq_to_id


def _pick_ids_from_sequence_indices(seq_to_id: dict[int, int], indices: list[int]) -> list[int]:
    picked: list[int] = []
    for seq in indices:
        qid = seq_to_id.get(seq)
        if isinstance(qid, int) and qid not in picked:
            picked.append(qid)
    return picked


def _pick_ids_from_display_indices(seq_to_id: dict[int, int], indices: list[int]) -> list[int]:
    picked: list[int] = []
    for display_idx in indices:
        seq = display_idx - 1
        qid = seq_to_id.get(seq)
        if isinstance(qid, int) and qid not in picked:
            picked.append(qid)
    return picked


def _compact_legend_images(raw: Any, *, max_keep: int = 2) -> list[str]:
    """压缩题目返回中的 legend_images，避免将 data URL(base64)注入模型上下文。"""

    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        url = str(item or "").strip()
        if not url:
            continue
        if url.startswith("data:image/"):
            # base64 图像过大，不在 LLM 上下文中回传。
            continue
        out.append(url)
        if len(out) >= max_keep:
            break
    return out


def _resolve_legend_source(item: dict[str, Any]) -> list[str]:
    """从 snapshot 题目条目中解析用于视觉判定的原始图例列表。

    约定：
    - 优先使用 vision_legend_images（保留 data URL）；
    - 回退到 legend_images（LLM 安全裁剪后的可见 URL）。
    """

    raw = item.get("vision_legend_images")
    if isinstance(raw, list):
        return raw
    raw = item.get("legend_images")
    if isinstance(raw, list):
        return raw
    return []


def _legend_fingerprint(raw: Any) -> str:
    if not isinstance(raw, list):
        return "none"
    normalized: list[str] = []
    for item in raw:
        url = str(item or "").strip()
        if not url:
            continue
        if url.startswith("data:image/"):
            normalized.append("data:image")
            continue
        normalized.append(url)
    if not normalized:
        return "none"
    text = "|".join(normalized)
    return hashlib.sha1(text.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _coerce_unique_int_ids(raw: Any) -> list[int]:
    ids: list[int] = []
    if not isinstance(raw, list):
        return ids
    for v in raw:
        try:
            qid = int(v)
        except (TypeError, ValueError):
            continue
        if qid not in ids:
            ids.append(qid)
    return ids


def apply_question_state_delta_from_tool_messages(
    *,
    tool_messages: List[dict],
    active_ids: list[int],
    recent_ids: list[int],
    max_active: int,
    max_recent: int,
) -> tuple[list[int], list[int]]:
    """统一消费题目工具返回的 state_delta，更新 active/recent 工作集。"""

    next_active = list(active_ids)
    next_recent = list(recent_ids)

    for msg in tool_messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "tool":
            continue
        name = str(msg.get("name") or "")
        if name not in ("resolve_questions", "describe_questions", "retrieve_questions"):
            continue

        raw = msg.get("content") or ""
        try:
            payload = json.loads(raw)
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(payload, dict):
            continue

        delta = payload.get("state_delta") if isinstance(payload.get("state_delta"), dict) else {}
        resolved = _coerce_unique_int_ids(delta.get("active_question_ids"))
        if not resolved:
            resolved = _coerce_unique_int_ids(payload.get("resolved_question_ids"))

        if not resolved:
            continue

        next_active = resolved[:max_active]
        merged_recent: list[int] = []
        for qid in next_active + next_recent:
            if qid not in merged_recent:
                merged_recent.append(qid)
            if len(merged_recent) >= max_recent:
                break
        next_recent = merged_recent

    return next_active, next_recent


def apply_question_retrieval_tool(state: AgentState, tool_calls: List[dict]) -> List[dict]:
    """执行 show/describe 题目工具：纯 DB/向量检索，不调用 LLM。

    返回可直接追加到 messages 的 tool 消息列表。"""

    if not tool_calls:
        return []

    snapshot_items = state.get("snapshot_items") or []
    tenant_id = state.get("tenant_id")
    document_id = state.get("document_id")

    id_to_item, seq_to_id = _build_question_index(snapshot_items)

    db = SessionLocal()
    agent_svc = AgentService(db)
    q_svc = QuestionService(db)
    v_svc = QuestionVectorService()

    tool_messages: List[dict] = []
    catalog_version_cache: int | None = None

    try:
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            name = fn.get("name")
            if name not in (
                "resolve_questions",
                "show_question_catalog",
                "describe_questions",
                "retrieve_questions",
            ):
                continue
            args_raw = fn.get("arguments") or "{}"
            try:
                args = json.loads(args_raw)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "assistant.question_tools.invalid_tool_args args_preview=%s",
                    str(args_raw)[:200],
                )
                continue

            if name == "resolve_questions":
                # 1) 读取目录（工具内部固定 show 阶段）
                catalog_limit_raw = args.get("catalog_limit")
                try:
                    catalog_limit = int(catalog_limit_raw) if catalog_limit_raw is not None else 100
                except (TypeError, ValueError):
                    catalog_limit = 100
                if catalog_limit <= 0:
                    catalog_limit = 20
                if catalog_limit > 200:
                    catalog_limit = 200

                if tenant_id is None or document_id is None:
                    payload = {
                        "error": "missing_scope",
                        "detail": "tenant_id/document_id 缺失，无法解析题目",
                    }
                    tool_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.get("id"),
                            "name": name,
                            "content": json.dumps(payload, ensure_ascii=False),
                        }
                    )
                    continue

                catalog_payload = agent_svc.get_question_catalog(
                    tenant_id=int(tenant_id),
                    document_id=int(document_id),
                    limit=catalog_limit,
                    offset=0,
                )
                try:
                    catalog_version_cache = int(catalog_payload.get("version"))
                except (TypeError, ValueError):
                    catalog_version_cache = None

                expected_raw = args.get("expected_catalog_version")
                try:
                    expected_catalog_version = int(expected_raw) if expected_raw is not None else None
                except (TypeError, ValueError):
                    expected_catalog_version = None

                if (
                    expected_catalog_version is not None
                    and catalog_version_cache is not None
                    and expected_catalog_version != catalog_version_cache
                ):
                    payload = {
                        "error": "stale_catalog",
                        "expected_catalog_version": expected_catalog_version,
                        "actual_catalog_version": catalog_version_cache,
                        "hint": "目录已更新，请基于新版本重新解析题目",
                        "catalog": {
                            "version": catalog_version_cache,
                            "question_count": catalog_payload.get("question_count"),
                            "rows": catalog_payload.get("rows") or [],
                        },
                    }
                    tool_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.get("id"),
                            "name": name,
                            "content": json.dumps(payload, ensure_ascii=False),
                        }
                    )
                    continue

                catalog_rows = catalog_payload.get("rows") or []
                seq_map = _catalog_rows_to_seq_map(catalog_rows)
                if not seq_map:
                    seq_map = dict(seq_to_id)

                # 2) 解析候选题目（工具内部固定 describe 阶段）
                cand_ids: list[int] = []
                for qid in _normalize_int_list(args.get("question_ids")):
                    if qid not in cand_ids:
                        cand_ids.append(qid)

                sequence_inputs = _normalize_int_list(args.get("sequence_indices"))
                display_inputs = _normalize_int_list(args.get("display_indices"))
                for qid in _pick_ids_from_sequence_indices(seq_map, sequence_inputs):
                    if qid not in cand_ids:
                        cand_ids.append(qid)
                for qid in _pick_ids_from_display_indices(seq_map, display_inputs):
                    if qid not in cand_ids:
                        cand_ids.append(qid)

                base_for_vector: list[int] = []
                for qid in _normalize_int_list(args.get("similar_to_question_ids")):
                    if qid not in base_for_vector:
                        base_for_vector.append(qid)
                similar_sequence_inputs = _normalize_int_list(args.get("similar_to_sequence_indices"))
                similar_display_inputs = _normalize_int_list(args.get("similar_to_display_indices"))
                for qid in _pick_ids_from_sequence_indices(seq_map, similar_sequence_inputs):
                    if qid not in base_for_vector:
                        base_for_vector.append(qid)
                for qid in _pick_ids_from_display_indices(seq_map, similar_display_inputs):
                    if qid not in base_for_vector:
                        base_for_vector.append(qid)

                similar_ids: list[int] = []
                if base_for_vector:
                    try:
                        similar_ids = v_svc.get_similar_questions(
                            tenant_id=int(tenant_id),
                            document_id=int(document_id),
                            base_question_ids=base_for_vector,
                            per_base_limit=4,
                            max_total=8,
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.exception(
                            "assistant.question_tools.resolve.vector_query_failed tenant=%s document=%s base_ids=%s error=%s",
                            tenant_id,
                            document_id,
                            base_for_vector,
                            exc,
                        )
                for qid in similar_ids:
                    try:
                        q_int = int(qid)
                    except (TypeError, ValueError):
                        continue
                    if q_int not in cand_ids:
                        cand_ids.append(q_int)

                catalog_only = bool(args.get("catalog_only"))
                if catalog_only and not cand_ids:
                    payload = {
                        "status": "ok",
                        "workflow": "show_then_describe",
                        "catalog": {
                            "version": catalog_version_cache,
                            "question_count": catalog_payload.get("question_count"),
                            "rows": catalog_rows,
                            "has_more": catalog_payload.get("has_more"),
                        },
                        "resolved_question_ids": [],
                        "state_delta": {
                            "active_question_ids": [],
                        },
                        "questions": [],
                    }
                    tool_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.get("id"),
                            "name": name,
                            "content": json.dumps(payload, ensure_ascii=False),
                        }
                    )
                    continue

                limit_raw = args.get("limit")
                try:
                    limit = int(limit_raw)
                except (TypeError, ValueError):
                    limit = 8
                if limit <= 0:
                    limit = 1
                if limit > 12:
                    limit = 12

                ordered_ids: list[int] = []
                for qid in cand_ids:
                    if len(ordered_ids) >= limit:
                        break
                    if qid not in ordered_ids:
                        ordered_ids.append(qid)

                questions: list[dict[str, Any]] = []
                for qid in ordered_ids:
                    try:
                        q_int = int(qid)
                    except (TypeError, ValueError):
                        continue
                    item = id_to_item.get(q_int)
                    if item is not None:
                        raw_legend = _resolve_legend_source(item)
                        compact_legend = _compact_legend_images(raw_legend)
                        legend_count = len(raw_legend) if isinstance(raw_legend, list) else 0
                        questions.append(
                            {
                                "id": q_int,
                                "sequence_index": item.get("sequence_index"),
                                "page": item.get("page"),
                                "content": item.get("content"),
                                "legend_images": compact_legend,
                                "has_legend_image": legend_count > 0,
                                "legend_count": legend_count,
                                "legend_fingerprint": _legend_fingerprint(raw_legend),
                                "visual_requirement": "required" if legend_count > 0 else "none",
                            }
                        )
                        continue
                    try:
                        q = q_svc.get_question(tenant_id=int(tenant_id), question_id=q_int, include_legend=True)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "assistant.question_tools.resolve.get_question_failed tenant=%s question_id=%s error=%s",
                            tenant_id,
                            q_int,
                            exc,
                        )
                        continue
                    raw_legend = q.get("legend_images") or []
                    legend_count = len(raw_legend) if isinstance(raw_legend, list) else 0
                    questions.append(
                        {
                            "id": q.get("id"),
                            "sequence_index": q.get("sequence_index"),
                            "page": q.get("page"),
                            "content": q.get("content"),
                            "legend_images": _compact_legend_images(raw_legend),
                            "has_legend_image": legend_count > 0,
                            "legend_count": legend_count,
                            "legend_fingerprint": _legend_fingerprint(raw_legend),
                            "visual_requirement": "required" if legend_count > 0 else "none",
                        }
                    )

                payload = {
                    "status": "ok" if questions or catalog_only else "partial",
                    "workflow": "show_then_describe",
                    "catalog": {
                        "version": catalog_version_cache,
                        "question_count": catalog_payload.get("question_count"),
                        "rows": catalog_rows,
                        "has_more": catalog_payload.get("has_more"),
                    },
                    "resolved_question_ids": ordered_ids,
                    "state_delta": {
                        "active_question_ids": ordered_ids[:3],
                    },
                    "questions": questions,
                    "visual_targets": [
                        {
                            "question_id": q.get("id"),
                            "visual_requirement": q.get("visual_requirement"),
                            "has_legend_image": q.get("has_legend_image"),
                            "legend_count": q.get("legend_count"),
                            "legend_fingerprint": q.get("legend_fingerprint"),
                        }
                        for q in questions
                        if isinstance(q, dict)
                    ],
                }
                tool_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.get("id"),
                        "name": name,
                        "content": json.dumps(payload, ensure_ascii=False),
                    }
                )
                continue

            if name == "show_question_catalog":
                limit_raw = args.get("limit")
                offset_raw = args.get("offset")
                version_raw = args.get("if_none_match_version")
                try:
                    limit = int(limit_raw) if limit_raw is not None else 100
                except (TypeError, ValueError):
                    limit = 100
                try:
                    offset = int(offset_raw) if offset_raw is not None else 0
                except (TypeError, ValueError):
                    offset = 0
                try:
                    if_none_match = int(version_raw) if version_raw is not None else None
                except (TypeError, ValueError):
                    if_none_match = None

                if tenant_id is None or document_id is None:
                    payload = {
                        "error": "missing_scope",
                        "detail": "tenant_id/document_id 缺失，无法查询题目目录",
                    }
                else:
                    payload = agent_svc.get_question_catalog(
                        tenant_id=int(tenant_id),
                        document_id=int(document_id),
                        limit=limit,
                        offset=offset,
                        if_none_match_version=if_none_match,
                    )
                    try:
                        catalog_version_cache = int(payload.get("version"))
                    except (TypeError, ValueError):
                        catalog_version_cache = catalog_version_cache

                tool_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.get("id"),
                        "name": name,
                        "content": json.dumps(payload, ensure_ascii=False),
                    }
                )
                continue

            expected_raw = args.get("expected_catalog_version")
            try:
                expected_catalog_version = int(expected_raw) if expected_raw is not None else None
            except (TypeError, ValueError):
                expected_catalog_version = None

            if expected_catalog_version is not None and tenant_id is not None and document_id is not None:
                if catalog_version_cache is None:
                    meta = agent_svc.get_question_catalog(
                        tenant_id=int(tenant_id),
                        document_id=int(document_id),
                        limit=1,
                        offset=0,
                    )
                    try:
                        catalog_version_cache = int(meta.get("version"))
                    except (TypeError, ValueError):
                        catalog_version_cache = None
                if catalog_version_cache is not None and expected_catalog_version != catalog_version_cache:
                    tool_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.get("id"),
                            "name": name,
                            "content": json.dumps(
                                {
                                    "error": "stale_catalog",
                                    "expected_catalog_version": expected_catalog_version,
                                    "actual_catalog_version": catalog_version_cache,
                                    "hint": "请先调用 show_question_catalog 刷新目录后重试 describe_questions",
                                },
                                ensure_ascii=False,
                            ),
                        }
                    )
                    continue

            # 1) 直接指定的题目 ID
            cand_ids: list[int] = []
            direct_ids = _normalize_int_list(args.get("question_ids"))
            for qid in direct_ids:
                if qid not in cand_ids:
                    cand_ids.append(qid)

            # 2) 通过题目序号映射的题目 ID（既支持 sequence_index 也支持 display_index）
            seq_list = _normalize_int_list(args.get("sequence_indices"))
            for seq in seq_list:
                for candidate in (seq, seq - 1):
                    qid = seq_to_id.get(candidate)
                    if isinstance(qid, int) and qid not in cand_ids:
                        cand_ids.append(qid)

            # 3) 基于题目向量的相似题检索
            base_for_vector: list[int] = []
            base_for_vector.extend(_normalize_int_list(args.get("similar_to_question_ids")))
            base_seq_list = _normalize_int_list(args.get("similar_to_sequence_indices"))
            for seq in base_seq_list:
                for candidate in (seq, seq - 1):
                    qid = seq_to_id.get(candidate)
                    if isinstance(qid, int) and qid not in base_for_vector:
                        base_for_vector.append(qid)

            similar_ids: list[int] = []
            if tenant_id is not None and document_id is not None and base_for_vector:
                try:
                    similar_ids = v_svc.get_similar_questions(
                        tenant_id=int(tenant_id),
                        document_id=int(document_id),
                        base_question_ids=base_for_vector,
                        per_base_limit=4,
                        max_total=8,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.exception(
                        "assistant.question_tools.vector_query_failed tenant=%s document=%s base_ids=%s error=%s",
                        tenant_id,
                        document_id,
                        base_for_vector,
                        exc,
                    )

            for qid in similar_ids:
                try:
                    q_int = int(qid)
                except (TypeError, ValueError):
                    continue
                if q_int not in cand_ids:
                    cand_ids.append(q_int)

            if not cand_ids:
                continue

            # 控制返回数量，避免工具一次性注入过多题目
            limit_raw = args.get("limit")
            try:
                limit = int(limit_raw)
            except (TypeError, ValueError):
                limit = 8
            if limit <= 0:
                limit = 1
            if limit > 12:
                limit = 12

            ordered_ids: list[int] = []
            for qid in cand_ids:
                if len(ordered_ids) >= limit:
                    break
                if qid not in ordered_ids:
                    ordered_ids.append(qid)

            questions: list[dict[str, Any]] = []
            for qid in ordered_ids:
                try:
                    q_int = int(qid)
                except (TypeError, ValueError):
                    continue

                item = id_to_item.get(q_int)
                if item is not None:
                    seq = item.get("sequence_index")
                    page = item.get("page")
                    content = item.get("content")
                    raw_legend = _resolve_legend_source(item)
                    legend_images = _compact_legend_images(raw_legend)
                    questions.append(
                        {
                            "id": q_int,
                            "sequence_index": seq,
                            "page": page,
                            "content": content,
                            "legend_images": legend_images,
                            "has_legend_image": bool(raw_legend),
                        }
                    )
                    continue

                # 如果 snapshot 中没有该题目，则退回到 QuestionService 按 ID 查询
                if tenant_id is None:
                    continue
                try:
                    q = q_svc.get_question(tenant_id=int(tenant_id), question_id=q_int, include_legend=True)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "assistant.question_tools.get_question_failed tenant=%s question_id=%s error=%s",
                        tenant_id,
                        q_int,
                        exc,
                    )
                    continue
                questions.append(
                    {
                        "id": q.get("id"),
                        "sequence_index": None,
                        "page": q.get("page"),
                        "content": q.get("content"),
                        "legend_images": _compact_legend_images(q.get("legend_images") or []),
                        "has_legend_image": bool(q.get("legend_images")),
                    }
                )

            if not questions:
                continue

            tool_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id"),
                    "name": name,
                    "content": json.dumps(
                        {
                            "questions": questions,
                            "catalog_version": catalog_version_cache,
                            "resolved_question_ids": [
                                q.get("id")
                                for q in questions
                                if isinstance(q, dict) and isinstance(q.get("id"), int)
                            ],
                            "state_delta": {
                                "active_question_ids": [
                                    q.get("id")
                                    for q in questions
                                    if isinstance(q, dict) and isinstance(q.get("id"), int)
                                ][:3],
                            },
                        },
                        ensure_ascii=False,
                    ),
                }
            )

    finally:
        db.close()

    return tool_messages
