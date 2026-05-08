import { randomBytes } from "node:crypto"
import { getLocalSqlite } from "../../lib/local-sqlite"

export type StudioBridgeTokenRecord = {
  userID: string
  workroomID: string
  token: string
  createdAt: string
  updatedAt: string
  expiresAt: string
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ROTATE_THRESHOLD_MS = 12 * 60 * 60 * 1000

function toRecord(row: Record<string, unknown>): StudioBridgeTokenRecord {
  return {
    userID: String(row.user_id),
    workroomID: String(row.workroom_id),
    token: String(row.token),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
  }
}

export const StudioBridgeTokenRepository = {
  async issue(input: { userID: string; workroomID: string; ttlMs?: number }) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT user_id, workroom_id, token, created_at, updated_at, expires_at
           FROM studio_bridge_tokens
          WHERE user_id = @user_id AND workroom_id = @workroom_id`,
      )
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
      }) as Record<string, unknown> | undefined

    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
    const now = Date.now()
    if (row) {
      const existing = toRecord(row)
      const expiresAtMs = Date.parse(existing.expiresAt)
      if (Number.isFinite(expiresAtMs) && expiresAtMs - now > ROTATE_THRESHOLD_MS) {
        return existing
      }
    }

    const createdAt = row ? String(row.created_at) : new Date(now).toISOString()
    const updatedAt = new Date(now).toISOString()
    const expiresAt = new Date(now + ttlMs).toISOString()
    const token = randomBytes(32).toString("hex")

    db.prepare(
      `INSERT INTO studio_bridge_tokens (
         user_id, workroom_id, token, created_at, updated_at, expires_at
       ) VALUES (
         @user_id, @workroom_id, @token, @created_at, @updated_at, @expires_at
       )
       ON CONFLICT(user_id, workroom_id) DO UPDATE SET
         token = excluded.token,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    ).run({
      user_id: input.userID,
      workroom_id: input.workroomID,
      token,
      created_at: createdAt,
      updated_at: updatedAt,
      expires_at: expiresAt,
    })

    return {
      userID: input.userID,
      workroomID: input.workroomID,
      token,
      createdAt,
      updatedAt,
      expiresAt,
    } satisfies StudioBridgeTokenRecord
  },

  async resolve(token: string) {
    const normalized = token.trim()
    if (!normalized) return null
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT user_id, workroom_id, token, created_at, updated_at, expires_at
           FROM studio_bridge_tokens
          WHERE token = @token`,
      )
      .get({ token: normalized }) as Record<string, unknown> | undefined
    if (!row) return null
    const record = toRecord(row)
    if (Date.parse(record.expiresAt) <= Date.now()) {
      db.prepare(`DELETE FROM studio_bridge_tokens WHERE token = @token`).run({ token: normalized })
      return null
    }
    return record
  },
}
