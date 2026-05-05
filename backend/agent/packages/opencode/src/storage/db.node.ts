import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"

type StatementSyncLike = ReturnType<DatabaseSync["prepare"]>

function toArrayRows(rows: unknown[]) {
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row
    return Object.values(row as Record<string, unknown>)
  })
}

function wrapStatement(stmt: StatementSyncLike) {
  let arrayMode = false
  return {
    setReturnArrays(mode: boolean) {
      arrayMode = mode
    },
    run(...params: unknown[]) {
      return stmt.run(...params)
    },
    all(...params: unknown[]) {
      const rows = stmt.all(...params)
      return arrayMode ? toArrayRows(rows as unknown[]) : rows
    },
    get(...params: unknown[]) {
      const row = stmt.get(...params)
      if (!arrayMode || row === undefined) return row
      if (!row || typeof row !== "object" || Array.isArray(row)) return row
      return Object.values(row as Record<string, unknown>)
    },
  }
}

export function init(path: string) {
  const sqlite = new DatabaseSync(path)
  const originalPrepare = sqlite.prepare.bind(sqlite)
  sqlite.prepare = ((sql: string) => {
    return wrapStatement(originalPrepare(sql))
  }) as typeof sqlite.prepare
  const db = drizzle({ client: sqlite })
  return db
}
