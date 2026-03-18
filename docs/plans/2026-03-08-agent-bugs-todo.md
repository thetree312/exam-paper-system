# Agent Known Bugs TODO (2026-03-08)

## Scope
This file tracks confirmed bugs from recent real traces. It is a runtime/debug backlog, not a product spec.

## P0
- Cross-request selective amnesia:
  - Loaded tools discovered in one request are not reused in the next request of the same session.
  - Effect: repeated `tool_search` and unstable first-loop behavior.
- Loop-process memory handoff missing:
  - No compact continuation summary is passed into the next request.
  - Effect: ORC re-derives world state and repeats discovery work.

## P1
- ORC context pollution by engineering counters:
  - Fields like `loaded_assets_count` leak into ORC-visible context.
  - Effect: model reasoning drifts to debug counters rather than world facts.
- Input growth pressure:
  - Tool metadata/schema and repeated evidence structures increase per-loop token load.
  - Effect: high input token cost and degraded stability in multi-loop turns.

## P2
- KB retrieval page mismatch:
  - `read_kb_evidence` may return pages unrelated to the asked question target page.
  - Effect: model receives valid images but wrong pages for the current question.

## Current Work Item
1. Fix cross-request selective amnesia with lightweight continuation state reuse.
2. Add compact loop-process continuation summary for next-request context.
3. Keep this stage independent from retrieval algorithm changes.
