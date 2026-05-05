import { createID } from "../../lib/ids"
import {
  createTextMathDocument,
  ensureMathContentDocument,
  mathContentToPromptText,
  type MathContentDocument,
} from "../../lib/math-content"
import { DocumentsService } from "../documents/service"
import { QuestionLlmService } from "../questions/llm-service"
import { WorkroomService } from "../workrooms/service"
import { StudioRepository } from "./repository"
import { StudioOcrService } from "./ocr-service"
import { importDocumentLayoutAsQuestionCards } from "./layout-importer"
import type {
  QuestionCardAttemptRecord,
  QuestionCardDiagnosisRecord,
  QuestionCardWeaknessRecord,
  StudioDocumentRecord,
  StudioLegendRegion,
  StudioQuestionCardRecord,
  StudioSelectionRegion,
} from "./types"

const DIAGNOSIS_PROMPT = [
  "你是学习诊断教练。请依据题目、本次作答、最近历史、已有薄弱点进行结构化诊断。",
  "必须输出 JSON 对象，字段仅允许：root_cause_type, conclusion, evidence_snippets, confidence, improvement_advice, weakness_items。",
  "root_cause_type 必须是 concept_gap|misread_question|method_gap|calculation_error|expression_issue|careless_mistake|unknown 之一。",
  "weakness_items 为数组，元素字段：weaknessKey, label, severity(low|medium|high), statusSuggestion(open|improving|resolved|relapsed)。",
  "禁止输出 markdown，禁止输出多余文本。",
].join("\n")

function normalizeTitle(input?: string | null) {
  const normalized = input?.trim()
  return normalized || "未命名题卡集"
}

function normalizeText(input?: string | null) {
  return input?.trim() ?? ""
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

function toLevel(score: number): StudioQuestionCardRecord["learningSnapshot"]["masteryLevel"] {
  if (score >= 85) return "mastered"
  if (score >= 70) return "good"
  if (score >= 50) return "reviewing"
  if (score > 0) return "struggling"
  return "unknown"
}

function parseQuestionNo(text: string, fallback: number) {
  const first = text.split(/\r?\n/).find((line) => line.trim())
  const match = /^\s*(\d{1,3})\s*[.．、:：]/.exec(first ?? "")
  if (!match) return fallback
  const n = Number(match[1])
  return Number.isFinite(n) ? n : fallback
}

function buildHeatmap180d(attempts: QuestionCardAttemptRecord[]) {
  const now = new Date()
  const bucket = new Map<string, number>()
  for (const item of attempts) {
    const key = String(item.submittedAt).slice(0, 10)
    bucket.set(key, (bucket.get(key) ?? 0) + 1)
  }
  const result: Array<{ date: string; intensity: number }> = []
  for (let i = 179; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    result.push({ date: d, intensity: Math.min(4, bucket.get(d) ?? 0) })
  }
  return result
}

function buildAnswerEvidence(card: StudioQuestionCardRecord, sourcePackage: Awaited<ReturnType<typeof DocumentsService.readSourcePackage>>) {
  const qNo = parseQuestionNo(card.text, card.sequenceIndex + 1)
  const candidates: Array<{
    page: number
    layoutUnitKey: string
    rawMarkdownRange: StudioQuestionCardRecord["answerEvidence"]["rawMarkdownRange"]
    answer: string
  }> = []
  const lines: Array<{
    page: number
    layoutUnitKey: string
    rawMarkdownRange: StudioQuestionCardRecord["answerEvidence"]["rawMarkdownRange"]
    line: string
  }> = []
  for (const page of sourcePackage.layoutPages) {
    for (const block of page.blocks) {
      if (block.blockLabel !== "text") continue
      const content = String(block.content ?? "")
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        lines.push({
          page: page.pageNumber,
          layoutUnitKey: block.layoutUnitKey,
          rawMarkdownRange: block.rawMarkdownRange,
          line,
        })
      }
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i]
    const header = /^[\[【]?(第\s*)?(\d+)\s*(题)?\s*答案[】\]]?\s*$/.exec(current.line)
    if (!header) continue
    const n = Number(header[2])
    if (!Number.isFinite(n) || n !== qNo) continue
    let value = ""
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
      const next = lines[j].line
      const m = /^[\[【]?答案[】\]]?\s*[:：]?\s*(.+)$/.exec(next)
      if (m?.[1]) {
        value = m[1].trim()
        break
      }
      if (/^[\[【]?(第\s*)?\d+\s*(题)?\s*答案/.test(next)) break
    }
    if (value) {
      candidates.push({
        page: current.page,
        layoutUnitKey: current.layoutUnitKey,
        rawMarkdownRange: current.rawMarkdownRange,
        answer: value,
      })
    }
  }
  if (candidates.length === 1) {
    return {
      canonicalAnswer: candidates[0].answer,
      evidence: {
        status: "verified_unique" as const,
        sourcePackagePath: sourcePackage.workspace.sourcePackagePath,
        page: candidates[0].page,
        layoutUnitKey: candidates[0].layoutUnitKey,
        rawMarkdownRange: candidates[0].rawMarkdownRange ?? null,
        notes: `mapped by deterministic header+answer rule, qNo=${qNo}`,
      },
    }
  }
  if (candidates.length > 1) {
    return {
      canonicalAnswer: "",
      evidence: {
        status: "ambiguous" as const,
        sourcePackagePath: sourcePackage.workspace.sourcePackagePath,
        notes: `multiple candidates=${candidates.length}, qNo=${qNo}`,
      },
    }
  }
  return {
    canonicalAnswer: "",
    evidence: {
      status: "missing" as const,
      sourcePackagePath: sourcePackage.workspace.sourcePackagePath,
      notes: `no deterministic candidate, qNo=${qNo}`,
    },
  }
}

function validateDiagnosisJson(json: Record<string, unknown>) {
  const rootCauseType = String(json.root_cause_type ?? "")
  const allowedRootCauseType = new Set([
    "concept_gap",
    "misread_question",
    "method_gap",
    "calculation_error",
    "expression_issue",
    "careless_mistake",
    "unknown",
  ])
  if (!allowedRootCauseType.has(rootCauseType)) throw new Error(`Invalid root_cause_type: ${rootCauseType}`)
  const conclusion = String(json.conclusion ?? "").trim()
  const improvementAdvice = String(json.improvement_advice ?? "").trim()
  const confidence = Number(json.confidence ?? 0)
  if (!conclusion || !improvementAdvice) throw new Error("Diagnosis fields are empty")
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Invalid diagnosis confidence")
  const evidenceSnippetsRaw = Array.isArray(json.evidence_snippets) ? json.evidence_snippets : []
  const evidenceSnippets = evidenceSnippetsRaw.map((item) => String(item).trim()).filter(Boolean)
  const weaknessItemsRaw = Array.isArray(json.weakness_items) ? json.weakness_items : []
  const weaknessItems = weaknessItemsRaw
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      weaknessKey: String(item.weaknessKey ?? item.weakness_key ?? "").trim(),
      label: String(item.label ?? "").trim(),
      severity: String(item.severity ?? "").trim(),
      statusSuggestion: String(item.statusSuggestion ?? item.status_suggestion ?? "").trim(),
    }))
    .filter((item) => item.weaknessKey && item.label)
    .map((item) => ({
      weaknessKey: item.weaknessKey,
      label: item.label,
      severity: (item.severity === "low" || item.severity === "medium" || item.severity === "high" ? item.severity : "medium") as
        | "low"
        | "medium"
        | "high",
      statusSuggestion:
        (item.statusSuggestion === "open" ||
        item.statusSuggestion === "improving" ||
        item.statusSuggestion === "resolved" ||
        item.statusSuggestion === "relapsed"
          ? item.statusSuggestion
          : "open") as "open" | "improving" | "resolved" | "relapsed",
    }))
  return {
    rootCauseType: rootCauseType as QuestionCardDiagnosisRecord["rootCauseType"],
    conclusion,
    improvementAdvice,
    confidence,
    evidenceSnippets,
    weaknessItems,
  }
}

async function rebuildSnapshot(input: {
  card: StudioQuestionCardRecord
  attempts: QuestionCardAttemptRecord[]
  weaknesses: QuestionCardWeaknessRecord[]
  latestDiagnosisSummary?: string | null
}) {
  const relatedAttempts = input.attempts.filter((item) => item.cardID === input.card.id)
  const relatedWeaknesses = input.weaknesses.filter((item) => item.cardID === input.card.id)
  const attemptCount = relatedAttempts.length
  const correctCount = relatedAttempts.filter((item) => item.judgement === "correct").length
  const incorrectCount = relatedAttempts.filter((item) => item.judgement === "incorrect").length
  const diagnosisFailedCount = relatedAttempts.filter((item) => item.judgement === "diagnosis_failed").length
  const last = relatedAttempts[0]
  const first = relatedAttempts[relatedAttempts.length - 1]
  const masteryScore = attemptCount === 0 ? 0 : Math.max(0, Math.min(100, Math.round((correctCount / attemptCount) * 100)))
  const snapshot: StudioQuestionCardRecord["learningSnapshot"] = {
    masteryScore,
    masteryLevel: toLevel(masteryScore),
    masteryTrend7d: 0,
    attemptCount,
    correctCount,
    incorrectCount,
    diagnosisFailedCount,
    firstAttemptAt: first?.submittedAt ?? null,
    lastAttemptAt: last?.submittedAt ?? null,
    lastReviewedAt: last?.submittedAt ?? null,
    lastJudgement: last?.judgement ?? null,
    latestDiagnosisSummary: input.latestDiagnosisSummary ?? input.card.learningSnapshot.latestDiagnosisSummary ?? null,
    weaknessSummary: relatedWeaknesses.map((w) => ({
      weaknessKey: w.weaknessKey,
      label: w.label,
      status: w.status,
      severity: w.severity,
      count: w.count,
    })),
    reviewHeatmap180d: buildHeatmap180d(relatedAttempts),
  }
  return snapshot
}

export const StudioService = {
  async listDocuments(input: { userID: string; workroomID: string; sourceDocumentID?: string }) {
    const state = await StudioRepository.readDocuments()
    return state.items
      .filter(
        (item) =>
          item.userID === input.userID &&
          item.workroomID === input.workroomID &&
          (!input.sourceDocumentID || item.sourceDocumentID === input.sourceDocumentID),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  },

  async getDocument(input: { userID: string; workroomID: string; studioDocumentID: string }) {
    const state = await StudioRepository.readDocuments()
    return (
      state.items.find(
        (item) => item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.studioDocumentID,
      ) ?? null
    )
  },

  async createDocument(input: { userID: string; workroomID: string; title?: string | null; sourceDocumentID?: string | null }) {
    const workroom = await WorkroomService.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const now = new Date().toISOString()
    const record: StudioDocumentRecord = {
      id: createID("studio_document"),
      userID: input.userID,
      workroomID: input.workroomID,
      sourceDocumentID: input.sourceDocumentID ?? null,
      title: normalizeTitle(input.title),
      status: "active",
      createdAt: now,
      updatedAt: now,
    }
    await StudioRepository.updateDocuments((state) => {
      state.items.push(record)
    })
    return record
  },

  async getOrCreateDocument(input: {
    userID: string
    workroomID: string
    studioDocumentID?: string | null
    sourceDocumentID?: string | null
    title?: string | null
  }) {
    if (input.studioDocumentID) {
      const existing = await this.getDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: input.studioDocumentID,
      })
      if (!existing) throw new Error(`Studio document not found: ${input.studioDocumentID}`)
      return existing
    }
    if (input.sourceDocumentID) {
      const existing = (
        await this.listDocuments({
          userID: input.userID,
          workroomID: input.workroomID,
          sourceDocumentID: input.sourceDocumentID,
        })
      )[0]
      if (existing) return existing
    }
    return this.createDocument(input)
  },

  async listQuestionCards(input: { userID: string; workroomID: string; studioDocumentID: string }) {
    const state = await StudioRepository.readQuestionCards()
    return state.items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.studioDocumentID === input.studioDocumentID)
      .sort((left, right) => left.sequenceIndex - right.sequenceIndex || left.createdAt.localeCompare(right.createdAt))
  },

  async getQuestionCardDetail(input: { userID: string; workroomID: string; cardID: string }) {
    const cards = await StudioRepository.readQuestionCards()
    const card = cards.items.find((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.cardID)
    if (!card) throw new Error(`Studio question card not found: ${input.cardID}`)
    const attempts = (await StudioRepository.readAttempts()).items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === card.id)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    const diagnoses = (await StudioRepository.readDiagnoses()).items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === card.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const weaknesses = (await StudioRepository.readWeaknesses()).items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === card.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { card, attempts, diagnoses, weaknesses, reviewHeatmap180d: card.learningSnapshot.reviewHeatmap180d }
  },

  async updateQuestionCard(input: {
    userID: string
    workroomID: string
    cardID: string
    text?: string
    answerContent?: MathContentDocument
    answerText?: string
    legendImages?: string[]
  }) {
    let updated: StudioQuestionCardRecord | undefined
    await StudioRepository.updateQuestionCards((state) => {
      const record = state.items.find((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.cardID)
      if (!record) throw new Error(`Studio question card not found: ${input.cardID}`)
      if (input.text !== undefined) {
        record.text = normalizeText(input.text)
        record.originalText = normalizeText(input.text)
      }
      if (input.answerContent !== undefined || input.answerText !== undefined) {
        record.answerContent = ensureMathContentDocument(input.answerContent, input.answerText ?? record.answerText ?? "")
        record.answerText = mathContentToPromptText(record.answerContent)
      }
      if (input.legendImages !== undefined) record.legendImages = input.legendImages
      record.updatedAt = new Date().toISOString()
      updated = record
    })
    if (!updated) throw new Error(`Studio question card not found: ${input.cardID}`)
    return updated
  },

  async deleteQuestionCard(input: { userID: string; workroomID: string; cardID: string }) {
    let removed = false
    await StudioRepository.updateQuestionCards((state) => {
      state.items = state.items.filter((item) => {
        const keep = !(item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.cardID)
        if (!keep) removed = true
        return keep
      })
    })
    if (!removed) throw new Error(`Studio question card not found: ${input.cardID}`)
    await StudioRepository.updateAttempts((state) => {
      state.items = state.items.filter((item) => !(item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === input.cardID))
    })
    await StudioRepository.updateDiagnoses((state) => {
      state.items = state.items.filter((item) => !(item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === input.cardID))
    })
    await StudioRepository.updateWeaknesses((state) => {
      state.items = state.items.filter((item) => !(item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === input.cardID))
    })
    return { cardID: input.cardID, status: "deleted" }
  },

  async recognizeSelection(input: {
    userID: string
    workroomID: string
    sourceDocumentID: string
    studioDocumentID?: string | null
    title?: string | null
    regions: StudioSelectionRegion[]
    legends?: StudioLegendRegion[]
  }) {
    const workroom = await WorkroomService.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const sourceDocument = await DocumentsService.getByWorkroom({
      userID: input.userID,
      workroomID: input.workroomID,
      documentID: input.sourceDocumentID,
    })
    if (!sourceDocument) throw new Error(`Source document not found: ${input.sourceDocumentID}`)
    const studioDocument = await this.getOrCreateDocument({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
      sourceDocumentID: input.sourceDocumentID,
      title: input.title ?? sourceDocument.name,
    })
    const recognition = await StudioOcrService.recognizeSelection({
      document: sourceDocument,
      regions: input.regions,
      legends: input.legends ?? [],
    })
    const existingCards = await this.listQuestionCards({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: studioDocument.id,
    })
    const nextSequenceIndex = existingCards.length
    const now = new Date().toISOString()
    const record: StudioQuestionCardRecord = {
      id: createID("studio_question_card"),
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: studioDocument.id,
      sourceDocumentID: input.sourceDocumentID,
      sequenceIndex: nextSequenceIndex,
      page: input.regions[0]?.page ?? 1,
      text: recognition.text,
      originalText: recognition.text,
      answerContent: createTextMathDocument(""),
      answerText: "",
      canonicalAnswer: "",
      legendImages: recognition.legendImages,
      sourceSelection: { regions: input.regions, legends: input.legends ?? [] },
      answerEvidence: defaultAnswerEvidence(),
      learningSnapshot: defaultLearningSnapshot(),
      createdAt: now,
      updatedAt: now,
    }
    await StudioRepository.updateQuestionCards((state) => {
      state.items.push(record)
    })
    await WorkroomService.upsertArtifact({
      userID: input.userID,
      workroomID: input.workroomID,
      artifactType: "question_card",
      artifactRefID: record.id,
      documentID: input.sourceDocumentID,
      payloadJson: {
        studioDocumentID: studioDocument.id,
        sourceDocumentID: input.sourceDocumentID,
        sequenceIndex: record.sequenceIndex,
        page: record.page,
      },
    })
    return { studioDocument, questionCard: record }
  },

  async importFromLayout(input: {
    userID: string
    workroomID: string
    sourceDocumentID: string
    studioDocumentID?: string | null
    title?: string | null
    replaceExisting?: boolean
  }) {
    const workroom = await WorkroomService.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const sourceDocument = await DocumentsService.getByWorkroom({
      userID: input.userID,
      workroomID: input.workroomID,
      documentID: input.sourceDocumentID,
    })
    if (!sourceDocument) throw new Error(`Source document not found: ${input.sourceDocumentID}`)
    const studioDocument = await this.getOrCreateDocument({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
      sourceDocumentID: input.sourceDocumentID,
      title: input.title ?? sourceDocument.name,
    })
    const existingCards = await this.listQuestionCards({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: studioDocument.id,
    })
    if (existingCards.length > 0 && !input.replaceExisting) {
      return { studioDocument, questionCards: existingCards, importedCount: 0, reusedExisting: true }
    }
    const sourcePackage = await DocumentsService.readSourcePackage({
      userID: input.userID,
      workroomID: input.workroomID,
      documentID: input.sourceDocumentID,
    })
    const drafts = await importDocumentLayoutAsQuestionCards(sourceDocument)
    const now = new Date().toISOString()
    const records: StudioQuestionCardRecord[] = drafts.map((draft) => {
      const temp: StudioQuestionCardRecord = {
        id: createID("studio_question_card"),
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: studioDocument.id,
        sourceDocumentID: input.sourceDocumentID,
        sequenceIndex: draft.sequenceIndex,
        page: draft.page,
        text: draft.text,
        originalText: draft.originalText,
        answerContent: createTextMathDocument(""),
        answerText: "",
        canonicalAnswer: "",
        legendImages: draft.legendImages,
        sourceSelection: draft.sourceSelection,
        answerEvidence: defaultAnswerEvidence(),
        learningSnapshot: defaultLearningSnapshot(),
        createdAt: now,
        updatedAt: now,
      }
      const mapped = buildAnswerEvidence(temp, sourcePackage)
      temp.canonicalAnswer = mapped.canonicalAnswer
      temp.answerEvidence = mapped.evidence
      temp.answerContent = createTextMathDocument(mapped.canonicalAnswer)
      temp.answerText = mapped.canonicalAnswer
      return temp
    })
    await StudioRepository.updateQuestionCards((state) => {
      state.items = state.items.filter(
        (item) => !(item.userID === input.userID && item.workroomID === input.workroomID && item.studioDocumentID === studioDocument.id),
      )
      state.items.push(...records)
    })
    for (const record of records) {
      await WorkroomService.upsertArtifact({
        userID: input.userID,
        workroomID: input.workroomID,
        artifactType: "question_card",
        artifactRefID: record.id,
        documentID: input.sourceDocumentID,
        payloadJson: {
          studioDocumentID: studioDocument.id,
          sourceDocumentID: input.sourceDocumentID,
          sequenceIndex: record.sequenceIndex,
          page: record.page,
          importedFromLayout: true,
        },
      })
    }
    return { studioDocument, questionCards: records, importedCount: records.length, reusedExisting: false }
  },

  async submitAttempt(input: { userID: string; workroomID: string; cardID: string; answerText: string }) {
    const answerText = input.answerText.trim()
    if (!answerText) throw new Error("answerText is required")
    const cards = await StudioRepository.readQuestionCards()
    const card = cards.items.find((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.cardID)
    if (!card) throw new Error(`Studio question card not found: ${input.cardID}`)

    const attemptsState = await StudioRepository.readAttempts()
    const relatedAttempts = attemptsState.items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === card.id)
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    const attemptNo = relatedAttempts.length + 1
    const now = new Date().toISOString()
    const gradingMode = card.answerEvidence.status === "verified_unique" ? "reference_based" : "llm_freeform"
    let judgement: QuestionCardAttemptRecord["judgement"] = "uncertain"
    let predictedAnswer: string | null = null
    let scorePercent = 0
    let scoreNumerator = 0
    let scoreDenominator = 1
    let reasoning = ""
    if (gradingMode === "reference_based" && card.canonicalAnswer.trim()) {
      predictedAnswer = card.canonicalAnswer.trim()
      const same = predictedAnswer.replace(/\s+/g, "") === answerText.replace(/\s+/g, "")
      judgement = same ? "correct" : "incorrect"
      scorePercent = same ? 100 : 0
      scoreNumerator = same ? 1 : 0
      scoreDenominator = 1
      reasoning = `标准答案：${predictedAnswer}\n学生答案：${answerText}`
    }

    const attempt: QuestionCardAttemptRecord = {
      id: createID("question_card_attempt"),
      userID: input.userID,
      workroomID: input.workroomID,
      cardID: card.id,
      studioDocumentID: card.studioDocumentID,
      sequenceIndex: card.sequenceIndex,
      sourceDocumentID: card.sourceDocumentID ?? null,
      answerText,
      judgement,
      predictedAnswer,
      scoreNumerator,
      scoreDenominator,
      scorePercent,
      gradingMode,
      referenceEvidenceStatus: card.answerEvidence.status,
      reasoning,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    }

    await StudioRepository.updateAttempts((state) => {
      state.items.push(attempt)
    })

    const latestAttempts = (await StudioRepository.readAttempts()).items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === card.id)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .slice(0, 5)
    const existingWeaknesses = (await StudioRepository.readWeaknesses()).items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.cardID === card.id)
      .map((item) => ({
        weaknessKey: item.weaknessKey,
        label: item.label,
        status: item.status,
        severity: item.severity,
        count: item.count,
      }))

    let diagnosis: QuestionCardDiagnosisRecord | null = null
    try {
      const response = await QuestionLlmService.chatJson({
        userID: input.userID,
        capability: "question_grading",
        system: DIAGNOSIS_PROMPT,
        user: JSON.stringify(
          {
            question: card.text,
            answerEvidence: card.answerEvidence,
            canonicalAnswer: card.answerEvidence.status === "verified_unique" ? card.canonicalAnswer : null,
            currentAttempt: {
              answerText,
              gradingMode,
              judgement,
              predictedAnswer,
              scorePercent,
            },
            recentAttempts: latestAttempts.map((item) => ({
              submittedAt: item.submittedAt,
              answerText: item.answerText,
              judgement: item.judgement,
              scorePercent: item.scorePercent,
            })),
            existingWeaknesses,
          },
          null,
          2,
        ),
        temperature: 0.2,
        topP: 0.8,
        timeoutMs: 90_000,
        retries: 1,
      })
      const parsed = validateDiagnosisJson(response)
      diagnosis = {
        id: createID("question_card_diagnosis"),
        userID: input.userID,
        workroomID: input.workroomID,
        cardID: card.id,
        attemptID: attempt.id,
        rootCauseType: parsed.rootCauseType,
        conclusion: parsed.conclusion,
        evidenceSnippets: parsed.evidenceSnippets,
        confidence: parsed.confidence,
        improvementAdvice: parsed.improvementAdvice,
        weaknessItems: parsed.weaknessItems,
        modelOutputRawJson: JSON.stringify(response),
        createdAt: now,
        updatedAt: now,
      }
      await StudioRepository.updateDiagnoses((state) => {
        state.items.push(diagnosis!)
      })
    } catch (error) {
      await StudioRepository.updateAttempts((state) => {
        const target = state.items.find((item) => item.id === attempt.id)
        if (!target) return
        target.judgement = "diagnosis_failed"
        target.reasoning = error instanceof Error ? error.message : "diagnosis_failed"
        target.updatedAt = new Date().toISOString()
      })
    }

    if (diagnosis) {
      await StudioRepository.updateWeaknesses((state) => {
        for (const weakness of diagnosis!.weaknessItems) {
          const existing = state.items.find(
            (item) =>
              item.userID === input.userID &&
              item.workroomID === input.workroomID &&
              item.cardID === card.id &&
              item.weaknessKey === weakness.weaknessKey,
          )
          if (existing) {
            existing.label = weakness.label
            existing.severity = weakness.severity
            existing.status = weakness.statusSuggestion
            existing.count += 1
            existing.lastSeenAt = now
            existing.updatedAt = now
            if (weakness.statusSuggestion === "resolved") existing.resolvedAt = now
            existing.evidenceAttemptIDs = Array.from(new Set([...existing.evidenceAttemptIDs, attempt.id]))
            existing.evidenceDiagnosisIDs = Array.from(new Set([...existing.evidenceDiagnosisIDs, diagnosis!.id]))
            continue
          }
          state.items.push({
            id: createID("question_card_weakness"),
            userID: input.userID,
            workroomID: input.workroomID,
            cardID: card.id,
            weaknessKey: weakness.weaknessKey,
            label: weakness.label,
            category: diagnosis!.rootCauseType,
            status: weakness.statusSuggestion,
            severity: weakness.severity,
            count: 1,
            firstSeenAt: now,
            lastSeenAt: now,
            resolvedAt: weakness.statusSuggestion === "resolved" ? now : null,
            evidenceAttemptIDs: [attempt.id],
            evidenceDiagnosisIDs: [diagnosis!.id],
            createdAt: now,
            updatedAt: now,
          })
        }
      })
    }

    const attemptsAfter = (await StudioRepository.readAttempts()).items
    const weaknessesAfter = (await StudioRepository.readWeaknesses()).items
    const snapshot = await rebuildSnapshot({
      card,
      attempts: attemptsAfter,
      weaknesses: weaknessesAfter,
      latestDiagnosisSummary: diagnosis?.conclusion ?? null,
    })
    await StudioRepository.updateQuestionCards((state) => {
      const target = state.items.find((item) => item.id === card.id)
      if (!target) return
      target.learningSnapshot = snapshot
      target.updatedAt = new Date().toISOString()
    })

    return this.getQuestionCardDetail({
      userID: input.userID,
      workroomID: input.workroomID,
      cardID: card.id,
    })
  },
}
