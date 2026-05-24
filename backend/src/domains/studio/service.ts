import { createID } from "../../lib/ids"
import { createLogger } from "../../lib/logger"
import {
  createTextMathDocument,
  ensureMathContentDocument,
  mathContentToPromptText,
  type MathContentDocument,
} from "../../lib/math-content"
import { DocumentsService } from "../documents/service"
import { ProblemCardService } from "../problem-cards/service"
import { QuestionLlmService } from "../questions/llm-service"
import { WorkroomService } from "../workrooms/service"
import { StudioEvents } from "./events"
import { StudioRepository } from "./repository"
import { StudioOcrService } from "./ocr-service"
import { StudioQuestionsProjection } from "./questions-projection"
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

const logger = createLogger({ domain: "studio-service" })

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

function normalizeOptionalText(input?: string | null) {
  const normalized = input?.trim()
  return normalized ? normalized : null
}

function normalizeStringArray(values?: string[] | null) {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)))
}

type StudioQuestionCardDraft = {
  text: string
  page?: number | null
  originalText?: string | null
  questionType?: string | null
  difficulty?: string | null
  knowledgePoints?: string[]
  answerContent?: MathContentDocument
  answerText?: string | null
  canonicalAnswer?: string | null
  explanation?: string | null
  legendImages?: string[]
  derivedFromCardID?: string | null
  relationType?: StudioQuestionCardRecord["relationType"]
  originTask?: StudioQuestionCardRecord["originTask"]
}

function normalizeDraft(input: StudioQuestionCardDraft) {
  const text = normalizeText(input.text)
  if (!text) throw new Error("Question card text is required")
  const answerContent = ensureMathContentDocument(input.answerContent, input.answerText ?? input.canonicalAnswer ?? "")
  const answerText = mathContentToPromptText(answerContent)
  return {
    text,
    originalText: normalizeText(input.originalText) || text,
    page: input.page && input.page > 0 ? input.page : 1,
    questionType: normalizeOptionalText(input.questionType),
    difficulty: normalizeOptionalText(input.difficulty),
    knowledgePoints: normalizeStringArray(input.knowledgePoints),
    answerContent,
    answerText,
    canonicalAnswer: normalizeOptionalText(input.canonicalAnswer) ?? normalizeOptionalText(answerText) ?? "",
    explanation: normalizeOptionalText(input.explanation),
    legendImages: Array.from(new Set((input.legendImages ?? []).map((item) => item.trim()).filter(Boolean))),
    derivedFromCardID: normalizeOptionalText(input.derivedFromCardID),
    relationType: input.relationType ?? "primary",
    originTask: input.originTask ?? null,
  }
}

function compactTextPreview(text: string, max = 80) {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

function normalizeWeaknessText(value: string) {
  return value
    .toLowerCase()
    .replace(/[，。、“”"'‘’（）()【】\[\]\s\-_,.:：;；!?！？]/g, "")
    .trim()
}

function severityRank(value: string) {
  if (value === "high") return 3
  if (value === "medium") return 2
  if (value === "low") return 1
  return 0
}

function dedupeWeaknessRecords(
  list: Array<{
    id: string
    weakness_key: string
    label: string
    category: string
    status: string
    severity: string
    count: number
    first_seen_at: string
    last_seen_at: string
    resolved_at: string | null
    note?: string | null
  }>,
) {
  const map = new Map<string, (typeof list)[number]>()
  for (const item of list) {
    const key = normalizeWeaknessText(item.weakness_key || item.label || "")
    if (!key) continue
    const existing = map.get(key)
    if (!existing) {
      map.set(key, { ...item })
      continue
    }
    existing.count += Number(item.count ?? 0)
    if (severityRank(item.severity) > severityRank(existing.severity)) {
      existing.severity = item.severity
    }
    if (String(item.last_seen_at) > String(existing.last_seen_at)) {
      existing.last_seen_at = item.last_seen_at
    }
    if (String(item.first_seen_at) < String(existing.first_seen_at)) {
      existing.first_seen_at = item.first_seen_at
    }
    if (!existing.resolved_at && item.resolved_at) {
      existing.resolved_at = item.resolved_at
    }
    if (!existing.note && item.note) {
      existing.note = item.note
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count || b.last_seen_at.localeCompare(a.last_seen_at))
}

function dedupeStringList(values: unknown) {
  if (!Array.isArray(values)) return []
  const map = new Map<string, string>()
  for (const raw of values) {
    const text = String(raw ?? "").trim()
    if (!text) continue
    const key = normalizeWeaknessText(text)
    if (!key) continue
    if (!map.has(key)) map.set(key, text)
  }
  return Array.from(map.values())
}

function buildSlimLearningProfile(raw: any, full: boolean) {
  const profile = raw && typeof raw === "object" ? raw : {}
  const currentState = (profile.currentState ?? profile.learningState ?? null) as Record<string, unknown> | null
  const latestGradingRecord = (profile.latestGradingRecord ?? null) as Record<string, unknown> | null
  const attemptsSource = Array.isArray(profile.raw_recent_attempts)
    ? profile.raw_recent_attempts
    : Array.isArray(profile.attempts)
      ? profile.attempts
      : []
  const weaknessesSource = Array.isArray(profile.weaknesses) ? profile.weaknesses : []
  const summaries = (profile.summaries ?? {}) as Record<string, unknown>

  const learning = {
    problemCard: profile.problemCard ?? null,
    knowledgeProfile: profile.knowledgeProfile ?? null,
    currentState: currentState
      ? {
          ...currentState,
          unresolved_weaknesses: dedupeStringList(currentState.unresolved_weaknesses),
          repeated_mistakes: dedupeStringList(currentState.repeated_mistakes),
        }
      : null,
    learningState: currentState
      ? {
          ...currentState,
          unresolved_weaknesses: dedupeStringList(currentState.unresolved_weaknesses),
          repeated_mistakes: dedupeStringList(currentState.repeated_mistakes),
        }
      : null,
    latestGradingRecord: latestGradingRecord
      ? {
          id: latestGradingRecord.id ?? null,
          attempt_index: latestGradingRecord.attempt_index ?? null,
          is_correct: latestGradingRecord.is_correct ?? null,
          score: latestGradingRecord.score ?? null,
          diagnosis: latestGradingRecord.diagnosis ?? null,
          mistake_type: latestGradingRecord.mistake_type ?? null,
          next_action_suggestion: latestGradingRecord.next_action_suggestion ?? null,
          created_at: latestGradingRecord.created_at ?? null,
        }
      : null,
    recentAttempts: attemptsSource.slice(0, 5).map((item: any) => ({
      id: item.id ?? null,
      attempt_index: item.attempt_index ?? null,
      user_answer: item.user_answer ?? null,
      judgement: item.judgement ?? null,
      score_percent: item.score_percent ?? null,
      submitted_at: item.submitted_at ?? null,
    })),
    weaknesses: dedupeWeaknessRecords(
      weaknessesSource.map((item: any) => ({
        id: String(item.id ?? ""),
        weakness_key: String(item.weakness_key ?? item.label ?? ""),
        label: String(item.label ?? item.weakness_key ?? ""),
        category: String(item.category ?? "unknown"),
        status: String(item.status ?? "open"),
        severity: String(item.severity ?? "medium"),
        count: Number(item.count ?? 0),
        first_seen_at: String(item.first_seen_at ?? ""),
        last_seen_at: String(item.last_seen_at ?? ""),
        resolved_at: item.resolved_at == null ? null : String(item.resolved_at),
        note: item.note == null ? null : String(item.note),
      })),
    ),
    gradingRecords: Array.isArray(profile.gradingRecords) ? profile.gradingRecords : [],
    attempts: Array.isArray(profile.attempts) ? profile.attempts : attemptsSource,
    raw_recent_attempts: attemptsSource.slice(0, 5),
    reviewHeatmap180d: Array.isArray(profile.reviewHeatmap180d) ? profile.reviewHeatmap180d : [],
    attemptStats: profile.attemptStats ?? null,
    reviewStats: profile.reviewStats ?? null,
    timelineEvents: Array.isArray(profile.timelineEvents) ? profile.timelineEvents : [],
    summaries: {
      monthly_summaries: Array.isArray(summaries.monthly_summaries) ? summaries.monthly_summaries : [],
      yearly_summaries: Array.isArray(summaries.yearly_summaries) ? summaries.yearly_summaries : [],
    },
    stats: {
      attemptStats: profile.attemptStats ?? null,
      reviewStats: profile.reviewStats ?? null,
    },
  } as Record<string, unknown>

  if (full) {
    learning.debug = {
      timelineEvents: Array.isArray(profile.timelineEvents) ? profile.timelineEvents : [],
      gradingRecords: Array.isArray(profile.gradingRecords)
        ? profile.gradingRecords
            .filter((item: any) => String(item?.id ?? "") !== String(latestGradingRecord?.id ?? ""))
            .map((item: any) => ({
              id: item.id ?? null,
              attempt_index: item.attempt_index ?? null,
              is_correct: item.is_correct ?? null,
              score: item.score ?? null,
              diagnosis: item.diagnosis ?? null,
              mistake_type: item.mistake_type ?? null,
              created_at: item.created_at ?? null,
            }))
        : [],
    }
  }

  return learning
}

function buildQuestionCardContent(card: StudioQuestionCardRecord, fallback?: { difficulty?: string | null; knowledgePoints?: string[] | null }) {
  return {
    cardID: card.id,
    studioDocumentID: card.studioDocumentID,
    sourceDocumentID: card.sourceDocumentID ?? null,
    sequenceIndex: card.sequenceIndex,
    cardGroupID: card.cardGroupID,
    stem: card.text,
    answer: card.answerText?.trim() || card.canonicalAnswer?.trim() || "",
    explanation: card.explanation ?? null,
    questionType: card.questionType ?? null,
    difficulty: card.difficulty ?? fallback?.difficulty ?? null,
    knowledgePoints: card.knowledgePoints.length > 0 ? card.knowledgePoints : normalizeStringArray(fallback?.knowledgePoints),
    legendImages: card.legendImages ?? [],
    derivedFromCardID: card.derivedFromCardID ?? null,
    relationType: card.relationType ?? null,
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
      note: w.note ?? null,
    })),
    reviewHeatmap180d: buildHeatmap180d(relatedAttempts),
  }
  return snapshot
}

async function upsertQuestionCardArtifacts(input: {
  userID: string
  workroomID: string
  studioDocumentID: string
  sourceDocumentID?: string | null
  cards: StudioQuestionCardRecord[]
}) {
  for (const card of input.cards) {
    await WorkroomService.upsertArtifact({
      userID: input.userID,
      workroomID: input.workroomID,
      artifactType: "question_card",
      artifactRefID: card.id,
      documentID: input.sourceDocumentID ?? card.sourceDocumentID ?? null,
      payloadJson: {
        studioDocumentID: input.studioDocumentID,
        sourceDocumentID: input.sourceDocumentID ?? card.sourceDocumentID ?? null,
        sequenceIndex: card.sequenceIndex,
        cardGroupID: card.cardGroupID,
        page: card.page,
        relationType: card.relationType ?? "primary",
        derivedFromCardID: card.derivedFromCardID ?? null,
      },
    })
  }
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

  async searchQuestionCards(input: { userID: string; workroomID: string; studioDocumentID: string; query: string; limit?: number }) {
    const query = input.query.trim()
    if (!query) throw new Error("INVALID_ARGUMENT: missing query")
    const cards = await this.listQuestionCards(input)
    const normalizedQuery = query.replace(/\s+/g, " ").trim().toLowerCase()
    const numberMatches = Array.from(query.matchAll(/\d+/g))
      .map((match) => Number.parseInt(match[0], 10))
      .filter((value) => Number.isInteger(value) && value > 0)
    const results = cards
      .map((card) => {
        const normalizedText = card.text.replace(/\s+/g, " ").trim().toLowerCase()
        const textMatched = normalizedText.includes(normalizedQuery)
        const numberMatched = numberMatches.some((value) => card.sequenceIndex + 1 === value)
        if (!textMatched && !numberMatched) return null
        return {
          cardID: card.id,
          sequenceIndex: card.sequenceIndex,
          stemPreview: compactTextPreview(card.text),
          questionType: card.questionType ?? null,
          difficulty: card.difficulty ?? null,
          masteryLevel: card.learningSnapshot.masteryLevel,
          updatedAt: card.updatedAt,
          _rank: numberMatched ? 0 : 1,
        }
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => left._rank - right._rank || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(input.limit ?? 5, 10)))

    return results.map(({ _rank, ...item }) => item)
  },

  async getQuestionCardDetail(input: { userID: string; workroomID: string; cardID: string; full?: boolean }) {
    const cards = await StudioRepository.readQuestionCards()
    const card = cards.items.find((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.cardID)
    if (!card) throw new Error(`Studio question card not found: ${input.cardID}`)
    const learningProfile = await ProblemCardService.getLearningDetail({
      userID: input.userID,
      workroomID: input.workroomID,
      problemCardID: input.cardID,
      full: input.full === true,
    })
    const profileKnowledge = (learningProfile as { knowledgeProfile?: Record<string, unknown> | null }).knowledgeProfile
    const content = buildQuestionCardContent(card, {
      difficulty:
        profileKnowledge && typeof profileKnowledge.difficulty_estimate === "string"
          ? profileKnowledge.difficulty_estimate
          : null,
      knowledgePoints:
        profileKnowledge && Array.isArray(profileKnowledge.knowledge_points)
          ? profileKnowledge.knowledge_points.map((item) => String(item))
          : [],
    })
    const anchor = {
      cardID: card.id,
      questionNumber: card.sequenceIndex + 1,
      studioDocumentID: card.studioDocumentID,
      sourceDocumentID: card.sourceDocumentID ?? null,
      cardGroupID: card.cardGroupID,
      sequenceIndex: card.sequenceIndex,
      page: card.page,
      relationType: card.relationType ?? null,
      derivedFromCardID: card.derivedFromCardID ?? null,
      sourceSelection: card.sourceSelection,
      answerEvidence: card.answerEvidence,
      timestamps: {
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      },
    }
    const learning = buildSlimLearningProfile(learningProfile, input.full === true)
    return {
      anchor,
      content,
      card: content,
      learningProfile: learning,
    }
  },

  async appendQuestionCards(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    drafts: StudioQuestionCardDraft[]
  }) {
    logger.info("append question cards start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID,
      drafts_count: input.drafts.length,
    })
    if (input.drafts.length === 0) return []
    const studioDocument = await this.getDocument({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
    })
    if (!studioDocument) throw new Error(`Studio document not found: ${input.studioDocumentID}`)

    const existing = await this.listQuestionCards({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
    })
    const now = new Date().toISOString()
    const created = input.drafts.map((draft, index) => {
      const normalized = normalizeDraft(draft)
      const cardID = createID("studio_question_card")
      return {
        id: cardID,
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: input.studioDocumentID,
        sourceDocumentID: studioDocument.sourceDocumentID ?? null,
        cardGroupID: cardID,
        sequenceIndex: existing.length + index,
        page: normalized.page,
        text: normalized.text,
        originalText: normalized.originalText,
        questionType: normalized.questionType,
        difficulty: normalized.difficulty,
        knowledgePoints: normalized.knowledgePoints,
        answerContent: normalized.answerContent,
        answerText: normalized.answerText,
        canonicalAnswer: normalized.canonicalAnswer,
        explanation: normalized.explanation,
        legendImages: normalized.legendImages,
        derivedFromCardID: normalized.derivedFromCardID,
        relationType: normalized.relationType,
        originTask: normalized.originTask,
        sourceSelection: { regions: [], legends: [] },
        answerEvidence: defaultAnswerEvidence(),
        learningSnapshot: defaultLearningSnapshot(),
        createdAt: now,
        updatedAt: now,
      } satisfies StudioQuestionCardRecord
    })

    await StudioRepository.updateQuestionCards((state) => {
      state.items.push(...created)
    })
    await StudioQuestionsProjection.syncCards(created)
    await upsertQuestionCardArtifacts({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
      sourceDocumentID: studioDocument.sourceDocumentID ?? null,
      cards: created,
    })
    await StudioEvents.publishChanged({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
      reason: "create",
      cardIDs: created.map((item) => item.id),
      anchorCardID: null,
      position: null,
    })
    logger.info("append question cards completed", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID,
      created_card_ids: created.map((item) => item.id),
      created_sequence_indexes: created.map((item) => item.sequenceIndex),
    })
    return created
  },

  async insertQuestionCards(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    anchorCardID: string
    position: "before" | "after"
    drafts: StudioQuestionCardDraft[]
  }) {
    logger.info("insert question cards start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID,
      anchor_card_id: input.anchorCardID,
      position: input.position,
      drafts_count: input.drafts.length,
    })
    if (input.drafts.length === 0) return []
    const studioDocument = await this.getDocument({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
    })
    if (!studioDocument) throw new Error(`Studio document not found: ${input.studioDocumentID}`)

    let created: StudioQuestionCardRecord[] = []
    let affected: StudioQuestionCardRecord[] = []
    await StudioRepository.updateQuestionCards((state) => {
      const scoped = state.items
        .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.studioDocumentID === input.studioDocumentID)
        .sort((left, right) => left.sequenceIndex - right.sequenceIndex || left.createdAt.localeCompare(right.createdAt))
      const anchorIndex = scoped.findIndex((item) => item.id === input.anchorCardID)
      if (anchorIndex === -1) throw new Error(`Anchor card not found: ${input.anchorCardID}`)
      const insertIndex = input.position === "before" ? anchorIndex : anchorIndex + 1
      const anchorCard = scoped[anchorIndex]
      const anchorGroupID = anchorCard.cardGroupID || anchorCard.id
      const now = new Date().toISOString()
      created = input.drafts.map((draft) => {
        const normalized = normalizeDraft(draft)
        return {
          id: createID("studio_question_card"),
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: input.studioDocumentID,
          sourceDocumentID: studioDocument.sourceDocumentID ?? null,
          cardGroupID: anchorGroupID,
          sequenceIndex: -1,
          page: normalized.page,
          text: normalized.text,
          originalText: normalized.originalText,
          questionType: normalized.questionType,
          difficulty: normalized.difficulty,
          knowledgePoints: normalized.knowledgePoints,
          answerContent: normalized.answerContent,
          answerText: normalized.answerText,
          canonicalAnswer: normalized.canonicalAnswer,
          explanation: normalized.explanation,
          legendImages: normalized.legendImages,
          derivedFromCardID: normalized.derivedFromCardID,
          relationType: normalized.relationType,
          originTask: normalized.originTask,
          sourceSelection: { regions: [], legends: [] },
          answerEvidence: defaultAnswerEvidence(),
          learningSnapshot: defaultLearningSnapshot(),
          createdAt: now,
          updatedAt: now,
        } satisfies StudioQuestionCardRecord
      })
      const merged = [...scoped.slice(0, insertIndex), ...created, ...scoped.slice(insertIndex)]
      merged.forEach((item, index) => {
        item.sequenceIndex = index
        item.updatedAt = now
      })
      affected = merged
      state.items = state.items
        .filter((item) => !(item.userID === input.userID && item.workroomID === input.workroomID && item.studioDocumentID === input.studioDocumentID))
        .concat(merged)
    })
    await StudioQuestionsProjection.syncCards(affected)
    await upsertQuestionCardArtifacts({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
      sourceDocumentID: studioDocument.sourceDocumentID ?? null,
      cards: created,
    })
    await StudioEvents.publishChanged({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
      reason: "insert",
      cardIDs: created.map((item) => item.id),
      anchorCardID: input.anchorCardID,
      position: input.position,
    })
    logger.info("insert question cards completed", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID,
      anchor_card_id: input.anchorCardID,
      position: input.position,
      created_card_ids: created.map((item) => item.id),
      created_sequence_indexes: created.map((item) => item.sequenceIndex),
    })
    return created
  },

  async updateQuestionCard(input: {
    userID: string
    workroomID: string
    cardID: string
    text?: string
    answerContent?: MathContentDocument
    answerText?: string
    legendImages?: string[]
    canonicalAnswer?: string | null
    explanation?: string | null
    derivedFromCardID?: string | null
    relationType?: StudioQuestionCardRecord["relationType"]
    originTask?: StudioQuestionCardRecord["originTask"]
  }) {
    logger.info("update question card start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.cardID,
      has_text: input.text !== undefined,
      has_answer_text: input.answerText !== undefined,
      has_explanation: input.explanation !== undefined,
    })
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
      if (input.canonicalAnswer !== undefined) record.canonicalAnswer = normalizeOptionalText(input.canonicalAnswer) ?? ""
      if (input.explanation !== undefined) record.explanation = normalizeOptionalText(input.explanation)
      if (input.derivedFromCardID !== undefined) record.derivedFromCardID = normalizeOptionalText(input.derivedFromCardID)
      if (input.relationType !== undefined) record.relationType = input.relationType ?? null
      if (input.originTask !== undefined) record.originTask = input.originTask ?? null
      record.updatedAt = new Date().toISOString()
      updated = record
    })
    if (!updated) throw new Error(`Studio question card not found: ${input.cardID}`)
    await StudioQuestionsProjection.syncCard(updated)
    await StudioEvents.publishChanged({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: updated.studioDocumentID,
      reason: "update",
      cardIDs: [updated.id],
      anchorCardID: null,
      position: null,
    })
    logger.info("update question card completed", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: updated.id,
      studio_document_id: updated.studioDocumentID,
    })
    return updated
  },

  async writeQuestionExplanation(input: {
    userID: string
    workroomID: string
    cardID: string
    explanation: string
  }) {
    logger.info("write question explanation start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.cardID,
    })
    return this.updateQuestionCard({
      userID: input.userID,
      workroomID: input.workroomID,
      cardID: input.cardID,
      explanation: input.explanation,
    })
  },

  async attachDerivedPracticeCards(input: {
    userID: string
    workroomID: string
    sourceCardID: string
    createdCardIDs: string[]
  }) {
    logger.info("attach derived practice cards start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      source_card_id: input.sourceCardID,
      created_card_ids: input.createdCardIDs,
    })
    const targetIDs = new Set(input.createdCardIDs)
    const updated: StudioQuestionCardRecord[] = []
    await StudioRepository.updateQuestionCards((state) => {
      const source = state.items.find((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.sourceCardID)
      if (!source) throw new Error(`Studio question card not found: ${input.sourceCardID}`)
      const now = new Date().toISOString()
      for (const card of state.items) {
        if (!(card.userID === input.userID && card.workroomID === input.workroomID && targetIDs.has(card.id))) continue
        card.derivedFromCardID = source.id
        card.relationType = "practice_generated"
        card.updatedAt = now
        updated.push(card)
      }
      if (updated.length !== targetIDs.size) {
        throw new Error("Some derived practice cards were not found")
      }
    })
    await StudioQuestionsProjection.syncCards(updated)
    if (updated.length > 0) {
      await StudioEvents.publishChanged({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: updated[0]!.studioDocumentID,
        reason: "attach",
        cardIDs: updated.map((item) => item.id),
        anchorCardID: input.sourceCardID,
        position: null,
      })
    }
    logger.info("attach derived practice cards completed", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      source_card_id: input.sourceCardID,
      updated_card_ids: updated.map((item) => item.id),
      studio_document_id: updated[0]?.studioDocumentID ?? null,
    })
    return updated
  },

  async deleteQuestionCard(input: { userID: string; workroomID: string; cardID: string }) {
    logger.info("delete question card start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.cardID,
    })
    let removed = false
    let removedStudioDocumentID: string | null = null
    await StudioRepository.updateQuestionCards((state) => {
      state.items = state.items.filter((item) => {
        const keep = !(item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.cardID)
        if (!keep) {
          removed = true
          removedStudioDocumentID = item.studioDocumentID
        }
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
    await StudioQuestionsProjection.removeCard({
      userID: input.userID,
      studioCardID: input.cardID,
    })
    if (removedStudioDocumentID) {
      await StudioEvents.publishChanged({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: removedStudioDocumentID,
        reason: "delete",
        cardIDs: [input.cardID],
        anchorCardID: null,
        position: null,
      })
    }
    logger.info("delete question card completed", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.cardID,
      studio_document_id: removedStudioDocumentID,
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
      cardGroupID: "",
      sequenceIndex: nextSequenceIndex,
      page: input.regions[0]?.page ?? 1,
      text: recognition.text,
      originalText: recognition.text,
      questionType: null,
      difficulty: null,
      knowledgePoints: [],
      answerContent: createTextMathDocument(""),
      answerText: "",
      canonicalAnswer: "",
      explanation: null,
      legendImages: recognition.legendImages,
      derivedFromCardID: null,
      relationType: "primary",
      originTask: null,
      sourceSelection: { regions: input.regions, legends: input.legends ?? [] },
      answerEvidence: defaultAnswerEvidence(),
      learningSnapshot: defaultLearningSnapshot(),
      createdAt: now,
      updatedAt: now,
    }
    record.cardGroupID = record.id
    await StudioRepository.updateQuestionCards((state) => {
      state.items.push(record)
    })
    await StudioQuestionsProjection.syncCard(record)
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
    await StudioEvents.publishChanged({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: studioDocument.id,
      reason: "recognize",
      cardIDs: [record.id],
      anchorCardID: null,
      position: null,
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
        cardGroupID: "",
        sequenceIndex: draft.sequenceIndex,
        page: draft.page,
        text: draft.text,
        originalText: draft.originalText,
        questionType: null,
        difficulty: null,
        knowledgePoints: [],
        answerContent: createTextMathDocument(""),
        answerText: "",
        canonicalAnswer: "",
        explanation: null,
        legendImages: draft.legendImages,
        derivedFromCardID: null,
        relationType: "primary",
        originTask: null,
        sourceSelection: draft.sourceSelection,
        answerEvidence: defaultAnswerEvidence(),
        learningSnapshot: defaultLearningSnapshot(),
        createdAt: now,
        updatedAt: now,
      }
      temp.cardGroupID = temp.id
      const mapped = buildAnswerEvidence(temp, sourcePackage)
      temp.canonicalAnswer = mapped.canonicalAnswer
      temp.answerEvidence = mapped.evidence
      temp.answerContent = createTextMathDocument(mapped.canonicalAnswer)
      temp.answerText = mapped.canonicalAnswer
      return temp
    })
    const removedCards = existingCards.filter((item) => input.replaceExisting)
    await StudioRepository.updateQuestionCards((state) => {
      state.items = state.items.filter(
        (item) => !(item.userID === input.userID && item.workroomID === input.workroomID && item.studioDocumentID === studioDocument.id),
      )
      state.items.push(...records)
    })
    for (const removed of removedCards) {
      await StudioQuestionsProjection.removeCard({
        userID: input.userID,
        studioCardID: removed.id,
      })
    }
    await StudioQuestionsProjection.syncCards(records)
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
    await StudioEvents.publishChanged({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: studioDocument.id,
      reason: "import",
      cardIDs: records.map((item) => item.id),
      anchorCardID: null,
      position: null,
    })
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
