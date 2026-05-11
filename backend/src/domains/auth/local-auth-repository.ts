import { createID } from "../../lib/ids"
import { getLocalSqlite } from "../../lib/local-sqlite"
import type { CloudAuthUserRecord } from "./cloud-auth-repository"
import { hashCloudPassword } from "./password"

type LocalAuthRow = {
  id: string
  tenant_id: number
  email: string
  display_name: string
  password_hash: string
  account_status: number
  subscription_plan: string
  subscription_status: string
  created_at: string
  updated_at: string
}

function mapRow(row: LocalAuthRow | undefined): CloudAuthUserRecord | null {
  if (!row) return null
  return {
    id: String(row.id),
    tenantID: Number(row.tenant_id),
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    accountStatus: Number(row.account_status),
    subscription: {
      plan: row.subscription_plan || "pro",
      status: row.subscription_status || "active",
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function ensureTable() {
  const db = getLocalSqlite()
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_auth_users (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      account_status INTEGER NOT NULL DEFAULT 1,
      subscription_plan TEXT NOT NULL DEFAULT 'pro',
      subscription_status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function fallbackDisplayName(email: string) {
  const localPart = email.split("@")[0]?.trim()
  return localPart || "Local User"
}

export const LocalAuthRepository = {
  async findUserByEmail(email: string) {
    ensureTable()
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT
          id, tenant_id, email, display_name, password_hash, account_status,
          subscription_plan, subscription_status, created_at, updated_at
         FROM local_auth_users
         WHERE email = ?`,
      )
      .get(normalizeEmail(email)) as LocalAuthRow | undefined
    return mapRow(row)
  },

  async getUserByID(userID: string) {
    ensureTable()
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT
          id, tenant_id, email, display_name, password_hash, account_status,
          subscription_plan, subscription_status, created_at, updated_at
         FROM local_auth_users
         WHERE id = ?`,
      )
      .get(userID) as LocalAuthRow | undefined
    return mapRow(row)
  },

  async updatePasswordHash(userID: string, passwordHash: string) {
    ensureTable()
    const db = getLocalSqlite()
    db.prepare(`UPDATE local_auth_users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(
      passwordHash,
      new Date().toISOString(),
      userID,
    )
  },

  async createUser(input: { email: string; password: string; displayName?: string }) {
    ensureTable()
    const db = getLocalSqlite()
    const now = new Date().toISOString()
    const email = normalizeEmail(input.email)
    const existing = db.prepare(`SELECT id FROM local_auth_users WHERE email = ?`).get(email) as { id: string } | undefined
    if (existing) {
      throw new Error("Email already registered")
    }

    const user: CloudAuthUserRecord = {
      id: createID("local_user"),
      tenantID: 1,
      email,
      displayName: input.displayName?.trim() || fallbackDisplayName(email),
      passwordHash: hashCloudPassword(input.password),
      accountStatus: 1,
      subscription: {
        plan: "pro",
        status: "active",
      },
      createdAt: now,
      updatedAt: now,
    }

    db.prepare(
      `INSERT INTO local_auth_users (
        id, tenant_id, email, display_name, password_hash, account_status,
        subscription_plan, subscription_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user.id,
      user.tenantID,
      user.email,
      user.displayName,
      user.passwordHash,
      user.accountStatus,
      user.subscription.plan,
      user.subscription.status,
      user.createdAt,
      user.updatedAt,
    )

    return user
  },

  async reconcileLegacyDataForUser(userID: string) {
    ensureTable()
    const db = getLocalSqlite()

    // 从历史数据中推断“主用户 ID”（旧实现常见为 '2'）
    const legacy = db
      .prepare(
        `SELECT user_id, COUNT(*) AS cnt
         FROM workrooms
         WHERE user_id IS NOT NULL AND user_id <> ?
         GROUP BY user_id
         ORDER BY cnt DESC
         LIMIT 1`,
      )
      .get(userID) as { user_id: string; cnt: number } | undefined
    if (!legacy?.user_id) return

    const fromUserID = String(legacy.user_id)
    const toUserID = String(userID)
    if (!fromUserID || fromUserID === toUserID) return

    const userScopedTables = [
      "workrooms",
      "workroom_sources",
      "workroom_artifacts",
      "documents",
      "studio_documents",
      "studio_question_cards",
      "question_card_attempts",
      "question_card_diagnoses",
      "question_card_grading_records",
      "question_card_weaknesses",
      "question_card_knowledge_profiles",
      "question_card_study_events",
      "question_card_learning_states",
      "questions",
      "favorites",
      "learning_artifacts",
      "taxonomies",
      "model_settings",
      "agent_skill_settings",
      "agent_session_model_selection",
      "studio_command_runs",
      "studio_bridge_tokens",
    ]

    const tableExists = (name: string) =>
      Boolean(
        db
          .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(name),
      )

    const hasColumn = (table: string, column: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        (item) => item.name === column,
      )

    for (const table of userScopedTables) {
      if (!tableExists(table)) continue
      if (!hasColumn(table, "user_id")) continue
      db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(toUserID, fromUserID)
    }

    // 会话表也做归属修复，防止旧 token 解析到历史 user_id。
    if (tableExists("auth_sessions") && hasColumn("auth_sessions", "user_id")) {
      db.prepare(`UPDATE auth_sessions SET user_id = ? WHERE user_id = ?`).run(toUserID, fromUserID)
    }
  },
}
