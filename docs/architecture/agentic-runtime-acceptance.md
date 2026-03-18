# Agentic Runtime Acceptance Standard

Last updated: 2026-03-12

This document defines the minimum bar for calling this system an agentic learning coach. If an implementation fails these checks, it is a workflow or a pseudo-agent, not an agent.

## Non-negotiable rules

The runtime fails review if any of the following is true:

1. Engineering code decides the main next action for normal turns.
2. A fixed node order carries the business meaning of the turn.
3. The model only emits `tool_calls` and does not emit explicit decision state.
4. Tool failure escapes as a graph failure instead of becoming an agent-observed error.
5. The frontend shows "thinking" or "trace" inferred from prose, node names, or hardcoded phase labels.
6. Backend code translates runtime steps into fake cognition instead of transporting agent-authored cognition.

## Authority matrix

| Engineering decides | Agent decides |
| --- | --- |
| Permissions and tool ACL | Whether to ask, explain, retrieve, test, reflect, wait, or stop |
| Resource budgets and rate limits | What the current goal means in this turn |
| Session isolation and persistence boundaries | What information is missing |
| Storage schema and transport contracts | Which actions are worth taking next |
| Human approval requirements | How to revise the plan after new observations |
| Error containment and retry policy | Whether evidence is sufficient to continue or stop |

## Learning coach fit

A learning coach is an open-ended, context-sensitive, long-running agent problem.

That means:

- The agent must adapt to learner state, not replay a fixed turn sequence.
- The agent must perceive environment changes and update its own understanding.
- The agent must be able to ask questions, change strategy, and stop naturally.

A workflow-first architecture is rejected for this domain.

LangGraph may be used as a runtime container, but it must not become the decision-maker. The graph may carry state and transport control, while the agent owns goal interpretation, strategy choice, observation integration, replanning, and stop decisions.

## Trace standard

The system has two different kinds of signals:

1. Runtime telemetry
   This is engineering data such as request start, request end, latency, retries, and persistence status.

2. Agent cognition trace
   This is agent-authored content such as goal understanding, current hypothesis, action rationale, observation interpretation, plan revision, and stop rationale.

The frontend trace for the learning coach must be rendered from agent-authored cognition trace, not reconstructed from telemetry, node names, or hardcoded UI copy.

## Required agent-owned artifacts

The runtime must carry, at minimum, agent-owned state for:

- current goal
- learner model
- active plan
- open questions
- decision log
- observations
- tool history
- memory references
- halt reason

Business meaning must not live only in `messages`.

## Review questions

Every architectural or code review must answer:

1. What does the agent decide here?
2. What does engineering constrain here?
3. Is any branch secretly encoding business flow in code?
4. Is any displayed trace inferred rather than agent-authored?
5. If a main tool path fails, does the agent observe and react, or does the system just crash?
