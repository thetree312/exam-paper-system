import { z } from "zod"
import { StudioCommandRunRepository } from "./command-run-repository"
import { StudioQuestionCardApi } from "./internal-api"
import { createLogger } from "../../lib/logger"

const logger = createLogger({ domain: "studio-question-cards-cli" })

const originTaskSchema = z
  .object({
    kind: z.string().min(1),
    sessionID: z.string().optional().nullable(),
    messageID: z.string().optional().nullable(),
  })
  .nullable()
  .optional()

const draftSchema = z.object({
  text: z.string().min(1),
  page: z.number().int().min(1).nullable().optional(),
  originalText: z.string().nullable().optional(),
  answerText: z.string().nullable().optional(),
  canonicalAnswer: z.string().nullable().optional(),
  explanation: z.string().nullable().optional(),
  legendImages: z.array(z.string().min(1)).optional(),
  derivedFromCardID: z.string().nullable().optional(),
  relationType: z.enum(["primary", "practice_generated", "variant", "explanation_followup"]).nullable().optional(),
  originTask: originTaskSchema,
})

const baseScopeSchema = z.object({
  userID: z.string().min(1),
  workroomID: z.string().min(1),
})

const targetResolverSchema = baseScopeSchema.extend({
  studioDocumentID: z.string().min(1).optional().nullable(),
  sourceDocumentID: z.string().min(1).optional().nullable(),
  title: z.string().optional().nullable(),
})

const createContainerSchema = baseScopeSchema.extend({
  sourceDocumentID: z.string().min(1).optional().nullable(),
  title: z.string().optional().nullable(),
  initialDrafts: z.array(draftSchema).optional(),
  idempotencyKey: z.string().min(1).optional(),
})

const listContainerCardsSchema = targetResolverSchema
const getCardSchema = baseScopeSchema.extend({ cardID: z.string().min(1) })

const appendSchema = targetResolverSchema.extend({
  drafts: z.array(draftSchema).min(1),
  idempotencyKey: z.string().min(1).optional(),
})

const insertCardSchema = targetResolverSchema.extend({
  anchorCardID: z.string().min(1),
  position: z.enum(["before", "after"]),
  drafts: z.array(draftSchema).min(1),
  idempotencyKey: z.string().min(1).optional(),
})

const updateSchema = baseScopeSchema.extend({
  cardID: z.string().min(1),
  text: z.string().optional(),
  answerText: z.string().optional(),
  canonicalAnswer: z.string().nullable().optional(),
  explanation: z.string().nullable().optional(),
  legendImages: z.array(z.string().min(1)).optional(),
  derivedFromCardID: z.string().nullable().optional(),
  relationType: z.enum(["primary", "practice_generated", "variant", "explanation_followup"]).nullable().optional(),
  originTask: originTaskSchema,
  idempotencyKey: z.string().min(1).optional(),
})

const writeExplanationSchema = baseScopeSchema.extend({
  cardID: z.string().min(1),
  explanation: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
})

const attachDerivedPracticeSchema = baseScopeSchema.extend({
  sourceCardID: z.string().min(1),
  createdCardIDs: z.array(z.string().min(1)).min(1),
  idempotencyKey: z.string().min(1).optional(),
})

export const studioQuestionCardsCommands = [
  "resolve-target",
  "create-container",
  "get-document",
  "list-cards",
  "list-container-cards",
  "get-card",
  "append",
  "insert",
  "insert-card",
  "create-practice-cards",
  "update-card",
  "write-explanation",
  "attach-derived-practice",
] as const

export type StudioQuestionCardsCommand = (typeof studioQuestionCardsCommands)[number]

export type StudioCommandError = { code: string; message: string; detail?: unknown }

export function asStructuredError(error: unknown): StudioCommandError {
  if (error instanceof z.ZodError) return { code: "INVALID_INPUT", message: "Invalid command payload", detail: error.issues }
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith("TARGET_STUDIO_DOCUMENT_NOT_FOUND")) return { code: "TARGET_STUDIO_DOCUMENT_NOT_FOUND", message }
  if (message.startsWith("TARGET_STUDIO_DOCUMENT_NOT_FOUND_FOR_SOURCE")) return { code: "TARGET_STUDIO_DOCUMENT_NOT_FOUND_FOR_SOURCE", message }
  if (message.startsWith("TARGET_STUDIO_DOCUMENT_UNRESOLVED")) return { code: "TARGET_STUDIO_DOCUMENT_UNRESOLVED", message }
  if (message.startsWith("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH")) return { code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", message }
  if (message.startsWith("IDEMPOTENCY_OPERATION_IN_PROGRESS")) return { code: "IDEMPOTENCY_OPERATION_IN_PROGRESS", message }
  if (message.startsWith("POSSIBLE_ENCODING_CORRUPTION")) return { code: "POSSIBLE_ENCODING_CORRUPTION", message }
  if (message.includes("Studio question card not found")) return { code: "TARGET_CARD_NOT_FOUND", message }
  return { code: "COMMAND_EXECUTION_FAILED", message }
}

function inferIdempotencyKey(command: StudioQuestionCardsCommand, payload: unknown) {
  if (!payload || typeof payload !== "object") return null
  const input = payload as Record<string, unknown>
  const explicit = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : ""
  if (explicit) return explicit
  const drafts = Array.isArray(input.drafts) ? input.drafts : Array.isArray(input.initialDrafts) ? input.initialDrafts : []
  const originTask = drafts[0] && typeof drafts[0] === "object" ? (drafts[0] as Record<string, unknown>).originTask : null
  if (!originTask || typeof originTask !== "object") return null
  const sessionID = typeof (originTask as Record<string, unknown>).sessionID === "string" ? (originTask as Record<string, unknown>).sessionID : ""
  const messageID = typeof (originTask as Record<string, unknown>).messageID === "string" ? (originTask as Record<string, unknown>).messageID : ""
  const userID = typeof input.userID === "string" ? input.userID : ""
  const workroomID = typeof input.workroomID === "string" ? input.workroomID : ""
  if (!sessionID || !messageID || !userID || !workroomID) return null
  return `${command}:${userID}:${workroomID}:${sessionID}:${messageID}`
}

function shouldUseIdempotency(command: StudioQuestionCardsCommand) {
  return (
    command === "create-container" ||
    command === "append" ||
    command === "insert" ||
    command === "insert-card" ||
    command === "create-practice-cards" ||
    command === "write-explanation" ||
    command === "attach-derived-practice"
  )
}

function hasPotentialEncodingCorruption(payload: unknown) {
  if (!payload || typeof payload !== "object") return false
  const input = payload as Record<string, unknown>
  const draftSets = [input.drafts, input.initialDrafts]
  for (const set of draftSets) {
    if (!Array.isArray(set)) continue
    for (const draft of set) {
      if (!draft || typeof draft !== "object") continue
      const text = typeof (draft as Record<string, unknown>).text === "string" ? String((draft as Record<string, unknown>).text) : ""
      if (!text) continue
      if (/\?{3,}/.test(text) && !/[\u4e00-\u9fff]/.test(text)) return true
    }
  }
  return false
}

async function withIdempotency(command: StudioQuestionCardsCommand, payload: unknown, execute: () => Promise<unknown>) {
  if (!shouldUseIdempotency(command)) return execute()
  if (!payload || typeof payload !== "object") return execute()
  const input = payload as Record<string, unknown>
  const userID = typeof input.userID === "string" ? input.userID : ""
  const workroomID = typeof input.workroomID === "string" ? input.workroomID : ""
  const idempotencyKey = inferIdempotencyKey(command, payload)
  if (!userID || !workroomID || !idempotencyKey) return execute()

  const payloadHash = StudioCommandRunRepository.hashPayload(payload)
  const started = await StudioCommandRunRepository.tryStart({ userID, workroomID, command, idempotencyKey, payloadHash })
  if (!started.started && started.record) {
    if (started.record.payloadHash !== payloadHash) throw new Error("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: same key with different payload")
    if (started.record.status === "completed" && started.record.resultJson) return JSON.parse(started.record.resultJson) as unknown
    if (started.record.status === "running") throw new Error("IDEMPOTENCY_OPERATION_IN_PROGRESS")
  }
  try {
    const result = await execute()
    await StudioCommandRunRepository.complete({ userID, workroomID, command, idempotencyKey, result })
    return result
  } catch (error) {
    await StudioCommandRunRepository.fail({
      userID,
      workroomID,
      command,
      idempotencyKey,
      errorText: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function resolveTarget(input: z.infer<typeof targetResolverSchema>) {
  const result = await StudioQuestionCardApi.resolveTargetStudioDocument(input)
  return {
    studioDocumentID: result.studioDocument.id,
    sourceDocumentID: result.studioDocument.sourceDocumentID ?? null,
    resolvedBy: result.resolvedBy,
    studioDocument: result.studioDocument,
  }
}

async function resolveExistingTarget(input: z.infer<typeof targetResolverSchema>) {
  const result = await StudioQuestionCardApi.resolveExistingStudioDocument(input)
  return {
    studioDocumentID: result.studioDocument.id,
    sourceDocumentID: result.studioDocument.sourceDocumentID ?? null,
    resolvedBy: result.resolvedBy,
    studioDocument: result.studioDocument,
  }
}

function asMutationResult(kind: "create" | "insert" | "create_practice", cards: Array<{ id: string; sequenceIndex: number }>, extra?: Record<string, unknown>) {
  return {
    kind,
    insertedCardIDs: cards.map((item) => item.id),
    sequenceIndexes: cards.map((item) => item.sequenceIndex),
    ...(extra ?? {}),
  }
}

export async function executeStudioQuestionCardsCommand(command: StudioQuestionCardsCommand, payload: unknown) {
  logger.info("studio question cards command received", {
    command,
    has_payload: payload != null,
  })
  const execute = async () => {
    switch (command) {
      case "resolve-target":
        return resolveTarget(targetResolverSchema.parse(payload))
      case "create-container": {
        const input = createContainerSchema.parse(payload)
        if (hasPotentialEncodingCorruption(input)) throw new Error("POSSIBLE_ENCODING_CORRUPTION: detected suspicious draft text")
        const studioDocument = await StudioQuestionCardApi.createStudioDocumentContainer({
          userID: input.userID,
          workroomID: input.workroomID,
          sourceDocumentID: input.sourceDocumentID ?? null,
          title: input.title ?? null,
        })
        const createdCards = input.initialDrafts?.length
          ? await StudioQuestionCardApi.appendStudioQuestionCards({
              userID: input.userID,
              workroomID: input.workroomID,
              studioDocumentID: studioDocument.id,
              drafts: input.initialDrafts,
            })
          : []
        return {
          studioDocumentID: studioDocument.id,
          sourceDocumentID: studioDocument.sourceDocumentID ?? null,
          resolvedBy: "created_container",
          studioDocument,
          mutation: asMutationResult("create", createdCards),
          cards: createdCards,
        }
      }
      case "get-document": {
        const input = targetResolverSchema.parse(payload)
        const target = await resolveExistingTarget(input)
        const document = await StudioQuestionCardApi.getStudioDocument({
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: target.studioDocumentID,
        })
        return { ...target, document }
      }
      case "list-cards":
      case "list-container-cards": {
        const input = listContainerCardsSchema.parse(payload)
        const target = await resolveExistingTarget(input)
        const cards = await StudioQuestionCardApi.listStudioQuestionCards({
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: target.studioDocumentID,
        })
        return { ...target, cards }
      }
      case "get-card":
        return StudioQuestionCardApi.getStudioQuestionCard(getCardSchema.parse(payload))
      case "append": {
        const input = appendSchema.parse(payload)
        if (hasPotentialEncodingCorruption(input)) throw new Error("POSSIBLE_ENCODING_CORRUPTION: detected suspicious draft text")
        const target = await resolveExistingTarget(input)
        const cards = await StudioQuestionCardApi.appendStudioQuestionCards({
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: target.studioDocumentID,
          drafts: input.drafts,
        })
        logger.info("studio question cards append result", {
          command,
          studio_document_id: target.studioDocumentID,
          resolved_by: target.resolvedBy,
          cards_count: cards.length,
          card_ids: cards.map((item) => item.id),
        })
        return { ...target, mutation: asMutationResult("create", cards), cards }
      }
      case "insert":
      case "insert-card": {
        const input = insertCardSchema.parse(payload)
        if (hasPotentialEncodingCorruption(input)) throw new Error("POSSIBLE_ENCODING_CORRUPTION: detected suspicious draft text")
        const target = await resolveExistingTarget(input)
        const cards = await StudioQuestionCardApi.insertStudioQuestionCards({
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: target.studioDocumentID,
          anchorCardID: input.anchorCardID,
          position: input.position,
          drafts: input.drafts,
        })
        logger.info("studio question cards insert result", {
          command,
          studio_document_id: target.studioDocumentID,
          resolved_by: target.resolvedBy,
          anchor_card_id: input.anchorCardID,
          position: input.position,
          cards_count: cards.length,
          card_ids: cards.map((item) => item.id),
        })
        return {
          ...target,
          mutation: asMutationResult("insert", cards, {
            anchorCardID: input.anchorCardID,
            position: input.position,
          }),
          cards,
        }
      }
      case "create-practice-cards": {
        const input = appendSchema.parse(payload)
        if (hasPotentialEncodingCorruption(input)) throw new Error("POSSIBLE_ENCODING_CORRUPTION: detected suspicious draft text")
        const target = await resolveExistingTarget(input)
        const cards = await StudioQuestionCardApi.appendStudioQuestionCards({
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: target.studioDocumentID,
          drafts: input.drafts.map((item) => ({ ...item, relationType: item.relationType ?? "practice_generated" })),
        })
        return { ...target, mutation: asMutationResult("create_practice", cards), cards }
      }
      case "update-card":
        return StudioQuestionCardApi.updateStudioQuestionCard(updateSchema.parse(payload))
      case "write-explanation":
        return StudioQuestionCardApi.writeStudioQuestionExplanation(writeExplanationSchema.parse(payload))
      case "attach-derived-practice":
        return StudioQuestionCardApi.attachDerivedPracticeCards(attachDerivedPracticeSchema.parse(payload))
      default: {
        const exhaustive: never = command
        throw new Error(`Unsupported studio question card command: ${exhaustive}`)
      }
    }
  }
  return withIdempotency(command, payload, execute)
}
