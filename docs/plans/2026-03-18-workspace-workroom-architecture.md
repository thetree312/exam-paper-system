# Workspace / Workroom Architecture

**Status:** Approved product terminology and architecture baseline.

## 1. Product Hierarchy

The product must use a strict two-level container model:

- `workspace`
  - the logged-in landing page entity
  - a project/theme-level learning container
  - users can create multiple workspaces over time
- `workroom`
  - the concrete three-panel learning workbench inside one workspace
  - left knowledge panel, center studio, right agent panel

This means:

- users log in to the `workspace` page
- creating a new workspace immediately creates or opens its initial workroom
- document upload happens inside `workroom`, not on the workspace index page

## 2. Naming Contract

To remove ambiguity, the following names are fixed:

- `workspace`
  - upper-level project/theme container
- `workroom`
  - concrete three-panel workbench
- `studio`
  - the center area inside a workroom

Do not use `workspace` to refer to the center panel anymore.

## 3. Studio Definition

The center area of `workroom` is not just an editor. It supports:

- question card documents
- flashcards
- mindmap
- notes
- OCR import flow

Therefore the center area should be named `studio`, and its active state should be named `studio_view`, not `workspace_view`.

Recommended `studio_view` values:

- `question_doc`
- `flashcards`
- `mindmap`
- `notes`

## 4. OCR Product Semantics

OCR is not the final content surface.

OCR is an ingestion/import flow whose output lands in a question-card document. That means:

- `question_doc` is the primary document form in the studio
- OCR produces or updates a document
- flashcards, mindmap, and notes are alternate studio views derived from or associated with documents

## 5. Design Source

The submitted design draft under:

- [stitch_test_paper_editor_workroom/_1/code.html](D:/Exam-paper/stitch_test_paper_editor_workroom/_1/code.html)
- [stitch_test_paper_editor_workroom/_2/code.html](D:/Exam-paper/stitch_test_paper_editor_workroom/_2/code.html)

is to be treated as the visual/product reference for the `workspace` index experience:

- clean editorial light theme
- timeline-like organization
- card/list presentation for learning assets
- strong separation between navigation container and active workbench

Those mockups are not the data model, but they are the primary UI reference.

## 6. Current Database Reality

The live PostgreSQL database currently contains:

- `workrooms`
- `workroom_source_bindings`
- `workroom_runtime_states`
- `workroom_panel_artifacts`

It does **not** currently contain any `workspace` table.

Therefore the new architecture requires adding a real `workspace` layer instead of overloading `workrooms`.

## 7. Required Data Model Change

The backend must introduce:

- `workspaces`
  - top-level user/tenant project container
- `workrooms.workspace_id`
  - foreign key from workroom to workspace

Recommended semantic split:

- `workspaces`
  - name, topic, status, timestamps
- `workrooms`
  - operational learning bench under that workspace
  - state and bound sources for one active workbench

## 8. Page Model

### 8.1 Workspace page

Login success lands here.

Responsibilities:

- list existing workspaces
- create new workspace
- display recent/active workspaces
- jump into the selected workspace's workroom

### 8.2 Workroom page

This is the actual three-column workbench.

Responsibilities:

- left knowledge panel
- center studio
- right agent panel
- bind uploaded source files
- persist workroom runtime state

## 9. Migration Direction

The previous implementation attempt incorrectly made workroom the post-login root page.

That direction is obsolete and must be rolled back conceptually.

Correct direction:

- login -> workspace page
- create workspace -> create/open workroom -> navigate to workroom page
- workroom hosts the three-panel working experience

## 10. Immediate Implementation Priorities

1. Add backend `workspace` data model and API.
2. Stop treating workroom as the login landing page.
3. Build a dedicated frontend `WorkspacePage`.
4. Route/create navigation from workspace page into workroom page.
5. Rename center-panel state from `workspaceView` toward `studioView`.
