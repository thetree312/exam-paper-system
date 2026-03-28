# Tool Exposure Infrastructure Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the duplicated tool-selection helpers with a single tool exposure infrastructure built around registry, contracts, policy, deferred namespace expansion, and unified meta-tool execution.

**Architecture:** The current runtime chooses individual tool schemas directly from `runtime_bootstrap.py` and `runtime_common.py`, which has already produced contract drift and behavior regressions. The new design centralizes tool metadata in a registry, computes namespace exposure from runtime state, expands only the currently-exposed namespaces into concrete schemas, and executes meta tools through one shared contract so selection and execution cannot drift.

**Tech Stack:** Python, LangGraph runtime nodes, existing tool handlers, pytest

---

### Task 1: Add tool contracts and registry

**Files:**
- Create: `backend/app/agent/tools/tool_contracts.py`
- Create: `backend/app/agent/tools/tool_registry.py`
- Modify: `backend/app/agent/tools/types.py`
- Modify: `backend/app/agent/tools/registry.py`
- Test: `backend/tests/assistant_graph/test_tool_exposure_infrastructure.py`

### Task 2: Add exposure policy and namespace expansion

**Files:**
- Create: `backend/app/agent/assistant_graph/tool_policy.py`
- Create: `backend/app/agent/assistant_graph/tool_expansion.py`
- Test: `backend/tests/assistant_graph/test_tool_exposure_infrastructure.py`

### Task 3: Unify meta-tool contract and execution

**Files:**
- Create: `backend/app/agent/assistant_graph/tool_runtime.py`
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`
- Modify: `backend/app/agent/assistant_graph/runtime_common.py`
- Test: `backend/tests/assistant_graph/test_tool_exposure_infrastructure.py`

### Task 4: Cut decision and execution over to the new infrastructure

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`
- Modify: `backend/app/agent/assistant_graph/runtime_nodes.py`
- Modify: `backend/app/agent/assistant_graph/runtime_common.py`
- Test: `backend/tests/assistant_graph/test_dynamic_tool_selection.py`
- Test: `backend/tests/assistant_graph/test_tool_exposure_infrastructure.py`

### Task 5: Verify runtime-adjacent regressions

**Files:**
- Test: `backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py`
- Test: `backend/tests/assistant_graph/test_evidence_register_runtime.py`
- Test: `backend/tests/services/test_qwen_client_stream_contract.py`
