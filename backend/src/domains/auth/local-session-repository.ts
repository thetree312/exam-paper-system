import { randomBytes } from "node:crypto"
import { createID } from "../../lib/ids"
import { getLocalSqlite } from "../../lib/local-sqlite"
import type { CloudAuthUserRecord } from "./cloud-auth-repository"

export type AuthSessionRecord = {
  id: string
  token: string
  userID: string
  createdAt: string
  lastUsedAt: string
}

export const LocalSessionRepository = {
  async create(user: CloudAuthUserRecord): Promise<AuthSessionRecord> {
    const db = getLocalSqlite()
    const now = new Date().toISOString()
    const session: AuthSessionRecord = {
      id: createID("auth_session"),
      token: randomBytes(32).toString("hex"),
      userID: user.id,
      createdAt: now,
      lastUsedAt: now,
    }

    db.prepare(
      `
        INSERT INTO auth_sessions (
          id, token, user_id, tenant_id, email, display_name,
          subscription_plan, subscription_status, created_at, last_used_at
        )
        VALUES (
          @id, @token, @user_id, @tenant_id, @email, @display_name,
          @subscription_plan, @subscription_status, @created_at, @last_used_at
        )
      `,
    ).run({
      id: session.id,
      token: session.token,
      user_id: user.id,
      tenant_id: user.tenantID,
      email: user.email,
      display_name: user.displayName,
      subscription_plan: user.subscription.plan,
      subscription_status: user.subscription.status,
      created_at: session.createdAt,
      last_used_at: session.lastUsedAt,
    })

    return session
  },

  async resolve(token: string): Promise<AuthSessionRecord | null> {
    const db = getLocalSqlite()
    const row = db
      .prepare(`SELECT id, token, user_id, created_at FROM auth_sessions WHERE token = ?`)
      .get(token) as { id: string; token: string; user_id: string; created_at: string } | undefined

    if (!row) return null

    const lastUsedAt = new Date().toISOString()
    db.prepare(`UPDATE auth_sessions SET last_used_at = ? WHERE token = ?`).run(lastUsedAt, token)

    return {
      id: row.id,
      token: row.token,
      userID: row.user_id,
      createdAt: row.created_at,
      lastUsedAt,
    }
  },

  async delete(token: string) {
    const db = getLocalSqlite()
    db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token)
  },
}
