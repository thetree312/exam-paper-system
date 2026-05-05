import path from "node:path"
import { createID } from "../../lib/ids"
import { getLocalSqlite, parseJsonText, readJsonFileIfExists } from "../../lib/local-sqlite"
import type {
  WorkroomPanelArtifactRecord,
  WorkroomRecord,
  WorkroomRuntimeState,
  WorkroomSourceBindingRecord,
} from "./types"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")

type WorkroomIndexState = {
  items: WorkroomRecord[]
}

type WorkroomSourceBindingState = {
  items: WorkroomSourceBindingRecord[]
}

type WorkroomPanelArtifactState = {
  items: WorkroomPanelArtifactRecord[]
}

let migrated = false

function normalizeWorkroomPath(input: string) {
  return path.resolve(input)
}

export function deriveWorkroomDirectories(input: { rootDirectory?: string; id: string }) {
  const base = normalizeWorkroomPath(
    input.rootDirectory ?? path.join(backendRoot, "local-data", "workrooms", input.id),
  )

  if (path.basename(base).toLowerCase() === "wiki") {
    return {
      rootDirectory: path.dirname(base),
      wikiDirectory: base,
    }
  }

  return {
    rootDirectory: base,
    wikiDirectory: path.join(base, "wiki"),
  }
}

export function defaultRuntimeState(): WorkroomRuntimeState {
  return {
    active_tab_index: 0,
    active_file_id: null,
    active_session_id: null,
    active_studio_document_id: null,
    active_agent_session_id: null,
    active_extraction_session_id: null,
    open_document_ids: [],
    left_panel_state_json: {},
    center_panel_state_json: {},
    right_panel_state_json: {},
  }
}

function mergeRuntimeState(
  current: WorkroomRuntimeState | null | undefined,
  patch: Partial<WorkroomRuntimeState>,
): WorkroomRuntimeState {
  const base = current ?? defaultRuntimeState()
  return {
    ...base,
    ...patch,
    open_document_ids: Array.from(
      new Set(
        (patch.open_document_ids ?? base.open_document_ids ?? [])
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ),
    left_panel_state_json: {
      ...base.left_panel_state_json,
      ...(patch.left_panel_state_json ?? {}),
    },
    center_panel_state_json: {
      ...base.center_panel_state_json,
      ...(patch.center_panel_state_json ?? {}),
    },
    right_panel_state_json: {
      ...base.right_panel_state_json,
      ...(patch.right_panel_state_json ?? {}),
    },
  }
}

function asRuntimeState(row: Record<string, unknown>): WorkroomRuntimeState {
  return {
    active_file_id: (row.active_file_id as string | null) ?? null,
    active_session_id: (row.active_session_id as string | null) ?? null,
    active_tab_index: Number(row.active_tab_index ?? 0),
    active_studio_document_id: (row.active_studio_document_id as string | null) ?? null,
    active_agent_session_id: (row.active_agent_session_id as string | null) ?? null,
    active_extraction_session_id: (row.active_extraction_session_id as string | null) ?? null,
    open_document_ids: parseJsonText<string[]>(String(row.open_document_ids_json ?? "[]"), []),
    left_panel_state_json: parseJsonText<Record<string, unknown>>(String(row.left_panel_state_json ?? "{}"), {}),
    center_panel_state_json: parseJsonText<Record<string, unknown>>(String(row.center_panel_state_json ?? "{}"), {}),
    right_panel_state_json: parseJsonText<Record<string, unknown>>(String(row.right_panel_state_json ?? "{}"), {}),
  }
}

function ensureMigrated() {
  if (migrated) return
  migrated = true

  const db = getLocalSqlite()
  const count = db.prepare(`SELECT COUNT(*) AS count FROM workrooms`).get() as { count: number }
  if (count.count > 0) return

  const indexState = readJsonFileIfExists<WorkroomIndexState>(path.join(backendRoot, "local-data", "workrooms", "index.json"))
  const sourceState = readJsonFileIfExists<WorkroomSourceBindingState>(
    path.join(backendRoot, "local-data", "workrooms", "source-bindings.json"),
  )
  const artifactState = readJsonFileIfExists<WorkroomPanelArtifactState>(
    path.join(backendRoot, "local-data", "workrooms", "panel-artifacts.json"),
  )

  const tx = db.transaction(() => {
    for (const item of indexState?.items ?? []) {
      const runtimeState = item.runtimeState ?? defaultRuntimeState()
      db.prepare(
        `
          INSERT OR REPLACE INTO workrooms (
            id, user_id, name, root_directory, wiki_directory,
            active_file_id, active_session_id, active_tab_index, active_studio_document_id,
            active_agent_session_id, active_extraction_session_id, open_document_ids_json,
            left_panel_state_json, center_panel_state_json, right_panel_state_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @name, @root_directory, @wiki_directory,
            @active_file_id, @active_session_id, @active_tab_index, @active_studio_document_id,
            @active_agent_session_id, @active_extraction_session_id, @open_document_ids_json,
            @left_panel_state_json, @center_panel_state_json, @right_panel_state_json, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        name: item.name,
        root_directory: item.rootDirectory,
        wiki_directory: item.wikiDirectory,
        active_file_id: runtimeState.active_file_id ?? null,
        active_session_id: runtimeState.active_session_id ?? null,
        active_tab_index: runtimeState.active_tab_index,
        active_studio_document_id: runtimeState.active_studio_document_id ?? null,
        active_agent_session_id: runtimeState.active_agent_session_id ?? null,
        active_extraction_session_id: runtimeState.active_extraction_session_id ?? null,
        open_document_ids_json: JSON.stringify(runtimeState.open_document_ids ?? []),
        left_panel_state_json: JSON.stringify(runtimeState.left_panel_state_json ?? {}),
        center_panel_state_json: JSON.stringify(runtimeState.center_panel_state_json ?? {}),
        right_panel_state_json: JSON.stringify(runtimeState.right_panel_state_json ?? {}),
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }

    for (const item of sourceState?.items ?? []) {
      db.prepare(
        `
          INSERT OR REPLACE INTO workroom_sources (
            id, user_id, workroom_id, document_id, source_package_path,
            raw_markdown_path, is_active, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @document_id, @source_package_path,
            @raw_markdown_path, @is_active, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        workroom_id: item.workroomID,
        document_id: item.documentID,
        source_package_path: item.sourcePackagePath,
        raw_markdown_path: item.rawMarkdownPath,
        is_active: item.isActive ? 1 : 0,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }

    for (const item of artifactState?.items ?? []) {
      db.prepare(
        `
          INSERT OR REPLACE INTO workroom_artifacts (
            id, user_id, workroom_id, artifact_type, artifact_ref_id,
            document_id, payload_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @artifact_type, @artifact_ref_id,
            @document_id, @payload_json, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        workroom_id: item.workroomID,
        artifact_type: item.artifactType,
        artifact_ref_id: item.artifactRefID,
        document_id: item.documentID ?? null,
        payload_json: JSON.stringify(item.payloadJson ?? {}),
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })

  tx()
}

export const WorkroomRepository = {
  async readIndex() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM workrooms ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        name: String(row.name),
        rootDirectory: String(row.root_directory),
        wikiDirectory: String(row.wiki_directory),
        runtimeState: asRuntimeState(row),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies WorkroomIndexState
  },

  async updateIndex(mutate: (state: WorkroomIndexState) => void | WorkroomIndexState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.readIndex()
    const next = (mutate(current) ?? current) as WorkroomIndexState
    const tx = db.transaction((state: WorkroomIndexState) => {
      db.prepare(`DELETE FROM workrooms`).run()
      const statement = db.prepare(
        `
          INSERT INTO workrooms (
            id, user_id, name, root_directory, wiki_directory,
            active_file_id, active_session_id, active_tab_index, active_studio_document_id,
            active_agent_session_id, active_extraction_session_id, open_document_ids_json,
            left_panel_state_json, center_panel_state_json, right_panel_state_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @name, @root_directory, @wiki_directory,
            @active_file_id, @active_session_id, @active_tab_index, @active_studio_document_id,
            @active_agent_session_id, @active_extraction_session_id, @open_document_ids_json,
            @left_panel_state_json, @center_panel_state_json, @right_panel_state_json, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        const runtimeState = item.runtimeState ?? defaultRuntimeState()
        statement.run({
          id: item.id,
          user_id: item.userID,
          name: item.name,
          root_directory: item.rootDirectory,
          wiki_directory: item.wikiDirectory,
          active_file_id: runtimeState.active_file_id ?? null,
          active_session_id: runtimeState.active_session_id ?? null,
          active_tab_index: runtimeState.active_tab_index,
          active_studio_document_id: runtimeState.active_studio_document_id ?? null,
          active_agent_session_id: runtimeState.active_agent_session_id ?? null,
          active_extraction_session_id: runtimeState.active_extraction_session_id ?? null,
          open_document_ids_json: JSON.stringify(runtimeState.open_document_ids ?? []),
          left_panel_state_json: JSON.stringify(runtimeState.left_panel_state_json ?? {}),
          center_panel_state_json: JSON.stringify(runtimeState.center_panel_state_json ?? {}),
          right_panel_state_json: JSON.stringify(runtimeState.right_panel_state_json ?? {}),
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },

  async readSourceBindings() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM workroom_sources ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        workroomID: String(row.workroom_id),
        documentID: String(row.document_id),
        sourcePackagePath: String(row.source_package_path),
        rawMarkdownPath: String(row.raw_markdown_path),
        isActive: Number(row.is_active) === 1,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies WorkroomSourceBindingState
  },

  async updateSourceBindings(mutate: (state: WorkroomSourceBindingState) => void | WorkroomSourceBindingState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.readSourceBindings()
    const next = (mutate(current) ?? current) as WorkroomSourceBindingState
    const tx = db.transaction((state: WorkroomSourceBindingState) => {
      db.prepare(`DELETE FROM workroom_sources`).run()
      const statement = db.prepare(
        `
          INSERT INTO workroom_sources (
            id, user_id, workroom_id, document_id, source_package_path,
            raw_markdown_path, is_active, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @document_id, @source_package_path,
            @raw_markdown_path, @is_active, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          document_id: item.documentID,
          source_package_path: item.sourcePackagePath,
          raw_markdown_path: item.rawMarkdownPath,
          is_active: item.isActive ? 1 : 0,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },

  async readPanelArtifacts() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM workroom_artifacts ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        workroomID: String(row.workroom_id),
        artifactType: String(row.artifact_type),
        artifactRefID: String(row.artifact_ref_id),
        documentID: (row.document_id as string | null) ?? null,
        payloadJson: parseJsonText<Record<string, unknown>>(String(row.payload_json ?? "{}"), {}),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies WorkroomPanelArtifactState
  },

  async updatePanelArtifacts(mutate: (state: WorkroomPanelArtifactState) => void | WorkroomPanelArtifactState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.readPanelArtifacts()
    const next = (mutate(current) ?? current) as WorkroomPanelArtifactState
    const tx = db.transaction((state: WorkroomPanelArtifactState) => {
      db.prepare(`DELETE FROM workroom_artifacts`).run()
      const statement = db.prepare(
        `
          INSERT INTO workroom_artifacts (
            id, user_id, workroom_id, artifact_type, artifact_ref_id,
            document_id, payload_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @artifact_type, @artifact_ref_id,
            @document_id, @payload_json, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          artifact_type: item.artifactType,
          artifact_ref_id: item.artifactRefID,
          document_id: item.documentID ?? null,
          payload_json: JSON.stringify(item.payloadJson ?? {}),
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },

  createSourceBinding(input: {
    userID: string
    workroomID: string
    documentID: string
    sourcePackagePath: string
    rawMarkdownPath: string
  }) {
    const now = new Date().toISOString()
    return {
      id: createID("workroom_source"),
      userID: input.userID,
      workroomID: input.workroomID,
      documentID: input.documentID,
      sourcePackagePath: input.sourcePackagePath,
      rawMarkdownPath: input.rawMarkdownPath,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    } satisfies WorkroomSourceBindingRecord
  },

  createPanelArtifact(input: {
    userID: string
    workroomID: string
    artifactType: string
    artifactRefID: string
    documentID?: string | null
    payloadJson: Record<string, unknown>
  }) {
    const now = new Date().toISOString()
    return {
      id: createID("workroom_artifact"),
      userID: input.userID,
      workroomID: input.workroomID,
      artifactType: input.artifactType,
      artifactRefID: input.artifactRefID,
      documentID: input.documentID ?? null,
      payloadJson: input.payloadJson,
      createdAt: now,
      updatedAt: now,
    } satisfies WorkroomPanelArtifactRecord
  },

  mergeRuntimeState,
}
