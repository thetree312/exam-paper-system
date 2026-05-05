import path from "node:path"
import { getLocalSqlite, parseJsonText, readJsonFileIfExists } from "../../lib/local-sqlite"
import type { DocumentRecord } from "./service"

type DocumentState = {
  items: DocumentRecord[]
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")
let migrated = false

function ensureMigrated() {
  if (migrated) return
  migrated = true

  const db = getLocalSqlite()
  const count = db.prepare(`SELECT COUNT(*) AS count FROM documents`).get() as { count: number }
  if (count.count > 0) return

  const state = readJsonFileIfExists<DocumentState>(path.join(backendRoot, "local-data", "documents", "index.json"))
  if (!state) return

  const tx = db.transaction(() => {
    for (const item of state.items) {
      db.prepare(
        `
          INSERT OR REPLACE INTO documents (
            id, user_id, workroom_id, name, mime_type, source_type, status,
            original_path, original_sha256, original_size_bytes, preview_pages_json,
            extracted_text_pages_json, layout_pages_json, raw_markdown_path,
            raw_markdown_relative_path, raw_markdown_character_count,
            source_package_path, last_error_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @name, @mime_type, @source_type, @status,
            @original_path, @original_sha256, @original_size_bytes, @preview_pages_json,
            @extracted_text_pages_json, @layout_pages_json, @raw_markdown_path,
            @raw_markdown_relative_path, @raw_markdown_character_count,
            @source_package_path, @last_error_json, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        workroom_id: item.workroomID,
        name: item.name,
        mime_type: item.mimeType,
        source_type: item.sourceType,
        status: item.status,
        original_path: item.originalPath,
        original_sha256: item.originalSha256,
        original_size_bytes: item.originalSizeBytes,
        preview_pages_json: JSON.stringify(item.previewPages ?? []),
        extracted_text_pages_json: JSON.stringify(item.extractedTextPages ?? []),
        layout_pages_json: JSON.stringify(item.layoutPages ?? []),
        raw_markdown_path: item.rawMarkdownPath,
        raw_markdown_relative_path: item.rawMarkdownRelativePath,
        raw_markdown_character_count: item.rawMarkdownCharacterCount,
        source_package_path: item.sourcePackagePath,
        last_error_json: item.lastError ? JSON.stringify(item.lastError) : null,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })

  tx()
}

export const DocumentsRepository = {
  async read() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM documents ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        workroomID: String(row.workroom_id),
        name: String(row.name),
        mimeType: String(row.mime_type),
        sourceType: row.source_type as DocumentRecord["sourceType"],
        status: row.status as DocumentRecord["status"],
        originalPath: String(row.original_path),
        originalSha256: String(row.original_sha256 ?? ""),
        originalSizeBytes: Number(row.original_size_bytes ?? 0),
        previewPages: parseJsonText<DocumentRecord["previewPages"]>(String(row.preview_pages_json ?? "[]"), []),
        extractedTextPages: parseJsonText<DocumentRecord["extractedTextPages"]>(
          String(row.extracted_text_pages_json ?? "[]"),
          [],
        ),
        layoutPages: parseJsonText<DocumentRecord["layoutPages"]>(String(row.layout_pages_json ?? "[]"), []),
        rawMarkdownPath: String(row.raw_markdown_path ?? ""),
        rawMarkdownRelativePath: String(row.raw_markdown_relative_path ?? ""),
        rawMarkdownCharacterCount: Number(row.raw_markdown_character_count ?? 0),
        sourcePackagePath: String(row.source_package_path ?? ""),
        lastError: parseJsonText<DocumentRecord["lastError"]>((row.last_error_json as string | null) ?? null, null),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies DocumentState
  },

  async update(mutate: (state: DocumentState) => void | DocumentState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.read()
    const next = (mutate(current) ?? current) as DocumentState
    const tx = db.transaction((state: DocumentState) => {
      db.prepare(`DELETE FROM documents`).run()
      const statement = db.prepare(
        `
          INSERT INTO documents (
            id, user_id, workroom_id, name, mime_type, source_type, status,
            original_path, original_sha256, original_size_bytes, preview_pages_json,
            extracted_text_pages_json, layout_pages_json, raw_markdown_path,
            raw_markdown_relative_path, raw_markdown_character_count,
            source_package_path, last_error_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @name, @mime_type, @source_type, @status,
            @original_path, @original_sha256, @original_size_bytes, @preview_pages_json,
            @extracted_text_pages_json, @layout_pages_json, @raw_markdown_path,
            @raw_markdown_relative_path, @raw_markdown_character_count,
            @source_package_path, @last_error_json, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          name: item.name,
          mime_type: item.mimeType,
          source_type: item.sourceType,
          status: item.status,
          original_path: item.originalPath,
          original_sha256: item.originalSha256,
          original_size_bytes: item.originalSizeBytes,
          preview_pages_json: JSON.stringify(item.previewPages ?? []),
          extracted_text_pages_json: JSON.stringify(item.extractedTextPages ?? []),
          layout_pages_json: JSON.stringify(item.layoutPages ?? []),
          raw_markdown_path: item.rawMarkdownPath,
          raw_markdown_relative_path: item.rawMarkdownRelativePath,
          raw_markdown_character_count: item.rawMarkdownCharacterCount,
          source_package_path: item.sourcePackagePath,
          last_error_json: item.lastError ? JSON.stringify(item.lastError) : null,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },
}
