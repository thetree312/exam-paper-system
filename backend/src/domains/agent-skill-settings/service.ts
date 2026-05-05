import { getLocalSqlite, parseJsonText } from "../../lib/local-sqlite"

export type AgentSkillSettings = {
  userID: string
  disabledSkillNames: string[]
  updatedAt: string
}

function createDefault(userID: string): AgentSkillSettings {
  return {
    userID,
    disabledSkillNames: [],
    updatedAt: new Date().toISOString(),
  }
}

function normalizeSkillNames(input: string[] | null | undefined) {
  return [...new Set((input ?? []).map((item) => String(item || "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
}

export const AgentSkillSettingsService = {
  async get(userID: string) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `
          SELECT user_id, disabled_skill_names_json, updated_at
          FROM agent_skill_settings
          WHERE user_id = ?
        `,
      )
      .get(userID) as
      | {
          user_id: string
          disabled_skill_names_json: string
          updated_at: string
        }
      | undefined

    if (!row) return createDefault(userID)

    const normalized: AgentSkillSettings = {
      userID: row.user_id,
      disabledSkillNames: normalizeSkillNames(parseJsonText<string[]>(row.disabled_skill_names_json, [])),
      updatedAt: row.updated_at,
    }

    if (JSON.stringify(parseJsonText<string[]>(row.disabled_skill_names_json, [])) !== JSON.stringify(normalized.disabledSkillNames)) {
      await this.put(normalized)
    }

    return normalized
  },

  async put(input: Pick<AgentSkillSettings, "userID" | "disabledSkillNames"> | AgentSkillSettings) {
    const normalized: AgentSkillSettings = {
      userID: input.userID,
      disabledSkillNames: normalizeSkillNames(input.disabledSkillNames),
      updatedAt: new Date().toISOString(),
    }

    const db = getLocalSqlite()
    db.prepare(
      `
        INSERT INTO agent_skill_settings (
          user_id, disabled_skill_names_json, updated_at
        ) VALUES (
          @user_id, @disabled_skill_names_json, @updated_at
        )
        ON CONFLICT(user_id) DO UPDATE SET
          disabled_skill_names_json = excluded.disabled_skill_names_json,
          updated_at = excluded.updated_at
      `,
    ).run({
      user_id: normalized.userID,
      disabled_skill_names_json: JSON.stringify(normalized.disabledSkillNames),
      updated_at: normalized.updatedAt,
    })

    return normalized
  },
}
