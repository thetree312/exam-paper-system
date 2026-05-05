import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  AgentInputFile,
  AgentNoteFocus,
  AgentPermissionAskedFact,
  AgentQuestionAskedFact,
  AgentRunMessage,
  AgentRunRequest,
} from '../types'
import type { AgentStreamEvent } from '../services/agentApi'
import { cancelAgentRun, sendAgentRunStream, sendAgentResumeStream } from '../services/agentApi'
import {
  applyPartDelta,
  applyPartSnapshot,
  createOptimisticAssistantMessage,
  createOptimisticUserMessage,
  markMessageCompleted,
  normalizeAgentRunMessage,
  upsertMessageFact,
} from '../lib/agentFacts'
import type { MathContentDocument } from '../lib/mathContent'

interface UseAgentChatOptions {
  backendBaseUrl: string
  tenantId?: number | null
  userId?: string | number | null
  workroomId?: string | number | null
  uiContext?: 'blank' | 'exam_editor' | 'code_editor' | 'other' | 'batch_question'
  documentId?: string | number | null
  noteFocus?: AgentNoteFocus | null
  viewId?: string | null
  onDocumentResolved?: (documentId: string | number) => void
}

type PendingInteraction =
  | {
      kind: 'permission'
      requestId: string
      request: AgentPermissionAskedFact
    }
  | {
      kind: 'question'
      requestId: string
      request: AgentQuestionAskedFact
    }
  | null

export function useAgentChat({
  backendBaseUrl,
  tenantId,
  userId,
  workroomId,
  uiContext,
  documentId,
  noteFocus,
  viewId,
  onDocumentResolved: _onDocumentResolved,
}: UseAgentChatOptions) {
  const streamDebugEnabled =
    import.meta.env?.DEV && typeof window !== 'undefined' && (window as any).__AGENT_DEBUG__ === true
  const debugStream = useCallback((label: string, payload?: Record<string, unknown>) => {
    if (!streamDebugEnabled) return
    console.info('[agent-stream-debug]', label, payload ?? {})
  }, [streamDebugEnabled])

  const [messages, setMessages] = useState<AgentRunMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAwaitingFirstToken, setIsAwaitingFirstToken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction>(null)
  const [cancelRequested, setCancelRequested] = useState(false)
  const messagesRef = useRef<AgentRunMessage[]>([])
  const pendingInteractionRef = useRef<PendingInteraction>(null)

  const updateMessages = useCallback((next: AgentRunMessage[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const isReady = useMemo(
    () => Boolean(backendBaseUrl && userId != null && workroomId != null),
    [backendBaseUrl, userId, workroomId],
  )

  const applyStreamEvent = useCallback((event: AgentStreamEvent) => {
    debugStream('stream event received', {
      event_type: event.type,
      message_id:
        'message' in event && event.message && typeof event.message === 'object' && 'info' in event.message
          ? event.message.info.id
          : undefined,
      part_id: 'part' in event && event.part ? event.part.id : undefined,
      field: event.type === 'part_delta' ? event.field : undefined,
      delta_preview:
        event.type === 'part_delta'
          ? String(event.delta || '').replace(/\s+/g, ' ').trim().slice(0, 120)
          : undefined,
    })

    if (event.type === 'session') {
      setSessionId(event.session.id)
      return
    }
    if (event.type === 'cancelled') {
      setCancelRequested(false)
      setIsAwaitingFirstToken(false)
      return
    }

    if (event.type === 'session_status') {
      return
    }

    if (event.type === 'message_started') {
      updateMessages(upsertMessageFact(messagesRef.current, event.message, { allowOptimisticReplace: true }))
      return
    }

    if (event.type === 'message_updated') {
      updateMessages(upsertMessageFact(messagesRef.current, event.message))
      return
    }

    if (event.type === 'message_completed') {
      pendingInteractionRef.current = null
      setPendingInteraction(null)
      updateMessages(markMessageCompleted(messagesRef.current, event.message))
      setIsAwaitingFirstToken(false)
      return
    }

    if (event.type === 'part_added') {
      updateMessages(applyPartSnapshot(messagesRef.current, event.part, { isAdd: true }))
      if (
        event.part.type === 'text' ||
        event.part.type === 'commentary' ||
        event.part.type === 'final_answer' ||
        event.part.type === 'tool'
      ) {
        setIsAwaitingFirstToken(false)
      }
      return
    }

    if (event.type === 'part_updated') {
      updateMessages(applyPartSnapshot(messagesRef.current, event.part, { isAdd: false }))
      return
    }

    if (event.type === 'part_completed') {
      updateMessages(applyPartSnapshot(messagesRef.current, event.part, { isAdd: false, markCompleted: true }))
      return
    }

    if (event.type === 'part_delta') {
      const targetMessage = messagesRef.current.find((item) => item.messageInfo?.id === event.message_id)
      const targetPart = Array.isArray(targetMessage?.parts)
        ? targetMessage.parts.find((part) => part.id === event.part_id)
        : undefined
      updateMessages(
        applyPartDelta(messagesRef.current, {
          messageId: event.message_id,
          partId: event.part_id,
          field: event.field,
          delta: event.delta,
        }),
      )
      if (
        targetPart?.type === 'text' ||
        targetPart?.type === 'commentary' ||
        targetPart?.type === 'final_answer' ||
        targetPart?.type === 'tool'
      ) {
        setIsAwaitingFirstToken(false)
      }
      return
    }

    if (event.type === 'permission_asked') {
      const nextInteraction: PendingInteraction = {
        kind: 'permission',
        requestId: event.request.id,
        request: event.request,
      }
      pendingInteractionRef.current = nextInteraction
      setPendingInteraction(nextInteraction)
      return
    }

    if (event.type === 'question_asked') {
      const nextInteraction: PendingInteraction = {
        kind: 'question',
        requestId: event.request.id,
        request: event.request,
      }
      pendingInteractionRef.current = nextInteraction
      setPendingInteraction(nextInteraction)
    }
  }, [debugStream, updateMessages])

  const sendMessage = useCallback(
    async (
      content: string | MathContentDocument,
      model?: { providerID: string; modelID: string } | null,
      inputFiles?: AgentInputFile[],
    ) => {
      if (!isReady) {
        setError('Agent 尚未完成初始化')
        return
      }

      setIsLoading(true)
      setIsAwaitingFirstToken(true)
      setCancelRequested(false)
      setError(null)
      pendingInteractionRef.current = null
      setPendingInteraction(null)

      const optimisticUser = createOptimisticUserMessage(content, inputFiles)
      const optimisticAssistant = createOptimisticAssistantMessage()
      const optimisticMessages = [...messagesRef.current, optimisticUser, optimisticAssistant]
      updateMessages(optimisticMessages)

      try {
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
          model: model ?? undefined,
          inputFiles: Array.isArray(inputFiles) && inputFiles.length > 0 ? inputFiles : undefined,
        }

        console.info('[agent-run] run_started', {
          sessionId: payload.sessionId ?? null,
          workroomId,
          viewId,
        })
        const outcome = await sendAgentRunStream(backendBaseUrl, payload, (event) => {
          applyStreamEvent(event)
        })
        console.info(outcome === 'cancelled' ? '[agent-run] run_cancelled' : '[agent-run] run_completed', {
          sessionId: sessionId ?? null,
          workroomId,
        })

        const finalized = messagesRef.current.map((message) =>
          message.role === 'assistant' ? { ...message, isStreaming: false, isOptimistic: false } : { ...message, isOptimistic: false },
        )
        updateMessages(finalized)
        return { messages: finalized }
      } catch (err) {
        console.error('[agent-run] run_failed', err)
        setError(err instanceof Error ? err.message : 'Agent 请求失败')
        const rollback = messagesRef.current.filter((item) => !item.isOptimistic)
        updateMessages(rollback)
        throw err
      } finally {
        setIsLoading(false)
        setIsAwaitingFirstToken(false)
      }
    },
    [applyStreamEvent, backendBaseUrl, documentId, isReady, noteFocus, sessionId, tenantId, uiContext, updateMessages, userId, viewId, workroomId],
  )

  const resumeWithPayload = useCallback(
    async (resumePayload: unknown) => {
      if (!isReady) {
        setError('Agent 尚未完成初始化')
        return
      }

      if (sessionId == null) {
        throw new Error('Agent 会话已丢失，无法从中断点恢复，请重新开始对话')
      }

      if (!pendingInteractionRef.current) {
        throw new Error('当前没有待处理的审批或提问，无法恢复会话')
      }

      setIsLoading(true)
      setIsAwaitingFirstToken(true)
      setCancelRequested(false)
      setError(null)

      try {
        const current = messagesRef.current
        if (!current.length || current[current.length - 1]?.role !== 'assistant') {
          updateMessages([...current, createOptimisticAssistantMessage()])
        }

        const outcome = await sendAgentResumeStream(
          backendBaseUrl,
          {
            workroomId: workroomId ?? 0,
            sessionId,
            resumePayload,
            interaction: pendingInteractionRef.current,
          },
          (event) => {
            applyStreamEvent(event)
          },
        )
        console.info(outcome === 'cancelled' ? '[agent-run] run_cancelled' : '[agent-run] run_completed', {
          sessionId,
          workroomId,
          resumed: true,
        })

        const finalized = messagesRef.current.map((message) =>
          message.role === 'assistant' ? { ...message, isStreaming: false, isOptimistic: false } : { ...message, isOptimistic: false },
        )
        updateMessages(finalized)
        return { messages: finalized }
      } catch (err) {
        console.error('[agent-run] run_failed', err)
        setError(err instanceof Error ? err.message : 'Agent 请求失败')
        throw err
      } finally {
        setIsLoading(false)
        setIsAwaitingFirstToken(false)
      }
    },
    [applyStreamEvent, backendBaseUrl, isReady, sessionId, updateMessages, workroomId],
  )

  const resetChat = useCallback(() => {
    updateMessages([])
    setError(null)
    setSessionId(null)
    pendingInteractionRef.current = null
    setPendingInteraction(null)
  }, [updateMessages])

  const cancelCurrentRun = useCallback(async () => {
    if (!isReady || !sessionId) return
    setError(null)
    setCancelRequested(true)
    console.info('[agent-run] cancel_requested', { sessionId, workroomId })
    try {
      await cancelAgentRun(backendBaseUrl, {
        workroomId: workroomId ?? 0,
        sessionId,
      })
      console.info('[agent-run] cancel_ack', { sessionId, workroomId })
    } catch (err) {
      setCancelRequested(false)
      setError(err instanceof Error ? err.message : 'Agent 中断失败')
      throw err
    }
  }, [backendBaseUrl, isReady, sessionId, workroomId])

  const setMessagesFromHistory = useCallback((next: AgentRunMessage[]) => {
    updateMessages(next.map((message) => {
      if (message.messageInfo && Array.isArray(message.parts)) {
        return normalizeAgentRunMessage({
          info: message.messageInfo,
          parts: message.parts,
        })
      }
      return message
    }))
  }, [updateMessages])

  return {
    isReady,
    messages,
    isLoading,
    isAwaitingFirstToken,
    error,
    sendMessage,
    resumeWithPayload,
    cancelCurrentRun,
    resetChat,
    setMessagesFromHistory,
    pendingInteraction,
    sessionId,
    setSessionId,
    cancelRequested,
  }
}
