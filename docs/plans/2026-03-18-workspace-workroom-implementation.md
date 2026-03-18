# Workspace / Workroom Implementation Plan

**Goal:** Introduce a real `workspace` layer above `workroom`, make login land on the workspace page, and keep workroom as the three-panel workbench with a center `studio`.

## Phase 1. Correct the domain model

### Backend

- add `workspaces` table
- add `workrooms.workspace_id`
- add ORM and schema coverage
- add repository/service/router for workspace lifecycle

### Validation

- backend compile passes
- workspace create/list endpoints return real data

## Phase 2. Restore the product entry flow

### Frontend

- stop using workroom as the post-login landing shell
- add dedicated `WorkspacePage`
- show workspace list and create action using the submitted design direction
- navigate into a workroom page after workspace creation

### Validation

- login lands on workspace page
- creating workspace jumps into workroom page

## Phase 3. Re-scope workroom correctly

### Frontend

- make workroom the page that owns:
  - left knowledge panel
  - center studio
  - right agent panel
- move center naming from `workspaceView` to `studioView`

### Validation

- workroom remains the actual working surface
- no more conceptual mixing between workspace and workroom

## Phase 4. Reconnect runtime persistence

### Backend / Frontend

- bind uploads to workroom as before
- persist workroom runtime state
- keep current workroom-centered agent scope

### Validation

- upload from workroom still binds files correctly
- workroom reload restores active state

## Notes

- Existing `workroom_*` tables stay useful and are not discarded.
- `workspace` is a new parent layer, not a rename of workroom.
- `studio` is the correct name for the center area in workroom.
