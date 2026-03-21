# Mindmap Capability And Performance Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Release the highest-value `Mind Elixir` capabilities for the mindmap feature while keeping the architecture lightweight enough for a small feature inside the larger web application.

**Architecture:** Keep the current `MindMapDocument` as the canonical backend document, extend it only where the editor already has first-class support, and keep most interaction state inside the `Mind Elixir` instance instead of mirroring every editor mutation through React. Persist semantic content and explicit cross-node relations; keep view-state and transient interaction state local or workroom-scoped.

**Tech Stack:** React, TypeScript, Mind Elixir, FastAPI, SQLAlchemy, existing `MindMapDocument` schema and `workroom_panel_artifacts`

---

## Requirements Summary

### Functional
- Release more of `Mind Elixir` beyond plain tree editing.
- Keep the feature maintainable as a small sub-feature of the editor workspace.
- Support explicit cross-node relations using editor-native arrows.
- Add practical user controls:
  - fit/reset view
  - collapse/expand all
  - export image
- Preserve current workroom/tenant isolation.

### Non-Functional
- Avoid building a dedicated mindmap state framework.
- Avoid rerendering React on every editor operation.
- Keep persistence simple and debuggable.
- Keep future extension path open for summaries and richer annotations.

---

## Capability Release Strategy

### Tranche 1: Release Now

These are high-value and fit the existing architecture with low risk:

- `arrow` relations
  - already first-class in `Mind Elixir`
  - map directly into `MindMapDocument.relations`
- view controls
  - `scaleFit`
  - `toCenter`
  - collapse all
  - expand all
- export
  - expose image export through the editor shell
- snapshot throttling
  - stop writing every editor operation directly into React state

### Tranche 2: Release Later

These need more schema and product design work:

- summaries
  - require a new canonical `summaries` field in backend schema
- richer node formatting
  - tags, icons, image blocks
- multi-select batch authoring flows
- explicit editor preferences per user or per workroom

---

## Performance Architecture

### Core Decision

Do **not** build a dedicated global editor store or collaborative state layer for mindmaps.

Use a lighter architecture:

- `Mind Elixir` instance owns interactive editor state
- React owns canonical persisted document snapshots
- bridge between them is **debounced**

This keeps the feature small and avoids duplicating the editor engine with a React-side shadow state machine.

### Recommended Data Boundary

#### Persisted canonical document

Persist in `mindmaps.graph_json`:

- root tree
- semantic node fields
- explicit `relations`
- document metadata

#### Workroom-scoped view state

Persist in `workroom_panel_artifacts`:

- selected node id
- current source
- optional zoom/pan later if needed

#### Transient local editor state

Keep inside the `Mind Elixir` instance:

- drag state
- selection box
- current zoom animation
- toolbar interaction state
- temporary focus state

### Why This Avoids Repeated Wheel Reinvention

If we mirror all editor operations into React state immediately:

- every node edit causes full tree serialization
- React rerenders on every interaction
- we end up implementing our own editor synchronization layer

If we keep the editor authoritative during interaction:

- the feature stays small
- React only receives intentional snapshots
- backend persistence stays canonical and simple

This matches the product reality: mindmap is a feature panel, not the application core runtime.

---

## Technical Design

### 1. Schema Extension

#### Keep

- `MindMapNodeTree`
- `MindMapRelation`
- `MindMapDocument`

#### Use now

- `MindMapRelation` becomes real editor data instead of unused placeholder output.

#### Defer

- `MindMapSummary`
- richer theme serialization

### 2. Frontend Controller Pattern

Add an imperative bridge around the editor:

- `MindElixirCanvas` exposes actions through a ref or callback:
  - `fitView()`
  - `expandAll()`
  - `collapseAll()`
  - `exportPng()`
  - `createRelation()` later if needed

This avoids pushing editor command state up through multiple React layers.

### 3. Debounced Snapshot Pipeline

Instead of calling `onDocumentChange` on every operation immediately:

- queue a snapshot from `instance.getData()`
- debounce flush to React state
- preserve immediate UI responsiveness inside the editor instance

Recommended target:

- 150-250ms debounce for structural edits
- immediate flush on explicit save/export if required

### 4. Relation Mapping

Add conversion between:

- `MindMapDocument.relations`
- `Mind Elixir` `arrows`

That gives us real cross-node relationships without redesigning the backend document model.

### 5. Export Strategy

Short term:

- use the editor’s built-in export methods for PNG/SVG compatibility

Later:

- move to a more modern screenshot path only if export quality becomes a real product issue

This is intentionally pragmatic: do not introduce another rendering/export pipeline until needed.

---

## Risks And Mitigations

### Risk: Editor and React snapshots drift
- Mitigation: always derive persisted payload from `instance.getData()` through a single conversion path.

### Risk: Full refresh resets user view too often
- Mitigation: only auto-fit on new document/version load, never on normal incremental edits.

### Risk: Too many capabilities too quickly
- Mitigation: release in tranches, starting with arrows and view controls only.

### Risk: Performance regressions from frequent snapshots
- Mitigation: debounce and keep interaction state inside the editor instance.

---

## Implementation Order

1. Extend conversion logic to round-trip `relations <-> arrows`.
2. Refactor `MindElixirCanvas` to expose imperative controls and debounced snapshots.
3. Expand toolbar with fit/reset, collapse/expand, export.
4. Keep current save flow but feed it debounced canonical snapshots.
5. Verify that generate/load/save still work and that no extra backend infrastructure was introduced.

