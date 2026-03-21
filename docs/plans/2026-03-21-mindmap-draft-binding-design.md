# Mindmap Draft + Binding Design

**Goal:** Replace direct LLM-to-canonical generation with a two-stage pipeline:

- Stage 1: LLM generates a semantic draft tree.
- Stage 2: backend services normalize and bind references into canonical `MindMapDocument`.

This design is intended to eliminate schema fragility, remove prompt-level coupling to database references, and provide strong tenant/workroom scoping.

## 1. Problem Statement

The current generation path asks the model to do all of the following in one response:

- extract concepts
- build a tree
- attach structured `questionRefs`
- satisfy the final persistence schema exactly

This is architecturally unstable.

Observed failures:

- model returns extra prose or multiple JSON objects
- model returns `questionRefs` as strings like `"17(1)"` instead of objects
- model sometimes falls back to page/snippet grouping when parsing fails

These are not isolated bugs. They are a symptom of using one model output as both:

- semantic content
- final storage payload

## 2. Design Decision

The model must no longer generate the final canonical `MindMapDocument`.

Instead:

1. The model generates a semantic draft tree.
2. The backend validates the draft.
3. The backend binds semantic reference hints to real question/document references.
4. The backend builds the canonical persisted object.

## 3. New Generation Stages

### 3.1 Stage 1: Semantic Draft

LLM output contract:

```ts
type MindMapDraft = {
  title?: string | null
  root: MindMapDraftNode
}

type MindMapDraftNode = {
  topic: string
  summary?: string | null
  side?: 'left' | 'right' | null
  referenceHints?: string[]
  children: MindMapDraftNode[]
}
```

Rules:

- `referenceHints` is a semantic hint field, not a database field.
- It may contain human-readable references such as:
  - `第17题第1问`
  - `函数与导数综合题`
  - `第2页风速向量题`
- Draft contains no `questionId`, `sequenceIndex`, or final persistence identifiers.

### 3.2 Stage 2: Backend Binding

Service:

- `ReferenceBindingService`

Input:

- validated draft tree
- scoped source context
  - current `tenant_id`
  - current `workroom_id`
  - current `source_type`
  - current `source_id`
  - source questions
  - source blocks/pages

Output:

- canonical `MindMapDocument`

Binding responsibilities:

- normalize human-readable hints
- resolve candidate question/page matches
- attach canonical `questionRefs`
- drop low-confidence unresolved references instead of failing the whole tree

## 4. Canonical Output Model

The persisted format remains:

```ts
type MindMapDocument = {
  id: number
  version: number
  source: {
    type: 'exam_document' | 'uploaded_file'
    id: number
  }
  kind: 'knowledge'
  title?: string | null
  root: MindMapNodeTree
  relations: MindMapRelation[]
  meta: {
    hasQuestionRefs: boolean
    generatedBy: 'llm' | 'manual' | 'system'
    updatedAt: string
  }
}
```

This schema remains the only persistence schema.

## 5. Validation Layers

Two explicit validations are required.

### 5.1 Draft validation

Validate:

- root exists
- every node has `topic`
- every node has `children`
- `referenceHints`, if present, is `string[]`

Failure meaning:

- model output is not a valid semantic draft

### 5.2 Canonical validation

Validate after binding:

- every node has normalized `questionRefs`
- no string references survive into canonical schema

Failure meaning:

- backend normalization/binding logic is incorrect

## 6. Reference Binding Strategy

Reference binding must be generic and not test-case-specific.

### 6.1 Normalize hints

Normalize:

- whitespace
- Chinese/ASCII punctuation
- full-width/half-width brackets
- common exam reference forms

Examples:

- `17（1）` -> normalized hint token set
- `第17题第1问` -> normalized hint token set
- `Q17-1` -> normalized hint token set

### 6.2 Candidate retrieval

For `exam_document`:

- question sequence index
- page
- content overlap

For `uploaded_file`:

- page/block anchors only

### 6.3 Resolve or drop

If a hint resolves with acceptable confidence:

- attach canonical object:
  - `questionId`
  - `sequenceIndex`
  - `page`

If not:

- leave `questionRefs = []`

No unresolved string hint is allowed in canonical output.

## 7. Logging Requirements

The generation chain must stop being a black box.

Required logs:

- `mindmap.generate.start`
- `mindmap.llm.raw_saved`
- `mindmap.draft.validated`
- `mindmap.binding.summary`
- `mindmap.generate.saved`

Required persisted debug artifacts:

- raw LLM response
- normalized draft JSON

These artifacts must be saved under `backend/app/logs/`.

## 8. Isolation Requirements

Generation and binding must both be scoped by:

- `tenant_id`
- `workroom_id`
- `source_type`
- `source_id`

Implications:

- no cross-tenant binding
- no cross-workroom reference resolution
- no shared mindmap content between different workrooms

## 9. Implementation Plan

1. Add draft schemas to `backend/app/services/mindmap/schemas.py`.
2. Replace current direct-JSON parser with draft parser in `generation.py`.
3. Add canonical builder and reference binder in `generation.py` or dedicated binder helpers.
4. Update `MindMapService._generate_with_llm()` to:
   - save raw response
   - parse draft
   - validate draft
   - bind references
   - validate canonical document
5. Keep existing fallback generation only as a true backend fallback path, not as the normal path.
6. Add tests for:
   - draft parsing
   - reference hint normalization
   - canonical binding output

## 10. Non-Goals

This change does not yet include:

- visual layout persistence
- cross-node semantic `relations` extraction
- multi-pass summarization with separate planner/reviewer models

Those can be added later on top of the two-stage pipeline.
