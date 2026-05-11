import { WorkroomService } from "../workrooms/service"
import { StudioService } from "./service"
import { createLogger } from "../../lib/logger"

type Placement = "before" | "after"

type QuestionIntentScope = {
  userID: string
  workroomID: string
}

type QuestionIntentInput = QuestionIntentScope & {
  stem: string
  answer?: string | null
  explanation?: string | null
  options?: string[]
  page?: number
}

type ResolveBusinessTargetResult = {
  studioDocumentID: string
  sourceDocumentID: string | null
  title: string
  resolvedBy: "runtime_active" | "single_document"
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

function buildCardText(input: QuestionIntentInput) {
  const stem = normalizeRequiredText(input.stem, "stem")
  const options = normalizeOptions(input.options)
  if (options.length === 0) return stem
  const labeled = options.map((item, index) => `${String.fromCharCode(65 + index)}. ${item}`)
  return [stem, ...labeled].join("\n")
}

function buildDraft(input: QuestionIntentInput) {
  return {
    text: buildCardText(input),
    originalText: input.stem.trim(),
    page: input.page,
    answerText: normalizeOptionalText(input.answer) ?? undefined,
    canonicalAnswer: normalizeOptionalText(input.answer) ?? undefined,
    explanation: normalizeOptionalText(input.explanation) ?? undefined,
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

export async function createQuestionByIntent(input: QuestionIntentInput) {
  logger.info("create question by intent start", {
    user_id: input.userID,
    workroom_id: input.workroomID,
  })
  const target = await resolveBusinessTarget({ userID: input.userID, workroomID: input.workroomID })
  const created = await StudioService.appendQuestionCards({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
    drafts: [buildDraft(input)],
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
  const created = await StudioService.insertQuestionCards({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: target.studioDocumentID,
    anchorCardID: anchor.id,
    position: input.placement,
    drafts: [buildDraft(input)],
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
