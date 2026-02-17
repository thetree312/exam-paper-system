from __future__ import annotations

from typing import Annotated, List, Literal, TypedDict, Any


def _append_events(existing: list | None, new_items: list | None) -> list:
    acc = list(existing or [])
    if new_items:
        acc.extend(new_items)
    return acc


def _replace_messages(existing: List["AgentMessageEntry"] | None, new_items: List["AgentMessageEntry"] | None) -> List["AgentMessageEntry"]:
    """Use latest full message list as canonical state.

    在本图中，多数节点会返回 dict(state)（全量状态）；
    若 messages 使用 append reducer，会把同一历史反复拼接导致指数级重复。
    这里改为“覆盖语义”：有新值则直接替换，无新值保留旧值。
    """

    if new_items is None:
        return list(existing or [])
    return list(new_items)


class AgentMessageEntry(TypedDict):
    """统一的对话消息结构，兼容旧版 Agent 接口。"""

    role: Literal["system", "user", "assistant"]
    content: str


class AgentState(TypedDict, total=False):
    """新版多 Agent 学习助手的状态结构。

    注意：不再包含任何 supervisor_* / solver_* / batch_config_* 字段。
    """

    # 会话 / 用户维度
    tenant_id: int
    user_id: int
    ui_context: str
    session_id: int | None
    messages: Annotated[List[AgentMessageEntry], _replace_messages]
    dialogue_window: List[AgentMessageEntry]

    # 用户画像与会话记忆
    user_profile: dict | None
    session_memory: dict | None
    history_summary: str | None
    # 对话摘要的增量指针：记录 messages 中已经被纳入 history_summary 的下标（左闭索引）
    summary_upto: int | None
    # 实体/原子事实索引，后续可用于更细粒度的长期记忆
    entities: dict | None
    # 语义回填得到的长期记忆摘要与事实列表
    hydrated_summary: str | None
    hydrated_facts: list | None

    # 文档 / 内容上下文
    document_id: int | None
    document_title: str | None
    doc_context: str | None
    # 从入口注入的题目快照（旧结构），用于构造 snapshot_items
    snapshot_questions: list
    # 统一承载题目/文档块/笔记等的新结构
    snapshot_items: list
    vision_assets: list
    vision_observations: list | None
    # 结构化视觉证据：按 question_id 维护可复用的视觉观察状态
    vision_evidence: list | None

    # 题目工作集（仅包含题目 ID，实际全文内容仍由 snapshot_questions/snapshot_items 承载）
    # - active_question_ids: 当前本轮需要重点关注的题目集合，长度保持在常数级（例如 1~3）；
    # - recent_question_ids: 近期对话中提及过的题目 LRU 列表，用于处理“前面那题”等模糊指代。
    active_question_ids: list
    recent_question_ids: list

    # Agent 协作 / 任务板
    active_agent: str | None
    next_agent: str | None
    agent_scratchpad: dict | None
    task_board: dict | None

    # 工具调用 & 中断
    pending_tools: list
    last_tool_results: list
    pending_interrupt: dict | None
    tool_execution_report: dict | None

    # Exercise 相关计划与配置
    exercise_plan: dict | None
    exercise_batch_config: dict | None
    exercise_need_batch_config: bool

    # UI / 流式相关
    ag_ui_events: Annotated[list, _append_events]
    ag_ui_prompt_events: Annotated[list, _append_events]
    run_id: str | None
    thread_id: str | None
    skip_model: bool

    # 最终输出
    assistant_reply: str | None

    # 便笺 / 笔记聚焦
    note_focus: dict | None
    note_context_text: str | None

    # 最近一次被替换的题目快照，供前端高亮使用
    latest_replaced_question: dict | None


__all__ = [
    "AgentMessageEntry",
    "AgentState",
    "_append_events",
    "_replace_messages",
]
