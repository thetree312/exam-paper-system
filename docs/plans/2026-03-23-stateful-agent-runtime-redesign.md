# Stateful Agent Runtime Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace replay-heavy agent prompt assembly with a stateful runtime contract that keeps model-visible context bounded while preserving tool usefulness and evidence reuse.

**Architecture:** The runtime will stop treating `messages` as the canonical storage layer for tool results and reusable evidence. Instead, server state will store full artifacts, model-visible messages will carry only bounded observations and receipts, and evidence reuse will flow through compact handles/summaries instead of replaying full multimodal payloads.

**Tech Stack:** Python, FastAPI backend, LangGraph runtime, DashScope/Qwen client, pytest.

---

## Requirements Summary

- Keep current agent behavior functionally intact: the agent must still reason over recent tool observations and continue multi-step tool calling.
- Eliminate prompt growth caused by replaying tool payloads, growing environment snapshots, and full evidence carryforward.
- Preserve multimodal evidence capability in runtime state, but stop using raw multimodal evidence as the default carryforward path.
- Align the runtime with 2025-2026 stateful agent patterns: provider-backed cache/session semantics, compact model-visible observations, and artifact/handle separation.
- Avoid a partial patchwork architecture. The redesign should establish a new contract that future work can build on directly.

## Root Cause

Current runtime cost comes from architectural replay, not user content:

- every `decide` call sends the full tool schema set
- tool calls and tool results are appended back into `messages`
- evidence frames are re-expanded into assistant/tool messages with full `content`
- `_build_model_snapshot()` turns runtime state into an ever-growing natural-language system block
- explicit cache markers only cover string `system/user` messages, missing the most expensive repeated assistant/tool blocks

## Target-State Runtime Contract

### 1. Split Runtime Data Into Three Layers

1. `messages`
   - only human conversation
   - assistant response text
   - assistant tool-call stubs
   - compact tool receipts

2. `runtime artifacts`
   - full tool outputs
   - evidence content
   - multimodal assets
   - debug/trace payloads
   - never replayed by default into model messages

3. `decision packet`
   - compact state snapshot used for the next model decision
   - bounded by explicit field budgets
   - no unbounded natural-language accumulation

### 2. Tool Result Contract

Each tool execution produces:

- `history_msg`
  - compact receipt only
  - stable schema for replay and audit
- `transient_msg`
  - bounded model-visible observation
  - no heavy evidence bodies
- `artifact`
  - full raw payload retained in runtime state/storage only

The default model-visible observation must include only:

- `tool_name`
- `status`
- `query`
- `summary`
- `answerability`
- `target_resolution`
- `source_refs`
- optional `artifact_ref`

### 3. Evidence Reuse Contract

The evidence register stores reusable evidence frames with two distinct surfaces:

- `summary_content`
  - compact carryforward payload for model reuse
- `artifact_content`
  - full multimodal payload retained server-side

Carryforward must default to `summary_content`.
Full multimodal evidence can still be re-materialized when a later step explicitly requires it, but must not be the default path.

### 4. Prompt Assembly Contract

Each model decision input is assembled from:

- primary system instruction
- compact decision packet system message
- current user-visible conversation
- recent compact tool observations
- at most a small number of carryforward evidence summaries
- dynamically selected tool subset

The following are explicitly excluded from default prompt assembly:

- raw tool payloads
- full evidence JSON blobs
- repeated multimodal asset payloads
- unbounded memory summaries

### 5. Cache Contract

Explicit cache markers must cover the highest-reuse prompt segments, not only plain `system/user` strings.

The client should cache-mark:

- string messages for `system`, `user`, `assistant`, `tool`
- text parts inside list-based content for `system`, `user`, `assistant`, `tool`
- bounded assistant/tool receipts that recur across retries/continuations

This does not replace the long-term goal of moving to provider-native session state, but it aligns the current transport with provider capabilities now.

## Key Decisions

### Decision 1: Compact Observations Replace Raw Replay

- Chosen: replay only compact tool receipts and compact carryforward evidence summaries
- Rejected: replay full tool outputs and rely on cache to make them affordable
- Reason: cache does not fix token pressure from mutable payloads and large evidence content

### Decision 2: Evidence Register Remains the Reuse Backbone

- Chosen: keep `evidence_register`, but change it to hold separate summary/artifact surfaces
- Rejected: remove evidence register and force tools to re-read everything
- Reason: the register is useful; the problem is what gets replayed from it

### Decision 3: Bounded Structured State Replaces Growing Natural-Language Snapshot

- Chosen: keep a compact system snapshot, but treat it as a bounded decision packet
- Rejected: keep appending more prose to `_build_model_snapshot()`
- Reason: state should be structured and budgeted, not treated as free-form transcript

## Risks And Mitigations

- Risk: the model loses useful visual detail after evidence compaction.
  - Mitigation: retain full multimodal `artifact_content` in register/state and enable explicit re-materialization paths later.
- Risk: compact observations become too lossy.
  - Mitigation: make summary schema explicit and test for preserved `source_refs`, `answerability`, and `target_resolution`.
- Risk: current tests encode old multimodal carryforward behavior.
  - Mitigation: rewrite tests to assert the new contract directly instead of old replay behavior.

## Implementation Slice In This Change

This implementation starts the new architecture immediately with the following hard changes:

1. expand explicit cache markers beyond plain string `system/user`
2. make carryforward evidence summary-first instead of full-content-first
3. add explicit summary/artifact separation inside evidence frames
4. keep compact receipts as the only persisted replay form for tool history
5. update tests to encode the new contract

This slice does not yet migrate to DashScope Responses API or provider-backed session state. It establishes the runtime contract required for that migration.

## Task 1: Lock The New Contract With Tests

**Files:**
- Modify: `backend/tests/services/test_qwen_client_stream_contract.py`
- Modify: `backend/tests/assistant_graph/test_evidence_register_runtime.py`
- Modify: `backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py`

Add tests for:

- cache markers applied to assistant/tool text content
- carryforward evidence uses compact summary text instead of full multimodal content
- evidence frames preserve full artifact content separately from carryforward summary

## Task 2: Update Qwen Client Cache Semantics

**Files:**
- Modify: `backend/app/services/qwen_client.py`

Implement:

- content-part-aware cache marker injection
- assistant/tool eligibility for cache marking
- bounded marker count preserved

## Task 3: Update Evidence Register Contract

**Files:**
- Modify: `backend/app/agent/assistant_graph/evidence_register.py`

Implement:

- `summary_content` generation for reusable carryforward
- `artifact_content` retention for full evidence payloads
- summary-first `select_carryforward_evidence_messages()`

## Task 4: Update Runtime Tool Packaging

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`
- Modify: `backend/app/agent/assistant_graph/runtime_nodes.py`

Implement:

- tool execution keeps compact history receipts
- transient model observation stays bounded
- evidence register stores artifact-rich frames but prompt assembly uses summary carryforward

## Task 5: Verification

**Files:**
- Test: `backend/tests/services/test_qwen_client_stream_contract.py`
- Test: `backend/tests/assistant_graph/test_evidence_register_runtime.py`
- Test: `backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py`

Run focused pytest coverage for the changed contract and confirm failures are limited to expected behavior changes.
