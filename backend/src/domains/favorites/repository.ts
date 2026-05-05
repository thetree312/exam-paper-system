import path from "node:path"
import { getLocalSqlite, parseJsonText, readJsonFileIfExists } from "../../lib/local-sqlite"
import { type FavoriteRecord, type FavoritesState } from "./types"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")
let migrated = false

function ensureMigrated() {
  if (migrated) return
  migrated = true

  const db = getLocalSqlite()
  const count = db.prepare(`SELECT COUNT(*) AS count FROM favorites`).get() as { count: number }
  if (count.count > 0) return

  const state = readJsonFileIfExists<FavoritesState>(path.join(backendRoot, "local-data", "favorites", "index.json"))
  if (!state) return

  const tx = db.transaction(() => {
    for (const item of state.items) {
      db.prepare(
        `
          INSERT OR REPLACE INTO favorites (
            id, user_id, question_id, question_type_id, subject_id, tag_ids_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @question_id, @question_type_id, @subject_id, @tag_ids_json, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        question_id: item.questionID,
        question_type_id: item.questionTypeID ?? null,
        subject_id: item.subjectID ?? null,
        tag_ids_json: JSON.stringify(item.tagIDs ?? []),
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })

  tx()
}

async function readAll() {
  ensureMigrated()
  const db = getLocalSqlite()
  const rows = db.prepare(`SELECT * FROM favorites`).all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    userID: String(row.user_id),
    questionID: String(row.question_id),
    questionTypeID: (row.question_type_id as string | null) ?? null,
    subjectID: (row.subject_id as string | null) ?? null,
    tagIDs: parseJsonText<string[]>(String(row.tag_ids_json ?? "[]"), []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })) satisfies FavoriteRecord[]
}

function normalizeFavoriteRecord(record: FavoriteRecord): FavoriteRecord {
  return {
    ...record,
    questionTypeID: record.questionTypeID ?? null,
    subjectID: record.subjectID ?? null,
  }
}

function writeAll(items: FavoriteRecord[]) {
  const db = getLocalSqlite()
  const tx = db.transaction((records: FavoriteRecord[]) => {
    db.prepare(`DELETE FROM favorites`).run()
    const statement = db.prepare(
      `
        INSERT INTO favorites (
          id, user_id, question_id, question_type_id, subject_id, tag_ids_json, created_at, updated_at
        ) VALUES (
          @id, @user_id, @question_id, @question_type_id, @subject_id, @tag_ids_json, @created_at, @updated_at
        )
      `,
    )
    for (const item of records) {
      statement.run({
        id: item.id,
        user_id: item.userID,
        question_id: item.questionID,
        question_type_id: item.questionTypeID ?? null,
        subject_id: item.subjectID ?? null,
        tag_ids_json: JSON.stringify(item.tagIDs ?? []),
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })
  tx(items)
}

export const FavoritesRepository = {
  async listByUser(input: { userID: string }) {
    const items: FavoriteRecord[] = await readAll()
    return items
      .filter((item) => item.userID === input.userID)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },

  async findByUserAndQuestion(input: { userID: string; questionID: string }) {
    const items: FavoriteRecord[] = await readAll()
    return items.find((item) => item.userID === input.userID && item.questionID === input.questionID)
  },

  async insert(record: FavoriteRecord) {
    const items: FavoriteRecord[] = await readAll()
    const normalized = normalizeFavoriteRecord(record)
    items.push(normalized)
    writeAll(items)
    return normalized
  },

  async remove(input: { userID: string; questionID: string }) {
    const items: FavoriteRecord[] = await readAll()
    const next = items.filter((item) => !(item.userID === input.userID && item.questionID === input.questionID))
    if (next.length === items.length) throw new Error(`Favorite not found for question: ${input.questionID}`)
    writeAll(next)
  },
}
