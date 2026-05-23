import { WorkroomService } from "../workrooms/service"
import { StudioService } from "./service"
import { ProblemCardService } from "../problem-cards/service"
import { createLogger } from "../../lib/logger"

type Placement = "before" | "after"

type QuestionIntentScope = {
  userID: string
  workroomID: string
}

type QuestionIntentInput = QuestionIntentScope & {
  text?: string | null
  stem?: string | null
  answer?: string | null
  explanation?: string | null
  questionType?: string | null
  difficulty?: string | null
  knowledgePoints?: string[]
  options?: string[]
  page?: number
}

type ResolveBusinessTargetResult = {
  studioDocumentID: string
  sourceDocumentID: string | null
  title: string
  resolvedBy: "runtime_active" | "single_document"
}

type GenerationRecommendation = {
  recommended_difficulty?: string
  recommended_question_types?: string[]
  recommended_knowledge_points?: string[]
}

const logger = createLogger({ domain: "studio-question-command" })

function normalizeRequiredText(value: string | undefined, field: string) {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`INVALID_ARGUMENT: missing ${field}`)
  return normalized
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function normalizeOptions(options?: string[]) {
  if (!Array.isArray(options) || options.length === 0) return []
  return options.map((item) => item.trim()).filter(Boolean)
}

function resolveQuestionText(input: QuestionIntentInput) {
  const directText = normalizeOptionalText(input.text)
  if (directText) return directText
  const stem = normalizeOptionalText(input.stem)
  if (!stem) throw new Error("INVALID_ARGUMENT: missing text")
  const options = normalizeOptions(input.options)
  if (options.length === 0) return stem
  const labeled = options.map((item, index) => `${String.fromCharCode(65 + index)}. ${item}`)
  return [stem, ...labeled].join("\n")
}

function buildDraft(input: QuestionIntentInput) {
  const text = resolveQuestionText(input)
  return {
    text,
    originalText: text,
    page: input.page,
    questionType: normalizeOptionalText(input.questionType) ?? undefined,
    difficulty: normalizeOptionalText(input.difficulty) ?? undefined,
    knowledgePoints: Array.from(new Set((input.knowledgePoints ?? []).map((item) => item.trim()).filter(Boolean))),
    answerText: normalizeOptionalText(input.answer) ?? undefined,
    canonicalAnswer: normalizeOptionalText(input.answer) ?? undefined,
    explanation: normalizeOptionalText(input.explanation) ?? undefined,
  }
}

function applyRecommendationToInput(input: QuestionIntentInput, recommendation: GenerationRecommendation | null): QuestionIntentInput {
  if (!recommendation) return input
  const recommendedQuestionType = Array.isArray(recommendation.recommended_question_types)
    ? recommendation.recommended_question_types.map((item) => String(item).trim()).find(Boolean) ?? null
    : null
  const recommendedKnowledgePoints = Array.isArray(recommendation.recommended_knowledge_points)
    ? recommendation.recommended_knowledge_points.map((item) => String(item).trim()).filter(Boolean)
    : []
  return {
    ...input,
    questionType: input.questionType?.trim() ? input.questionType : recommendedQuestionType,
    difficulty: input.difficulty?.trim() ? input.difficulty : (recommendation.recommended_difficulty?.trim() ?? null),
    knowledgePoints: Array.isArray(input.knowledgePoints) && input.knowledgePoints.length > 0 ? input.knowledgePoints : recommendedKnowledgePoints,
  }
}

function compactTextPreview(text: string, max = 80) {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

function toQuestionCardResult(card: {
  id: string
  sequenceIndex: number
  text: string
  page?: number | null
  answerText?: string | null
  canonicalAnswer?: string | null
  explanation?: string | null
}) {
  return {
    id: card.id,
    questionNumber: card.sequenceIndex + 1,
    sequenceIndex: card.sequenceIndex,
    page: card.page ?? null,
    text: card.text,
    preview: compactTextPreview(card.text),
    questionType: (card as any).questionType ?? null,
    difficulty: (card as any).difficulty ?? null,
    knowledgePoints: (card as any).knowledgePoints ?? [],
    answerText: card.answerText ?? card.canonicalAnswer ?? null,
    explanation: card.explanation ?? null,
  }
}

async function resolveBusinessTarget(input: QuestionIntentScope): Promise<ResolveBusinessTargetResult> {
  const runtimeState = await WorkroomService.getRuntimeState(input).catch(() => null)
  const activeStudioDocumentID = runtimeState?.active_studio_document_id ?? null
  if (activeStudioDocumentID) {
    const active = await StudioService.getDocument({
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: String(activeStudioDocumentID),
    })
    if (active) {
      return {
        studioDocumentID: active.id,
        sourceDocumentID: active.sourceDocumentID ?? null,
        title: active.title,
        resolvedBy: "runtime_active",
      }
    }
  }

  const documents = await StudioService.listDocuments(input)
  if (documents.length === 1) {
    return {
      studioDocumentID: documents[0]!.id,
      sourceDocumentID: documents[0]!.sourceDocumentID ?? null,
      title: documents[0]!.title,
      resolvedBy: "single_document",
    }
  }
  if (documents.length === 0) {
    throw new Error("TARGET_STUDIO_DOCUMENT_UNRESOLVED: no existing studio document in this workroom")
  }

  const error = new Error("TARGET_STUDIO_DOCUMENT_AMBIGUOUS: multiple studio documents available")
  ;(error as Error & { detail?: unknown }).detail = {
    totalDocuments: documents.length,
    documentIDs: documents.map((item) => item.id),
  }
  throw error
}

async function resolveAnchorByQuestionNumber(input: QuestionIntentScope & { studioDocumentID: string; questionNumber: number }) {
  const cards = await StudioService.listQuestionCards({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: input.studioDocumentID,
  })
  const anchor = cards[input.questionNumber - 1]
  if (!anchor) {
    const error = new Error(`QUESTION_NUMBER_OUT_OF_RANGE: ${input.questionNumber}`)
    ;(error as Error & { detail?: unknown }).detail = {
      requested: input.questionNumber,
      totalAvailable: cards.length,
    }
    throw error
  }
  return anchor
}

export async function getQuestionCardDetailByNumber(
  input: QuestionIntentScope & {
    questionNumber: number
    full?: boolean
  },
) {
  if (!Number.isInteger(input.questionNumber) || input.questionNumber < 1) {
    throw new Error("INVALID_ARGUMENT: question-number must be a positive integer")
  }
  const target = await resolveBusinessTarget({ userID: input.userID, workroomID: input.workroomID })
  const anchor = await resolveAnchorByQuestionNumber({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
    questionNumber: input.questionNumber,
  })
  return StudioService.getQuestionCardDetail({
    userID: input.userID,
    workroomID: input.workroomID,
    cardID: anchor.id,
    full: input.full === true,
  })
}

async function resolveCardRecommendation(input: QuestionIntentScope & { cardID: string }) {
  const detail = await ProblemCardService.getLearningDetail({
    userID: input.userID,
    workroomID: input.workroomID,
    problemCardID: input.cardID,
  }).catch(() => null)
  const state =
    detail && typeof detail === "object"
      ? "currentState" in detail
        ? (detail as { currentState: unknown }).currentState
        : "learningState" in detail
          ? (detail as { learningState: unknown }).learningState
          : null
      : null
  if (!state || typeof state !== "object") return null
  const recommendation = (state as Record<string, unknown>).generation_recommendation
  if (!recommendation || typeof recommendation !== "object") return null
  return recommendation as GenerationRecommendation
}

async function resolveLatestCardRecommendation(input: QuestionIntentScope & { studioDocumentID: string }) {
  const cards = await StudioService.listQuestionCards({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: input.studioDocumentID,
  })
  const latest = [...cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (!latest) return null
  return resolveCardRecommendation({ ...input, cardID: latest.id })
}

export async function createQuestionByIntent(input: QuestionIntentInput) {
  logger.info("create question by intent start", {
    user_id: input.userID,
    workroom_id: input.workroomID,
  })
  const target = await resolveBusinessTarget({ userID: input.userID, workroomID: input.workroomID })
  const recommendation = await resolveLatestCardRecommendation({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
  })
  const effectiveInput = applyRecommendationToInput(input, recommendation)
  const created = await StudioService.appendQuestionCards({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
    drafts: [buildDraft(effectiveInput)],
  })
  const card = created[0]
  if (!card) throw new Error("COMMAND_EXECUTION_FAILED: create returned no card")
  return {
    mode: "create" as const,
    resolvedBy: target.resolvedBy,
    document: {
      id: target.studioDocumentID,
      title: target.title,
      sourceDocumentID: target.sourceDocumentID,
    },
    card: toQuestionCardResult(card),
  }
}

export async function insertQuestionByIntent(
  input: QuestionIntentInput & {
    questionNumber: number
    placement: Placement
  },
) {
  if (!Number.isInteger(input.questionNumber) || input.questionNumber < 1) {
    throw new Error("INVALID_ARGUMENT: question-number must be a positive integer")
  }
  logger.info("insert question by intent start", {
    user_id: input.userID,
    workroom_id: input.workroomID,
    question_number: input.questionNumber,
    placement: input.placement,
  })
  const target = await resolveBusinessTarget({ userID: input.userID, workroomID: input.workroomID })
  const anchor = await resolveAnchorByQuestionNumber({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
    questionNumber: input.questionNumber,
  })
  const recommendation = await resolveCardRecommendation({
    userID: input.userID,
    workroomID: input.workroomID,
    cardID: anchor.id,
  })
  const effectiveInput = applyRecommendationToInput(input, recommendation)
  const created = await StudioService.insertQuestionCards({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
    anchorCardID: anchor.id,
    position: input.placement,
    drafts: [buildDraft(effectiveInput)],
  })
  const card = created[0]
  if (!card) throw new Error("COMMAND_EXECUTION_FAILED: insert returned no card")
  return {
    mode: "insert" as const,
    resolvedBy: target.resolvedBy,
    document: {
      id: target.studioDocumentID,
      title: target.title,
      sourceDocumentID: target.sourceDocumentID,
    },
    anchor: {
      id: anchor.id,
      questionNumber: anchor.sequenceIndex + 1,
    },
    placement: input.placement,
    card: toQuestionCardResult(card),
  }
}

export async function similarQuestionByIntent(
  input: QuestionIntentInput & {
    questionNumber: number
    placement: Placement
  },
) {
  if (!Number.isInteger(input.questionNumber) || input.questionNumber < 1) {
    throw new Error("INVALID_ARGUMENT: question-number must be a positive integer")
  }
  logger.info("similar question by intent start", {
    user_id: input.userID,
    workroom_id: input.workroomID,
    question_number: input.questionNumber,
    placement: input.placement,
  })
  const target = await resolveBusinessTarget({ userID: input.userID, workroomID: input.workroomID })
  const anchor = await resolveAnchorByQuestionNumber({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
    questionNumber: input.questionNumber,
  })
  const recommendation = await resolveCardRecommendation({
    userID: input.userID,
    workroomID: input.workroomID,
    cardID: anchor.id,
  })
  const effectiveInput = applyRecommendationToInput(input, recommendation)
  const created = await StudioService.insertQuestionCards({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
    anchorCardID: anchor.id,
    position: input.placement,
    drafts: [buildDraft(effectiveInput)],
  })
  const card = created[0]
  if (!card) throw new Error("COMMAND_EXECUTION_FAILED: similar returned no card")
  return {
    mode: "similar" as const,
    resolvedBy: target.resolvedBy,
    document: {
      id: target.studioDocumentID,
      title: target.title,
      sourceDocumentID: target.sourceDocumentID,
    },
    source: {
      cardID: anchor.id,
      questionNumber: anchor.sequenceIndex + 1,
    },
    placement: input.placement,
    card: toQuestionCardResult(card),
  }
}
