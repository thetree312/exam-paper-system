import path from "node:path"
import { getLocalSqlite, readJsonFileIfExists } from "../../lib/local-sqlite"
import type { CloudAuthUserRecord } from "./cloud-auth-repository"

type LegacyAuthState = {
  users?: Array<{
    id: string
    email: string
  }>
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")
const legacyAuthPath = path.join(backendRoot, "local-data", "auth", "index.json")

let migratedEmails = new Set<string>()

export async function migrateLegacyLocalStateForCloudUser(user: CloudAuthUserRecord) {
  const email = user.email.trim().toLowerCase()
  if (!email || migratedEmails.has(email)) return

  const legacy = readJsonFileIfExists<LegacyAuthState>(legacyAuthPath)
  const legacyUserIDs = Array.from(
    new Set(
      (legacy?.users ?? [])
        .filter((item) => item.email?.trim().toLowerCase() === email)
        .map((item) => item.id)
        .filter((item) => item && item !== user.id),
    ),
  )

  if (legacyUserIDs.length === 0) {
    migratedEmails.add(email)
    return
  }

  const db = getLocalSqlite()
  const updateUserTables = [
    "workrooms",
    "workroom_sources",
    "workroom_artifacts",
    "documents",
    "studio_documents",
    "studio_question_cards",
    "questions",
    "favorites",
    "learning_artifacts",
    "taxonomies",
    "model_settings",
  ]

  const tx = db.transaction(() => {
    for (const legacyUserID of legacyUserIDs) {
      for (const table of updateUserTables) {
        db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(user.id, legacyUserID)
      }
    }
  })

  tx()
  migratedEmails.add(email)
}
