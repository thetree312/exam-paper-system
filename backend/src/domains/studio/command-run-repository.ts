import { createHash } from "node:crypto"
import { createID } from "../../lib/ids"
import { getLocalSqlite } from "../../lib/local-sqlite"

type StudioCommandRunRecord = {
  id: string
  userID: string
  workroomID: string
  command: string
  idempotencyKey: string
  status: "running" | "completed" | "failed"
  payloadHash: string
  resultJson: string | null
  errorText: string | null
  createdAt: string
  updatedAt: string
}

function toRecord(row: Record<string, unknown>): StudioCommandRunRecord {
  return {
    id: String(row.id),
    userID: String(row.user_id),
    workroomID: String(row.workroom_id),
    command: String(row.command),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as StudioCommandRunRecord["status"],
    payloadHash: String(row.payload_hash),
    resultJson: (row.result_json as string | null) ?? null,
    errorText: (row.error_text as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function hashPayload(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

export const StudioCommandRunRepository = {
  hashPayload,

  async get(input: {
    userID: string
    workroomID: string
    command: string
    idempotencyKey: string
  }) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT * FROM studio_command_runs
         WHERE user_id=@user_id AND workroom_id=@workroom_id AND command=@command AND idempotency_key=@idempotency_key
         LIMIT 1`,
      )
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        command: input.command,
        idempotency_key: input.idempotencyKey,
      }) as Record<string, unknown> | null
    return row ? toRecord(row) : null
  },

  async tryStart(input: {
    userID: string
    workroomID: string
    command: string
    idempotencyKey: string
    payloadHash: string
  }) {
    const db = getLocalSqlite()
    const now = new Date().toISOString()
    const id = createID("studio_command_run")
    try {
      db.prepare(
        `INSERT INTO studio_command_runs (
          id, user_id, workroom_id, command, idempotency_key, status, payload_hash, result_json, error_text, created_at, updated_at
        ) VALUES (
          @id, @user_id, @workroom_id, @command, @idempotency_key, 'running', @payload_hash, NULL, NULL, @created_at, @updated_at
        )`,
      ).run({
        id,
        user_id: input.userID,
        workroom_id: input.workroomID,
        command: input.command,
        idempotency_key: input.idempotencyKey,
        payload_hash: input.payloadHash,
        created_at: now,
        updated_at: now,
      })
      return { started: true as const, record: await this.get(input) }
    } catch {
      return { started: false as const, record: await this.get(input) }
    }
  },

  async complete(input: {
    userID: string
    workroomID: string
    command: string
    idempotencyKey: string
    result: unknown
  }) {
    const db = getLocalSqlite()
    db.prepare(
      `UPDATE studio_command_runs
       SET status='completed', result_json=@result_json, error_text=NULL, updated_at=@updated_at
       WHERE user_id=@user_id AND workroom_id=@workroom_id AND command=@command AND idempotency_key=@idempotency_key`,
    ).run({
      user_id: input.userID,
      workroom_id: input.workroomID,
      command: input.command,
      idempotency_key: input.idempotencyKey,
      result_json: JSON.stringify(input.result),
      updated_at: new Date().toISOString(),
    })
  },

  async fail(input: {
    userID: string
    workroomID: string
    command: string
    idempotencyKey: string
    errorText: string
  }) {
    const db = getLocalSqlite()
    db.prepare(
      `UPDATE studio_command_runs
       SET status='failed', error_text=@error_text, updated_at=@updated_at
       WHERE user_id=@user_id AND workroom_id=@workroom_id AND command=@command AND idempotency_key=@idempotency_key`,
    ).run({
      user_id: input.userID,
      workroom_id: input.workroomID,
      command: input.command,
      idempotency_key: input.idempotencyKey,
      error_text: input.errorText,
      updated_at: new Date().toISOString(),
    })
  },
}

