import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { NamedError } from "@opencode-ai/shared/util/error"
import { createLogger, runWithLogContext, type LogContext } from "../lib/logger"
import { requireAuth } from "./auth-context"
import { AgentSkillSettingsService } from "../domains/agent-skill-settings/service"
import { AgentSessionModelSelectionService } from "../domains/agent/session-model-selection"
import {
  buildStudioQuestionCardsCommandGuide,
  buildWorkroomSessionPermission,
  getDisabledSkillNames,
  loadAgentRuntimeModules,
  resolveAgentModel,
  STUDIO_QUESTION_CARDS_BRIDGE_GUIDE_VERSION,
  syncAgentUserSettings,
  withAgentScope,
} from "../domains/agent/service"

const logger = createLogger({ domain: "agent-route" })

class LocalAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T) {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    this.values.push(value)
  }

  end() {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined as T })
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const queued = this.values.shift()
        if (queued !== undefined) {
          return Promise.resolve({ done: false, value: queued })
        }
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined as T })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

const sessionCreateSchema = z.object({
  workroomID: z.string().min(1),
  title: z.string().optional(),
})

const sessionUpdateSchema = z.object({
  workroomID: z.string().min(1),
  title: z.string().optional(),
  archived: z.boolean().optional(),
  selectedModel: z
    .object({
      providerID: z.string().min(1),
      modelID: z.string().min(1),
    })
    .nullable()
    .optional(),
})

const promptSchema = z.object({
  workroomID: z.string().min(1),
  text: z.string().min(1).optional(),
  parts: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("text"),
          text: z.string().min(1),
        }),
        z.object({
          type: z.literal("file"),
          mime: z.string().min(1),
          filename: z.string().optional(),
          url: z.string().min(1),
          source: z
            .object({
              type: z.enum(["file", "symbol", "resource"]),
              text: z
                .object({
                  value: z.string(),
                  start: z.number().int(),
                  end: z.number().int(),
                })
                .optional(),
            })
            .passthrough()
            .optional(),
        }),
      ]),
    )
    .optional(),
  agent: z.string().optional(),
  system: z.string().optional(),
  model: z
    .object({
      providerID: z.string().min(1),
      modelID: z.string().min(1),
    })
    .optional(),
})

const loopSchema = z.object({
  workroomID: z.string().min(1),
})

const sessionAbortSchema = z.object({
  workroomID: z.string().min(1),
})

const permissionReplySchema = z.object({
  workroomID: z.string().min(1),
  reply: z.enum(["once", "always", "reject"]),
  message: z.string().optional(),
})

const questionReplySchema = z.object({
  workroomID: z.string().min(1),
  answers: z.array(z.array(z.string())),
})

const skillUpdateSchema = z.object({
  workroomID: z.string().min(1),
  sessionID: z.string().min(1).optional(),
  disabledSkillNames: z.array(z.string()).default([]),
})

const mcpAddSchema = z.object({
  workroomID: z.string().min(1),
  name: z.string().min(1),
  config: z.unknown(),
})

const mcpActionSchema = z.object({
  workroomID: z.string().min(1),
})

const MCP_ACTION_TIMEOUT_MS = 12000
const MCP_STATUS_TIMEOUT_MS = 1200

async function runMcpActionWithTimeout<T>(action: () => Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    action(),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`MCP action timed out: ${label}`)), MCP_ACTION_TIMEOUT_MS)
    }),
  ])
}

async function runMcpStatusProbe<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await Promise.race([
      action(),
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(fallback), MCP_STATUS_TIMEOUT_MS)
      }),
    ])
  } catch {
    return fallback
  }
}

type AgentStreamEnvelope = {
  type: string
  properties: Record<string, unknown>
}

function toRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

function firstNonEmptyString(values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return null
}

function extractRuntimeErrorMessage(error: unknown): string {
  const root = toRecord(error)
  const data = toRecord(root?.data)
  const cause = toRecord(root?.cause)
  const metadata = toRecord(data?.metadata)
  return (
    firstNonEmptyString([
      root?.message,
      data?.message,
      cause?.message,
      metadata?.message,
      metadata?.error,
      root?.name,
    ]) ?? "Unknown agent runtime error"
  )
}

function shouldUpgradeLegacyWorkroomPermission(permission: unknown) {
  if (!Array.isArray(permission)) return true
  return permission.some((rule) => {
    if (!rule || typeof rule !== "object") return false
    const item = rule as Record<string, unknown>
    return item.permission === "bash" && item.pattern === "*" && item.action === "ask"
  })
}

const runtimeStreamSubscribers = new Map<string, Set<(event: AgentStreamEnvelope) => void>>()
const studioGuideVersionBySessionID = new Map<string, string>()

function subscribeRuntimeStream(sessionID: string, listener: (event: AgentStreamEnvelope) => void) {
  const bucket = runtimeStreamSubscribers.get(sessionID) ?? new Set<(event: AgentStreamEnvelope) => void>()
  bucket.add(listener)
  runtimeStreamSubscribers.set(sessionID, bucket)
  return () => {
    const current = runtimeStreamSubscribers.get(sessionID)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      runtimeStreamSubscribers.delete(sessionID)
    }
  }
}

function publishRuntimeStream(sessionID: string, event: AgentStreamEnvelope) {
  const listeners = runtimeStreamSubscribers.get(sessionID)
  if (!listeners || listeners.size === 0) return
  for (const listener of listeners) {
    listener(event)
  }
}

function toRuntimeStreamEnvelope(event: any): AgentStreamEnvelope | null {
  if (!event || typeof event !== "object" || typeof event.type !== "string") return null

  switch (event.type) {
    case "message_started":
    case "message_updated":
    case "message_completed":
      return {
        type: event.type.replace("_", "."),
        properties: {
          info: event.message?.info ?? {},
          parts: Array.isArray(event.message?.parts) ? event.message.parts : [],
        },
      }
    case "part_added":
      return {
        type: "message.part.added",
        properties: {
          sessionID: event.part?.sessionID,
          messageID: event.messageID,
          part: event.part,
        },
      }
    case "part_updated":
      return {
        type: "message.part.updated",
        properties: {
          sessionID: event.part?.sessionID,
          messageID: event.messageID,
          part: event.part,
        },
      }
    case "part_completed":
      return {
        type: "message.part.completed",
        properties: {
          sessionID: event.part?.sessionID,
          messageID: event.messageID,
          part: event.part,
        },
      }
    case "part_delta":
      return {
        type: "message.part.delta",
        properties: {
          sessionID: event.part?.sessionID,
          messageID: event.messageID,
          partID: event.partID,
          field: event.field,
          delta: event.delta,
        },
      }
    default:
      return null
  }
}

function toAgUiCompatibleEvent(input: Record<string, unknown>, sessionID: string) {
  const type = typeof input.type === "string" ? input.type : ""
  const timestamp = Date.now()
  if (type === "session.idle") {
    return {
      type: "RUN_FINISHED",
      timestamp,
      threadId: sessionID,
      runId: sessionID,
      rawEvent: input,
    }
  }
  if (type === "session.error") {
    const properties =
      input.properties && typeof input.properties === "object" ? (input.properties as Record<string, unknown>) : {}
    const err =
      properties.error && typeof properties.error === "object" ? (properties.error as Record<string, unknown>) : {}
    return {
      type: "RUN_ERROR",
      timestamp,
      message: extractRuntimeErrorMessage(err),
      code: typeof err.name === "string" ? err.name : undefined,
      rawEvent: input,
    }
  }
  if (type === "permission.asked" || type === "question.asked") {
    return {
      type: "CUSTOM",
      timestamp,
      name: type,
      value: input,
      rawEvent: input,
    }
  }
  return {
    type: "RAW",
    timestamp,
    source: "opencode-runtime",
    event: input,
    rawEvent: input,
  }
}

function encodeAgUiEvent(input: Record<string, unknown>, sessionID: string) {
  return JSON.stringify(toAgUiCompatibleEvent(input, sessionID))
}

function deriveMcpAuthStatus(
  supportsOAuth: boolean,
  authEntry: { tokens?: { expiresAt?: number } } | null,
): "authenticated" | "expired" | "not_authenticated" | null {
  if (!supportsOAuth) return null
  if (!authEntry?.tokens) return "not_authenticated"
  if (authEntry.tokens.expiresAt && authEntry.tokens.expiresAt < Date.now() / 1000) return "expired"
  return "authenticated"
}

function buildMcpSettingsResponse(input: {
  globalConfig: { mcp?: Record<string, unknown> }
  authByName: Record<string, { tokens?: { expiresAt?: number } }>
  statusByName?: Record<string, { status: string; error?: string }>
}) {
  const entries = Object.entries(input.globalConfig.mcp ?? {}).filter(
    (entry): entry is [string, { type: "local" | "remote"; enabled?: boolean; oauth?: unknown }] =>
      isMcpConfigEntry(entry[1]),
  )

  const items = entries.map(([name, configEntry]) => {
    const supportsOAuth = configEntry.type === "remote" && configEntry.oauth !== false
    const authEntry = (input.authByName?.[name] ?? null) as { tokens?: { expiresAt?: number } } | null
    const authStatus = deriveMcpAuthStatus(supportsOAuth, authEntry)
    const runtimeStatus = input.statusByName?.[name]
    const status =
      runtimeStatus ??
      (configEntry.enabled === false
        ? ({ status: "disabled" } as const)
        : supportsOAuth && authStatus === "not_authenticated"
          ? ({ status: "needs_auth" } as const)
          : ({ status: "unknown" } as const))

    return {
      name,
      config: configEntry,
      status,
      supportsOAuth,
      authStatus,
    }
  })

  return {
    items: items.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

const mcpAuthCallbackSchema = z.object({
  workroomID: z.string().min(1),
  code: z.string().min(1),
})

const eventQuerySchema = z.object({
  workroom_id: z.string().min(1),
  session_id: z.string().min(1),
})

export const agentRoutes = new Hono()

export function streamJsonResponse(
  handler: (write: (payload: unknown) => Promise<void>) => Promise<void>,
  context: LogContext = {},
) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = async (payload: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
      }

      void runWithLogContext(context, async () => {
        try {
          await handler(write)
        } catch (error) {
          await write({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          controller.close()
        }
      }).catch(() => {
        controller.close()
      })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function eventSessionID(event: Record<string, unknown>) {
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

function isMcpConfigEntry(input: unknown): input is { type: "local" | "remote"; enabled?: boolean } {
  return Boolean(input && typeof input === "object" && "type" in input)
}

async function listMcpItems(input: { userID: string; workroomID: string }, options?: { probeRuntime?: boolean }) {
  const { AppRuntime, Config, McpAuth, MCP } = await loadAgentRuntimeModules()
  const [globalConfig, authByName] = await Promise.all([
    AppRuntime.runPromise(Config.Service.use((config: any) => config.getGlobal())),
    AppRuntime.runPromise(McpAuth.Service.use((auth: any) => auth.all())),
  ])
  let statusByName: Record<string, { status: string; error?: string }> | undefined

  if (options?.probeRuntime) {
    statusByName = await withAgentScope(
      { userID: input.userID, workroomID: input.workroomID, syncUserSettings: false },
      async () =>
        runMcpStatusProbe<Record<string, { status: string; error?: string }>>(
          () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.status())),
          {},
        ),
      {
        bootstrap: false,
      },
    )
  }

  return buildMcpSettingsResponse({
    globalConfig,
    authByName,
    statusByName,
  })
}

async function getGlobalMcpConfig(name: string) {
  const { AppRuntime, Config } = await loadAgentRuntimeModules()
  const globalConfig = await AppRuntime.runPromise(Config.Service.use((config: any) => config.getGlobal()))
  const entry = globalConfig.mcp?.[name]
  if (!isMcpConfigEntry(entry)) return undefined
  return Config.Mcp.parse(entry)
}

async function ensureScopedMcpLoaded(input: { userID: string; workroomID: string; name: string }) {
  const { AppRuntime, MCP } = await loadAgentRuntimeModules()
  const config = await getGlobalMcpConfig(input.name)
  if (!config) return false

  await withAgentScope(
    { userID: input.userID, workroomID: input.workroomID, syncUserSettings: false },
    async () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.add(input.name, config))),
    {
      bootstrap: false,
    },
  )

  return true
}

agentRoutes.get("/session", async (c) => {
  const { user } = await requireAuth(c)
  logger.info("agent session list route enter", {
    user_id: user.id,
    workroom_id: c.req.query("workroom_id"),
  })
  const { Session } = await loadAgentRuntimeModules()
  logger.info("agent session list runtime modules ready", {
    user_id: user.id,
    workroom_id: c.req.query("workroom_id"),
  })
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined

  const items = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async ({ workroom }) => {
    logger.info("agent session list with scope ready", {
      user_id: user.id,
      workroom_id: workroomID,
      directory: workroom.rootDirectory,
    })
    const listFn =
      typeof (Session as any).listGlobal === "function"
        ? (Session as any).listGlobal
        : (Session as any).list
    logger.info("agent session list function selected", {
      user_id: user.id,
      workroom_id: workroomID,
      directory: workroom.rootDirectory,
      function_name: typeof (Session as any).listGlobal === "function" ? "listGlobal" : "list",
    })
    const sessions: any[] = []
    for await (const session of listFn({
      directory: AppFileSystem.resolve(workroom.rootDirectory),
      limit,
    })) {
      sessions.push(session)
    }
    logger.info("agent session list collected", {
      user_id: user.id,
      workroom_id: workroomID,
      count: sessions.length,
    })
    return sessions
  })

  const sessionIDs = items
    .map((item: any) => (typeof item?.id === "string" ? item.id : ""))
    .filter((item) => item.length > 0)
  const selectedModelBySessionID = await AgentSessionModelSelectionService.listBySessions({
    userID: user.id,
    workroomID,
    sessionIDs,
  })
  logger.info("agent session list selected models loaded", {
    user_id: user.id,
    workroom_id: workroomID,
    session_count: sessionIDs.length,
  })

  return c.json(
    items.map((item: any) => ({
      ...item,
      selectedModel: typeof item?.id === "string" ? (selectedModelBySessionID.get(item.id) ?? null) : null,
    })),
  )
})

agentRoutes.post("/session", async (c) => {
  const { user } = await requireAuth(c)
  logger.info("agent session create route enter", {
    user_id: user.id,
  })
  const { AppRuntime, Session } = await loadAgentRuntimeModules()
  logger.info("agent session create runtime modules ready", {
    user_id: user.id,
  })
  const body = sessionCreateSchema.parse(await c.req.json())

  const session = await withAgentScope(
    { userID: user.id, workroomID: body.workroomID, syncUserSettings: false },
    async () => {
      logger.info("agent session create with scope ready", {
        user_id: user.id,
        workroom_id: body.workroomID,
      })
      const created = await AppRuntime.runPromise(
        Session.Service.use((svc: any) =>
          svc.create({
            title: body.title,
            permission: buildWorkroomSessionPermission(),
          }),
        ),
      )
      logger.info("agent session create completed", {
        user_id: user.id,
        workroom_id: body.workroomID,
        session_id: created?.id,
      })
      return created
    },
    { bootstrap: true },
  )

  return c.json(session, 201)
})

agentRoutes.get("/session/:sessionID", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Session, SessionID } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")

  const session = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Session.Service.use((svc: any) => svc.get(SessionID.make(c.req.param("sessionID"))))),
  )

  const selectedModel = await AgentSessionModelSelectionService.get({
    userID: user.id,
    workroomID,
    sessionID: c.req.param("sessionID"),
  })

  return c.json({
    ...session,
    selectedModel,
  })
})

agentRoutes.patch("/session/:sessionID", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Session, SessionID } = await loadAgentRuntimeModules()
  const body = sessionUpdateSchema.parse(await c.req.json())
  const sessionID = SessionID.make(c.req.param("sessionID"))

  const session = await withAgentScope({ userID: user.id, workroomID: body.workroomID }, async () =>
    (async () => {
      if (body.title !== undefined) {
        await AppRuntime.runPromise(Session.Service.use((svc: any) => svc.setTitle({ sessionID, title: body.title })))
      }
      if (body.archived !== undefined) {
        await AppRuntime.runPromise(
          Session.Service.use((svc: any) =>
            svc.setArchived({ sessionID, time: body.archived ? Date.now() : undefined }),
          ),
        )
      }
      if (body.selectedModel !== undefined) {
        await AgentSessionModelSelectionService.put({
          userID: user.id,
          workroomID: body.workroomID,
          sessionID: c.req.param("sessionID"),
          selectedModel: body.selectedModel,
        })
      }
      return AppRuntime.runPromise(Session.Service.use((svc: any) => svc.get(sessionID)))
    })(),
  )

  const selectedModel = await AgentSessionModelSelectionService.get({
    userID: user.id,
    workroomID: body.workroomID,
    sessionID: c.req.param("sessionID"),
  })

  return c.json({
    ...session,
    selectedModel,
  })
})

agentRoutes.delete("/session/:sessionID", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Session, SessionID } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")
  const sessionID = SessionID.make(c.req.param("sessionID"))

  await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Session.Service.use((svc: any) => svc.remove(sessionID))),
  )
  await AgentSessionModelSelectionService.remove({
    userID: user.id,
    workroomID,
    sessionID: c.req.param("sessionID"),
  })
  studioGuideVersionBySessionID.delete(c.req.param("sessionID"))

  return c.json(true)
})

agentRoutes.get("/session/:sessionID/message", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Session, SessionID } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined
  const sessionID = SessionID.make(c.req.param("sessionID"))

  const messages = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Session.Service.use((svc: any) => svc.messages({ sessionID, limit }))),
  )

  return c.json(messages)
})

agentRoutes.post("/session/:sessionID/prompt_async", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Bus, Session, SessionID, SessionPrompt } = await loadAgentRuntimeModules()
  const body = promptSchema.parse(await c.req.json())
  const parts =
    Array.isArray(body.parts) && body.parts.length > 0
      ? body.parts
      : body.text
        ? [{ type: "text" as const, text: body.text }]
        : []
  if (parts.length === 0) {
    throw new Error("Missing prompt parts")
  }
  const model = await resolveAgentModel({ userID: user.id, model: body.model })
  const sessionID = SessionID.make(c.req.param("sessionID"))
  logger.info("agent prompt start", {
    user_id: user.id,
    workroom_id: body.workroomID,
    session_id: sessionID,
    prompt_length: body.text?.length ?? 0,
    prompt_parts_count: parts.length,
    model_provider_id: model?.providerID,
    model_id: model?.modelID,
  })

  void withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () => {
    const sessionInfo = await AppRuntime.runPromise(Session.Service.use((svc: any) => svc.get(sessionID)))
    const sessionIDText = String(sessionID)
    const existingGuideVersion = studioGuideVersionBySessionID.get(sessionIDText)
    const shouldInjectStudioGuide = existingGuideVersion !== STUDIO_QUESTION_CARDS_BRIDGE_GUIDE_VERSION
    const effectiveSystem = [
      body.system?.trim() ? body.system.trim() : "",
      shouldInjectStudioGuide
        ? buildStudioQuestionCardsCommandGuide({
            userID: user.id,
            workroomID: body.workroomID,
            workroomRootDirectory: sessionInfo?.directory ?? "",
          })
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
    if (shouldInjectStudioGuide) {
      studioGuideVersionBySessionID.set(sessionIDText, STUDIO_QUESTION_CARDS_BRIDGE_GUIDE_VERSION)
    }
    logger.info("agent prompt runtime session loaded", {
      user_id: user.id,
      workroom_id: body.workroomID,
      session_id: sessionID,
      session_title: sessionInfo?.title,
      session_project_id: sessionInfo?.projectID,
      session_directory: sessionInfo?.directory,
    })
    if (shouldUpgradeLegacyWorkroomPermission(sessionInfo?.permission)) {
      await AppRuntime.runPromise(
        Session.Service.use((svc: any) =>
          svc.setPermission({
            sessionID,
            permission: buildWorkroomSessionPermission(),
          }),
        ),
      )
    }
    await syncAgentUserSettings(user.id)
    logger.info("agent prompt runtime invoke start", {
      user_id: user.id,
      workroom_id: body.workroomID,
      session_id: sessionID,
    })
    await AppRuntime.runPromise(
      SessionPrompt.Service.use((svc: any) =>
        svc.prompt({
          sessionID,
          agent: body.agent,
          model: model ?? undefined,
          system: effectiveSystem,
          parts,
          stream: {
            onEvent(event: any) {
              const payload = toRuntimeStreamEnvelope(event)
              if (payload) {
                publishRuntimeStream(String(sessionID), payload)
              }
            },
          },
        }),
      ),
    )
    logger.info("agent prompt runtime invoke completed", {
      user_id: user.id,
      workroom_id: body.workroomID,
      session_id: sessionID,
    })
  }).catch(async (err) => {
    const runtimeErrorMessage = extractRuntimeErrorMessage(err)
    logger.error("agent prompt failed", {
      user_id: user.id,
      workroom_id: body.workroomID,
      session_id: sessionID,
      error: runtimeErrorMessage,
      stack: err instanceof Error ? err.stack : undefined,
      raw_error: err,
    })
    await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () =>
      AppRuntime.runPromise(
        Bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({ message: runtimeErrorMessage }).toObject(),
        }),
      ),
    ).catch(() => {})
  })

  return c.body(null, 204)
})

agentRoutes.post("/session/:sessionID/loop", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Session, SessionID, SessionPrompt } = await loadAgentRuntimeModules()
  const body = loopSchema.parse(await c.req.json())
  const sessionID = SessionID.make(c.req.param("sessionID"))

  logger.info("agent loop start", {
    user_id: user.id,
    workroom_id: body.workroomID,
    session_id: sessionID,
  })

  await withAgentScope({ userID: user.id, workroomID: body.workroomID }, async () => {
    const sessionInfo = await AppRuntime.runPromise(Session.Service.use((svc: any) => svc.get(sessionID)))
    if (shouldUpgradeLegacyWorkroomPermission(sessionInfo?.permission)) {
      await AppRuntime.runPromise(
        Session.Service.use((svc: any) =>
          svc.setPermission({
            sessionID,
            permission: buildWorkroomSessionPermission(),
          }),
        ),
      )
    }
    await AppRuntime.runPromise(
      SessionPrompt.Service.use((svc: any) =>
        svc.loop({
          sessionID,
          stream: {
            onEvent(event: any) {
              const payload = toRuntimeStreamEnvelope(event)
              if (payload) {
                publishRuntimeStream(String(sessionID), payload)
              }
            },
          },
        }),
      ),
    )
  })

  logger.info("agent loop completed", {
    user_id: user.id,
    workroom_id: body.workroomID,
    session_id: sessionID,
  })

  return c.body(null, 204)
})

agentRoutes.post("/session/:sessionID/cancel", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, SessionID, SessionPrompt } = await loadAgentRuntimeModules()
  const body = sessionAbortSchema.parse(await c.req.json())
  const sessionID = SessionID.make(c.req.param("sessionID"))

  logger.info("agent cancel start", {
    user_id: user.id,
    workroom_id: body.workroomID,
    session_id: sessionID,
  })

  await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(SessionPrompt.Service.use((svc: any) => svc.cancel(sessionID))),
  )

  logger.info("agent cancel completed", {
    user_id: user.id,
    workroom_id: body.workroomID,
    session_id: sessionID,
  })

  return c.json(true)
})

agentRoutes.get("/event", async (c) => {
  const { user } = await requireAuth(c)
  const { Bus } = await loadAgentRuntimeModules()
  const query = eventQuerySchema.parse({
    workroom_id: c.req.query("workroom_id"),
    session_id: c.req.query("session_id"),
  })

  return withAgentScope({ userID: user.id, workroomID: query.workroom_id, syncUserSettings: false }, async () => {
    c.header("Cache-Control", "no-cache, no-transform")
    c.header("X-Accel-Buffering", "no")
    c.header("X-Content-Type-Options", "nosniff")

    return streamSSE(c, async (stream) => {
      const queue = new LocalAsyncQueue<string | null>()
      let closed = false

      const stop = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe?.()
        queue.end()
      }

      queue.push(
        encodeAgUiEvent(
          {
          type: "server.connected",
          properties: {},
          },
          query.session_id,
        ),
      )

      const heartbeat = setInterval(() => {
        queue.push(
          encodeAgUiEvent(
            {
            type: "server.heartbeat",
            properties: {},
            },
            query.session_id,
          ),
        )
      }, 3_000)

      const unsubscribe = Bus.subscribeAll((event: any) => {
        if (closed) return
        if (eventSessionID(event as Record<string, unknown>) !== query.session_id) return
        if (!event || typeof event !== "object") return
        queue.push(encodeAgUiEvent(event as Record<string, unknown>, query.session_id))
      })
      const unsubscribeRuntime = subscribeRuntimeStream(query.session_id, (event) => {
        if (closed) return
        queue.push(encodeAgUiEvent(event, query.session_id))
      })

      stream.onAbort(stop)

      try {
        for await (const data of queue) {
          if (data === null) return
          await stream.writeSSE({ data })
        }
      } finally {
        unsubscribeRuntime()
        stop()
      }
    })
  })
})

agentRoutes.get("/permission", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Permission } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")

  const permissions = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Permission.Service.use((svc: any) => svc.list())),
  )

  return c.json(permissions)
})

agentRoutes.post("/permission/:requestID/reply", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Permission, PermissionID } = await loadAgentRuntimeModules()
  const body = permissionReplySchema.parse(await c.req.json())

  logger.info("agent permission reply start", {
    user_id: user.id,
    workroom_id: body.workroomID,
    request_id: c.req.param("requestID"),
    reply: body.reply,
  })

  await withAgentScope({ userID: user.id, workroomID: body.workroomID }, async () =>
    AppRuntime.runPromise(
      Permission.Service.use((svc: any) =>
        svc.reply({
          requestID: PermissionID.make(c.req.param("requestID")),
          reply: body.reply,
          message: body.message,
        }),
      ),
    ),
  )

  logger.info("agent permission reply completed", {
    user_id: user.id,
    workroom_id: body.workroomID,
    request_id: c.req.param("requestID"),
    reply: body.reply,
  })

  return c.json(true)
})

agentRoutes.get("/question", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Question } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")

  const questions = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Question.Service.use((svc: any) => svc.list())),
  )

  return c.json(questions)
})

agentRoutes.post("/question/:requestID/reply", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Question, QuestionID } = await loadAgentRuntimeModules()
  const body = questionReplySchema.parse(await c.req.json())

  await withAgentScope({ userID: user.id, workroomID: body.workroomID }, async () =>
    AppRuntime.runPromise(
      Question.Service.use((svc: any) =>
        svc.reply({
          requestID: QuestionID.make(c.req.param("requestID")),
          answers: body.answers,
        }),
      ),
    ),
  )

  return c.json(true)
})

agentRoutes.post("/question/:requestID/reject", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Question, QuestionID } = await loadAgentRuntimeModules()
  const body = z.object({ workroomID: z.string().min(1) }).parse(await c.req.json())

  await withAgentScope({ userID: user.id, workroomID: body.workroomID }, async () =>
    AppRuntime.runPromise(Question.Service.use((svc: any) => svc.reject(QuestionID.make(c.req.param("requestID"))))),
  )

  return c.json(true)
})

agentRoutes.get("/agent", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Agent } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")

  const agents = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Agent.Service.use((svc: any) => svc.list())),
  )

  return c.json(agents)
})

agentRoutes.get("/skill", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Skill } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")
  const disabledSkillNames = new Set(await getDisabledSkillNames(user.id))

  const skills = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Skill.Service.use((skill: any) => skill.all())),
  )

  return c.json({
    items: skills
      .slice()
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
      .map((item: { name: string; description: string; location: string }) => ({
        ...item,
        enabled: !disabledSkillNames.has(item.name),
      })),
  })
})

agentRoutes.put("/skill", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Skill } = await loadAgentRuntimeModules()
  const body = skillUpdateSchema.parse(await c.req.json())

  const saved = await getDisabledSkillNames(user.id)
  const nextDisabledSkillNames = [...new Set(body.disabledSkillNames.map((item) => item.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
  if (JSON.stringify(saved) !== JSON.stringify(nextDisabledSkillNames)) {
    await AgentSkillSettingsService.put({
      userID: user.id,
      disabledSkillNames: nextDisabledSkillNames,
    })
  }

  const disabledSkillNames = new Set(nextDisabledSkillNames)

  const response = await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () => {
    const skills = await AppRuntime.runPromise(Skill.Service.use((skill: any) => skill.all()))
    return {
      items: skills
        .slice()
        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
        .map((item: { name: string; description: string; location: string }) => ({
          ...item,
          enabled: !disabledSkillNames.has(item.name),
        })),
    }
  })

  return c.json(response)
})

agentRoutes.get("/mcp", async (c) => {
  const { user } = await requireAuth(c)
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")

  return c.json(await listMcpItems({ userID: user.id, workroomID }, { probeRuntime: true }))
})

agentRoutes.post("/mcp", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Config, MCP } = await loadAgentRuntimeModules()
  const body = mcpAddSchema.parse(await c.req.json())
  const parsedConfig = Config.Mcp.parse(body.config)
  await AppRuntime.runPromise(
    Config.Service.use((config: any) =>
      config.updateGlobal({
        mcp: {
          ...(config.current?.global?.mcp ?? {}),
          [body.name]: parsedConfig,
        },
      }),
    ),
  )

  await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () => {
    try {
      await runMcpActionWithTimeout(
        () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.disconnect(body.name))),
        `disconnect-before-save:${body.name}`,
      )
    } catch {}
    await runMcpActionWithTimeout(
      () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.add(body.name, parsedConfig))),
      `add-after-save:${body.name}`,
    )
    if (parsedConfig.enabled !== false) {
      await runMcpActionWithTimeout(
        () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.connect(body.name))),
        `connect-after-save:${body.name}`,
      )
    }
  }, {
    bootstrap: false,
  })

  return c.json(await listMcpItems({ userID: user.id, workroomID: body.workroomID }, { probeRuntime: true }))
})

agentRoutes.post("/mcp/:name/connect", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, MCP } = await loadAgentRuntimeModules()
  const body = mcpActionSchema.parse(await c.req.json())
  const name = c.req.param("name")

  const loaded = await ensureScopedMcpLoaded({ userID: user.id, workroomID: body.workroomID, name })
  if (!loaded) {
    return c.json({ error: `MCP server ${name} not found in global config` }, 404)
  }
  await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () => {
    try {
      await runMcpActionWithTimeout(
        () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.disconnect(name))),
        `disconnect-before-connect:${name}`,
      )
    } catch {}
    await runMcpActionWithTimeout(
      () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.connect(name))),
      `connect:${name}`,
    )
  }, {
    bootstrap: false,
  })

  return c.json(await listMcpItems({ userID: user.id, workroomID: body.workroomID }, { probeRuntime: true }))
})

agentRoutes.post("/mcp/:name/disconnect", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, MCP } = await loadAgentRuntimeModules()
  const body = mcpActionSchema.parse(await c.req.json())
  const name = c.req.param("name")

  await withAgentScope(
    { userID: user.id, workroomID: body.workroomID, syncUserSettings: false },
    async () =>
      runMcpActionWithTimeout(
        () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.disconnect(name))),
        `disconnect:${name}`,
      ),
    {
      bootstrap: false,
    },
  )

  return c.json(await listMcpItems({ userID: user.id, workroomID: body.workroomID }, { probeRuntime: true }))
})

agentRoutes.post("/mcp/:name/auth", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, MCP } = await loadAgentRuntimeModules()
  const body = mcpActionSchema.parse(await c.req.json())
  const name = c.req.param("name")

  const loaded = await ensureScopedMcpLoaded({ userID: user.id, workroomID: body.workroomID, name })
  if (!loaded) {
    return c.json({ error: `MCP server ${name} not found in global config` }, 404)
  }

  const result = await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () =>
    (async () => {
      const supports = await AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.supportsOAuth(name)))
      if (!supports) return { supports }
      const auth = await AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.startAuth(name)))
      return { supports, auth }
    })(),
  )

  if (!result.supports) {
    return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
  }

  return c.json(result.auth)
})

agentRoutes.post("/mcp/:name/auth/callback", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, MCP } = await loadAgentRuntimeModules()
  const body = mcpAuthCallbackSchema.parse(await c.req.json())
  const name = c.req.param("name")

  await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.finishAuth(name, body.code))),
  )

  return c.json(await listMcpItems({ userID: user.id, workroomID: body.workroomID }, { probeRuntime: true }))
})

agentRoutes.post("/mcp/:name/auth/authenticate", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, MCP } = await loadAgentRuntimeModules()
  const body = mcpActionSchema.parse(await c.req.json())
  const name = c.req.param("name")

  const loaded = await ensureScopedMcpLoaded({ userID: user.id, workroomID: body.workroomID, name })
  if (!loaded) {
    return c.json({ error: `MCP server ${name} not found in global config` }, 404)
  }

  const result = await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () =>
    (async () => {
      const supports = await AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.supportsOAuth(name)))
      if (!supports) return { supports }
      await runMcpActionWithTimeout(
        () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.authenticate(name))),
        `authenticate:${name}`,
      )
      return { supports }
    })(),
  )

  if (!result.supports) {
    return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
  }

  return c.json(await listMcpItems({ userID: user.id, workroomID: body.workroomID }, { probeRuntime: true }))
})

agentRoutes.delete("/mcp/:name/auth", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, MCP } = await loadAgentRuntimeModules()
  const body = mcpActionSchema.parse(await c.req.json())
  const name = c.req.param("name")

  const loaded = await ensureScopedMcpLoaded({ userID: user.id, workroomID: body.workroomID, name })
  if (!loaded) {
    return c.json({ error: `MCP server ${name} not found in global config` }, 404)
  }

  await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () =>
    runMcpActionWithTimeout(
      () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.removeAuth(name))),
      `remove-auth:${name}`,
    ),
  )

  return c.json(await listMcpItems({ userID: user.id, workroomID: body.workroomID }, { probeRuntime: true }))
})

agentRoutes.delete("/mcp/:name", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Config, MCP } = await loadAgentRuntimeModules()
  const body = mcpActionSchema.parse(await c.req.json())
  const name = c.req.param("name")
  await AppRuntime.runPromise(
    Config.Service.use((config: any) => {
      const nextMcp = { ...(config.current?.global?.mcp ?? {}) } as Record<string, unknown>
      delete nextMcp[name]
      return config.updateGlobal({ mcp: nextMcp })
    }),
  )

  await withAgentScope({ userID: user.id, workroomID: body.workroomID, syncUserSettings: false }, async () => {
    try {
      await runMcpActionWithTimeout(
        () => AppRuntime.runPromise(MCP.Service.use((mcp: any) => mcp.disconnect(name))),
        `disconnect-before-delete:${name}`,
      )
    } catch {
      // no-op: remove from config is authoritative
    }
  })

  return c.json(await listMcpItems({ userID: user.id, workroomID: body.workroomID }, { probeRuntime: true }))
})

agentRoutes.get("/provider", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Provider } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")

  const providers = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Provider.Service.use((svc: any) => svc.list())),
  )

  return c.json(providers)
})

agentRoutes.get("/default-model", async (c) => {
  const { user } = await requireAuth(c)
  const { AppRuntime, Provider } = await loadAgentRuntimeModules()
  const workroomID = c.req.query("workroom_id")
  if (!workroomID) throw new Error("Missing workroom_id")

  const model = await withAgentScope({ userID: user.id, workroomID, syncUserSettings: false }, async () =>
    AppRuntime.runPromise(Provider.Service.use((svc: any) => svc.defaultModel())),
  )

  return c.json(model)
})
