import type {
  AgentRunRequest,
  AgentRunResponse,
  AgentSnapshotResponse,
  AgUiEvent,
  GradeRunRequest,
  GradeRunResponse,
  QuestionSyncPayload,
  QuestionSyncResponse,
  SplitQuestionsRequest,
  SplitQuestionsResponse,
  AgentSessionListResponse,
  AgentSessionMessagesResponseDto,
} from '../types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }

  return (await resp.json()) as T
}

const toSnake = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null),
  )

async function getJSON<T>(url: string): Promise<T> {
  const resp = await fetch(url, {
    method: 'GET',
    headers: JSON_HEADERS,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }
  return (await resp.json()) as T
}

export async function syncQuestion(
  baseUrl: string,
  payload: QuestionSyncPayload,
): Promise<QuestionSyncResponse> {
  const body = toSnake({
    tenant_id: payload.tenantId,
    user_id: payload.userId,
    document_id: payload.documentId,
    session_id: payload.sessionId,
    file_id: payload.fileId,
    question_id: payload.questionId,
    sequence_index: payload.sequenceIndex,
    page: payload.page,
    content: payload.content,
    legend_images: payload.legendImages,
    student_answer: payload.studentAnswer,
    title: payload.title,
  })

  return postJSON<QuestionSyncResponse>(`${baseUrl}/api/agent/sync-question`, body)
}

export async function deleteQuestion(
  baseUrl: string,
  params: { tenantId: number; documentId: number; questionId: number },
): Promise<void> {
  const body = {
    tenant_id: params.tenantId,
    document_id: params.documentId,
    question_id: params.questionId,
  }
  await postJSON<{
    ok: boolean
  }>(`${baseUrl}/api/agent/delete-question`, body)
}

export async function fetchSnapshot(
  baseUrl: string,
  tenantId: number,
  documentId: number,
): Promise<AgentSnapshotResponse> {
  const body = {
    tenant_id: tenantId,
    document_id: documentId,
  }
  return postJSON<AgentSnapshotResponse>(`${baseUrl}/api/agent/snapshot`, body)
}

export async function sendAgentRun(baseUrl: string, payload: AgentRunRequest): Promise<AgentRunResponse> {
  const body = toSnake({
    tenant_id: payload.tenantId,
    user_id: payload.userId,
    ui_context: payload.uiContext,
    document_id: payload.documentId ?? undefined,
    messages: payload.messages,
    note_focus: payload.noteFocus
      ? {
          document_id: payload.noteFocus.documentId ?? undefined,
          file_id: payload.noteFocus.fileId ?? undefined,
          block_index: payload.noteFocus.blockIndex ?? undefined,
          snippet: payload.noteFocus.snippet ?? undefined,
          title: payload.noteFocus.title ?? undefined,
        }
      : undefined,
    view_id: payload.viewId ?? undefined,
    session_id: payload.sessionId ?? undefined,
    preferred_language: payload.preferredLanguage,
  })

  return postJSON<AgentRunResponse>(`${baseUrl}/api/agent/run`, body)
}

export type AgentStreamEvent =
  | { type: 'delta'; role: 'assistant'; delta: string }
  | { type: 'ag_ui'; event: AgUiEvent }
  | { type: 'session'; session_id: number; document_id?: number | null }

export async function sendAgentRunStream(
  baseUrl: string,
  payload: AgentRunRequest,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/agent/run-stream`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(
      toSnake({
        tenant_id: payload.tenantId,
        user_id: payload.userId,
        ui_context: payload.uiContext,
        document_id: payload.documentId ?? undefined,
        messages: payload.messages,
        note_focus: payload.noteFocus
          ? {
              document_id: payload.noteFocus.documentId ?? undefined,
              file_id: payload.noteFocus.fileId ?? undefined,
              block_index: payload.noteFocus.blockIndex ?? undefined,
              snippet: payload.noteFocus.snippet ?? undefined,
              title: payload.noteFocus.title ?? undefined,
            }
          : undefined,
        view_id: payload.viewId ?? undefined,
        session_id: payload.sessionId ?? undefined,
        preferred_language: payload.preferredLanguage,
      }),
    ),
  })

  if (!resp.ok || !resp.body) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      const chunk = decoder.decode(value, { stream: true })
      if (!chunk) continue
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as AgentStreamEvent
          console.debug('[agentStream] event', event)
          onEvent(event)
        } catch (err) {
          // 帮助定位流式解析问题
          console.warn('[agentStream] invalid line', trimmed, err)
        }
      }
    }
  }
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as AgentStreamEvent
      console.debug('[agentStream] trailing event', event)
      onEvent(event)
    } catch (err) {
      console.warn('[agentStream] invalid trailing buffer', buffer, err)
    }
  }
}

export async function sendAgentResumeStream(
  baseUrl: string,
  params: {
    tenantId: number
    userId: number
    documentId?: number | null
    sessionId: number
    resumePayload: unknown
  },
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/agent/run-resume-stream`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(
      toSnake({
        tenant_id: params.tenantId,
        user_id: params.userId,
        document_id: params.documentId ?? undefined,
        session_id: params.sessionId,
        resume_payload: params.resumePayload,
      }),
    ),
  })

  if (!resp.ok || !resp.body) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      const chunk = decoder.decode(value, { stream: true })
      if (!chunk) continue
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as AgentStreamEvent
          console.debug('[agentResumeStream] event', event)
          onEvent(event)
        } catch (err) {
          console.warn('[agentResumeStream] invalid line', trimmed, err)
        }
      }
    }
  }
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as AgentStreamEvent
      console.debug('[agentResumeStream] trailing event', event)
      onEvent(event)
    } catch (err) {
      console.warn('[agentResumeStream] invalid trailing buffer', buffer, err)
    }
  }
}

export async function requestGrading(baseUrl: string, payload: GradeRunRequest): Promise<GradeRunResponse> {
  const body = toSnake({
    tenant_id: payload.tenantId,
    user_id: payload.userId,
    document_id: payload.documentId,
    title: payload.title,
    preferred_language: payload.preferredLanguage,
    questions: payload.questions.map((q) =>
      toSnake({
        sequence_index: q.sequenceIndex,
        content: q.content,
        user_answer: q.userAnswer,
        legend_images: q.legendImages,
        page: q.page,
        file_name: q.fileName,
      }),
    ),
  })
  return postJSON<GradeRunResponse>(`${baseUrl}/api/agent/grade`, body)
}

export async function requestSplitQuestions(
  baseUrl: string,
  payload: SplitQuestionsRequest,
): Promise<SplitQuestionsResponse> {
  const body = toSnake({
    tenant_id: payload.tenantId,
    user_id: payload.userId,
    text: payload.text,
    max_questions: payload.maxQuestions,
  })

  return postJSON<SplitQuestionsResponse>(`${baseUrl}/api/agent/split-questions`, body)
}

// ===== Agent 会话管理 API =====

export async function fetchAgentSessions(
  baseUrl: string,
  params: {
    tenantId: number
    userId: number
    documentId?: number | null
    viewId?: string | null
    includeArchived?: boolean
  },
): Promise<AgentSessionListResponseDto> {
  const search = new URLSearchParams()
  search.set('tenant_id', String(params.tenantId))
  search.set('user_id', String(params.userId))
  if (params.documentId != null) search.set('document_id', String(params.documentId))
  if (params.viewId) search.set('view_id', params.viewId)
  if (params.includeArchived) search.set('include_archived', 'true')

  const url = `${baseUrl}/api/agent/sessions?${search.toString()}`
  return getJSON<AgentSessionListResponseDto>(url)
}

export async function updateAgentSession(
  baseUrl: string,
  sessionId: number,
  payload: { tenantId: number; userId: number; title?: string; archived?: boolean; status?: string },
): Promise<void> {
  const body = toSnake({
    tenant_id: payload.tenantId,
    user_id: payload.userId,
    title: payload.title,
    archived: payload.archived,
    status: payload.status,
  })

  await fetch(`${baseUrl}/api/agent/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).then(async (resp) => {
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(text || `Request failed (${resp.status})`)
    }
  })
}

export async function deleteAgentSession(
  baseUrl: string,
  sessionId: number,
  payload: { tenantId: number; userId: number },
): Promise<void> {
  const body = toSnake({
    tenant_id: payload.tenantId,
    user_id: payload.userId,
  })

  await fetch(`${baseUrl}/api/agent/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).then(async (resp) => {
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(text || `Request failed (${resp.status})`)
    }
  })
}

export async function fetchAgentSessionMessages(
  baseUrl: string,
  params: { tenantId: number; userId: number; sessionId: number; limit?: number },
): Promise<AgentSessionMessagesResponseDto> {
  const search = new URLSearchParams()
  search.set('tenant_id', String(params.tenantId))
  search.set('user_id', String(params.userId))
  if (params.limit != null) search.set('limit', String(params.limit))
  const url = `${baseUrl}/api/agent/sessions/${params.sessionId}/messages?${search.toString()}`
  return getJSON<AgentSessionMessagesResponseDto>(url)
}
