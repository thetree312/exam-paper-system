import type {
  AgentMessageFact,
  AgentMessagePartFact,
  AgentPermissionAskedFact,
  AgentQuestionAskedFact,
  AgentMcpConfigDto,
  AgentMcpSettingsDto,
  AgentRunRequest,
  AgentRunResponse,
  AgentSkillSettingsDto,
  AgentSessionFact,
  AgentSessionListItem,
  AgentSessionMessagesResponseDto,
  AgentSnapshotResponse,
  GradeRunRequest,
  GradeRunResponse,
  QuestionSyncPayload,
  QuestionSyncResponse,
  SplitQuestionsRequest,
  SplitQuestionsResponse,
} from '../types'
import { apiFetch, apiJson, withJsonBody } from '../lib/api'
import { ensureMathContentDocument, mathContentToPromptText } from '../lib/mathContent'
import { createWorkroomFile } from './workroomTreeApi'

export type AgentStreamEvent =
  | { type: 'session'; session: AgentSessionFact }
  | { type: 'session_status'; status: 'busy' | 'idle' | 'retry'; attempt?: number; message?: string; next?: number }
  | { type: 'message_started'; message: AgentMessageFact }
  | { type: 'message_updated'; message: AgentMessageFact }
  | { type: 'message_completed'; message: AgentMessageFact }
  | { type: 'part_added'; message_id: string; part: AgentMessagePartFact }
  | { type: 'part_updated'; message_id: string; part: AgentMessagePartFact }
  | { type: 'part_delta'; message_id: string; part_id: string; field: string; delta: string }
  | { type: 'part_completed'; message_id: string; part: AgentMessagePartFact }
  | { type: 'permission_asked'; request: AgentPermissionAskedFact }
  | { type: 'question_asked'; request: AgentQuestionAskedFact }
  | { type: 'question_replied'; requestId: string; sessionId: string; answers: string[][]; freeText?: Array<string | null> }
  | { type: 'question_rejected'; requestId: string; sessionId: string }
  | { type: 'cancelled'; reason?: string }
  | { type: 'error'; error?: string }
  | { type: 'done' }

export type AgentStreamOutcome = 'completed' | 'cancelled'

function encodeFilePath(filepath: string) {
  let normalized = filepath.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = '/' + normalized
  }
  return normalized
    .split('/')
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join('/')
}

function sanitizeAttachmentName(name: string) {
  const normalized = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim()
  return normalized || 'attachment.txt'
}

function joinAbsolutePath(root: string, relative: string) {
  return `${root.replace(/[\\/]+$/, '')}/${relative.replace(/^\/+/, '').replace(/\\/g, '/')}`
}

function buildStagedAttachmentPath(name: string) {
  const safeName = sanitizeAttachmentName(name)
  return ['.agent', 'uploads', `${Date.now()}-${crypto.randomUUID()}-${safeName}`].join('/')
}

async function fetchAgentSession(
  baseUrl: string,
  workroomId: string | number,
  sessionId: string,
): Promise<AgentSessionFact> {
  const session = await apiJson<unknown>(
    `${baseUrl}/api/agent/session/${encodeURIComponent(sessionId)}?workroom_id=${encodeURIComponent(String(workroomId))}`,
    {
      method: 'GET',
    },
  )
  return mapAgentSessionFact(session)
}

async function toRunBody(
  baseUrl: string,
  payload: AgentRunRequest,
  session: AgentSessionFact,
) {
  const promptRaw = [...payload.messages].reverse().find((item) => item.role === 'user')?.content
  const prompt =
    typeof promptRaw === 'string'
      ? promptRaw.trim()
      : mathContentToPromptText(ensureMathContentDocument(promptRaw)).trim()
  if (!prompt) {
    throw new Error('Missing user prompt')
  }

  const parts: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: prompt,
    },
  ]
  if (Array.isArray(payload.inputFiles)) {
    const sessionDirectory = typeof session.directory === 'string' ? session.directory.trim() : ''
    if (!sessionDirectory) {
      throw new Error('Missing agent session directory for file attachments')
    }
    for (const file of payload.inputFiles) {
      const name = String(file?.name || '').trim()
      const content = typeof file?.content === 'string' ? file.content : ''
      if (!name || !content.trim()) continue
      const stagedPath = buildStagedAttachmentPath(name)
      await createWorkroomFile(baseUrl, payload.workroomId, stagedPath, content)
      parts.push({
        type: 'file',
        mime: 'text/plain',
        filename: name,
        url: `file://${encodeFilePath(joinAbsolutePath(sessionDirectory, stagedPath))}`,
      })
    }
  }

  return {
    workroomID: String(payload.workroomId),
    parts,
    model:
      payload.model && payload.model.providerID && payload.model.modelID
        ? {
            providerID: payload.model.providerID,
            modelID: payload.model.modelID,
          }
        : undefined,
  }
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
}

function asString(input: unknown): string | null {
  return typeof input === 'string' && input.trim() ? input : null
}

function asNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined
}

function toIsoString(input: unknown): string | undefined {
  const value = asNumber(input)
  return value == null ? undefined : new Date(value).toISOString()
}

function mapAgentSessionFact(input: unknown): AgentSessionFact {
  const session = asRecord(input) ?? {}
  const time = asRecord(session.time) ?? {}
  return {
    id: asString(session.id) ?? '',
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
    time: {
      created: asNumber(time.created),
      updated: asNumber(time.updated),
      compacting: asNumber(time.compacting),
      archived: asNumber(time.archived),
    },
  }
}

function mapAgentPartFact(input: unknown): AgentMessagePartFact {
  const part = asRecord(input) ?? {}
  const base = {
    id: asString(part.id) ?? '',
    session_id: asString(part.sessionID) ?? '',
    message_id: asString(part.messageID) ?? '',
    type: asString(part.type) ?? 'unknown',
  }

  if (part.type === 'text') {
    const phase = part.phase === 'final_answer' ? 'final_answer' : part.phase === 'commentary' ? 'commentary' : 'text'
    return {
      ...base,
      type: phase,
      text: typeof part.text === 'string' ? part.text : '',
      phase: phase === 'text' ? undefined : phase,
      synthetic: part.synthetic === true ? true : undefined,
      ignored: part.ignored === true ? true : undefined,
      time: asRecord(part.time) ?? undefined,
      metadata: asRecord(part.metadata),
    }
  }

  if (part.type === 'reasoning') {
    return {
      ...base,
      type: 'reasoning',
      text: typeof part.text === 'string' ? part.text : '',
      time: asRecord(part.time) ?? undefined,
      metadata: asRecord(part.metadata),
    }
  }

  if (part.type === 'file') {
    return {
      ...base,
      type: 'file',
      mime: asString(part.mime) ?? 'application/octet-stream',
      filename: asString(part.filename) ?? undefined,
      url: asString(part.url) ?? '',
      source: asRecord(part.source),
    }
  }

  if (part.type === 'tool') {
    const rawState = asRecord(part.state) ?? {}
    const rawStatus = asString(rawState.status) ?? 'pending'
    let state: Record<string, unknown>

    if (rawStatus === 'running') {
      state = {
        status: 'running',
        input: asRecord(rawState.input) ?? {},
        title: asString(rawState.title) ?? undefined,
        metadata: asRecord(rawState.metadata),
        time: asRecord(rawState.time) ?? undefined,
      }
    } else if (rawStatus === 'completed') {
      state = {
        status: 'completed',
        input: asRecord(rawState.input) ?? {},
        output: typeof rawState.output === 'string' ? rawState.output : '',
        title: asString(rawState.title) ?? undefined,
        metadata: asRecord(rawState.metadata),
        time: asRecord(rawState.time) ?? undefined,
        attachments: Array.isArray(rawState.attachments)
          ? rawState.attachments
              .map((item) => mapAgentPartFact(item))
              .filter((item) => item.type === 'file')
          : undefined,
      }
    } else if (rawStatus === 'error') {
      state = {
        status: 'error',
        input: asRecord(rawState.input) ?? {},
        error: typeof rawState.error === 'string' ? rawState.error : '',
        metadata: asRecord(rawState.metadata),
        time: asRecord(rawState.time) ?? undefined,
      }
    } else {
      state = {
        status: 'pending',
        input: asRecord(rawState.input) ?? {},
        raw: typeof rawState.raw === 'string' ? rawState.raw : undefined,
      }
    }

    return {
      ...base,
      type: 'tool',
      call_id: asString(part.callID) ?? '',
      tool: asString(part.tool) ?? 'tool',
      state: state as any,
      metadata: asRecord(part.metadata),
    }
  }

  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(part)) {
    if (['id', 'sessionID', 'messageID', 'type'].includes(key)) continue
    extra[key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`)] = value
  }

  return {
    ...base,
    ...extra,
  }
}

function mapAgentMessageFact(input: unknown): AgentMessageFact {
  const message = asRecord(input) ?? {}
  const info = asRecord(message.info) ?? {}
  return {
    info: {
      id: asString(info.id) ?? '',
      session_id: asString(info.sessionID) ?? '',
      role: info.role === 'user' ? 'user' : 'assistant',
      time: asRecord(info.time) ?? {},
      parent_id: asString(info.parentID),
      provider_id: asString(info.providerID),
      model_id: asString(info.modelID),
      agent: asString(info.agent),
      path: asRecord(info.path),
      error: asRecord(info.error),
      summary: typeof info.summary === 'boolean' ? info.summary : asRecord(info.summary),
      cost: typeof info.cost === 'number' ? info.cost : null,
      tokens: asRecord(info.tokens),
      structured: info.structured,
      variant: asString(info.variant),
      finish: asString(info.finish),
    },
    parts: Array.isArray(message.parts) ? message.parts.map(mapAgentPartFact) : [],
  }
}

function mapPermissionAsked(input: unknown): AgentPermissionAskedFact {
  const request = asRecord(input) ?? {}
  const tool = asRecord(request.tool)
  return {
    id: asString(request.id) ?? '',
    session_id: asString(request.sessionID) ?? '',
    permission: asString(request.permission) ?? '',
    patterns: Array.isArray(request.patterns) ? request.patterns.map((item) => String(item)) : [],
    metadata: asRecord(request.metadata) ?? {},
    always: Array.isArray(request.always) ? request.always.map((item) => String(item)) : [],
    tool: tool
      ? {
          message_id: asString(tool.messageID),
          call_id: asString(tool.callID),
        }
      : null,
  }
}

function mapQuestionAsked(input: unknown): AgentQuestionAskedFact {
  const request = asRecord(input) ?? {}
  const tool = asRecord(request.tool)
  const questions = Array.isArray(request.questions) ? request.questions : []
  return {
    id: asString(request.id) ?? '',
    session_id: asString(request.sessionID) ?? '',
    questions: questions.map((item) => {
      const question = asRecord(item) ?? {}
      const options = Array.isArray(question.options) ? question.options : []
      const normalizedOptions: AgentQuestionAskedFact['questions'][number]['options'] = options
        .map((option) => {
          const normalized = asRecord(option) ?? {}
          return {
            label: asString(normalized.label) ?? '',
            description: asString(normalized.description) ?? '',
          }
        })
        .filter((option) => option.label && option.description)
      const allowsCustom = question.custom !== false
      return {
        question: asString(question.question) ?? '',
        header: asString(question.header) ?? '',
        options: normalizedOptions,
        multiple: question.multiple === true ? true : undefined,
        custom: allowsCustom ? true : undefined,
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

export function parseAgentStreamEvent(raw: unknown, depth = 0): AgentStreamEvent | null {
  if (depth > 3) return null
  const event = asRecord(raw)
  if (!event) return null
  const type = asString(event.type)
  const properties = asRecord(event.properties) ?? {}
  if (!type) return null

  if (type === 'RUN_FINISHED') {
    return {
      type: 'session_status',
      status: 'idle',
    }
  }

  if (type === 'RUN_ERROR') {
    const message = asString(event.message)
    const code = asString(event.code)
    const cancelled = code === 'MessageAbortedError' || code === 'AbortError' || message?.toLowerCase() === 'aborted'
    if (cancelled) {
      return {
        type: 'cancelled',
        reason: message ?? 'Aborted',
      }
    }
    return {
      type: 'error',
      error: message ?? 'Agent stream failed',
    }
  }

  if (type === 'CUSTOM') {
    const name = asString(event.name)
    const value = asRecord(event.value) ?? {}
    const customProperties = asRecord(value.properties) ?? value
    if (name === 'permission.asked') {
      return {
        type: 'permission_asked',
        request: mapPermissionAsked(customProperties),
      }
    }
    if (name === 'question.asked') {
      return {
        type: 'question_asked',
        request: mapQuestionAsked(customProperties),
      }
    }
    if (name === 'question.replied') {
      return {
        type: 'question_replied',
        requestId: asString(customProperties.requestID) ?? '',
        sessionId: asString(customProperties.sessionID) ?? '',
        answers: Array.isArray(customProperties.answers)
          ? customProperties.answers.map((entry) => (Array.isArray(entry) ? entry.map((item) => String(item)) : []))
          : [],
        freeText: Array.isArray(customProperties.freeText)
          ? customProperties.freeText.map((item) => (typeof item === 'string' ? item : null))
          : undefined,
      }
    }
    if (name === 'question.rejected') {
      return {
        type: 'question_rejected',
        requestId: asString(customProperties.requestID) ?? '',
        sessionId: asString(customProperties.sessionID) ?? '',
      }
    }
    return null
  }

  if (type === 'RAW') {
    const nested = asRecord(event.event) ?? asRecord(event.rawEvent)
    if (!nested) return null
    return parseAgentStreamEvent(nested, depth + 1)
  }

  if (type === 'server.connected' || type === 'server.heartbeat') return null

  if (type === 'session.status') {
    const status = asRecord(properties.status) ?? {}
    const statusType = asString(status.type)
    if (statusType === 'busy' || statusType === 'idle' || statusType === 'retry') {
      return {
        type: 'session_status',
        status: statusType,
        attempt: asNumber(status.attempt),
        message: asString(status.message) ?? undefined,
        next: asNumber(status.next),
      }
    }
    return null
  }

  if (type === 'session.idle') {
    return {
      type: 'session_status',
      status: 'idle',
    }
  }

  if (type === 'message.updated') {
    const message = mapAgentMessageFact({
      info: properties.info,
      parts: Array.isArray(properties.parts) ? properties.parts : [],
    })
    const completed =
      typeof message.info.time?.completed === 'number' || Boolean(message.info.error)
    return {
      type: completed ? 'message_completed' : 'message_updated',
      message,
    }
  }

  if (type === 'message.started') {
    return {
      type: 'message_started',
      message: mapAgentMessageFact({
        info: properties.info,
        parts: Array.isArray(properties.parts) ? properties.parts : [],
      }),
    }
  }

  if (type === 'message.completed') {
    return {
      type: 'message_completed',
      message: mapAgentMessageFact({
        info: properties.info,
        parts: Array.isArray(properties.parts) ? properties.parts : [],
      }),
    }
  }

  if (type === 'message.part.added') {
    const part = mapAgentPartFact(properties.part)
    return {
      type: 'part_added',
      message_id: part.message_id,
      part,
    }
  }

  if (type === 'message.part.updated') {
    const part = mapAgentPartFact(properties.part)
    return {
      type: 'part_updated',
      message_id: part.message_id,
      part,
    }
  }

  if (type === 'message.part.completed') {
    const part = mapAgentPartFact(properties.part)
    return {
      type: 'part_completed',
      message_id: part.message_id,
      part,
    }
  }

  if (type === 'message.part.delta') {
    return {
      type: 'part_delta',
      message_id: asString(properties.messageID) ?? '',
      part_id: asString(properties.partID) ?? '',
      field: asString(properties.field) ?? '',
      delta: asString(properties.delta) ?? '',
    }
  }

  if (type === 'permission.asked') {
    return {
      type: 'permission_asked',
      request: mapPermissionAsked(properties),
    }
  }

  if (type === 'question.asked') {
    return {
      type: 'question_asked',
      request: mapQuestionAsked(properties),
    }
  }

  if (type === 'session.error') {
    const error = asRecord(properties.error)
    const errorName = asString(error?.name) ?? asString(error?.type) ?? ''
    const errorMessage = asString(error?.message) ?? ''
    const cancelled =
      errorName === 'MessageAbortedError' ||
      errorName === 'AbortError' ||
      errorMessage.toLowerCase() === 'aborted'
    if (cancelled) {
      return {
        type: 'cancelled',
        reason: errorMessage || 'Aborted',
      }
    }
    return {
      type: 'error',
      error: errorMessage || 'Agent stream failed',
    }
  }

  return null
}

async function readSseStream(
  response: Response,
  onEvent: (event: AgentStreamEvent) => void,
  options?: { stopWhen?: (event: AgentStreamEvent) => boolean },
): Promise<AgentStreamOutcome> {
  if (!response.body) {
    throw new Error('Streaming response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventBuffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue

    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        eventBuffer += line.slice(5).trim()
      }
      if (!eventBuffer) continue
      const event = parseAgentStreamEvent(JSON.parse(eventBuffer))
      eventBuffer = ''
      if (!event) continue
      if (event.type === 'error') {
        throw new Error(event.error || 'Agent stream failed')
      }
      if (event.type === 'cancelled') {
        onEvent(event)
        await reader.cancel().catch(() => {})
        return 'cancelled'
      }
      onEvent(event)
      if (options?.stopWhen?.(event)) {
        await reader.cancel().catch(() => {})
        return 'completed'
      }
    }
  }
  return 'completed'
}

async function createAgentSession(baseUrl: string, workroomId: string | number) {
  const session = await apiJson<unknown>(`${baseUrl}/api/agent/session`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(workroomId),
    }),
  })
  return mapAgentSessionFact(session)
}

export async function sendAgentRun(baseUrl: string, payload: AgentRunRequest): Promise<AgentRunResponse> {
  const session = await createAgentSession(baseUrl, payload.workroomId)
  const body = await toRunBody(baseUrl, payload, session)
  await apiFetch(`${baseUrl}/api/agent/session/${session.id}/prompt_async`, {
    method: 'POST',
    ...withJsonBody(body),
  })

  return {
    sessionId: session.id,
    messages: payload.messages,
    finalAnswerPayload: null,
  }
}

export async function syncQuestion(
  baseUrl: string,
  payload: QuestionSyncPayload,
): Promise<QuestionSyncResponse> {
  if (payload.studioDocumentId == null || String(payload.studioDocumentId).trim() === '') {
    throw new Error('Missing studioDocumentId for question sync')
  }

  return apiJson<QuestionSyncResponse>(`${baseUrl}/api/questions/sync`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
      studioDocumentID: String(payload.studioDocumentId),
      sourceDocumentID:
        payload.sourceDocumentId != null ? String(payload.sourceDocumentId) : undefined,
      questionID: payload.questionId != null ? String(payload.questionId) : undefined,
      sequenceIndex: payload.sequenceIndex,
      page: payload.page ?? undefined,
      content: payload.content,
      legendImages: payload.legendImages,
      title: payload.title ?? undefined,
      studentAnswer: payload.studentAnswer ?? undefined,
      canonicalAnswer: payload.canonicalAnswer ?? undefined,
    }),
  })
}

export async function deleteQuestion(
  baseUrl: string,
  params: { tenantId: number; documentId: string | number; questionId: number | string },
): Promise<void> {
  await apiFetch(`${baseUrl}/api/questions/${params.questionId}`, {
    method: 'DELETE',
  })
}

export async function fetchSnapshot(
  baseUrl: string,
  _tenantId: number,
  _userId: string | number,
  workroomId: string | number,
  studioDocumentId: string | number,
): Promise<AgentSnapshotResponse> {
  return apiJson<AgentSnapshotResponse>(
    `${baseUrl}/api/questions/snapshot/${studioDocumentId}?workroom_id=${encodeURIComponent(String(workroomId))}`,
    {
      method: 'GET',
    },
  )
}

export async function sendAgentRunStream(
  baseUrl: string,
  payload: AgentRunRequest,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<AgentStreamOutcome> {
  const session =
    payload.sessionId != null
      ? await fetchAgentSession(baseUrl, payload.workroomId, payload.sessionId)
      : await createAgentSession(baseUrl, payload.workroomId)

  onEvent({
    type: 'session',
    session,
  })

  const streamResponse = await apiFetch(
    `${baseUrl}/api/agent/event?workroom_id=${encodeURIComponent(String(payload.workroomId))}&session_id=${encodeURIComponent(session.id)}`,
    {
      method: 'GET',
    },
  )

  let streamBecameActive = false
  const streamTask = readSseStream(streamResponse, (event) => {
    if (
      (event.type === 'session_status' && event.status === 'busy') ||
      event.type === 'message_started' ||
      event.type === 'message_updated' ||
      event.type === 'message_completed' ||
      event.type === 'part_added' ||
      event.type === 'part_updated' ||
      event.type === 'part_delta' ||
      event.type === 'part_completed' ||
      event.type === 'permission_asked' ||
      event.type === 'question_asked'
    ) {
      streamBecameActive = true
    }
    onEvent(event)
  }, {
    stopWhen: (event) =>
      (event.type === 'session_status' &&
        event.status === 'idle' &&
        streamBecameActive) ||
      event.type === 'cancelled' ||
      event.type === 'permission_asked' ||
      event.type === 'question_asked',
  })

  const body = await toRunBody(baseUrl, payload, session)
  const promptTask = apiFetch(`${baseUrl}/api/agent/session/${session.id}/prompt_async`, {
    method: 'POST',
    ...withJsonBody(body),
  })

  const [outcome] = await Promise.all([streamTask, promptTask])
  onEvent({ type: 'done' })
  return outcome
}

export async function sendAgentResumeStream(
  baseUrl: string,
  params: {
    workroomId: string | number
    sessionId: string
    resumePayload: unknown
    interaction:
      | {
          kind: 'permission'
          requestId: string
        }
      | {
          kind: 'question'
          requestId: string
        }
  },
  onEvent: (event: AgentStreamEvent) => void,
): Promise<AgentStreamOutcome> {
  const streamResponse = await apiFetch(
    `${baseUrl}/api/agent/event?workroom_id=${encodeURIComponent(String(params.workroomId))}&session_id=${encodeURIComponent(params.sessionId)}`,
    {
      method: 'GET',
    },
  )

  let streamBecameActive = false
  const streamTask = readSseStream(streamResponse, (event) => {
    if (
      (event.type === 'session_status' && event.status === 'busy') ||
      event.type === 'message_started' ||
      event.type === 'message_updated' ||
      event.type === 'message_completed' ||
      event.type === 'part_added' ||
      event.type === 'part_updated' ||
      event.type === 'part_delta' ||
      event.type === 'part_completed' ||
      event.type === 'permission_asked' ||
      event.type === 'question_asked'
    ) {
      streamBecameActive = true
    }
    onEvent(event)
  }, {
    stopWhen: (event) =>
      (event.type === 'session_status' &&
        event.status === 'idle' &&
        streamBecameActive) ||
      event.type === 'cancelled' ||
      event.type === 'permission_asked' ||
      event.type === 'question_asked',
  })

  const payloadRecord = asRecord(params.resumePayload) ?? {}
  if (params.interaction.kind === 'permission') {
    console.info('[agent-resume] permission reply start', {
      sessionId: params.sessionId,
      requestId: params.interaction.requestId,
      reply: typeof payloadRecord.reply === 'string' ? payloadRecord.reply : 'once',
    })
    await apiFetch(`${baseUrl}/api/agent/permission/${params.interaction.requestId}/reply`, {
      method: 'POST',
      ...withJsonBody({
        workroomID: String(params.workroomId),
        reply: typeof payloadRecord.reply === 'string' ? payloadRecord.reply : 'once',
        message: typeof payloadRecord.message === 'string' ? payloadRecord.message : undefined,
      }),
    })
    console.info('[agent-resume] permission reply completed', {
      sessionId: params.sessionId,
      requestId: params.interaction.requestId,
    })
  } else {
    const answers = Array.isArray(payloadRecord.answers)
      ? payloadRecord.answers.map((entry) =>
          Array.isArray(entry) ? entry.map((item) => String(item)) : [],
        )
      : []

    await apiFetch(`${baseUrl}/api/agent/question/${params.interaction.requestId}/reply`, {
      method: 'POST',
      ...withJsonBody({
        workroomID: String(params.workroomId),
        answers,
      }),
    })
  }

  console.info('[agent-resume] loop start', {
    sessionId: params.sessionId,
    interactionKind: params.interaction.kind,
  })
  const loopTask = apiFetch(`${baseUrl}/api/agent/session/${params.sessionId}/loop`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(params.workroomId),
    }),
  })

  const [outcome] = await Promise.all([streamTask, loopTask])
  console.info('[agent-resume] loop completed', {
    sessionId: params.sessionId,
    interactionKind: params.interaction.kind,
  })
  onEvent({ type: 'done' })
  return outcome
}

export async function cancelAgentRun(
  baseUrl: string,
  params: { workroomId: string | number; sessionId: string },
): Promise<void> {
  console.info('[agent-cancel] request start', params)
  await apiFetch(`${baseUrl}/api/agent/session/${params.sessionId}/cancel`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(params.workroomId),
    }),
  })
  console.info('[agent-cancel] request completed', params)
}

export async function requestGrading(
  baseUrl: string,
  payload: GradeRunRequest,
): Promise<GradeRunResponse> {
  return apiJson<GradeRunResponse>(`${baseUrl}/api/questions/grade-run`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
      studioDocumentID: String(payload.studioDocumentId),
      sourceDocumentID:
        payload.sourceDocumentId != null ? String(payload.sourceDocumentId) : undefined,
      questions: payload.questions.map((question) => ({
        sequenceIndex: question.sequenceIndex,
        content: question.content,
        userAnswer: question.userAnswer ?? undefined,
      })),
    }),
  })
}

export async function requestSplitQuestions(
  baseUrl: string,
  payload: SplitQuestionsRequest,
): Promise<SplitQuestionsResponse> {
  return apiJson<SplitQuestionsResponse>(`${baseUrl}/api/questions/split`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
      text: payload.text,
      maxQuestions: payload.maxQuestions ?? undefined,
    }),
  })
}

export async function fetchAgentSessions(
  baseUrl: string,
  params: {
    workroomId: string | number
    limit?: number
  },
): Promise<{ items: AgentSessionListItem[] }> {
  const search = new URLSearchParams()
  search.set('workroom_id', String(params.workroomId))
  if (params.limit != null) {
    search.set('limit', String(params.limit))
  }

  const sessions = await apiJson<unknown[]>(`${baseUrl}/api/agent/session?${search.toString()}`, {
    method: 'GET',
  })

  return {
    items: sessions.map((session) => {
      const fact = mapAgentSessionFact(session)
      return {
        id: fact.id,
        title: fact.title ?? null,
        last_message_preview: null,
        message_count: 0,
        status: fact.time.archived ? 'archived' : 'active',
        archived: Boolean(fact.time.archived),
        created_at: toIsoString(fact.time.created),
        updated_at: toIsoString(fact.time.updated),
        selected_model: (() => {
          const row = asRecord(session)
          const selected = asRecord(row?.selectedModel)
          const providerID = asString(selected?.providerID)
          const modelID = asString(selected?.modelID)
          if (!providerID || !modelID) return null
          return {
            provider_id: providerID,
            model_id: modelID,
            updated_at: asString(selected?.updatedAt) ?? undefined,
          }
        })(),
      }
    }),
  }
}

export async function fetchAgentSkills(
  baseUrl: string,
  params: { workroomId: string | number },
): Promise<AgentSkillSettingsDto> {
  const search = new URLSearchParams()
  search.set('workroom_id', String(params.workroomId))
  return apiJson<AgentSkillSettingsDto>(`${baseUrl}/api/agent/skill?${search.toString()}`, {
    method: 'GET',
  })
}

export async function fetchAgentMcps(
  baseUrl: string,
  params: { workroomId: string | number },
): Promise<AgentMcpSettingsDto> {
  const search = new URLSearchParams()
  search.set('workroom_id', String(params.workroomId))
  return apiJson<AgentMcpSettingsDto>(`${baseUrl}/api/agent/mcp?${search.toString()}`, {
    method: 'GET',
  })
}

const MCP_REQUEST_TIMEOUT_MS = 12000

async function apiJsonWithMcpTimeout<T>(url: string, options: RequestInit) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), MCP_REQUEST_TIMEOUT_MS)
  try {
    return await apiJson<T>(url, {
      ...(options as any),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('MCP 请求超时，请检查配置与本地命令')
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

export async function addAgentMcp(
  baseUrl: string,
  payload: {
    workroomId: string | number
    name: string
    config: AgentMcpConfigDto
  },
): Promise<AgentMcpSettingsDto> {
  return apiJsonWithMcpTimeout<AgentMcpSettingsDto>(`${baseUrl}/api/agent/mcp`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
      name: payload.name,
      config: payload.config,
    }),
  })
}

export async function connectAgentMcp(
  baseUrl: string,
  payload: {
    workroomId: string | number
    name: string
  },
): Promise<AgentMcpSettingsDto> {
  return apiJsonWithMcpTimeout<AgentMcpSettingsDto>(`${baseUrl}/api/agent/mcp/${encodeURIComponent(payload.name)}/connect`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
    }),
  })
}

export async function disconnectAgentMcp(
  baseUrl: string,
  payload: {
    workroomId: string | number
    name: string
  },
): Promise<AgentMcpSettingsDto> {
  return apiJsonWithMcpTimeout<AgentMcpSettingsDto>(`${baseUrl}/api/agent/mcp/${encodeURIComponent(payload.name)}/disconnect`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
    }),
  })
}

export async function startAgentMcpAuth(
  baseUrl: string,
  payload: {
    workroomId: string | number
    name: string
  },
): Promise<{ authorizationUrl: string; oauthState: string }> {
  return apiJson<{ authorizationUrl: string; oauthState: string }>(
    `${baseUrl}/api/agent/mcp/${encodeURIComponent(payload.name)}/auth`,
    {
      method: 'POST',
      ...withJsonBody({
        workroomID: String(payload.workroomId),
      }),
    },
  )
}

export async function authenticateAgentMcp(
  baseUrl: string,
  payload: {
    workroomId: string | number
    name: string
  },
): Promise<AgentMcpSettingsDto> {
  return apiJsonWithMcpTimeout<AgentMcpSettingsDto>(
    `${baseUrl}/api/agent/mcp/${encodeURIComponent(payload.name)}/auth/authenticate`,
    {
      method: 'POST',
      ...withJsonBody({
        workroomID: String(payload.workroomId),
      }),
    },
  )
}

export async function removeAgentMcpAuth(
  baseUrl: string,
  payload: {
    workroomId: string | number
    name: string
  },
): Promise<AgentMcpSettingsDto> {
  return apiJsonWithMcpTimeout<AgentMcpSettingsDto>(`${baseUrl}/api/agent/mcp/${encodeURIComponent(payload.name)}/auth`, {
    method: 'DELETE',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
    }),
  })
}

export async function saveAgentSkills(
  baseUrl: string,
  payload: {
    workroomId: string | number
    sessionId?: string | null
    disabledSkillNames: string[]
  },
): Promise<AgentSkillSettingsDto> {
  return apiJson<AgentSkillSettingsDto>(`${baseUrl}/api/agent/skill`, {
    method: 'PUT',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
      sessionID: payload.sessionId ?? undefined,
      disabledSkillNames: payload.disabledSkillNames,
    }),
  })
}

export async function updateAgentSession(
  baseUrl: string,
  sessionId: string,
  payload: {
    workroomId: string | number
    title?: string
    archived?: boolean
    selectedModel?: { providerID: string; modelID: string } | null
  },
): Promise<void> {
  await apiFetch(`${baseUrl}/api/agent/session/${sessionId}`, {
    method: 'PATCH',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
      title: payload.title,
      archived: payload.archived,
      selectedModel: payload.selectedModel,
    }),
  })
}

export async function deleteAgentMcp(
  baseUrl: string,
  payload: {
    workroomId: string | number
    name: string
  },
): Promise<AgentMcpSettingsDto> {
  return apiJsonWithMcpTimeout<AgentMcpSettingsDto>(`${baseUrl}/api/agent/mcp/${encodeURIComponent(payload.name)}`, {
    method: 'DELETE',
    ...withJsonBody({
      workroomID: String(payload.workroomId),
    }),
  })
}

export async function deleteAgentSession(
  baseUrl: string,
  sessionId: string,
  payload: { workroomId: string | number },
): Promise<void> {
  const search = new URLSearchParams()
  search.set('workroom_id', String(payload.workroomId))
  await apiFetch(`${baseUrl}/api/agent/session/${sessionId}?${search.toString()}`, {
    method: 'DELETE',
  })
}

export async function fetchAgentSessionMessages(
  baseUrl: string,
  params: { workroomId: string | number; sessionId: string; limit?: number },
): Promise<AgentSessionMessagesResponseDto> {
  const search = new URLSearchParams()
  search.set('workroom_id', String(params.workroomId))
  if (params.limit != null) {
    search.set('limit', String(params.limit))
  }

  const result = await apiJson<unknown[]>(
    `${baseUrl}/api/agent/session/${params.sessionId}/message?${search.toString()}`,
    {
      method: 'GET',
    },
  )

  return {
    session_id: params.sessionId,
    messages: result.map(mapAgentMessageFact),
  }
}
