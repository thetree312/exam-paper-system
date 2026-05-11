import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { AuthService } from "../domains/auth/service"
import { QuestionsRepository } from "../domains/questions/repository"
import { StudioBridgeTokenRepository } from "../domains/studio/bridge-token-repository"
import {
  asStructuredError,
  executeStudioQuestionCardsCommand,
  studioQuestionCardsCommands,
  type StudioQuestionCardsCommand,
} from "../domains/studio/command-bridge"
import { createQuestionByIntent, insertQuestionByIntent } from "../domains/studio/question-write-service"
import { StudioEvents } from "../domains/studio/events"
import { StudioRevisionRepository } from "../domains/studio/revision-repository"
import { StudioService } from "../domains/studio/service"
import { createLogger } from "../lib/logger"
import { requireAuth } from "./auth-context"

const listDocumentsQuerySchema = z.object({
  workroomID: z.string().min(1),
  sourceDocumentID: z.string().min(1).optional(),
})

const createDocumentSchema = z.object({
  workroomID: z.string().min(1),
  title: z.string().trim().optional().nullable(),
  sourceDocumentID: z.string().min(1).optional().nullable(),
})

const listQuestionCardsQuerySchema = z.object({
  workroomID: z.string().min(1),
  studioDocumentID: z.string().min(1),
})

const bridgeCommandBodySchema = z.object({
  payload: z.unknown().optional(),
})

const bridgeQuestionActionSchema = z.enum(["create", "insert"])

const bridgeQuestionBodySchema = z.object({
  stem: z.string().min(1),
  answer: z.string().optional().nullable(),
  explanation: z.string().optional().nullable(),
  options: z.array(z.string().min(1)).optional(),
  page: z.number().int().min(1).optional(),
  questionNumber: z.number().int().min(1).optional(),
  placement: z.enum(["before", "after"]).optional(),
})

const normalizedRegionSchema = z.object({
  page: z.number().int().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
})

const selectionRegionSchema = normalizedRegionSchema.extend({
  exclusions: z.array(normalizedRegionSchema.omit({ page: true })).optional(),
})

const legendRegionSchema = normalizedRegionSchema

const recognizeSelectionSchema = z.object({
  workroomID: z.string().min(1),
  sourceDocumentID: z.string().min(1),
  studioDocumentID: z.string().min(1).optional().nullable(),
  title: z.string().trim().optional().nullable(),
  regions: z.array(selectionRegionSchema).min(1),
  legends: z.array(legendRegionSchema).optional(),
})

const importFromLayoutSchema = z.object({
  workroomID: z.string().min(1),
  sourceDocumentID: z.string().min(1),
  studioDocumentID: z.string().min(1).optional().nullable(),
  title: z.string().trim().optional().nullable(),
  replaceExisting: z.boolean().optional(),
})

const submitAttemptSchema = z.object({
  workroomID: z.string().min(1),
  answerText: z.string().min(1),
})

export const studioRoutes = new Hono()
const logger = createLogger({ domain: "studio-route" })

async function requireStudioBridgeAuth(c: Context) {
  const token = c.req.header("x-studio-bridge-token")?.trim()
  if (!token) throw new Error("Missing x-studio-bridge-token header")
  const record = await StudioBridgeTokenRepository.resolve(token)
  if (!record) throw new Error("Invalid studio bridge token")
  return record
}

studioRoutes.get("/events", async (c) => {
  const tokenFromQuery = c.req.query("access_token")?.trim()
  const auth = tokenFromQuery ? await AuthService.resolveSession(tokenFromQuery) : await requireAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")
  logger.info("studio events stream connected", {
    user_id: auth.user.id,
    workroom_id: workroomID,
  })

  c.header("Cache-Control", "no-cache, no-transform")
  c.header("X-Accel-Buffering", "no")
  c.header("X-Content-Type-Options", "nosniff")

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({
        type: "studio.connected",
        workroomID,
        at: new Date().toISOString(),
      }),
    })

    const unsubscribe = StudioEvents.subscribe(
      { userID: auth.user.id, workroomID },
      async (event) => {
        logger.info("studio events stream emit", {
          user_id: auth.user.id,
          workroom_id: workroomID,
          event_type: event.type,
          studio_document_id: event.studioDocumentID,
          revision: event.revision,
          reason: event.reason,
          card_ids: event.cardIDs ?? [],
          anchor_card_id: event.anchorCardID ?? null,
          position: event.position ?? null,
        })
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      },
    )

    const heartbeat = setInterval(async () => {
      await stream.writeSSE({
        event: "heartbeat",
        data: JSON.stringify({ type: "studio.heartbeat", at: new Date().toISOString() }),
      })
    }, 15_000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        logger.info("studio events stream aborted", {
          user_id: auth.user.id,
          workroom_id: workroomID,
        })
        clearInterval(heartbeat)
        unsubscribe()
        resolve()
      })
    })
  })
})

studioRoutes.get("/documents", async (c) => {
  const { user } = await requireAuth(c)
  const query = listDocumentsQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    sourceDocumentID: c.req.query("source_document_id") ?? undefined,
  })

  return c.json({
    items: await StudioService.listDocuments({
      userID: user.id,
      workroomID: query.workroomID,
      sourceDocumentID: query.sourceDocumentID,
    }),
  })
})

studioRoutes.post("/documents", async (c) => {
  const { user } = await requireAuth(c)
  const body = createDocumentSchema.parse(await c.req.json())

  return c.json(
    await StudioService.createDocument({
      userID: user.id,
      workroomID: body.workroomID,
      title: body.title,
      sourceDocumentID: body.sourceDocumentID,
    }),
    201,
  )
})

studioRoutes.get("/question-cards", async (c) => {
  const { user } = await requireAuth(c)
  const query = listQuestionCardsQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    studioDocumentID: c.req.query("studio_document_id"),
  })
  const cards = await StudioService.listQuestionCards({
    userID: user.id,
    workroomID: query.workroomID,
    studioDocumentID: query.studioDocumentID,
  })
  const revision = await StudioRevisionRepository.get({
    workroomID: query.workroomID,
    studioDocumentID: query.studioDocumentID,
  })
  const projectedQuestions = await QuestionsRepository.listByStudioCardIDs({
    userID: user.id,
    studioCardIDs: cards.map((item) => item.id),
  })
  const projectedByCardID = new Map(projectedQuestions.map((item) => [item.studioCardID, item]))

  return c.json({
    revision,
    items: cards.map((card) => {
      const projected = projectedByCardID.get(card.id)
      return {
        ...card,
        projectedQuestionID: projected?.id ?? null,
      }
    }),
  })
})

studioRoutes.post("/question-cards/bridge/:command", async (c) => {
  const bridge = await requireStudioBridgeAuth(c)
  const command = String(c.req.param("command") ?? "").trim()
  if (!studioQuestionCardsCommands.includes(command as StudioQuestionCardsCommand)) {
    return c.json(
      {
        ok: false,
        command,
        error: `Unsupported studio bridge command: ${command}`,
        code: "UNSUPPORTED_COMMAND",
        detail: null,
      },
      400,
    )
  }

  const body = bridgeCommandBodySchema.parse(await c.req.json())
  const payload = body.payload ?? {}
  if (!payload || typeof payload !== "object") {
    return c.json(
      {
        ok: false,
        command,
        error: "Bridge payload must be an object",
        code: "INVALID_INPUT",
        detail: null,
      },
      400,
    )
  }

  const payloadRecord = payload as Record<string, unknown>
  if (payloadRecord.userID !== undefined && payloadRecord.userID !== bridge.userID) {
    return c.json(
      {
        ok: false,
        command,
        error: "Bridge payload userID does not match token scope",
        code: "BRIDGE_SCOPE_MISMATCH",
        detail: null,
      },
      403,
    )
  }
  if (payloadRecord.workroomID !== undefined && payloadRecord.workroomID !== bridge.workroomID) {
    return c.json(
      {
        ok: false,
        command,
        error: "Bridge payload workroomID does not match token scope",
        code: "BRIDGE_SCOPE_MISMATCH",
        detail: null,
      },
      403,
    )
  }

  const effectivePayload = {
    ...payloadRecord,
    userID: bridge.userID,
    workroomID: bridge.workroomID,
  }

  logger.info("studio question cards bridge route execute", {
    user_id: bridge.userID,
    workroom_id: bridge.workroomID,
    command,
  })

  try {
    const result = await executeStudioQuestionCardsCommand(command as StudioQuestionCardsCommand, effectivePayload)
    return c.json({
      ok: true,
      command,
      result,
    })
  } catch (error) {
    const parsed = asStructuredError(error)
    logger.warn("studio question cards bridge route failed", {
      user_id: bridge.userID,
      workroom_id: bridge.workroomID,
      command,
      code: parsed.code,
      error: parsed.message,
    })
    return c.json(
      {
        ok: false,
        command,
        error: parsed.message,
        code: parsed.code,
        detail: parsed.detail ?? null,
      },
      parsed.code === "IDEMPOTENCY_OPERATION_IN_PROGRESS" ? 409 : parsed.code === "INVALID_INPUT" ? 400 : 500,
    )
  }
})

studioRoutes.post("/question-cards/question/:action", async (c) => {
  const bridge = await requireStudioBridgeAuth(c)
  const action = bridgeQuestionActionSchema.parse(c.req.param("action"))
  const body = bridgeQuestionBodySchema.parse(await c.req.json())

  try {
    const result =
      action === "create"
        ? await createQuestionByIntent({
            userID: bridge.userID,
            workroomID: bridge.workroomID,
            stem: body.stem,
            answer: body.answer,
            explanation: body.explanation,
            options: body.options,
            page: body.page,
          })
        : await insertQuestionByIntent({
            userID: bridge.userID,
            workroomID: bridge.workroomID,
            stem: body.stem,
            answer: body.answer,
            explanation: body.explanation,
            options: body.options,
            page: body.page,
            questionNumber: body.questionNumber ?? 0,
            placement: body.placement ?? "after",
          })

    return c.json({
      ok: true,
      action,
      result,
    })
  } catch (error) {
    const parsed = asStructuredError(error)
    return c.json(
      {
        ok: false,
        action,
        error: parsed.message,
        code: parsed.code,
        detail: parsed.detail ?? null,
      },
      parsed.code === "INVALID_ARGUMENT" ? 400 : 500,
    )
  }
})

studioRoutes.get("/question-cards/:cardID/detail", async (c) => {
  const { user } = await requireAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")
  return c.json(
    await StudioService.getQuestionCardDetail({
      userID: user.id,
      workroomID,
      cardID: c.req.param("cardID"),
    }),
  )
})

studioRoutes.post("/question-cards/recognize-selection", async (c) => {
  const { user } = await requireAuth(c)
  const body = recognizeSelectionSchema.parse(await c.req.json())

  return c.json(
    await StudioService.recognizeSelection({
      userID: user.id,
      workroomID: body.workroomID,
      sourceDocumentID: body.sourceDocumentID,
      studioDocumentID: body.studioDocumentID,
      title: body.title,
      regions: body.regions,
      legends: body.legends ?? [],
    }),
    201,
  )
})

studioRoutes.post("/question-cards/import-from-layout", async (c) => {
  const { user } = await requireAuth(c)
  const body = importFromLayoutSchema.parse(await c.req.json())

  return c.json(
    await StudioService.importFromLayout({
      userID: user.id,
      workroomID: body.workroomID,
      sourceDocumentID: body.sourceDocumentID,
      studioDocumentID: body.studioDocumentID,
      title: body.title,
      replaceExisting: body.replaceExisting ?? false,
    }),
    201,
  )
})

studioRoutes.delete("/question-cards/:cardID", async (c) => {
  const { user } = await requireAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")

  return c.json(
    await StudioService.deleteQuestionCard({
      userID: user.id,
      workroomID,
      cardID: c.req.param("cardID"),
    }),
  )
})

studioRoutes.post("/question-cards/:cardID/attempts", async (c) => {
  const { user } = await requireAuth(c)
  const body = submitAttemptSchema.parse(await c.req.json())
  return c.json(
    await StudioService.submitAttempt({
      userID: user.id,
      workroomID: body.workroomID,
      cardID: c.req.param("cardID"),
      answerText: body.answerText,
    }),
    201,
  )
})
