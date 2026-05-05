import { getLocalSqlite } from "../../lib/local-sqlite"

export type AgentSessionSelectedModel = {
  providerID: string
  modelID: string
  updatedAt: string
}

function normalizeModelSelection(input: { providerID?: string; modelID?: string } | null | undefined) {
  if (!input) return null
  const providerID = String(input.providerID || "").trim()
  const modelID = String(input.modelID || "").trim()
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

export const AgentSessionModelSelectionService = {
  async get(input: { userID: string; workroomID: string; sessionID: string }) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `
          SELECT provider_id, model_id, updated_at
          FROM agent_session_model_selection
          WHERE user_id = ? AND workroom_id = ? AND session_id = ?
        `,
      )
      .get(input.userID, input.workroomID, input.sessionID) as
      | {
          provider_id: string
          model_id: string
          updated_at: string
        }
      | undefined

    if (!row) return null
    return {
      providerID: row.provider_id,
      modelID: row.model_id,
      updatedAt: row.updated_at,
    } satisfies AgentSessionSelectedModel
  },

  async listBySessions(input: { userID: string; workroomID: string; sessionIDs: string[] }) {
    const sessionIDs = [...new Set(input.sessionIDs.map((item) => String(item || "").trim()).filter(Boolean))]
    if (sessionIDs.length === 0) return new Map<string, AgentSessionSelectedModel>()
    const placeholders = sessionIDs.map(() => "?").join(", ")
    const db = getLocalSqlite()
    const rows = db
      .prepare(
        `
          SELECT session_id, provider_id, model_id, updated_at
          FROM agent_session_model_selection
          WHERE user_id = ? AND workroom_id = ? AND session_id IN (${placeholders})
        `,
      )
      .all(input.userID, input.workroomID, ...sessionIDs) as Array<{
      session_id: string
      provider_id: string
      model_id: string
      updated_at: string
    }>

    const out = new Map<string, AgentSessionSelectedModel>()
    for (const row of rows) {
      out.set(row.session_id, {
        providerID: row.provider_id,
        modelID: row.model_id,
        updatedAt: row.updated_at,
      })
    }
    return out
  },

  async put(input: {
    userID: string
    workroomID: string
    sessionID: string
    selectedModel: { providerID?: string; modelID?: string } | null | undefined
  }) {
    const normalized = normalizeModelSelection(input.selectedModel)
    const db = getLocalSqlite()
    if (!normalized) {
      db.prepare(
        `
          DELETE FROM agent_session_model_selection
          WHERE user_id = ? AND workroom_id = ? AND session_id = ?
        `,
      ).run(input.userID, input.workroomID, input.sessionID)
      return null
    }

    const updatedAt = new Date().toISOString()
    db.prepare(
      `
        INSERT INTO agent_session_model_selection (
          user_id, workroom_id, session_id, provider_id, model_id, updated_at
        ) VALUES (
          @user_id, @workroom_id, @session_id, @provider_id, @model_id, @updated_at
        )
        ON CONFLICT(user_id, workroom_id, session_id) DO UPDATE SET
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          updated_at = excluded.updated_at
      `,
    ).run({
      user_id: input.userID,
      workroom_id: input.workroomID,
      session_id: input.sessionID,
      provider_id: normalized.providerID,
      model_id: normalized.modelID,
      updated_at: updatedAt,
    })

    return {
      providerID: normalized.providerID,
      modelID: normalized.modelID,
      updatedAt,
    } satisfies AgentSessionSelectedModel
  },

  async remove(input: { userID: string; workroomID: string; sessionID: string }) {
    const db = getLocalSqlite()
    db.prepare(
      `
        DELETE FROM agent_session_model_selection
        WHERE user_id = ? AND workroom_id = ? AND session_id = ?
      `,
    ).run(input.userID, input.workroomID, input.sessionID)
  },
}
