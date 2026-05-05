import path from "node:path"
import { getLocalSqlite, parseJsonText, readJsonFileIfExists } from "../../lib/local-sqlite"
import type { LearningArtifactRecord, LearningArtifactsState } from "./types"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")
let migrated = false

function ensureMigrated() {
  if (migrated) return
  migrated = true

  const db = getLocalSqlite()
  const count = db.prepare(`SELECT COUNT(*) AS count FROM learning_artifacts`).get() as { count: number }
  if (count.count > 0) return

  const state = readJsonFileIfExists<LearningArtifactsState>(
    path.join(backendRoot, "local-data", "learning-artifacts", "index.json"),
  )
  if (!state) return

  const tx = db.transaction(() => {
    for (const item of state.items) {
      db.prepare(
        `
          INSERT OR REPLACE INTO learning_artifacts (
            id, user_id, workroom_id, type, linkage_json, payload_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @type, @linkage_json, @payload_json, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        workroom_id: item.workroomID,
        type: item.type,
        linkage_json: JSON.stringify(item.linkage),
        payload_json: JSON.stringify(item.payload),
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })

  tx()
}

function mapRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => ({
    id: String(row.id),
    userID: String(row.user_id),
    workroomID: String(row.workroom_id),
    type: row.type as LearningArtifactRecord["type"],
    linkage: parseJsonText<LearningArtifactRecord["linkage"]>(String(row.linkage_json ?? "{}"), {
      wikiPaths: [],
      documentIDs: [],
      documentBlocks: [],
      agentSessionIDs: [],
    }),
    payload: parseJsonText<LearningArtifactRecord["payload"]>(String(row.payload_json ?? "{}"), {
      title: "",
      prompt: "",
      answer: "",
    }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })) satisfies LearningArtifactRecord[]
}

export const LearningArtifactsRepository = {
  async read() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM learning_artifacts ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: mapRows(rows),
    } satisfies LearningArtifactsState
  },

  async update(mutate: (state: LearningArtifactsState) => void | LearningArtifactsState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.read()
    const next = (mutate(current) ?? current) as LearningArtifactsState
    const tx = db.transaction((state: LearningArtifactsState) => {
      db.prepare(`DELETE FROM learning_artifacts`).run()
      const statement = db.prepare(
        `
          INSERT INTO learning_artifacts (
            id, user_id, workroom_id, type, linkage_json, payload_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @type, @linkage_json, @payload_json, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          type: item.type,
          linkage_json: JSON.stringify(item.linkage),
          payload_json: JSON.stringify(item.payload),
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },

  async listByWorkroom(input: {
    userID: string
    workroomID: string
    type?: LearningArtifactRecord["type"]
  }) {
    const state = await this.read()
    return state.items.filter(
      (item) =>
        item.userID === input.userID &&
        item.workroomID === input.workroomID &&
        (!input.type || item.type === input.type),
    )
  },

  async getByWorkroom(input: { userID: string; workroomID: string; artifactID: string }) {
    const state = await this.read()
    return state.items.find(
      (item) =>
        item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.artifactID,
    )
  },
}
