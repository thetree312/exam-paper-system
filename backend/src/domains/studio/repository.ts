import path from "node:path"
import { getLocalSqlite, parseJsonText, readJsonFileIfExists } from "../../lib/local-sqlite"
import { createLogger } from "../../lib/logger"
import { EMPTY_MATH_DOCUMENT, ensureMathContentDocument, mathContentToPromptText } from "../../lib/math-content"
import type {
  QuestionCardAttemptRecord,
  QuestionCardDiagnosisRecord,
  QuestionCardWeaknessRecord,
  StudioDocumentRecord,
  StudioQuestionCardRecord,
} from "./types"

type StudioDocumentState = {
  items: StudioDocumentRecord[]
}

type StudioQuestionCardState = {
  items: StudioQuestionCardRecord[]
}

type QuestionCardAttemptState = {
  items: QuestionCardAttemptRecord[]
}

type QuestionCardDiagnosisState = {
  items: QuestionCardDiagnosisRecord[]
}

type QuestionCardWeaknessState = {
  items: QuestionCardWeaknessRecord[]
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")
let migrated = false
const logger = createLogger({ domain: "studio-repository" })

function captureCallerStack(maxLines = 8) {
  const raw = new Error().stack ?? ""
  return raw
    .split("\n")
    .slice(2)
    .map((line) => line.trim())
    .filter((line) => !line.includes("repository.ts"))
    .slice(0, maxLines)
}

function summarizeCardDelta(before: StudioQuestionCardRecord[], after: StudioQuestionCardRecord[]) {
  const beforeByID = new Map(before.map((item) => [item.id, item]))
  const afterByID = new Map(after.map((item) => [item.id, item]))
  const created: string[] = []
  const removed: string[] = []
  const touched: string[] = []
  for (const item of after) {
    const prev = beforeByID.get(item.id)
    if (!prev) {
      created.push(item.id)
      continue
    }
    if (
      prev.sequenceIndex !== item.sequenceIndex ||
      prev.text !== item.text ||
      prev.updatedAt !== item.updatedAt ||
      prev.cardGroupID !== item.cardGroupID
    ) {
      touched.push(item.id)
    }
  }
  for (const item of before) {
    if (!afterByID.has(item.id)) removed.push(item.id)
  }
  const studioDocumentIDs = Array.from(new Set(after.map((item) => item.studioDocumentID))).sort((a, b) => a.localeCompare(b))
  return {
    beforeCount: before.length,
    afterCount: after.length,
    created,
    removed,
    touched,
    studioDocumentIDs,
  }
}

function defaultAnswerEvidence(): StudioQuestionCardRecord["answerEvidence"] {
  return { status: "missing" }
}

function defaultLearningSnapshot(): StudioQuestionCardRecord["learningSnapshot"] {
  return {
    masteryScore: 0,
    masteryLevel: "unknown",
    masteryTrend7d: 0,
    attemptCount: 0,
    correctCount: 0,
    incorrectCount: 0,
    diagnosisFailedCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    lastReviewedAt: null,
    lastJudgement: null,
    latestDiagnosisSummary: null,
    weaknessSummary: [],
    reviewHeatmap180d: [],
  }
}

function ensureMigrated() {
  if (migrated) return
  migrated = true

  const db = getLocalSqlite()
  const count = db.prepare(`SELECT COUNT(*) AS count FROM studio_documents`).get() as { count: number }
  if (count.count > 0) return

  const documents = readJsonFileIfExists<StudioDocumentState>(path.join(backendRoot, "local-data", "studio", "documents.json"))
  const cards = readJsonFileIfExists<StudioQuestionCardState>(
    path.join(backendRoot, "local-data", "studio", "question-cards.json"),
  )

  const tx = db.transaction(() => {
    for (const item of documents?.items ?? []) {
      db.prepare(
        `
          INSERT OR REPLACE INTO studio_documents (
            id, user_id, workroom_id, source_document_id, title, status, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @source_document_id, @title, @status, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        workroom_id: item.workroomID,
        source_document_id: item.sourceDocumentID ?? null,
        title: item.title,
        status: item.status,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }

    for (const item of cards?.items ?? []) {
      db.prepare(
        `
          INSERT OR REPLACE INTO studio_question_cards (
            id, user_id, workroom_id, studio_document_id, source_document_id, sequence_index,
            card_group_id,
            page, text, original_text, answer_content_json, answer_text, canonical_answer, explanation,
            legend_images_json, derived_from_card_id, relation_type, origin_task_json,
            source_selection_json, answer_evidence_json, learning_snapshot_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @studio_document_id, @source_document_id, @sequence_index,
            @card_group_id,
            @page, @text, @original_text, @answer_content_json, @answer_text, @canonical_answer, @explanation,
            @legend_images_json, @derived_from_card_id, @relation_type, @origin_task_json,
            @source_selection_json, @answer_evidence_json, @learning_snapshot_json, @created_at, @updated_at
          )
        `,
      ).run({
        id: item.id,
        user_id: item.userID,
        workroom_id: item.workroomID,
        studio_document_id: item.studioDocumentID,
        source_document_id: item.sourceDocumentID ?? null,
        card_group_id: (item as any).cardGroupID ?? item.id,
        sequence_index: item.sequenceIndex,
        page: item.page,
        text: item.text,
        original_text: item.originalText,
        answer_content_json: JSON.stringify(ensureMathContentDocument((item as any).answerContent, item.answerText ?? "")),
        answer_text: mathContentToPromptText(ensureMathContentDocument((item as any).answerContent, item.answerText ?? "")),
        canonical_answer: item.canonicalAnswer ?? "",
        explanation: item.explanation ?? null,
        legend_images_json: JSON.stringify(item.legendImages ?? []),
        derived_from_card_id: item.derivedFromCardID ?? null,
        relation_type: item.relationType ?? null,
        origin_task_json: JSON.stringify(item.originTask ?? null),
        source_selection_json: JSON.stringify(item.sourceSelection ?? { regions: [], legends: [] }),
        answer_evidence_json: JSON.stringify((item as any).answerEvidence ?? defaultAnswerEvidence()),
        learning_snapshot_json: JSON.stringify((item as any).learningSnapshot ?? defaultLearningSnapshot()),
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })

  tx()
}

export const StudioRepository = {
  async readDocuments() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM studio_documents ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        workroomID: String(row.workroom_id),
        sourceDocumentID: (row.source_document_id as string | null) ?? null,
        title: String(row.title),
        status: "active",
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies StudioDocumentState
  },

  async updateDocuments(mutate: (state: StudioDocumentState) => void | StudioDocumentState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.readDocuments()
    const next = (mutate(current) ?? current) as StudioDocumentState
    const tx = db.transaction((state: StudioDocumentState) => {
      db.prepare(`DELETE FROM studio_documents`).run()
      const statement = db.prepare(
        `
          INSERT INTO studio_documents (
            id, user_id, workroom_id, source_document_id, title, status, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @source_document_id, @title, @status, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          source_document_id: item.sourceDocumentID ?? null,
          title: item.title,
          status: item.status,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },

  async readQuestionCards() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db
      .prepare(`SELECT * FROM studio_question_cards ORDER BY sequence_index ASC, created_at ASC`)
      .all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        workroomID: String(row.workroom_id),
        studioDocumentID: String(row.studio_document_id),
        sourceDocumentID: (row.source_document_id as string | null) ?? null,
        cardGroupID: String((row.card_group_id as string | null) ?? row.id),
        sequenceIndex: Number(row.sequence_index),
        page: Number(row.page),
        text: String(row.text),
        originalText: String(row.original_text),
        answerContent: ensureMathContentDocument(
          parseJsonText(String(row.answer_content_json ?? ""), EMPTY_MATH_DOCUMENT),
          String(row.answer_text ?? ""),
        ),
        answerText: String(row.answer_text),
        canonicalAnswer: String(row.canonical_answer ?? ""),
        explanation: (row.explanation as string | null) ?? null,
        legendImages: parseJsonText<string[]>(String(row.legend_images_json ?? "[]"), []),
        derivedFromCardID: (row.derived_from_card_id as string | null) ?? null,
        relationType: (row.relation_type as StudioQuestionCardRecord["relationType"]) ?? null,
        originTask: parseJsonText<StudioQuestionCardRecord["originTask"]>(String(row.origin_task_json ?? "null"), null),
        sourceSelection: parseJsonText<StudioQuestionCardRecord["sourceSelection"]>(String(row.source_selection_json ?? "{}"), {
          regions: [],
          legends: [],
        }),
        answerEvidence: parseJsonText<StudioQuestionCardRecord["answerEvidence"]>(
          String(row.answer_evidence_json ?? `{"status":"missing"}`),
          defaultAnswerEvidence(),
        ),
        learningSnapshot: parseJsonText<StudioQuestionCardRecord["learningSnapshot"]>(
          String(row.learning_snapshot_json ?? "{}"),
          defaultLearningSnapshot(),
        ),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies StudioQuestionCardState
  },

  async updateQuestionCards(mutate: (state: StudioQuestionCardState) => void | StudioQuestionCardState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.readQuestionCards()
    const callerStack = captureCallerStack()
    logger.info("update question cards invoked", {
      before_count: current.items.length,
      caller_stack: callerStack,
    })
    const next = (mutate(current) ?? current) as StudioQuestionCardState
    const delta = summarizeCardDelta(current.items, next.items)
    logger.info("update question cards mutation summary", {
      before_count: delta.beforeCount,
      after_count: delta.afterCount,
      created_count: delta.created.length,
      removed_count: delta.removed.length,
      touched_count: delta.touched.length,
      created_card_ids: delta.created,
      removed_card_ids: delta.removed,
      touched_card_ids: delta.touched,
      studio_document_ids: delta.studioDocumentIDs,
    })
    const tx = db.transaction((state: StudioQuestionCardState) => {
      db.prepare(`DELETE FROM studio_question_cards`).run()
      const statement = db.prepare(
        `
          INSERT INTO studio_question_cards (
            id, user_id, workroom_id, studio_document_id, source_document_id, sequence_index,
            card_group_id,
            page, text, original_text, answer_content_json, answer_text, canonical_answer, explanation,
            legend_images_json, derived_from_card_id, relation_type, origin_task_json,
            source_selection_json, answer_evidence_json, learning_snapshot_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @studio_document_id, @source_document_id, @sequence_index,
            @card_group_id,
            @page, @text, @original_text, @answer_content_json, @answer_text, @canonical_answer, @explanation,
            @legend_images_json, @derived_from_card_id, @relation_type, @origin_task_json,
            @source_selection_json, @answer_evidence_json, @learning_snapshot_json, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        const answerContent = ensureMathContentDocument(item.answerContent, item.answerText ?? "")
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          studio_document_id: item.studioDocumentID,
          source_document_id: item.sourceDocumentID ?? null,
          card_group_id: item.cardGroupID ?? item.id,
          sequence_index: item.sequenceIndex,
          page: item.page,
          text: item.text,
          original_text: item.originalText,
          answer_content_json: JSON.stringify(answerContent),
          answer_text: mathContentToPromptText(answerContent),
          canonical_answer: item.canonicalAnswer ?? "",
          explanation: item.explanation ?? null,
          legend_images_json: JSON.stringify(item.legendImages ?? []),
          derived_from_card_id: item.derivedFromCardID ?? null,
          relation_type: item.relationType ?? null,
          origin_task_json: JSON.stringify(item.originTask ?? null),
          source_selection_json: JSON.stringify(item.sourceSelection ?? { regions: [], legends: [] }),
          answer_evidence_json: JSON.stringify(item.answerEvidence ?? defaultAnswerEvidence()),
          learning_snapshot_json: JSON.stringify(item.learningSnapshot ?? defaultLearningSnapshot()),
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    logger.info("update question cards persisted", {
      after_count: next.items.length,
      studio_document_ids: Array.from(new Set(next.items.map((item) => item.studioDocumentID))).sort((a, b) =>
        a.localeCompare(b),
      ),
    })
    return next
  },

  async readAttempts() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM question_card_attempts ORDER BY submitted_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        workroomID: String(row.workroom_id),
        cardID: String(row.card_id),
        studioDocumentID: String(row.studio_document_id),
        sequenceIndex: Number(row.sequence_index),
        sourceDocumentID: (row.source_document_id as string | null) ?? null,
        answerText: String(row.answer_text ?? ""),
        judgement: row.judgement as QuestionCardAttemptRecord["judgement"],
        predictedAnswer: (row.predicted_answer as string | null) ?? null,
        scoreNumerator: Number(row.score_numerator ?? 0),
        scoreDenominator: Number(row.score_denominator ?? 1),
        scorePercent: Number(row.score_percent ?? 0),
        gradingMode: row.grading_mode as QuestionCardAttemptRecord["gradingMode"],
        referenceEvidenceStatus: row.reference_evidence_status as QuestionCardAttemptRecord["referenceEvidenceStatus"],
        reasoning: (row.reasoning as string | null) ?? null,
        submittedAt: String(row.submitted_at),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies QuestionCardAttemptState
  },

  async updateAttempts(mutate: (state: QuestionCardAttemptState) => void | QuestionCardAttemptState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.readAttempts()
    const next = (mutate(current) ?? current) as QuestionCardAttemptState
    const tx = db.transaction((state: QuestionCardAttemptState) => {
      db.prepare(`DELETE FROM question_card_attempts`).run()
      const statement = db.prepare(
        `
          INSERT INTO question_card_attempts (
            id, user_id, workroom_id, card_id, studio_document_id, sequence_index, source_document_id,
            answer_text, judgement, predicted_answer, score_numerator, score_denominator, score_percent,
            grading_mode, reference_evidence_status, reasoning, submitted_at, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @card_id, @studio_document_id, @sequence_index, @source_document_id,
            @answer_text, @judgement, @predicted_answer, @score_numerator, @score_denominator, @score_percent,
            @grading_mode, @reference_evidence_status, @reasoning, @submitted_at, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          card_id: item.cardID,
          studio_document_id: item.studioDocumentID,
          sequence_index: item.sequenceIndex,
          source_document_id: item.sourceDocumentID ?? null,
          answer_text: item.answerText,
          judgement: item.judgement,
          predicted_answer: item.predictedAnswer ?? null,
          score_numerator: item.scoreNumerator,
          score_denominator: item.scoreDenominator,
          score_percent: item.scorePercent,
          grading_mode: item.gradingMode,
          reference_evidence_status: item.referenceEvidenceStatus,
          reasoning: item.reasoning ?? null,
          submitted_at: item.submittedAt,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },

  async readDiagnoses() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM question_card_diagnoses ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        workroomID: String(row.workroom_id),
        cardID: String(row.card_id),
        attemptID: String(row.attempt_id),
        rootCauseType: row.root_cause_type as QuestionCardDiagnosisRecord["rootCauseType"],
        conclusion: String(row.conclusion ?? ""),
        evidenceSnippets: parseJsonText<string[]>(String(row.evidence_snippets_json ?? "[]"), []),
        confidence: Number(row.confidence ?? 0),
        improvementAdvice: String(row.improvement_advice ?? ""),
        weaknessItems: parseJsonText<QuestionCardDiagnosisRecord["weaknessItems"]>(
          String(row.weakness_items_json ?? "[]"),
          [],
        ),
        modelOutputRawJson: String(row.model_output_raw_json ?? "{}"),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies QuestionCardDiagnosisState
  },

  async updateDiagnoses(mutate: (state: QuestionCardDiagnosisState) => void | QuestionCardDiagnosisState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.readDiagnoses()
    const next = (mutate(current) ?? current) as QuestionCardDiagnosisState
    const tx = db.transaction((state: QuestionCardDiagnosisState) => {
      db.prepare(`DELETE FROM question_card_diagnoses`).run()
      const statement = db.prepare(
        `
          INSERT INTO question_card_diagnoses (
            id, user_id, workroom_id, card_id, attempt_id, root_cause_type, conclusion, evidence_snippets_json,
            confidence, improvement_advice, weakness_items_json, model_output_raw_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @card_id, @attempt_id, @root_cause_type, @conclusion, @evidence_snippets_json,
            @confidence, @improvement_advice, @weakness_items_json, @model_output_raw_json, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          card_id: item.cardID,
          attempt_id: item.attemptID,
          root_cause_type: item.rootCauseType,
          conclusion: item.conclusion,
          evidence_snippets_json: JSON.stringify(item.evidenceSnippets ?? []),
          confidence: item.confidence,
          improvement_advice: item.improvementAdvice,
          weakness_items_json: JSON.stringify(item.weaknessItems ?? []),
          model_output_raw_json: item.modelOutputRawJson,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },

  async readWeaknesses() {
    ensureMigrated()
    const db = getLocalSqlite()
    const rows = db.prepare(`SELECT * FROM question_card_weaknesses ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        userID: String(row.user_id),
        workroomID: String(row.workroom_id),
        cardID: String(row.card_id),
        weaknessKey: String(row.weakness_key),
        label: String(row.label),
        category: row.category as QuestionCardWeaknessRecord["category"],
        status: row.status as QuestionCardWeaknessRecord["status"],
        severity: row.severity as QuestionCardWeaknessRecord["severity"],
        count: Number(row.count ?? 1),
        firstSeenAt: String(row.first_seen_at),
        lastSeenAt: String(row.last_seen_at),
        resolvedAt: (row.resolved_at as string | null) ?? null,
        evidenceAttemptIDs: parseJsonText<string[]>(String(row.evidence_attempt_ids_json ?? "[]"), []),
        evidenceDiagnosisIDs: parseJsonText<string[]>(String(row.evidence_diagnosis_ids_json ?? "[]"), []),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    } satisfies QuestionCardWeaknessState
  },

  async updateWeaknesses(mutate: (state: QuestionCardWeaknessState) => void | QuestionCardWeaknessState) {
    ensureMigrated()
    const db = getLocalSqlite()
    const current = await this.readWeaknesses()
    const next = (mutate(current) ?? current) as QuestionCardWeaknessState
    const tx = db.transaction((state: QuestionCardWeaknessState) => {
      db.prepare(`DELETE FROM question_card_weaknesses`).run()
      const statement = db.prepare(
        `
          INSERT INTO question_card_weaknesses (
            id, user_id, workroom_id, card_id, weakness_key, label, category, status, severity, count,
            first_seen_at, last_seen_at, resolved_at, evidence_attempt_ids_json, evidence_diagnosis_ids_json, created_at, updated_at
          ) VALUES (
            @id, @user_id, @workroom_id, @card_id, @weakness_key, @label, @category, @status, @severity, @count,
            @first_seen_at, @last_seen_at, @resolved_at, @evidence_attempt_ids_json, @evidence_diagnosis_ids_json, @created_at, @updated_at
          )
        `,
      )
      for (const item of state.items) {
        statement.run({
          id: item.id,
          user_id: item.userID,
          workroom_id: item.workroomID,
          card_id: item.cardID,
          weakness_key: item.weaknessKey,
          label: item.label,
          category: item.category,
          status: item.status,
          severity: item.severity,
          count: item.count,
          first_seen_at: item.firstSeenAt,
          last_seen_at: item.lastSeenAt,
          resolved_at: item.resolvedAt ?? null,
          evidence_attempt_ids_json: JSON.stringify(item.evidenceAttemptIDs ?? []),
          evidence_diagnosis_ids_json: JSON.stringify(item.evidenceDiagnosisIDs ?? []),
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
      }
    })
    tx(next)
    return next
  },
}
