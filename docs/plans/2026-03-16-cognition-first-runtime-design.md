# Cognition-First Runtime Design

**Date:** 2026-03-16
**Status:** approved for implementation

## Goal

Replace the current query-first agent runtime with a cognition-first runtime that treats dialogue as shared-reference building before evidence retrieval.

## Problem

The current runtime collapses user utterances into retrieval requests too early. It reasons over environment fragments, tool outputs, and counts, but it does not maintain a stable internal understanding of:

- what object the user is referring to
- whether that object is already grounded in the shared scene
- what kind of ambiguity is blocking understanding
- whether the next action should reduce ambiguity or collect evidence

This causes the agent to behave like a retrieval controller instead of a participant in shared understanding.

## Design Principles

1. Shared reference before content
2. Clarification is a normal understanding act, not a fallback
3. Evidence retrieval serves already-bound objects
4. The runtime should preserve unresolved ambiguity as a first-class cognitive state
5. Tools extend perception; they do not replace understanding

## Blackboard Model

The new runtime centers on a `cognitive_blackboard` object. It holds the agent's current understanding, not just technical traces.

### Sections

- `utterances`
  Parsed object expressions, anchors, deictic phrases, and constraints from recent user messages.
- `scene`
  Shared environment summary expressed as visible containers, active objects, and candidate holders.
- `reference_hypotheses`
  Candidate mappings from user expressions to world objects or object containers.
- `ambiguities`
  Unresolved reference or interpretation tensions, such as container ambiguity, missing anchor, modality gap, or capability gap.
- `beliefs`
  The agent's current best understanding of the user's intended object and what remains unproven.
- `epistemic_tension`
  Why understanding is still incomplete.
- `action_intents`
  Candidate actions described by what uncertainty they reduce, not by tool names.
- `interaction_commitment`
  Whether the agent is ready to answer, must clarify, or should gather more evidence.

## Runtime Shape

The external runtime API stays stable. The internal loop changes.

### Per turn

1. Observe the shared scene
2. Build or update the blackboard
3. Present the model with:
   - observation
   - cognitive blackboard
   - decision contract
4. Let the model choose an action
5. Apply the result back into the blackboard

## Action Philosophy

The runtime stops framing decisions as "which tool should I call next".

Instead, actions are interpreted as:

- reduce reference ambiguity
- inspect the current shared scene
- gather evidence about a bound object
- interpret visual or structural evidence
- ask the user to complete shared reference
- answer only when shared understanding is stable enough

## Migration Strategy

### Phase 1

Introduce `cognitive_blackboard` into runtime state and change `memory_sync` output to cognition-first model input.

### Phase 2

Update decision prompts and tool traces so the model reasons over blackboard state instead of environment fragments.

### Phase 3

Replace remaining world-model-first heuristics with blackboard updates derived from tool outcomes and user clarifications.

### Phase 4

Use the blackboard as the canonical source for clarification decisions, stopping conditions, and answer-readiness checks.

## Success Criteria

The redesign is successful when:

1. The model input explicitly represents unresolved reference ambiguity.
2. The agent distinguishes "understanding incomplete" from "evidence missing".
3. Clarification arises naturally from blackboard state, not from ad hoc retrieval rules.
4. Multi-document ambiguity becomes a general consequence of shared reference failure, not a case-specific branch.
