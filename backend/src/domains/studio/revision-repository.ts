import { getLocalSqlite } from "../../lib/local-sqlite"

export const StudioRevisionRepository = {
  async get(input: { workroomID: string; studioDocumentID: string }) {
    const db = getLocalSqlite()
    const existing = db
      .prepare(
        `SELECT revision FROM studio_document_revisions WHERE workroom_id = ? AND studio_document_id = ?`,
      )
      .get(input.workroomID, input.studioDocumentID) as { revision: number } | undefined
    return Number(existing?.revision ?? 0)
  },

  async bump(input: { workroomID: string; studioDocumentID: string }) {
    const db = getLocalSqlite()
    const now = new Date().toISOString()
    const existing = db
      .prepare(
        `SELECT revision FROM studio_document_revisions WHERE workroom_id = ? AND studio_document_id = ?`,
      )
      .get(input.workroomID, input.studioDocumentID) as { revision: number } | undefined

    const nextRevision = Number(existing?.revision ?? 0) + 1
    db.prepare(
      `
        INSERT INTO studio_document_revisions (
          workroom_id, studio_document_id, revision, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(workroom_id, studio_document_id)
        DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
      `,
    ).run(input.workroomID, input.studioDocumentID, nextRevision, now)
    return nextRevision
  },
}
