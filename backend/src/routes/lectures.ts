import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { AuthService } from "../domains/auth/service"
import { LectureEvents } from "../domains/lecture/events"
import { LectureService } from "../domains/lecture/service"
import { loadAgentRuntimeModules, withAgentScope } from "../domains/agent/service"
import { toRuntimeStreamEnvelope } from "../domains/agent/runtime-event-envelope"
import { StudioBridgeTokenRepository } from "../domains/studio/bridge-token-repository"
import { StudioService } from "../domains/studio/service"
import { requireAuth } from "./auth-context"

const launchSchema = z.object({
  workroomID: z.string().min(1),
  studioDocumentID: z.string().min(1).optional(),
  cardID: z.string().min(1),
  originAgentSessionID: z.string().min(1).optional().nullable(),
  originMessageID: z.string().min(1).optional().nullable(),
})

const closeSchema = z.object({
  workroomID: z.string().min(1),
})

const completeSchema = z.object({
  workroomID: z.string().min(1),
  teachingSummary: z.string().min(1),
  nextSuggestion: z.string().optional().nullable(),
})

const appendBlockSchema = z.object({
  workroomID: z.string().min(1),
  role: z.enum(["lecture", "answer", "student_question", "system"]),
  text: z.string().min(1),
  highlightSpans: z.array(z.object({ sourceId: z.string().min(1), quote: z.string().min(1) })).optional(),
})

const visualizationSchema = z.object({
  workroomID: z.string().min(1),
  html: z.string().nullable().optional(),
  patches: z
    .array(
      z.discriminatedUnion("op", [
        z.object({
          op: z.literal("set_html"),
          targetId: z.string().min(1),
          html: z.string(),
        }),
        z.object({
          op: z.literal("set_text"),
          targetId: z.string().min(1),
          text: z.string(),
        }),
        z.object({
          op: z.literal("set_attr"),
          targetId: z.string().min(1),
          name: z.string().min(1),
          value: z.string().nullable(),
        }),
        z.object({
          op: z.literal("remove_node"),
          targetId: z.string().min(1),
        }),
        z.object({
          op: z.literal("append_child"),
          targetId: z.string().min(1),
          html: z.string(),
        }),
        z.object({
          op: z.literal("scene_state"),
          targetId: z.string().min(1),
          state: z.record(z.string(), z.unknown()),
        }),
      ]),
    )
    .optional(),
}).superRefine((value, ctx) => {
  const isFullDocument = (raw: string) => /<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>]/i.test(raw)
  const hasForbiddenMarkup = (raw: string) =>
    /<script[^>]*\ssrc\s*=|<iframe\b|<object\b|<embed\b|<link\b|<meta\b|\son\w+\s*=|javascript\s*:|window\s*\.\s*(top|parent)|document\s*\.\s*cookie|location\s*=/i.test(
      raw,
    )
  const hasHtml = value.html != null
  const hasPatches = Array.isArray(value.patches) && value.patches.length > 0
  if (!hasHtml && !hasPatches) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "html or patches is required" })
  }
  if (hasHtml && value.html != null && !value.html.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "html must not be empty" })
  }
  if (hasHtml && hasPatches) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "html and patches are mutually exclusive" })
  }
  if (value.html && isFullDocument(value.html)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "full visualization html documents are not allowed; submit a fragment for #lecture-visualization-root",
    })
  }
  if (value.html && hasForbiddenMarkup(value.html)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "forbidden visualization html markup" })
  }
  for (const patch of value.patches ?? []) {
    if ((patch.op === "set_html" || patch.op === "append_child") && isFullDocument(patch.html)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `full visualization patch documents are not allowed: ${patch.op}`,
      })
    }
    if ((patch.op === "set_html" || patch.op === "append_child") && hasForbiddenMarkup(patch.html)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `forbidden visualization patch markup: ${patch.op}`,
      })
    }
  }
})

const runtimeQuestionReplySchema = z.object({
  workroomID: z.string().min(1),
  answers: z.array(z.array(z.string())),
  freeText: z.array(z.string().nullable()).optional(),
})

async function requireLectureAuth(c: Context) {
  const token = c.req.header("x-studio-bridge-token")?.trim()
  if (token) {
    const record = await StudioBridgeTokenRepository.resolve(token)
    if (!record) throw new Error("Invalid studio bridge token")
    return { userID: record.userID }
  }
  const { user } = await requireAuth(c)
  return { userID: user.id }
}

async function resolveStudioDocumentID(input: { userID: string; workroomID: string; cardID: string; studioDocumentID?: string }) {
  if (input.studioDocumentID?.trim()) return input.studioDocumentID.trim()
  const detail = await StudioService.getQuestionCardDetail({
    userID: input.userID,
    workroomID: input.workroomID,
    cardID: input.cardID,
  })
  return detail.card.studioDocumentID
}

export const lectureRoutes = new Hono()

lectureRoutes.post("/launch", async (c) => {
  const auth = await requireLectureAuth(c)
  const body = launchSchema.parse(await c.req.json())
  const studioDocumentID = await resolveStudioDocumentID({
    userID: auth.userID,
    workroomID: body.workroomID,
    cardID: body.cardID,
    studioDocumentID: body.studioDocumentID,
  })
  return c.json(
    await LectureService.launchSession({
      userID: auth.userID,
      workroomID: body.workroomID,
      studioDocumentID,
      cardID: body.cardID,
      originAgentSessionID: body.originAgentSessionID,
      originMessageID: body.originMessageID,
    }),
    201,
  )
})

function eventSessionID(event: Record<string, unknown>) {
  if (typeof event.sessionID === "string") return event.sessionID
  const properties = event.properties
  if (!properties || typeof properties !== "object") return undefined
  const props = properties as Record<string, unknown>
  if (typeof props.sessionID === "string") return props.sessionID
  const info = props.info
  if (info && typeof info === "object" && typeof (info as Record<string, unknown>).sessionID === "string") {
    return String((info as Record<string, unknown>).sessionID)
  }
  const part = props.part
  if (part && typeof part === "object" && typeof (part as Record<string, unknown>).sessionID === "string") {
    return String((part as Record<string, unknown>).sessionID)
  }
  return undefined
}

function lecturePayloadSignature(payload: Awaited<ReturnType<typeof LectureService.getSession>>) {
  return JSON.stringify({
    sessionID: payload.session.id,
    status: payload.session.status,
    updatedAt: payload.session.updatedAt,
    visualizationHTML: payload.session.visualizationHTML,
    questionRequestID: payload.pendingQuestion?.requestID ?? null,
    blocks: payload.blocks.map((block) => ({
      id: block.id,
      role: block.role,
      text: block.text,
      createdAt: block.createdAt,
    })),
  })
}

lectureRoutes.get("/:sessionID", async (c) => {
  const auth = await requireLectureAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")
  return c.json(
    await LectureService.getSession({
      userID: auth.userID,
      workroomID,
      lectureSessionID: c.req.param("sessionID"),
    }),
  )
})

lectureRoutes.get("/:sessionID/stream", async (c) => {
  const tokenFromQuery = c.req.query("access_token")?.trim()
  const auth = tokenFromQuery ? await AuthService.resolveSession(tokenFromQuery) : await requireAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")
  const lectureSessionID = c.req.param("sessionID")
  return withAgentScope({ userID: auth.user.id, workroomID, syncUserSettings: false }, async () => {
    const payload = await LectureService.getSession({
      userID: auth.user.id,
      workroomID,
      lectureSessionID,
    })

    c.header("Cache-Control", "no-cache, no-transform")
    c.header("X-Accel-Buffering", "no")
    c.header("X-Content-Type-Options", "nosniff")

    return streamSSE(c, async (stream) => {
      let currentPayload = payload
      let watchedSessionIDs = new Set(
        [payload.session.originAgentSessionID, payload.session.lectureAgentSessionID].filter(
          (value): value is string => Boolean(value?.trim()),
        ),
      )
      let syncInFlight: Promise<void> | null = null
      let syncQueued = false
      let syncAbort = false
      let syncWake: (() => void) | null = null
      let lastReadySignature = lecturePayloadSignature(currentPayload)

      const refreshWatchedSessions = (session: typeof payload.session) => {
        watchedSessionIDs = new Set(
          [session.originAgentSessionID, session.lectureAgentSessionID].filter(
            (value): value is string => Boolean(value?.trim()),
          ),
        )
      }

      const syncLectureProjection = async () => {
        if (syncInFlight) {
          syncQueued = true
          return syncInFlight
        }
        syncInFlight = (async () => {
          do {
            syncQueued = false
            currentPayload = await LectureService.getSession({
              userID: auth.user.id,
              workroomID,
              lectureSessionID,
            })
            refreshWatchedSessions(currentPayload.session)
            const nextSignature = lecturePayloadSignature(currentPayload)
            if (nextSignature !== lastReadySignature) {
              lastReadySignature = nextSignature
              await stream.writeSSE({
                event: "lecture.session.ready",
                data: JSON.stringify({
                  type: "lecture.session.ready",
                  session: currentPayload.session,
                  blocks: currentPayload.blocks,
                  pendingQuestion: currentPayload.pendingQuestion,
                  at: new Date().toISOString(),
                }),
              })
            }
          } while (syncQueued)
        })().finally(() => {
          syncInFlight = null
        })
        return syncInFlight
      }

      const requestSyncLectureProjection = () => {
        syncQueued = true
        syncWake?.()
      }

      const syncLectureProjectionWorker = async () => {
        while (!syncAbort) {
          if (!syncQueued) {
            await new Promise<void>((resolve) => {
              syncWake = resolve
            })
            syncWake = null
          }
          if (syncAbort) return
          if (!syncQueued) continue
          syncQueued = false
          await syncLectureProjection().catch((error) => {
            console.error("lecture projection sync failed", error)
          })
        }
      }

      await stream.writeSSE({
        event: "lecture.session.ready",
        data: JSON.stringify({
          type: "lecture.session.ready",
          session: currentPayload.session,
          blocks: currentPayload.blocks,
          pendingQuestion: currentPayload.pendingQuestion,
          at: new Date().toISOString(),
        }),
      })

      const { Bus } = await loadAgentRuntimeModules()
      const unsubscribe = LectureEvents.subscribe(lectureSessionID, async (event) => {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      })

      const unsubscribeRuntime = Bus.subscribeAll((event: any) => {
        if (!event || typeof event !== "object") return
        const sourceSessionID = eventSessionID(event as Record<string, unknown>)
        if (!sourceSessionID || !watchedSessionIDs.has(sourceSessionID)) return
        const payload = toRuntimeStreamEnvelope(event)
        if (payload) {
          void LectureService.projectRuntimeStreamEvent({
            userID: auth.user.id,
            workroomID,
            agentSessionID: sourceSessionID,
            event: payload,
          }).catch((error) => {
            console.error("lecture runtime projection failed", error)
          })
        }
        requestSyncLectureProjection()
      })
      requestSyncLectureProjection()
      void syncLectureProjectionWorker().catch((error) => {
        console.error("lecture projection worker failed", error)
      })

      const heartbeat = setInterval(async () => {
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ type: "lecture.heartbeat", at: new Date().toISOString() }),
        })
      }, 15_000)

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          syncAbort = true
          syncWake?.()
          clearInterval(heartbeat)
          unsubscribeRuntime()
          unsubscribe()
          resolve()
        })
      })
    })
  })
})

lectureRoutes.get("/by-agent-session/:sessionID", async (c) => {
  const auth = await requireLectureAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")
  const session = await LectureService.resolveSessionByAgentSessionID({
    userID: auth.userID,
    workroomID,
    lectureAgentSessionID: c.req.param("sessionID"),
  })
  if (!session) {
    return c.json({ session: null }, 404)
  }
  return c.json({ session })
})

lectureRoutes.post("/:sessionID/block", async (c) => {
  const auth = await requireLectureAuth(c)
  const body = appendBlockSchema.parse(await c.req.json())
  if (body.role === "lecture") {
    throw new Error("LECTURE_TEXT_RUNTIME_STREAM_ONLY")
  }
  const block = await LectureService.appendBlock({
    userID: auth.userID,
    workroomID: body.workroomID,
    lectureSessionID: c.req.param("sessionID"),
    role: body.role,
    text: body.text,
    highlightSpans: body.highlightSpans,
  })
  return c.json({ block })
})

lectureRoutes.post("/:sessionID/answer", async (c) => {
  const auth = await requireLectureAuth(c)
  const body = appendBlockSchema.parse(await c.req.json())
  return c.json(
    await LectureService.answerQuestion({
      userID: auth.userID,
      workroomID: body.workroomID,
      lectureSessionID: c.req.param("sessionID"),
      text: body.text,
      highlightSpans: body.highlightSpans,
    }),
  )
})

lectureRoutes.post("/:sessionID/visualization", async (c) => {
  const auth = await requireLectureAuth(c)
  const body = visualizationSchema.parse(await c.req.json())
  if (body.patches?.length) {
    return c.json({
      session: await LectureService.patchVisualizationHTML({
        userID: auth.userID,
        workroomID: body.workroomID,
        lectureSessionID: c.req.param("sessionID"),
        patches: body.patches,
      }),
    })
  }
  return c.json({
    session: await LectureService.setVisualizationHTML({
      userID: auth.userID,
      workroomID: body.workroomID,
      lectureSessionID: c.req.param("sessionID"),
      html: body.html ?? null,
    }),
  })
})

lectureRoutes.post("/:sessionID/runtime-question/:requestID/reply", async (c) => {
  const auth = await requireLectureAuth(c)
  const body = runtimeQuestionReplySchema.parse(await c.req.json())
  return c.json(
    await LectureService.replyRuntimeQuestion({
      userID: auth.userID,
      workroomID: body.workroomID,
      lectureSessionID: c.req.param("sessionID"),
      requestID: c.req.param("requestID"),
      answers: body.answers,
      freeText: body.freeText,
    }),
  )
})

lectureRoutes.post("/:sessionID/close", async (c) => {
  const auth = await requireLectureAuth(c)
  const body = closeSchema.parse(await c.req.json())
  return c.json(
    await LectureService.closeSession({
      userID: auth.userID,
      workroomID: body.workroomID,
      lectureSessionID: c.req.param("sessionID"),
    }),
  )
})

lectureRoutes.post("/:sessionID/complete", async (c) => {
  const auth = await requireLectureAuth(c)
  const body = completeSchema.parse(await c.req.json())
  return c.json(
    await LectureService.completeSession({
      userID: auth.userID,
      workroomID: body.workroomID,
      lectureSessionID: c.req.param("sessionID"),
      teachingSummary: body.teachingSummary,
      nextSuggestion: body.nextSuggestion,
    }),
  )
})
