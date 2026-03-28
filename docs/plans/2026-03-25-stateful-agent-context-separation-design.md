# Stateful Agent Context Separation Design

**Date:** 2026-03-25

**Goal:** Remove replay-driven prompt growth by separating human-visible conversation, runtime execution trace, and reusable evidence memory into different state surfaces. This redesign targets the actual root causes observed in production logs rather than hiding them with dedupe patches or prompt truncation.

## Problem Statement

Recent production traces show three structural failures:

1. Follow-up requests still re-enter the graph with `ingress_len > 1`, meaning prior turns are being resent as new ingress.
2. Persisted runtime `messages` contain both human-visible conversation and execution-only assistant/tool trace items, so overlap merging no longer operates on a single semantic sequence.
3. Working-set carryforward can still include raw multimodal image parts, causing follow-up turns to rehydrate visual payloads even when the previous turn already derived the relevant fact.

These are not isolated bugs. They are symptoms of one design problem: the runtime treats one `messages` list as transcript, execution log, persistence source, and future decision context at the same time.

## Design Principles

This redesign follows 2025-2026 agent runtime trends:

- keep continuity in state, not transcript replay
- isolate raw artifacts from model-visible context
- carry forward derived observations, not raw multimodal payloads
- project only the minimum decision context into the model
- keep conversation persistence and runtime persistence on separate contracts

## Target State

The runtime must separate state into four layers.

### 1. Conversation Transcript

Human-visible conversation only:

- user turns
- assistant natural-language answers
- user clarification submissions

Explicitly excluded:

- assistant tool-call stubs
- tool receipts
- tool result payloads
- carryforward working-set blobs

This transcript is the only surface persisted into `agent_messages` and the only surface used to compute new ingress overlap.

### 2. Execution Trace

Execution-only graph state:

- assistant tool-call stubs
- tool receipts
- transient tool observations
- current-turn orchestration state

This state is useful for intra-turn continuation, but it is not part of the visible conversation and must not be persisted as transcript history.

### 3. Evidence Memory

Reusable evidence state:

- artifact references
- compact text evidence
- derived visual observations
- working set selection metadata

This memory is the continuity layer for follow-up reasoning.

### 4. Artifact Store

Heavy raw payloads:

- images
- full multimodal tool output
- long snippet bodies
- debug payloads

Artifacts remain available for explicit rehydration, but never become the default carryforward surface.

## Contract Changes

### Transcript Contract

Add a dedicated `conversation_messages` state field.

- `conversation_messages` is the canonical human-visible conversation.
- `messages` remains execution-local runtime state.
- graph prepare merges `conversation_messages + ingress_messages`
- graph persistence returns `conversation_messages`

### Ingress Contract

Ingress overlap must be computed only against persisted `conversation_messages`, never against execution trace.

This removes the current semantic mismatch where transcript overlap is computed against a database polluted by empty assistant tool-call stubs and replayed answers.

### Execution Contract

Tool execution may update `messages`, but must not update `conversation_messages` unless a human-visible assistant reply is emitted.

Human-visible updates are limited to:

- final assistant answer
- user clarification input rendered back into conversation

### Evidence Contract

Evidence memory splits into:

- `artifact_content`: raw multimodal payload
- `summary_content`: compact text-only reusable summary
- `observation_memory`: derived reusable facts, including visual facts

Raw images must not enter default working-set carryforward.
Instead, follow-up turns should consume derived visual observations such as coordinates, labels, object bindings, or extracted chart facts.

## Implementation Plan

### Phase 1: Conversation / Execution Separation

- add `conversation_messages` to graph state
- make `prepare` rebuild execution-local `messages` from transcript + ingress
- stop persisting execution-only assistant/tool items as transcript
- make router persistence consume `conversation_messages`
- make stream updates surface `conversation_messages`

### Phase 2: Evidence Memory Separation

- introduce explicit derived observation memory for reusable visual facts
- stop carrying raw image parts in `summary_content`
- keep images in `artifact_content` only
- update working-set selection to consume derived observation memory

### Phase 3: Decision Projection Tightening

- ensure `decide` consumes bounded `message_window`
- keep `decision_projection` structured and bounded
- tighten tool exposure based on environment + evidence state

## Non-Goals

This design does not rely on:

- hand-written duplicate filtering
- prompt truncation as the primary fix
- image bans without derived visual memory
- special handling for this single test scenario

## Acceptance Criteria

The redesign is correct when:

1. follow-up turns enter with only the new user turn as ingress
2. persisted transcript contains no empty assistant tool-call placeholders
3. persisted transcript contains no duplicated prior question/answer pairs
4. execution trace remains available within a turn without polluting persisted conversation
5. follow-up visual reasoning reuses derived visual observations instead of replaying raw image parts by default
