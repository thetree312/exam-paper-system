# Knowledge Base Unit Architecture Rebuild Plan

## 1. Background

Current KB stores independent `text chunk` and `image chunk` rows, then the agent tool assembles them at query time.
This causes structural instability for multimodal QA:

- retrieval returns fragmented evidence
- text and image can drift apart semantically
- agent receives mixed payloads instead of atomic evidence objects

The fix is not rule-based post-processing.  
The fix is rebuilding ingestion and retrieval around a **unit-first** data model.

## 2. Core Principles

- Domain-agnostic: works for PDF/Word/image now, extendable to PPT/video/web later.
- Unit-first: retrieval object is a `unit`, not a fragment.
- Ingest-time structure, query-time simplicity.
- Agent consumes stable evidence protocol (`evidence_units`), not ad-hoc chunk glue.

## 3. Data Model

### 3.1 New table: `kb_units`

One row = one atomic retrieval unit (current phase: page-level unit).

Fields:

- `id` bigint pk
- `source_id` bigint fk -> `kb_sources.id`
- `unit_key` varchar(128) (stable key in source scope, e.g. `page:10`)
- `unit_type` varchar(32) (`page`, future: `section`, `segment`, ...)
- `page_no_start` int nullable
- `page_no_end` int nullable
- `title` varchar(255) nullable
- `text_content` text nullable
- `primary_image_path` text nullable
- `token_count` int default 0
- `metadata_json` jsonb
- `content_hash` varchar(64)
- `version` int default 1
- `created_at` timestamp

Unique index:

- `(source_id, unit_key)`

### 3.2 New table: `kb_unit_embeddings`

Multiple embeddings per unit by modality.

Fields:

- `id` bigint pk
- `unit_id` bigint fk -> `kb_units.id`
- `tenant_id` bigint
- `user_id` bigint
- `model_name` varchar(128)
- `embed_kind` varchar(16) (`text`, `image`)
- `dim` int
- `embedding` vector(768)
- `created_at` timestamp

Indexes:

- `(tenant_id, user_id, unit_id)`
- `(tenant_id, user_id, embed_kind, model_name)`
- ivfflat on `embedding`

## 4. Ingestion Pipeline

For each source file:

1. parse text blocks + preview pages
2. build page-level units (`unit_key=page:{n}`)
3. unit embeddings:
   - text embedding if `text_content` exists
   - image embedding if `primary_image_path` exists
4. replace source units + embeddings in one transaction

Legacy chunk pipeline remains for transition only.
Primary retrieval path switches to unit-based API.

## 5. Retrieval Protocol

New primary service API:

- `search_units(...)` -> ranked `unit` records
- `get_units_by_ids(...)`

Ranking strategy:

- query text embedding against `kb_unit_embeddings` (`text` + `image`)
- aggregate by `unit_id` with best distance
- return enriched unit payload (text + image + metadata)

## 6. Agent Tool Protocol

Agent KB tools return:

- `evidence_units`: list of atomic unit objects
- `source_refs`: `unit:{id}`
- backward-compatible `snippets` and `asset_refs` for transition
- `model_message_content`: one text part + optional image part from top unit

No domain-specific rules.
No keyword routing.

## 7. Workspace Deletion Semantics

When deleting workspace scope:

- delete `kb_unit_embeddings` first
- delete `kb_units`
- then delete legacy chunk tables and sources

This guarantees permanent cleanup under tenant/user isolation.

## 8. Migration Plan

### Phase A (this implementation)

- add SQL migration for new unit tables and indexes
- add unit row builder
- add repository write/read methods for units
- ingest writes units + unit embeddings
- rag service adds `search_units/get_units_by_ids`
- agent kb tool consumes unit retrieval
- workspace delete includes unit tables

### Phase B (next)

- backfill existing sources into units
- switch all KB tools to unit refs only
- deprecate legacy chunk retrieval path

### Phase C (next)

- add parsers for PPT/video/web into same unit interface

## 9. Acceptance Criteria

- Agent sees same-source text+image in one unit payload.
- No cross-source multimodal mix in a single returned evidence unit.
- Query pipeline remains multimodal without domain rules.
- Existing API calls still function during transition.

