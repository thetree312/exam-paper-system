import { z } from "zod"
import { StudioQuestionCardApi } from "./internal-api"
import { createLogger } from "../../lib/logger"

const logger = createLogger({ domain: "studio-question-cards-bridge" })

const baseScopeSchema = z.object({
  userID: z.string().min(1),
  workroomID: z.string().min(1),
})

const targetSchema = baseScopeSchema.extend({
  studioDocumentID: z.string().min(1).optional().nullable(),
  sourceDocumentID: z.string().min(1).optional().nullable(),
  title: z.string().optional().nullable(),
})

const getCardSchema = baseScopeSchema.extend({
  cardID: z.string().min(1),
  full: z.boolean().optional(),
})

const searchCardsSchema = targetSchema.extend({
  query: z.string().min(1),
})

export const studioQuestionCardsCommands = [
  "resolve-target",
  "get-document",
  "search-cards",
  "get-card",
] as const

export type StudioQuestionCardsCommand = (typeof studioQuestionCardsCommands)[number]
export type StudioCommandError = { code: string; message: string; detail?: unknown }

export function asStructuredError(error: unknown): StudioCommandError {
  if (error instanceof z.ZodError) {
    return { code: "INVALID_INPUT", message: "Invalid command payload", detail: error.issues }
  }
  const message = error instanceof Error ? error.message : String(error)
  const detail =
    error && typeof error === "object" && "detail" in error ? ((error as { detail?: unknown }).detail ?? undefined) : undefined
  if (message.startsWith("TARGET_STUDIO_DOCUMENT_NOT_FOUND")) return { code: "TARGET_STUDIO_DOCUMENT_NOT_FOUND", message }
  if (message.startsWith("TARGET_STUDIO_DOCUMENT_NOT_FOUND_FOR_SOURCE")) return { code: "TARGET_STUDIO_DOCUMENT_NOT_FOUND_FOR_SOURCE", message }
  if (message.startsWith("TARGET_STUDIO_DOCUMENT_UNRESOLVED")) return { code: "TARGET_STUDIO_DOCUMENT_UNRESOLVED", message }
  if (message.startsWith("TARGET_STUDIO_DOCUMENT_AMBIGUOUS")) return { code: "TARGET_STUDIO_DOCUMENT_AMBIGUOUS", message, detail }
  if (message.startsWith("QUESTION_NUMBER_OUT_OF_RANGE")) return { code: "QUESTION_NUMBER_OUT_OF_RANGE", message, detail }
  if (message.startsWith("DEPRECATED_COMMAND")) return { code: "DEPRECATED_COMMAND", message, detail }
  if (message.startsWith("MISSING_REQUIRED_ARGUMENT")) return { code: "MISSING_REQUIRED_ARGUMENT", message, detail }
  if (message.startsWith("INVALID_ARGUMENT")) return { code: "INVALID_ARGUMENT", message, detail }
  if (message.includes("Studio question card not found")) return { code: "TARGET_CARD_NOT_FOUND", message }
  return { code: "COMMAND_EXECUTION_FAILED", message, detail }
}

function toCompactCard(card: {
  cardID: string
  sequenceIndex: number
  stemPreview: string
  questionType?: string | null
  difficulty?: string | null
  masteryLevel?: string | null
  updatedAt: string
}) {
  return {
    cardID: card.cardID,
    questionNumber: card.sequenceIndex + 1,
    sequenceIndex: card.sequenceIndex,
    stemPreview: card.stemPreview,
    questionType: card.questionType ?? null,
    difficulty: card.difficulty ?? null,
    masteryLevel: card.masteryLevel ?? null,
    updatedAt: card.updatedAt,
  }
}

async function resolveExistingTarget(input: z.infer<typeof targetSchema>) {
  const result = await StudioQuestionCardApi.resolveExistingStudioDocument(input)
  return {
    studioDocumentID: result.studioDocument.id,
    sourceDocumentID: result.studioDocument.sourceDocumentID ?? null,
    resolvedBy: result.resolvedBy,
    studioDocument: result.studioDocument,
  }
}

export async function executeStudioQuestionCardsCommand(command: StudioQuestionCardsCommand, payload: unknown) {
  logger.info("studio question cards bridge command received", {
    command,
    has_payload: payload != null,
  })

  switch (command) {
    case "resolve-target": {
      return resolveExistingTarget(targetSchema.parse(payload))
    }
    case "get-document": {
      const input = targetSchema.parse(payload)
      const target = await resolveExistingTarget(input)
      const document = await StudioQuestionCardApi.getStudioDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: target.studioDocumentID,
      })
      return { ...target, document }
    }
    case "search-cards": {
      const input = searchCardsSchema.parse(payload)
      const target = await resolveExistingTarget(input)
      const cards = await StudioQuestionCardApi.searchStudioQuestionCards({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: target.studioDocumentID,
        query: input.query,
      })
      return { ...target, cards: cards.map(toCompactCard) }
    }
    case "get-card": {
      const input = getCardSchema.parse(payload)
      return StudioQuestionCardApi.getStudioQuestionCard(input)
    }
    default: {
      const exhaustive: never = command
      throw new Error(`Unsupported studio question card command: ${exhaustive}`)
    }
  }
}
