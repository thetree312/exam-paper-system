import path from "node:path"
import { getLocalSqlite, parseJsonText, readJsonFileIfExists } from "../../lib/local-sqlite"
import { type QuestionRecord, type QuestionsState } from "./types"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")
let migrated = false

function ensureMigrated() {
  if (migrated) return
  migrated = true

  const db = getLocalSqlite()
  const count = db.prepare(`SELECT COUNT(*) AS count FROM questions`).get() as { count: number }
  if (count.count > 0) return

  const state = readJsonFileIfExists<QuestionsState>(path.join(backendRoot, "local-data", "questions", "index.json"))
  if (!state) return

  const tx = db.transaction(() => {
    for (const item of state.items) {
      db.prepare(
        `
          INSERT OR REPLACE INTO questions (
            id, user_id, workroom_id, document_id, studio_document_id, source_document_id, sequence_index, content, legend_images_json, page,
            student_answer, canonical_answer, explanation, grading_judgement, grading_predicted_answer,
            grading_reasoning, grading_confidence, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @document_id, @studio_document_id, @source_document_id, @sequence_index, @content, @legend_images_json, @page,
            @student_answer, @canonical_answer, @explanation, @grading_judgement, @grading_predicted_answer,
            @grading_reasoning, @grading_confidence, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        workroom_id: item.workroomID,
        document_id: item.studioDocumentID,
        studio_document_id: item.studioDocumentID,
        source_document_id: item.sourceDocumentID ?? null,
        sequence_index: item.sequenceIndex,
        content: item.content,
        legend_images_json: JSON.stringify(item.legendImages ?? []),
        page: item.page ?? null,
        student_answer: item.studentAnswer ?? null,
        canonical_answer: item.canonicalAnswer ?? null,
        explanation: item.explanation ?? null,
        grading_judgement: item.gradingJudgement ?? null,
        grading_predicted_answer: item.gradingPredictedAnswer ?? null,
        grading_reasoning: item.gradingReasoning ?? null,
        grading_confidence: item.gradingConfidence ?? null,
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
  const rows = db.prepare(`SELECT * FROM questions`).all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    userID: String(row.user_id),
    workroomID: String(row.workroom_id),
    studioDocumentID: String(row.studio_document_id ?? row.document_id),
    sourceDocumentID: (row.source_document_id as string | null) ?? null,
    sequenceIndex: Number(row.sequence_index),
    content: String(row.content),
    legendImages: parseJsonText<string[]>(String(row.legend_images_json ?? "[]"), []),
    page: row.page === null || row.page === undefined ? null : Number(row.page),
    studentAnswer: (row.student_answer as string | null) ?? null,
    canonicalAnswer: (row.canonical_answer as string | null) ?? null,
    explanation: (row.explanation as string | null) ?? null,
    gradingJudgement: (row.grading_judgement as QuestionRecord["gradingJudgement"]) ?? null,
    gradingPredictedAnswer: (row.grading_predicted_answer as string | null) ?? null,
    gradingReasoning: (row.grading_reasoning as string | null) ?? null,
    gradingConfidence: row.grading_confidence === null || row.grading_confidence === undefined ? null : Number(row.grading_confidence),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })) satisfies QuestionRecord[]
}

function normalizeQuestionRecord(record: QuestionRecord): QuestionRecord {
  return {
    ...record,
    page: record.page ?? null,
    studentAnswer: record.studentAnswer ?? null,
    canonicalAnswer: record.canonicalAnswer ?? null,
    explanation: record.explanation ?? null,
    gradingJudgement: record.gradingJudgement ?? null,
    gradingPredictedAnswer: record.gradingPredictedAnswer ?? null,
    gradingReasoning: record.gradingReasoning ?? null,
    gradingConfidence: record.gradingConfidence ?? null,
  }
}

function writeAll(items: QuestionRecord[]) {
  const db = getLocalSqlite()
  const tx = db.transaction((records: QuestionRecord[]) => {
    db.prepare(`DELETE FROM questions`).run()
    const statement = db.prepare(
      `
        INSERT INTO questions (
          id, user_id, workroom_id, document_id, studio_document_id, source_document_id, sequence_index, content, legend_images_json, page,
          student_answer, canonical_answer, explanation, grading_judgement, grading_predicted_answer,
          grading_reasoning, grading_confidence, created_at, updated_at
        ) VALUES (
          @id, @user_id, @workroom_id, @document_id, @studio_document_id, @source_document_id, @sequence_index, @content, @legend_images_json, @page,
          @student_answer, @canonical_answer, @explanation, @grading_judgement, @grading_predicted_answer,
          @grading_reasoning, @grading_confidence, @created_at, @updated_at
        )
      `,
    )
    for (const item of records) {
      statement.run({
        id: item.id,
        user_id: item.userID,
        workroom_id: item.workroomID,
        document_id: item.studioDocumentID,
        studio_document_id: item.studioDocumentID,
        source_document_id: item.sourceDocumentID ?? null,
        sequence_index: item.sequenceIndex,
        content: item.content,
        legend_images_json: JSON.stringify(item.legendImages ?? []),
        page: item.page ?? null,
        student_answer: item.studentAnswer ?? null,
        canonical_answer: item.canonicalAnswer ?? null,
        explanation: item.explanation ?? null,
        grading_judgement: item.gradingJudgement ?? null,
        grading_predicted_answer: item.gradingPredictedAnswer ?? null,
        grading_reasoning: item.gradingReasoning ?? null,
        grading_confidence: item.gradingConfidence ?? null,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })
  tx(items)
}

export const QuestionsRepository = {
  async listByUser(input: { userID: string }) {
    const items: QuestionRecord[] = await readAll()
    return items.filter((item) => item.userID === input.userID)
  },

  async listByStudioDocument(input: { userID: string; studioDocumentID: string }) {
    const items: QuestionRecord[] = await readAll()
    return items
      .filter((item) => item.userID === input.userID && item.studioDocumentID === input.studioDocumentID)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex || a.createdAt.localeCompare(b.createdAt))
  },

  async listBySourceDocument(input: { userID: string; sourceDocumentID: string }) {
    const items: QuestionRecord[] = await readAll()
    return items
      .filter((item) => item.userID === input.userID && item.sourceDocumentID === input.sourceDocumentID)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex || a.createdAt.localeCompare(b.createdAt))
  },

  async findByID(input: { userID: string; questionID: string }) {
    const items: QuestionRecord[] = await readAll()
    return items.find((item) => item.userID === input.userID && item.id === input.questionID)
  },

  async findByStudioDocumentAndSequence(input: { userID: string; studioDocumentID: string; sequenceIndex: number }) {
    const items: QuestionRecord[] = await readAll()
    return items.find(
      (item) =>
        item.userID === input.userID &&
        item.studioDocumentID === input.studioDocumentID &&
        item.sequenceIndex === input.sequenceIndex,
    )
  },

  async listByDocument(input: { userID: string; documentID: string }) {
    return this.listByStudioDocument({
      userID: input.userID,
      studioDocumentID: input.documentID,
    })
  },

  async findByDocumentAndSequence(input: { userID: string; documentID: string; sequenceIndex: number }) {
    return this.findByStudioDocumentAndSequence({
      userID: input.userID,
      studioDocumentID: input.documentID,
      sequenceIndex: input.sequenceIndex,
    })
  },

  async insert(record: QuestionRecord) {
    const items: QuestionRecord[] = await readAll()
    const normalized = normalizeQuestionRecord(record)
    items.push(normalized)
    writeAll(items)
    return normalized
  },

  async update(input: {
    userID: string
    questionID: string
    mutate: (record: QuestionRecord) => void
  }) {
    const items: QuestionRecord[] = await readAll()
    const record = items.find((item) => item.userID === input.userID && item.id === input.questionID)
    if (!record) throw new Error(`Question not found: ${input.questionID}`)
    input.mutate(record)
    writeAll(items)
    return record
  },

  async remove(input: { userID: string; questionID: string }) {
    const items: QuestionRecord[] = await readAll()
    const next = items.filter((item) => !(item.userID === input.userID && item.id === input.questionID))
    if (next.length === items.length) throw new Error(`Question not found: ${input.questionID}`)
    writeAll(next)
  },
}
