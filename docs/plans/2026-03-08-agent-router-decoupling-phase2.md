# Agent Router Decoupling (Phase 2) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 `agent_v2` 中剩余 Agent 主链路编排逻辑继续从路由层剥离，路由只保留 HTTP 边界职责。

**Architecture:** 在不改变行为的前提下，把 `/run`、`/run-stream`、`/run-resume`、`/run-resume-stream` 的重复编排逻辑沉到 service 层；图调用、线程上下文、流式输出合并为统一调用器。路由层只负责参数接收、scope 校验、返回结构封装。

**Tech Stack:** FastAPI, SQLAlchemy, LangGraph, Pytest

---

### Task 1: 抽离 Resume 上下文解析

**Files:**
- Modify: `backend/app/services/agent_runtime_bootstrap_service.py`
- Modify: `backend/app/routers/agent_v2.py`
- Test: `backend/tests/assistant_graph/test_router_source_binding_and_human_io.py`

**Step 1: Write the failing test**

```python
def test_resolve_resume_context_session_scope_mismatch_raises():
    ...
```

**Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py -k resume_context`
Expected: FAIL with missing function/behavior.

**Step 3: Write minimal implementation**

在 `agent_runtime_bootstrap_service.py` 新增：
- `resolve_resume_runtime_context(...)`
- 负责 session/thread 解析与 workroom scope 校验

**Step 4: Route wiring**

在 `agent_v2.py` 的 `agent_run_resume` 和 `agent_run_resume_stream` 改为调用 service，删除重复代码。

**Step 5: Run tests**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py`
Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/services/agent_runtime_bootstrap_service.py backend/app/routers/agent_v2.py backend/tests/assistant_graph/test_router_source_binding_and_human_io.py
git commit -m "refactor: extract resume runtime context from agent router"
```

### Task 2: 抽离 Run/Run-Stream 公共调用编排

**Files:**
- Create: `backend/app/services/agent_invocation_service.py`
- Modify: `backend/app/routers/agent_v2.py`
- Test: `backend/tests/assistant_graph/test_router_source_binding_and_human_io.py`

**Step 1: Write the failing test**

```python
def test_build_agent_base_state_contains_required_runtime_fields():
    ...
```

**Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py -k base_state`
Expected: FAIL with missing builder/service.

**Step 3: Write minimal implementation**

在 `agent_invocation_service.py` 新增：
- `build_agent_base_state(...)`
- `build_agent_stream_thread_context(...)`
- 保持 `session_memory/loaded_tools/tool_search_history/loop_budget` 语义不变

**Step 4: Route wiring**

`agent_run` 与 `agent_run_stream` 改为调用新 service 组装 state/config，删除重复组装段。

**Step 5: Run tests**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py tests/assistant_graph/test_persist_continuation_summary.py`
Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/services/agent_invocation_service.py backend/app/routers/agent_v2.py backend/tests/assistant_graph/test_router_source_binding_and_human_io.py
git commit -m "refactor: move run invocation assembly out of agent router"
```

### Task 3: 抽离 note_focus 领域组装

**Files:**
- Create: `backend/app/services/note_focus_service.py`
- Modify: `backend/app/routers/agent_v2.py`
- Test: `backend/tests/assistant_graph/test_router_source_binding_and_human_io.py`

**Step 1: Write the failing test**

```python
def test_resolve_note_focus_returns_note_context_and_state():
    ...
```

**Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py -k note_focus`
Expected: FAIL.

**Step 3: Write minimal implementation**

在 `note_focus_service.py` 封装：
- `resolve_note_focus(...)`
- 内部调用 `DocumentReadTool.read_span(...)`
- 输出 `note_focus_state` + `note_context_text`

**Step 4: Route wiring**

`agent_run` 中移除直接 `DocumentReadTool` 逻辑，改为调用新 service。

**Step 5: Run tests**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py`
Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/services/note_focus_service.py backend/app/routers/agent_v2.py backend/tests/assistant_graph/test_router_source_binding_and_human_io.py
git commit -m "refactor: extract note focus resolution from agent router"
```

### Task 4: 提供统一 Scope 校验服务

**Files:**
- Create: `backend/app/services/workroom_scope_service.py`
- Modify: `backend/app/routers/agent_v2.py`
- Test: `backend/tests/assistant_graph/test_router_source_binding_and_human_io.py`

**Step 1: Write the failing test**

```python
def test_assert_workspace_document_scope_not_in_workroom_raises():
    ...
```

**Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py -k workroom_scope`
Expected: FAIL.

**Step 3: Write minimal implementation**

在 `workroom_scope_service.py` 新增：
- `assert_workroom_scope(...)`
- `assert_workspace_document_scope(...)`

**Step 4: Route wiring**

路由改为调用 service；删除 `_assert_workroom_scope` 与 `_assert_workspace_document_scope` 私有函数。

**Step 5: Run tests**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py tests/assistant_graph/test_persist_continuation_summary.py`
Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/services/workroom_scope_service.py backend/app/routers/agent_v2.py backend/tests/assistant_graph/test_router_source_binding_and_human_io.py
git commit -m "refactor: move workroom scope checks to dedicated service"
```

### Task 5: 清理与回归

**Files:**
- Modify: `backend/app/routers/agent_v2.py`
- Test: `backend/tests/assistant_graph/*.py`

**Step 1: Remove dead imports and dead helpers**

移除 `agent_v2.py` 中未使用 import/helper（例如 `atexit`、`os`、日志重复辅助）。

**Step 2: Full targeted regression**

Run:

```bash
.\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_router_source_binding_and_human_io.py tests/assistant_graph/test_persist_continuation_summary.py tests/assistant_graph/test_context_init_world_snapshot.py tests/assistant_graph/test_execution_runtime_world_changes.py tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py
```

Expected: PASS.

**Step 3: Commit**

```bash
git add backend/app/routers/agent_v2.py backend/tests/assistant_graph
git commit -m "chore: clean router residue and verify agent graph regression"
```

