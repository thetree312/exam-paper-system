import path from "node:path"
import { getLocalSqlite, parseJsonText, readJsonFileIfExists } from "../../lib/local-sqlite"
import { type TaxonomyKind, type TaxonomyRecord, type TaxonomyState } from "./types"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")
let migrated = false

function ensureMigrated() {
  if (migrated) return
  migrated = true

  const db = getLocalSqlite()
  const count = db.prepare(`SELECT COUNT(*) AS count FROM taxonomies`).get() as { count: number }
  if (count.count > 0) return

  const state = readJsonFileIfExists<TaxonomyState>(path.join(backendRoot, "local-data", "taxonomies", "index.json"))
  if (!state) return

  const tx = db.transaction(() => {
    for (const item of state.items) {
      db.prepare(
        `
          INSERT OR REPLACE INTO taxonomies (
            id, user_id, kind, name, created_at, updated_at
          ) VALUES (
            @id, @user_id, @kind, @name, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        kind: item.kind,
        name: item.name,
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
  const rows = db.prepare(`SELECT * FROM taxonomies`).all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    userID: String(row.user_id),
    kind: row.kind as TaxonomyKind,
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })) satisfies TaxonomyRecord[]
}

function writeAll(items: TaxonomyRecord[]) {
  const db = getLocalSqlite()
  const tx = db.transaction((records: TaxonomyRecord[]) => {
    db.prepare(`DELETE FROM taxonomies`).run()
    const statement = db.prepare(
      `
        INSERT INTO taxonomies (
          id, user_id, kind, name, created_at, updated_at
        ) VALUES (
          @id, @user_id, @kind, @name, @created_at, @updated_at
        )
      `,
    )
    for (const item of records) {
      statement.run({
        id: item.id,
        user_id: item.userID,
        kind: item.kind,
        name: item.name,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })
  tx(items)
}

export const TaxonomyRepository = {
  async listByUserAndKind(input: { userID: string; kind: TaxonomyKind }) {
    const items: TaxonomyRecord[] = await readAll()
    return items
      .filter((item) => item.userID === input.userID && item.kind === input.kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },

  async findByUserKindAndName(input: { userID: string; kind: TaxonomyKind; name: string }) {
    const items: TaxonomyRecord[] = await readAll()
    return items.find((item) => item.userID === input.userID && item.kind === input.kind && item.name === input.name)
  },

  async findByID(input: { userID: string; taxonomyID: string; kind: TaxonomyKind }) {
    const items: TaxonomyRecord[] = await readAll()
    return items.find(
      (item) => item.userID === input.userID && item.kind === input.kind && item.id === input.taxonomyID,
    )
  },

  async insert(record: TaxonomyRecord) {
    const items: TaxonomyRecord[] = await readAll()
    items.push(record)
    writeAll(items)
    return record
  },
}
