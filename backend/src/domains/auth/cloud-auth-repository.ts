import { getPostgresPool } from "../../lib/postgres"

export type CloudAuthUserRecord = {
  id: string
  tenantID: number
  email: string
  displayName: string
  passwordHash: string
  accountStatus: number
  subscription: {
    plan: string
    status: string
  }
  createdAt: string
  updatedAt: string
}

type UserRow = {
  id: string | number
  tenant_id: number
  email: string
  display_name: string
  password_hash: string
  account_status: number
  subscription_plan: string | null
  subscription_status: string | null
  created_at: Date | string
  updated_at: Date | string
}

function mapRow(row: UserRow | undefined): CloudAuthUserRecord | null {
  if (!row) return null
  return {
    id: String(row.id),
    tenantID: Number(row.tenant_id),
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    accountStatus: Number(row.account_status),
    subscription: {
      plan: row.subscription_plan ?? "free",
      status: row.subscription_status ?? "inactive",
    },
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

const selectUserSql = `
  SELECT
    u.id,
    u.tenant_id,
    u.email,
    u.display_name,
    u.password_hash,
    u.status AS account_status,
    p.code AS subscription_plan,
    s.status AS subscription_status,
    u.created_at,
    u.updated_at
  FROM users u
  LEFT JOIN subscriptions s ON s.tenant_id = u.tenant_id
  LEFT JOIN plans p ON p.id = s.plan_id
  WHERE %CONDITION%
  ORDER BY
    CASE s.status
      WHEN 'active' THEN 0
      WHEN 'trialing' THEN 1
      ELSE 2
    END,
    s.current_period_end DESC NULLS LAST,
    s.id DESC NULLS LAST
  LIMIT 1
`

export const CloudAuthRepository = {
  async findUserByEmail(email: string) {
    const pool = getPostgresPool()
    const result = await pool.query<UserRow>(selectUserSql.replace("%CONDITION%", "LOWER(u.email) = LOWER($1)"), [
      email,
    ])
    return mapRow(result.rows[0])
  },

  async getUserByID(userID: string) {
    const pool = getPostgresPool()
    const result = await pool.query<UserRow>(selectUserSql.replace("%CONDITION%", "u.id = $1"), [userID])
    return mapRow(result.rows[0])
  },

  async updatePasswordHash(userID: string, passwordHash: string) {
    const pool = getPostgresPool()
    await pool.query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [userID, passwordHash])
  },
}
