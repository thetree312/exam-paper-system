type RawAgentSession = {
  id?: unknown
  slug?: unknown
  title?: unknown
  projectID?: unknown
  workspaceID?: unknown
  directory?: unknown
  parentID?: unknown
  version?: unknown
  summary?: unknown
  share?: unknown
  revert?: unknown
  permission?: unknown
  time?: {
    created?: unknown
    updated?: unknown
    compacting?: unknown
    archived?: unknown
  }
}

type RawAgentPart = {
  id?: unknown
  sessionID?: unknown
  messageID?: unknown
  type?: unknown
  [key: string]: unknown
}

type RawAgentMessage = {
  info?: {
    id?: unknown
    sessionID?: unknown
    role?: unknown
    time?: Record<string, unknown>
    [key: string]: unknown
  }
  parts?: RawAgentPart[]
}

export type AgentSessionFactDto = {
  id: string
  slug?: string
  title?: string | null
  project_id?: string | null
  workspace_id?: string | null
  directory?: string | null
  parent_id?: string | null
  version?: string | null
  summary?: Record<string, unknown> | null
  share?: Record<string, unknown> | null
  revert?: Record<string, unknown> | null
  permission?: Array<Record<string, unknown>> | null
  time: {
    created?: number
    updated?: number
    compacting?: number
    archived?: number
  }
}

export type AgentMessageInfoFactDto = {
  id: string
  session_id: string
  role: "user" | "assistant"
  time: Record<string, unknown>
  parent_id?: string | null
  provider_id?: string | null
  model_id?: string | null
  agent?: string | null
  path?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
  summary?: boolean | Record<string, unknown> | null
  cost?: number | null
  tokens?: Record<string, unknown> | null
  structured?: unknown
  variant?: string | null
  finish?: string | null
}

type AgentPartFactBaseDto = {
  id: string
  session_id: string
  message_id: string
  type: string
}

export type AgentTextPartFactDto = AgentPartFactBaseDto & {
  type: "text"
  text: string
  phase?: "commentary" | "final_answer"
  synthetic?: boolean
  ignored?: boolean
  time?: Record<string, unknown>
  metadata?: Record<string, unknown> | null
}

export type AgentCommentaryPartFactDto = AgentPartFactBaseDto & {
  type: "commentary"
  text: string
  phase?: "commentary"
  synthetic?: boolean
  ignored?: boolean
  time?: Record<string, unknown>
  metadata?: Record<string, unknown> | null
}

export type AgentFinalAnswerPartFactDto = AgentPartFactBaseDto & {
  type: "final_answer"
  text: string
  phase?: "final_answer"
  synthetic?: boolean
  ignored?: boolean
  time?: Record<string, unknown>
  metadata?: Record<string, unknown> | null
}

export type AgentReasoningPartFactDto = AgentPartFactBaseDto & {
  type: "reasoning"
  text: string
  time?: Record<string, unknown>
  metadata?: Record<string, unknown> | null
}

export type AgentToolStateFactDto =
  | {
      status: "pending"
      input: Record<string, unknown>
      raw?: string
    }
  | {
      status: "running"
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown> | null
      time?: Record<string, unknown>
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title?: string
      metadata?: Record<string, unknown> | null
      time?: Record<string, unknown>
      attachments?: AgentFilePartFactDto[]
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown> | null
      time?: Record<string, unknown>
    }

export type AgentToolPartFactDto = AgentPartFactBaseDto & {
  type: "tool"
  call_id: string
  tool: string
  state: AgentToolStateFactDto
  metadata?: Record<string, unknown> | null
}

export type AgentFilePartFactDto = AgentPartFactBaseDto & {
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: Record<string, unknown> | null
}

export type AgentSimplePartFactDto = AgentPartFactBaseDto & Record<string, unknown>

export type AgentMessagePartFactDto =
  | AgentTextPartFactDto
  | AgentCommentaryPartFactDto
  | AgentFinalAnswerPartFactDto
  | AgentReasoningPartFactDto
  | AgentToolPartFactDto
  | AgentFilePartFactDto
  | AgentSimplePartFactDto

export type AgentMessageFactDto = {
  info: AgentMessageInfoFactDto
  parts: AgentMessagePartFactDto[]
}

export type AgentPermissionAskedFactDto = {
  id: string
  session_id: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: {
    message_id?: string | null
    call_id?: string | null
  } | null
}

export type AgentQuestionAskedFactDto = {
  id: string
  session_id: string
  questions: Array<{
    question: string
    header: string
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean
    custom?: boolean
  }>
  tool?: {
    message_id?: string | null
    call_id?: string | null
  } | null
}

export type AgentSessionListItemDto = {
  id: string
  document_id?: string | number | null
  view_id?: string | null
  title?: string | null
  last_message_preview?: string | null
  message_count: number
  status?: string
  archived?: boolean
  created_at?: string
  updated_at?: string
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
}

function asString(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input : null
}

function asNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function asStringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.map((item) => String(item)).filter(Boolean) : []
}

function toIsoString(input: unknown): string | undefined {
  const value = asNumber(input)
  if (value == null) return undefined
  return new Date(value).toISOString()
}

function normalizeRole(input: unknown): AgentMessageInfoFactDto["role"] {
  return input === "user" ? "user" : "assistant"
}

function mapSessionTime(input: RawAgentSession["time"]): AgentSessionFactDto["time"] {
  return {
    created: asNumber(input?.created),
    updated: asNumber(input?.updated),
    compacting: asNumber(input?.compacting),
    archived: asNumber(input?.archived),
  }
}

export function mapAgentSessionFact(input: unknown): AgentSessionFactDto {
  const session = (input ?? {}) as RawAgentSession
  return {
    id: asString(session.id) ?? "",
    slug: asString(session.slug) ?? undefined,
    title: asString(session.title),
    project_id: asString(session.projectID),
    workspace_id: asString(session.workspaceID),
    directory: asString(session.directory),
    parent_id: asString(session.parentID),
    version: asString(session.version),
    summary: asRecord(session.summary),
    share: asRecord(session.share),
    revert: asRecord(session.revert),
    permission: Array.isArray(session.permission)
      ? session.permission.map((item) => asRecord(item) ?? {}).filter((item) => Object.keys(item).length > 0)
      : null,
    time: mapSessionTime(session.time),
  }
}

function mapMessageInfo(input: RawAgentMessage["info"]): AgentMessageInfoFactDto {
  const info = (input ?? {}) as NonNullable<RawAgentMessage["info"]>
  return {
    id: asString(info.id) ?? "",
    session_id: asString(info.sessionID) ?? "",
    role: normalizeRole(info.role),
    time: asRecord(info.time) ?? {},
    parent_id: asString(info.parentID),
    provider_id: asString(info.providerID),
    model_id: asString(info.modelID),
    agent: asString(info.agent),
    path: asRecord(info.path),
    error: asRecord(info.error),
    summary:
      typeof info.summary === "boolean"
        ? info.summary
        : asRecord(info.summary),
    cost: typeof info.cost === "number" ? info.cost : null,
    tokens: asRecord(info.tokens),
    structured: info.structured,
    variant: asString(info.variant),
    finish: asString(info.finish),
  }
}

function mapFilePartAttachment(input: unknown): AgentFilePartFactDto | null {
  const part = (input ?? {}) as RawAgentPart
  if (part.type !== "file") return null
  return {
    id: asString(part.id) ?? "",
    session_id: asString(part.sessionID) ?? "",
    message_id: asString(part.messageID) ?? "",
    type: "file",
    mime: asString(part.mime) ?? "application/octet-stream",
    filename: asString(part.filename) ?? undefined,
    url: asString(part.url) ?? "",
    source: asRecord(part.source),
  }
}

export function mapAgentPartFact(input: unknown): AgentMessagePartFactDto {
  const part = (input ?? {}) as RawAgentPart
  const base: AgentPartFactBaseDto = {
    id: asString(part.id) ?? "",
    session_id: asString(part.sessionID) ?? "",
    message_id: asString(part.messageID) ?? "",
    type: asString(part.type) ?? "unknown",
  }

  if (part.type === "text") {
    const phase = part.phase === "final_answer" ? "final_answer" : part.phase === "commentary" ? "commentary" : "text"
    return {
      ...base,
      type: phase,
      text: typeof part.text === "string" ? part.text : "",
      phase: phase === "text" ? undefined : phase,
      synthetic: part.synthetic === true ? true : undefined,
      ignored: part.ignored === true ? true : undefined,
      time: asRecord(part.time) ?? undefined,
      metadata: asRecord(part.metadata),
    }
  }

  if (part.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: typeof part.text === "string" ? part.text : "",
      time: asRecord(part.time) ?? undefined,
      metadata: asRecord(part.metadata),
    }
  }

  if (part.type === "file") {
    return {
      ...base,
      type: "file",
      mime: asString(part.mime) ?? "application/octet-stream",
      filename: asString(part.filename) ?? undefined,
      url: asString(part.url) ?? "",
      source: asRecord(part.source),
    }
  }

  if (part.type === "tool") {
    const rawState = asRecord(part.state) ?? {}
    const rawStatus = asString(rawState.status) ?? "pending"
    let state: AgentToolStateFactDto

    if (rawStatus === "running") {
      state = {
        status: "running",
        input: asRecord(rawState.input) ?? {},
        title: asString(rawState.title) ?? undefined,
        metadata: asRecord(rawState.metadata),
        time: asRecord(rawState.time) ?? undefined,
      }
    } else if (rawStatus === "completed") {
      state = {
        status: "completed",
        input: asRecord(rawState.input) ?? {},
        output: typeof rawState.output === "string" ? rawState.output : "",
        title: asString(rawState.title) ?? undefined,
        metadata: asRecord(rawState.metadata),
        time: asRecord(rawState.time) ?? undefined,
        attachments: Array.isArray(rawState.attachments)
          ? rawState.attachments
              .map(mapFilePartAttachment)
              .filter((item): item is AgentFilePartFactDto => Boolean(item))
          : undefined,
      }
    } else if (rawStatus === "error") {
      state = {
        status: "error",
        input: asRecord(rawState.input) ?? {},
        error: typeof rawState.error === "string" ? rawState.error : "",
        metadata: asRecord(rawState.metadata),
        time: asRecord(rawState.time) ?? undefined,
      }
    } else {
      state = {
        status: "pending",
        input: asRecord(rawState.input) ?? {},
        raw: typeof rawState.raw === "string" ? rawState.raw : undefined,
      }
    }

    return {
      ...base,
      type: "tool",
      call_id: asString(part.callID) ?? "",
      tool: asString(part.tool) ?? "tool",
      state,
      metadata: asRecord(part.metadata),
    }
  }

  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(part)) {
    if (["id", "sessionID", "messageID", "type"].includes(key)) continue
    extra[key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`)] = value
  }

  return {
    ...base,
    ...extra,
  }
}

export function mapAgentMessageFact(input: unknown): AgentMessageFactDto {
  const message = (input ?? {}) as RawAgentMessage
  return {
    info: mapMessageInfo(message.info),
    parts: Array.isArray(message.parts) ? message.parts.map(mapAgentPartFact) : [],
  }
}

export function mapAgentMessageFacts(messages: unknown[]): AgentMessageFactDto[] {
  return messages.map(mapAgentMessageFact)
}

export type AgentHistoryMessageDto = {
  id: string
  role: "user" | "assistant"
  content: string
  created_at?: string
  citations: unknown[]
  citation_status: unknown
  used_rag_evidence: boolean
}

export function mapAgentHistoryMessages(messages: unknown[]): AgentHistoryMessageDto[] {
  return messages.map((message) => {
    const normalized = mapAgentMessageFact(message)
    const content = normalized.parts
      .filter((part) => part.type === "text" || part.type === "commentary" || part.type === "final_answer")
      .map((part) => (typeof (part as { text?: unknown }).text === "string" ? String((part as { text: string }).text) : ""))
      .join("")
      .trim()

    return {
      id: normalized.info.id,
      role: normalized.info.role,
      content,
      created_at: toIsoString((normalized.info.time as Record<string, unknown>)?.created),
      citations: [],
      citation_status: null,
      used_rag_evidence: false,
    }
  })
}

function extractMessagePreview(message: RawAgentMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : []
    return parts
      .filter(
        (part) =>
          (part?.type === "text" || part?.type === "commentary" || part?.type === "final_answer") &&
          typeof part.text === "string",
      )
      .map((part) => String(part.text))
      .join("")
    .replace(/\s+/g, " ")
    .trim()
}

export function mapAgentPermissionAskedFact(input: unknown): AgentPermissionAskedFactDto {
  const request = asRecord(input) ?? {}
  const tool = asRecord(request.tool)
  return {
    id: asString(request.id) ?? "",
    session_id: asString(request.sessionID) ?? "",
    permission: asString(request.permission) ?? "",
    patterns: asStringArray(request.patterns),
    metadata: asRecord(request.metadata) ?? {},
    always: asStringArray(request.always),
    tool: tool
      ? {
          message_id: asString(tool.messageID),
          call_id: asString(tool.callID),
        }
      : null,
  }
}

export function mapAgentQuestionAskedFact(input: unknown): AgentQuestionAskedFactDto {
  const request = asRecord(input) ?? {}
  const tool = asRecord(request.tool)
  const questions = Array.isArray(request.questions) ? request.questions : []
  return {
    id: asString(request.id) ?? "",
    session_id: asString(request.sessionID) ?? "",
    questions: questions.map((item) => {
      const question = asRecord(item) ?? {}
      const options = Array.isArray(question.options) ? question.options : []
      return {
        question: asString(question.question) ?? "",
        header: asString(question.header) ?? "",
        options: options.map((option) => {
          const normalized = asRecord(option) ?? {}
          return {
            label: asString(normalized.label) ?? "",
            description: asString(normalized.description) ?? "",
          }
        }),
        multiple: question.multiple === true ? true : undefined,
        custom: question.custom === true ? true : undefined,
      }
    }),
    tool: tool
      ? {
          message_id: asString(tool.messageID),
          call_id: asString(tool.callID),
        }
      : null,
  }
}

export function mapAgentSessionListItems(input: {
  sessions: unknown[]
  messagesBySessionID?: Record<string, unknown[]>
}): AgentSessionListItemDto[] {
  return input.sessions.map((item, index) => {
    const session = item as RawAgentSession
    const id = asString(session.id) ?? `session-${index}`
    const history = input.messagesBySessionID?.[id] ?? []
    const normalizedHistory = history.map((entry) => {
      const maybeFlat = asRecord(entry)
      if (maybeFlat && typeof maybeFlat.role === "string" && typeof maybeFlat.content === "string") {
        return {
          id: asString(maybeFlat.id) ?? "",
          role: maybeFlat.role === "user" ? "user" : "assistant",
          content: String(maybeFlat.content),
          createdAt: asString(maybeFlat.created_at) ?? undefined,
        }
      }
      const mapped = mapAgentMessageFact(entry)
      return {
        id: mapped.info.id,
        role: mapped.info.role,
        content: extractMessagePreview({
          info: {
            id: mapped.info.id,
            role: mapped.info.role,
            time: mapped.info.time,
          },
          parts: mapped.parts.map((part) => {
            if (part.type === "text" || part.type === "commentary" || part.type === "final_answer") {
              return {
                id: part.id,
                sessionID: part.session_id,
                messageID: part.message_id,
                type: part.type,
                text: part.text,
              }
            }
            return {
              id: part.id,
              sessionID: part.session_id,
              messageID: part.message_id,
              type: part.type,
            }
          }),
        }),
        createdAt: toIsoString((mapped.info.time as Record<string, unknown>)?.created),
      }
    })

    const previewSource = [...normalizedHistory]
      .reverse()
      .find((message) => message.role === "assistant" || message.role === "user")
    const preview = previewSource?.content ?? null

    return {
      id,
      title: asString(session.title),
      last_message_preview: preview?.slice(0, 120) ?? null,
      message_count: normalizedHistory.length,
      status: session.time?.archived ? "archived" : "active",
      archived: Boolean(session.time?.archived),
      created_at: toIsoString(session.time?.created),
      updated_at: toIsoString(session.time?.updated),
    }
  })
}
