# Agentic Runtime Acceptance Checklist Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace subjective "agentic" claims with hard acceptance gates that prevent this project from shipping another workflow disguised as an agent.

**Architecture:** The runtime must be agent-led and guardrail-bounded. Engineering owns permissions, budgets, persistence, audit, and transport. The agent owns next-action choice, plan revision, evidence use, learner adaptation, and stop decisions inside those boundaries. Agent cognition trace must be authored by the agent itself and rendered directly by the frontend without hardcoded stage prose or backend-generated fake cognition.

**Tech Stack:** FastAPI, LangGraph runtime container, LangChain/OpenAI-compatible tool calling, Postgres persistence, SSE streaming, React frontend, pytest

---

### Task 1: Freeze the agent-vs-workflow definition in repository docs

**Files:**
- Create: `docs/architecture/agentic-runtime-acceptance.md`
- Modify: `docs/plans/2026-03-11-langgraph-agent-runtime-rebuild-plan.md`
- Modify: `docs/plans/2026-02-25-agentic-learning-coach-one-shot-design.md`

**Step 1: Write the non-negotiable definition**

Document these rules:
- The runtime fails review if engineering code decides the main next action for normal turns.
- The runtime fails review if fixed node order carries business intent.
- The runtime fails review if the model only emits `tool_calls` without explicit decision state.
- The runtime fails review if the frontend trace is inferred from prose or hardcoded phase labels.
- The runtime fails review if tool failure escapes as graph failure instead of agent-observed error.

**Step 2: Add an authority matrix**

Write a table with two columns:
- `Engineering decides`
- `Agent decides`

Required examples:
- Engineering decides permissions, ACL, budgets, session isolation, storage boundaries, transport schema, approval requirements.
- Agent decides diagnose vs ask vs explain vs retrieve vs test vs wait vs stop.

**Step 3: Add a learning-coach fit statement**

State explicitly:
- A learning coach is an open-ended, context-sensitive, long-running agent problem.
- A workflow-first architecture is rejected for this domain.
- LangGraph may be used as a runtime container only if it does not become the decision-maker.

**Step 4: Review old planning docs**

Update the two existing plan documents so they point to the new acceptance doc as the governing standard.

**Step 5: Commit**

```bash
git add docs/architecture/agentic-runtime-acceptance.md docs/plans/2026-03-11-langgraph-agent-runtime-rebuild-plan.md docs/plans/2026-02-25-agentic-learning-coach-one-shot-design.md
git commit -m "docs: define project agentic runtime acceptance standard"
```

### Task 2: Define the minimum runtime state an agentic coach must own

**Files:**
- Modify: `backend/app/assistant_graph/state.py`
- Create: `backend/tests/assistant_graph/test_agentic_runtime_contract.py`
- Modify: `backend/tests/assistant_graph/test_state_world_model.py`

**Step 1: Write failing state contract tests**

Add tests requiring these fields to exist in the primary runtime state:
- `goal`
- `learner_model`
- `active_plan`
- `open_questions`
- `decision_log`
- `observations`
- `tool_history`
- `memory_refs`
- `halt_reason`
- `approval_state`

Reject implementations where business meaning lives only in `messages`.

**Step 2: Write failing reducer tests**

Require:
- `decision_log` appends
- `observations` append
- `learner_model` updates structurally
- `active_plan` can be replaced by replan
- `halt_reason` is explicit and not implied by missing tool calls

**Step 3: Implement the state contract**

Refactor the state so the graph runs on one primary runtime state that carries learner context, reasoning artifacts, and tool outcomes as first-class data.

**Step 4: Run focused tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agentic_runtime_contract.py backend/tests/assistant_graph/test_state_world_model.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/state.py backend/tests/assistant_graph/test_agentic_runtime_contract.py backend/tests/assistant_graph/test_state_world_model.py
git commit -m "test: lock agentic runtime state contract"
```

### Task 3: Replace tool-call-only planning with explicit decision objects

**Files:**
- Modify: `backend/app/assistant_graph/agent_graph.py`
- Create: `backend/app/assistant_graph/schemas/decision_schema.py`
- Modify: `backend/tests/assistant_graph/test_agent_graph_runtime.py`

**Step 1: Write failing decision tests**

Require each turn to produce a structured decision with:
- `turn_goal`
- `situation_assessment`
- `next_intent`
- `selected_actions`
- `why_now`
- `expected_observation`
- `stop_condition`

Reject runs where the only machine-readable planning artifact is `tool_calls`.

**Step 2: Refactor the model contract**

The model must first decide among actions such as:
- `ask_user`
- `explain`
- `probe_understanding`
- `retrieve_evidence`
- `inspect_workspace`
- `assign_exercise`
- `reflect`
- `stop`

Tool requests become a consequence of the decision, not the decision itself.

**Step 3: Refactor graph transitions**

Transitions may still exist as runtime plumbing, but they must route on explicit decision state rather than hardcoded business flow.

**Step 4: Run graph tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_graph_runtime.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/agent_graph.py backend/app/assistant_graph/schemas/decision_schema.py backend/tests/assistant_graph/test_agent_graph_runtime.py
git commit -m "refactor: make explicit decisions primary runtime artifact"
```

### Task 4: Make tool failure an observation, not a graph-ending exception

**Files:**
- Modify: `backend/app/assistant_graph/agent_tools.py`
- Modify: `backend/app/assistant_graph/tool_runtime.py`
- Modify: `backend/tests/assistant_graph/test_agent_tool_contract.py`
- Modify: `backend/tests/services/test_qwen_client.py`

**Step 1: Write failing failure-path tests**

Require:
- tool exceptions become structured `tool_failed` records
- the agent receives normalized error observations
- graph execution continues unless policy explicitly halts
- protocol/model mismatch is caught before external request when possible

**Step 2: Implement normalized tool outcomes**

Each tool execution must return:
- `status`
- `error_type`
- `error_message`
- `retryable`
- `observation`
- `state_delta`
- `display_payload`

**Step 3: Add provider guardrails**

Validate embedding model and endpoint compatibility before issuing requests. Fail fast with actionable error records instead of raw provider 404 bubbling through the graph.

**Step 4: Run focused tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_tool_contract.py backend/tests/services/test_qwen_client.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/agent_tools.py backend/app/assistant_graph/tool_runtime.py backend/tests/assistant_graph/test_agent_tool_contract.py backend/tests/services/test_qwen_client.py
git commit -m "fix: convert tool failures into agent-observable runtime events"
```

### Task 5: Define an agent-authored cognition trace protocol and ban pseudo-trace rendering

**Files:**
- Modify: `backend/app/assistant_graph/router_runtime.py`
- Modify: `backend/app/routers/agent_v2.py`
- Modify: `frontend/src/hooks/useAgentChat.ts`
- Modify: `frontend/src/components/AgentChatPanel.tsx`
- Create: `backend/tests/assistant_graph/test_agent_trace_protocol.py`
- Create: `frontend/src/__tests__/agentTraceRendering.test.tsx`

**Step 1: Write failing backend transport tests**

Require the backend to transport first-class agent-authored cognition payloads for:
- goal update
- decision
- action rationale
- observation interpretation
- reflection
- plan revision
- halt rationale

Reject streams that fabricate trace from assistant prose, node names, or backend-inferred stages.

**Step 2: Write failing frontend rendering tests**

Require the frontend to:
- render trace only from agent-authored cognition payloads
- show rationale, observation, and halt reason when present
- stop using hardcoded phase text as fake cognition

**Step 3: Implement the transport contract**

Create a typed transport schema for cognition trace frames. Each frame must include:
- `trace_type`
- `run_id`
- `turn_id`
- `timestamp`
- `agent_payload`

The backend may add transport metadata, but it must not synthesize cognition content on the agent's behalf.

**Step 4: Implement frontend rendering**

Render trace cards from real agent-authored trace data. If no trace exists, render nothing instead of synthetic stage prose.

**Step 5: Run focused tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_trace_protocol.py -q`

Run: `frontend\...` with the repository's frontend test command for `agentTraceRendering.test.tsx`

Expected: PASS

**Step 6: Commit**

```bash
git add backend/app/assistant_graph/router_runtime.py backend/app/routers/agent_v2.py frontend/src/hooks/useAgentChat.ts frontend/src/components/AgentChatPanel.tsx backend/tests/assistant_graph/test_agent_trace_protocol.py frontend/src/__tests__/agentTraceRendering.test.tsx
git commit -m "feat: add agent-authored cognition trace transport and rendering"
```

### Task 6: Add review gates that block workflow regressions

**Files:**
- Create: `docs/reviews/agentic-runtime-review-checklist.md`
- Modify: `backend/tests/assistant_graph/test_agent_graph_runtime.py`
- Modify: `backend/tests/assistant_graph/test_agent_trace_protocol.py`

**Step 1: Write the review checklist**

Every future change must answer:
- What does the agent decide here?
- What does engineering constrain here?
- Could this branch be removed and replaced by agent decision state?
- Does any UI element pretend to show cognition without backend evidence?
- What happens when the main tool path fails?

**Step 2: Add regression tests**

Add tests that fail if:
- core action routing is hardcoded by user intent keywords
- the graph terminates just because no `tool_calls` were returned
- frontend trace text appears without a matching backend trace event

**Step 3: Run regression tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_graph_runtime.py backend/tests/assistant_graph/test_agent_trace_protocol.py -q`

Expected: PASS

**Step 4: Commit**

```bash
git add docs/reviews/agentic-runtime-review-checklist.md backend/tests/assistant_graph/test_agent_graph_runtime.py backend/tests/assistant_graph/test_agent_trace_protocol.py
git commit -m "test: add workflow regression review gates"
```

### Task 7: Validate with scenario-based acceptance, not implementation trivia

**Files:**
- Create: `docs/testing/agentic-learning-coach-acceptance.md`
- Create: `backend/tests/acceptance/test_learning_coach_agentic_behavior.py`

**Step 1: Write scenario acceptance cases**

Cover at least these cases:
- learner is confused and the agent chooses to probe before explaining
- learner already understands basics and the agent skips redundant teaching
- retrieval tool fails and the agent recovers or changes strategy
- evidence is sufficient and the agent stops naturally
- user asks an ambiguous goal and the agent asks a clarifying question instead of guessing

**Step 2: Write the failing acceptance tests**

The assertions should inspect decisions and trace events, not only final text.

**Step 3: Run acceptance tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/acceptance/test_learning_coach_agentic_behavior.py -q`

Expected: PASS

**Step 4: Commit**

```bash
git add docs/testing/agentic-learning-coach-acceptance.md backend/tests/acceptance/test_learning_coach_agentic_behavior.py
git commit -m "test: add learning coach agentic acceptance scenarios"
```
