import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  AgentCitationAnchor,
  AgentCitationStatus,
  AgentNoteFocus,
  AgentRunMessage,
  AgentRunRequest,
  AgentThinkingThoughtTrace,
  AgentThinkingToolTrace,
} from '../types'
import type { AgentStreamEvent } from '../services/agentApi'
import { sendAgentRunStream, sendAgentResumeStream } from '../services/agentApi'

interface UseAgentChatOptions {
  backendBaseUrl: string
  tenantId?: number | null
  userId?: number | null
  workroomId?: number | null
  uiContext?: 'blank' | 'exam_editor' | 'code_editor' | 'other' | 'batch_question'
  documentId?: number | null
  noteFocus?: AgentNoteFocus | null
  onAgUiEvent?: (event: AgentStreamEvent & { type: 'ag_ui' }) => void
  /** 会话视图 ID，用于同一文档下区分不同编辑视图/标签的 Agent 会话 */
  viewId?: string | null
  onDocumentResolved?: (documentId: number) => void
}

export function useAgentChat({
  backendBaseUrl,
  tenantId,
  userId,
  workroomId,
  uiContext,
  documentId,
  noteFocus,
  onAgUiEvent,
  viewId,
  onDocumentResolved,
}: UseAgentChatOptions) {
  const [messages, setMessages] = useState<AgentRunMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAwaitingFirstToken, setIsAwaitingFirstToken] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sessionId, setSessionId] = useState<number | null>(null)

  const messagesRef = useRef<AgentRunMessage[]>([])

  const updateMessages = useCallback((next: AgentRunMessage[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const patchLastAssistant = useCallback((patch: Partial<AgentRunMessage> | ((message: AgentRunMessage) => AgentRunMessage)) => {
    const current = messagesRef.current
    if (!current.length) return
    const lastIndex = current.length - 1
    const last = current[lastIndex]
    if (!last || last.role !== 'assistant') return
    const next = [...current]
    next[lastIndex] = typeof patch === 'function' ? patch(last) : { ...last, ...patch }
    updateMessages(next)
  }, [updateMessages])

  const applyAssistantCitations = useCallback(
    (citations: AgentCitationAnchor[], citationStatus: AgentCitationStatus) => {
      patchLastAssistant((last) => ({
        ...last,
        citations,
        citationStatus,
        usedRagEvidence: citations.length > 0,
      }))
    },
    [patchLastAssistant],
  )

  const applyAssistantFinal = useCallback(
    (answerText: string, citationStatus: AgentCitationStatus) => {
      patchLastAssistant((last) => ({
        ...last,
        content: answerText,
        citationStatus,
        usedRagEvidence: last.usedRagEvidence ?? false,
      }))
    },
    [patchLastAssistant],
  )

  const appendAgentTraceToLastAssistant = useCallback((event: Extract<AgentStreamEvent, { type: 'agent_trace' }>) => {
    const current = messagesRef.current
    if (!current.length) return
    const lastIndex = current.length - 1
    const last = current[lastIndex]
    if (!last || last.role !== 'assistant') return

    const payload = event.payload || {}
    const traceType = String((payload as any).trace_type || '').trim().toLowerCase()

    const next = [...current]
    const updated: AgentRunMessage = {
      ...last,
      historyTraces: [...(last.historyTraces || [])],
      activeThought: null,
      activeTool: null,
      isStreaming: true,
    }

    if (traceType === 'model_native_thinking') {
      const content = String((payload as any).content || '')
      if (content) {
        const traces = updated.historyTraces || []
        const lastTrace = traces.length > 0 ? traces[traces.length - 1] : null
        if (lastTrace && lastTrace.type === 'thought') {
          lastTrace.text = `${lastTrace.text || ''}${content}`
        } else {
          traces.push({
            id: `thought-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: 'thought',
            text: content,
          } as AgentThinkingThoughtTrace)
        }
      }
    } else if (traceType === 'model_event') {
      const toolCalls = Array.isArray((payload as any).tool_calls) ? (payload as any).tool_calls : []
      for (const item of toolCalls) {
        if (!item || typeof item !== 'object') continue
        const toolCallId = String((item as any).id || '').trim()
        if (!toolCallId) continue
        const name = String((item as any).name || '').trim() || 'tool'
        const exists = (updated.historyTraces || []).some(
          (trace) => trace.type === 'tool' && (trace as AgentThinkingToolTrace).toolCallId === toolCallId,
        )
        if (exists) continue
        updated.historyTraces?.push({
          id: `tool-${toolCallId}`,
          type: 'tool',
          toolCallId,
          name,
          status: 'calling',
        } as AgentThinkingToolTrace)
      }
    } else if (traceType === 'tool_call') {
      const toolCallId = String((payload as any).tool_call_id || '').trim()
      const toolName = String((payload as any).tool_name || '').trim() || 'tool'
      const rawStatus = String((payload as any).status || '').trim().toLowerCase()
      let mappedStatus: AgentThinkingToolTrace['status'] = 'calling'
      if (rawStatus === 'ok' || rawStatus === 'success') {
        mappedStatus = 'success'
      } else if (rawStatus === 'error' || rawStatus === 'fail' || rawStatus === 'failed') {
        mappedStatus = 'fail'
      }

      let target = (updated.historyTraces || []).find(
        (trace) => trace.type === 'tool' && (trace as AgentThinkingToolTrace).toolCallId === toolCallId,
      ) as AgentThinkingToolTrace | undefined

      if (!target) {
        const reversed = [...(updated.historyTraces || [])].reverse()
        target = reversed.find(
          (trace) =>
            trace.type === 'tool' &&
            (trace as AgentThinkingToolTrace).name === toolName &&
            (trace as AgentThinkingToolTrace).status === 'calling',
        ) as AgentThinkingToolTrace | undefined
      }

      if (target) {
        target.status = mappedStatus
      } else {
        updated.historyTraces?.push({
          id: `tool-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'tool',
          toolCallId: toolCallId || undefined,
          name: toolName,
          status: mappedStatus,
        } as AgentThinkingToolTrace)
      }
    }

    next[lastIndex] = updated
    updateMessages(next)
  }, [updateMessages])

  const isReady = useMemo(() => Boolean(backendBaseUrl && tenantId && userId && workroomId), [backendBaseUrl, tenantId, userId, workroomId])

  const markLastAssistantFinished = useCallback(() => {
    patchLastAssistant((last) => (last.isStreaming ? { ...last, isStreaming: false } : last))
  }, [patchLastAssistant])

  const sendMessage = useCallback(
    async (content: string) => {
      if (!isReady) {
        setError('Agent 尚未完成初始化')
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        const userMessage: AgentRunMessage = {
          role: 'user',
          content,
        }
        const assistantMessage: AgentRunMessage = {
          role: 'assistant',
          content: '',
          isStreaming: true,
          historyTraces: [],
          activeThought: null,
          activeTool: null,
        }

        const optimisticMessages = [...messagesRef.current, userMessage, assistantMessage]
        updateMessages(optimisticMessages)

        const payload: AgentRunRequest = {
          tenantId: tenantId ?? 0,
          userId: userId ?? 0,
          workroomId: workroomId ?? 0,
          uiContext: uiContext ?? 'blank',
          documentId: documentId ?? undefined,
          messages: optimisticMessages,
          noteFocus: noteFocus ?? undefined,
          viewId: viewId ?? undefined,
          sessionId: sessionId ?? undefined,
        }

        // 将流式增量合并到同一条助手消息中，但通过 requestAnimationFrame
        // 节流 UI 更新，避免每个小 token 都触发一次 React 重渲，从而在
        // 拖拽/动画时明显掉帧。
        let acc = ''
        let pendingContent = ''
        let authoritativeFinalText: string | null = null
        let rafId: number | null = null

        const flush = () => {
          rafId = null
          const current = messagesRef.current
          if (!current.length) return
          const lastIndex = current.length - 1
          const last = current[lastIndex]
          if (!last || last.role !== 'assistant') return

          // 创建新的消息数组和新的助手消息对象，避免就地修改，
          // 以便 React.memo 能正确感知 props 变化并触发重渲染。
          const next = current.map((msg, index) =>
            index === lastIndex
              ? { ...msg, content: authoritativeFinalText ?? pendingContent }
              : msg,
          )
          updateMessages(next)
        }

        setIsAwaitingFirstToken(true)
        let hasReceivedFirstToken = false

        await sendAgentRunStream(backendBaseUrl, payload, (event) => {
          if (event.type === 'session') {
            setSessionId(event.session_id)
            const resolvedDocumentId = (event as any).studio_document_id ?? (event as any).document_id
            if (typeof resolvedDocumentId === 'number') {
              onDocumentResolved?.(resolvedDocumentId)
            }
            return
          }

          if (event.type === 'delta') {
            acc += event.delta
            pendingContent = acc
            if (!hasReceivedFirstToken) {
              hasReceivedFirstToken = true
              setIsAwaitingFirstToken(false)
            }
            if (rafId == null) {
              rafId = window.requestAnimationFrame(flush)
            }
          } else if (event.type === 'agent_trace') {
            appendAgentTraceToLastAssistant(event)
          } else if (event.type === 'assistant_citations') {
            applyAssistantCitations(event.citations, event.citation_status)
          } else if (event.type === 'assistant_final') {
            authoritativeFinalText = event.answer_text
            acc = event.answer_text
            pendingContent = event.answer_text
            applyAssistantFinal(event.answer_text, event.citation_status)
          } else if (event.type === 'ag_ui') {
            console.debug('[agentStream] ag_ui received', event.event)
            onAgUiEvent?.({ ...event, type: 'ag_ui' })
          }
        })

        // 保证最终结果被刷新一次
        if (rafId != null) {
          window.cancelAnimationFrame(rafId)
          flush()
        }
        markLastAssistantFinished()
        return { messages: messagesRef.current }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Agent 请求失败')
        // 回滚最后一条助手消息
        const next = messagesRef.current.filter((m, idx, arr) => !(idx === arr.length - 1 && m.role === 'assistant'))
        updateMessages(next)
        throw err
      } finally {
        setIsLoading(false)
        setIsAwaitingFirstToken(false)
      }
    },
    [
      appendAgentTraceToLastAssistant,
      applyAssistantCitations,
      applyAssistantFinal,
      backendBaseUrl,
      isReady,
      markLastAssistantFinished,
      sessionId,
      tenantId,
      uiContext,
      documentId,
      noteFocus,
      updateMessages,
      userId,
      workroomId,
      viewId,
    ],
  )

  const resumeWithPayload = useCallback(
    async (resumePayload: unknown) => {
      if (!isReady) {
        setError('Agent 尚未完成初始化')
        return
      }

      const tenant = tenantId ?? 0
      const user = userId ?? 0
      const workroom = workroomId ?? 0
      const docId = documentId ?? undefined

      setIsLoading(true)
      setError(null)

      try {
        // 确保存在一条末尾的助手消息供追加
        let current = messagesRef.current
        if (!current.length || current[current.length - 1]?.role !== 'assistant') {
          const assistantMessage: AgentRunMessage = {
            role: 'assistant',
            content: '',
            isStreaming: true,
            historyTraces: [],
            activeThought: null,
            activeTool: null,
          }
          current = [...current, assistantMessage]
          updateMessages(current)
        }

        // 从现有助手消息内容开始累积增量
        const lastIndex = current.length - 1
        const last = current[lastIndex]
        let acc = typeof last?.content === 'string' ? last.content : ''
        let pendingContent = acc
        let authoritativeFinalText: string | null = null
        let rafId: number | null = null

        const flush = () => {
          rafId = null
          const snapshot = messagesRef.current
          if (!snapshot.length) return
          const li = snapshot.length - 1
          const lastMsg = snapshot[li]
          if (!lastMsg || lastMsg.role !== 'assistant') return

          const next = snapshot.map((msg, index) =>
            index === li
              ? { ...msg, content: authoritativeFinalText ?? pendingContent }
              : msg,
          )
          updateMessages(next)
        }

        setIsAwaitingFirstToken(true)
        let hasReceivedFirstToken = false

        if (sessionId == null) {
          throw new Error('Agent 会话已丢失，无法从中断点恢复，请重新开始对话')
        }

        await sendAgentResumeStream(
          backendBaseUrl,
          {
            tenantId: tenant,
            userId: user,
            workroomId: workroom,
            documentId: docId,
            sessionId,
            resumePayload,
          },
          (event: AgentStreamEvent) => {
            if (event.type === 'delta') {
              acc += event.delta
              pendingContent = acc
              if (!hasReceivedFirstToken) {
                hasReceivedFirstToken = true
                setIsAwaitingFirstToken(false)
              }
              if (rafId == null) {
                rafId = window.requestAnimationFrame(flush)
              }
            } else if (event.type === 'agent_trace') {
              appendAgentTraceToLastAssistant(event)
            } else if (event.type === 'assistant_citations') {
              applyAssistantCitations(event.citations, event.citation_status)
            } else if (event.type === 'assistant_final') {
              authoritativeFinalText = event.answer_text
              acc = event.answer_text
              pendingContent = event.answer_text
              applyAssistantFinal(event.answer_text, event.citation_status)
            } else if (event.type === 'ag_ui') {
              console.debug('[agentResumeStream] ag_ui received', event.event)
              onAgUiEvent?.({ ...event, type: 'ag_ui' })
            }
          },
        )

        if (rafId != null) {
          window.cancelAnimationFrame(rafId)
          flush()
        }
        markLastAssistantFinished()
        return { messages: messagesRef.current }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Agent 请求失败')
        throw err
      } finally {
        setIsLoading(false)
        setIsAwaitingFirstToken(false)
      }
    },
    [
      appendAgentTraceToLastAssistant,
      applyAssistantCitations,
      applyAssistantFinal,
      backendBaseUrl,
      documentId,
      isReady,
      markLastAssistantFinished,
      onAgUiEvent,
      sessionId,
      tenantId,
      updateMessages,
      userId,
      workroomId,
    ],
  )

  const resetChat = useCallback(() => {
    updateMessages([])
    setError(null)
    setSessionId(null)
  }, [updateMessages])

  return {
    isReady,
    messages,
    isLoading,
    isAwaitingFirstToken,
    error,
    sendMessage,
    resumeWithPayload,
    resetChat,
    // 供会话历史加载时直接灌入完整消息列表
    setMessagesFromHistory: updateMessages,
    sessionId,
    setSessionId,
  }
}
