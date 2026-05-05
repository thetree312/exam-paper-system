import { useState, useEffect, useCallback, useMemo } from 'react'
import type {
  AgentConversationMeta,
  AgentHistoryMessageDto,
  AgentRunMessage,
} from '../types'
import { useRef } from 'react'
import { useAppStore } from '../store/appStore'
import {
  fetchAgentSessions,
  fetchAgentSessionMessages,
  deleteAgentSession,
  updateAgentSession,
} from '../services/agentApi'
import { pickConversationKey } from './conversationSelection'
import { normalizeAgentRunMessage } from '../lib/agentFacts'
import { ensureMathContentDocument, mathContentToPromptText } from '../lib/mathContent'

interface UseConversationReturn {
  conversations: AgentConversationMeta[]
  setConversations: (convs: AgentConversationMeta[] | ((prev: AgentConversationMeta[]) => AgentConversationMeta[])) => void
  conversationMessages: Record<string, AgentRunMessage[]>
  setConversationMessages: (msgs: Record<string, AgentRunMessage[]> | ((prev: Record<string, AgentRunMessage[]>) => Record<string, AgentRunMessage[]>)) => void
  activeConversationKey: string | null
  setActiveConversationKey: (key: string | null) => void
  conversationResetSignal: number | null
  setConversationResetSignal: (signal: number | null) => void
  conversationsLoaded: boolean
  activeConversation: AgentConversationMeta | null
  activeConversationMessages: AgentRunMessage[]
  upsertConversation: (key: string, updater: (prev: AgentConversationMeta) => AgentConversationMeta) => void
  handleConversationMessagesChange: (
    key: string | null,
    nextMessages: AgentRunMessage[],
    sessionId?: string | null,
  ) => void
  handleCreateConversation: (documentId: string | number | null) => void
  handleSelectConversation: (key: string) => void
  handleDeleteConversation: (key: string) => Promise<void>
  cleanupConversationThread: (threadId?: string | null) => Promise<void>
  handleRenameConversation: (key: string, title: string) => Promise<void>
}

function getMessageText(message: AgentRunMessage | undefined): string {
  if (!message) return ''
  return typeof message.content === 'string'
    ? message.content
    : mathContentToPromptText(ensureMathContentDocument(message.content))
}

const debug = (...args: any[]) => {
  if (import.meta.env?.DEV && (window as any).__AGENT_DEBUG__ === true) {
    console.info('[agent conversations]', ...args)
  }
}

function isTransientHistoryLoadError(error: unknown) {
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('Unexpected end of JSON input') ||
    error.message.includes('Request failed (400)')
  )
}

function mapHistoryMessage(message: AgentHistoryMessageDto): AgentRunMessage {
  return normalizeAgentRunMessage(message)
}

export const useConversation = (
  backendBaseUrl: string,
  options: {
    tenantId: number | null | undefined
    userId: string | number | null | undefined
    workroomId?: string | number | null | undefined
    documentId: string | number | null
    viewId?: string | null
    preferredSessionId?: string | null
  },
): UseConversationReturn => {
  const storeConversations = useAppStore((state) => state.conversations)
  const setStoreConversations = useAppStore((state) => state.setConversations)
  const storeConversationMessages = useAppStore((state) => state.conversationMessages)
  const setStoreConversationMessages = useAppStore((state) => state.setConversationMessages)
  const storeActiveConversationKey = useAppStore((state) => state.activeConversationKey)
  const setStoreActiveConversationKey = useAppStore((state) => state.setActiveConversationKey)

  const [conversationResetSignal, setConversationResetSignal] = useState<number | null>(null)
  const [conversationsLoaded, setConversationsLoaded] = useState(false)
  const scopeKeyRef = useRef<string | null>(null)
  const loadInFlightScopeRef = useRef<string | null>(null)
  const loadTokenRef = useRef(0)
  const historyRequestRef = useRef(new Map<string, Promise<AgentRunMessage[]>>())
  const autoSelectionIntentRef = useRef<string | null>(null)

  const tenantId = options.tenantId ?? null
  const userId = options.userId ?? null
  const workroomId = options.workroomId ?? null
  const documentId = options.documentId ?? null
  const viewId = options.viewId ?? null
  const preferredSessionId = options.preferredSessionId ?? null

  const scopeKey = useMemo(
    () => JSON.stringify({ backendBaseUrl, tenantId, userId, workroomId }),
    [backendBaseUrl, tenantId, userId, workroomId],
  )

  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) return
    scopeKeyRef.current = scopeKey
    loadTokenRef.current += 1
    loadInFlightScopeRef.current = null
    historyRequestRef.current.clear()
    autoSelectionIntentRef.current = null
    setConversationsLoaded(false)
    setStoreConversations([])
    setStoreConversationMessages({})
    setStoreActiveConversationKey(null)
    setConversationResetSignal(null)
  }, [scopeKey, setStoreActiveConversationKey, setStoreConversationMessages, setStoreConversations])

  const fetchHistoryMessages = useCallback(
    async (sessionId: string) => {
      const cached = historyRequestRef.current.get(sessionId)
      if (cached) return cached

      const request = (async () => {
        try {
          const historyResp = await fetchAgentSessionMessages(backendBaseUrl, {
            workroomId: workroomId!,
            sessionId,
            limit: 200,
          })
          return historyResp.messages.map(mapHistoryMessage)
        } catch (error) {
          if (!isTransientHistoryLoadError(error)) {
            throw error
          }
          await new Promise((resolve) => window.setTimeout(resolve, 180))
          const retryResp = await fetchAgentSessionMessages(backendBaseUrl, {
            workroomId: workroomId!,
            sessionId,
            limit: 200,
          })
          return retryResp.messages.map(mapHistoryMessage)
        } finally {
          historyRequestRef.current.delete(sessionId)
        }
      })()

      historyRequestRef.current.set(sessionId, request)
      return request
    },
    [backendBaseUrl, workroomId],
  )

  const activeConversation = useMemo(
    () => storeConversations.find((conv) => conv.key === storeActiveConversationKey) ?? null,
    [storeConversations, storeActiveConversationKey],
  )

  const activeConversationMessages = useMemo(
    () => (storeActiveConversationKey ? storeConversationMessages[storeActiveConversationKey] ?? [] : []),
    [storeConversationMessages, storeActiveConversationKey],
  )

  useEffect(() => {
    if (conversationsLoaded) return
    if (!backendBaseUrl || workroomId == null) return
    if (loadInFlightScopeRef.current === scopeKey) return

    const load = async () => {
      const token = ++loadTokenRef.current
      loadInFlightScopeRef.current = scopeKey
      debug('load start', { workroomId, documentId })
      try {
        const resp = await fetchAgentSessions(backendBaseUrl, {
          workroomId,
          limit: 200,
        })

        const now = Date.now()
        const mapped: AgentConversationMeta[] = resp.items.map((session, index) => ({
          key: `s-${session.id}-${index}`,
          sessionId: session.id,
          tenantId: tenantId ?? 0,
          userId: userId ?? 0,
          documentId: session.document_id ?? documentId ?? null,
          viewId: session.view_id ?? null,
          title: session.title || '',
          lastMessagePreview: session.last_message_preview ?? null,
          messageCount: session.message_count,
          status: session.status,
          archived: Boolean(session.archived),
          createdAt: session.created_at ? Date.parse(session.created_at) || now : now,
          updatedAt: session.updated_at ? Date.parse(session.updated_at) || now : now,
          selectedModel:
            session.selected_model?.provider_id && session.selected_model?.model_id
              ? {
                  providerID: session.selected_model.provider_id,
                  modelID: session.selected_model.model_id,
                  updatedAt: session.selected_model.updated_at,
                }
              : null,
        }))

        let initialKey: string | null = null

        if (mapped.length > 0) {
          initialKey = pickConversationKey({
            conversations: mapped,
            preferredSessionId,
            documentId,
            viewId,
          })
        } else {
          const fallbackKey = `conv-${now}`
          mapped.push({
            key: fallbackKey,
            sessionId: null,
            tenantId: tenantId ?? 0,
            userId: userId ?? 0,
            documentId,
            viewId,
            title: '',
            lastMessagePreview: null,
            messageCount: 0,
            status: 'active',
            archived: false,
            createdAt: now,
            updatedAt: now,
            selectedModel: null,
          })
          initialKey = fallbackKey
        }

        const initialMessages: Record<string, AgentRunMessage[]> = {}
        if (initialKey) {
          const initialMeta = mapped.find((item) => item.key === initialKey)
          if (initialMeta?.sessionId) {
            try {
              initialMessages[initialKey] = await fetchHistoryMessages(initialMeta.sessionId)
            } catch (error) {
              console.warn('[agent conversations] preload messages failed', error)
              initialMessages[initialKey] = []
            }
          } else {
            initialMessages[initialKey] = []
          }
        }

        if (loadTokenRef.current !== token || scopeKeyRef.current !== scopeKey) return
        setStoreConversations(mapped)
        setStoreConversationMessages(initialMessages)
        setStoreActiveConversationKey(initialKey)
        if (initialKey) {
          setConversationResetSignal(Date.now())
        }
      } catch (error) {
        if (loadTokenRef.current !== token || scopeKeyRef.current !== scopeKey) return
        console.warn('[agent conversations] load failed', error)
        const now = Date.now()
        const fallbackKey = `conv-${now}`
        const fallback: AgentConversationMeta = {
          key: fallbackKey,
          sessionId: null,
          tenantId: tenantId ?? 0,
          userId: userId ?? 0,
          documentId,
          viewId: null,
          title: '',
          lastMessagePreview: null,
          messageCount: 0,
          status: 'active',
          archived: false,
          createdAt: now,
          updatedAt: now,
          selectedModel: null,
        }
        setStoreConversations([fallback])
        setStoreConversationMessages({ [fallbackKey]: [] })
        setStoreActiveConversationKey(fallbackKey)
        setConversationResetSignal(now)
      } finally {
        if (loadTokenRef.current === token && scopeKeyRef.current === scopeKey) {
          loadInFlightScopeRef.current = null
          setConversationsLoaded(true)
        }
      }
    }

    void load()
  }, [backendBaseUrl, conversationsLoaded, documentId, fetchHistoryMessages, preferredSessionId, scopeKey, setStoreActiveConversationKey, setStoreConversationMessages, setStoreConversations, tenantId, userId, viewId, workroomId])

  useEffect(() => {
    if (!conversationsLoaded || storeConversations.length === 0) return
    const selectionIntentKey = JSON.stringify({
      preferredSessionId: preferredSessionId ?? null,
      documentId: documentId ?? null,
      viewId: viewId ?? null,
    })
    const intentChanged = autoSelectionIntentRef.current !== selectionIntentKey
    const hasActiveConversation =
      storeActiveConversationKey != null &&
      storeConversations.some((item) => item.key === storeActiveConversationKey)

    if (!intentChanged && hasActiveConversation) return

    const currentActiveConversation =
      storeActiveConversationKey != null
        ? storeConversations.find((item) => item.key === storeActiveConversationKey) ?? null
        : null

    // 用户刚点了“新建对话”时，当前激活项会是一个尚未绑定真实 session 的草稿会话。
    // 这里不能再按 preferredSessionId / documentId 自动切回旧会话，否则 UI 会马上回弹。
    if (currentActiveConversation?.sessionId == null) {
      return
    }

    const nextKey = pickConversationKey({
      conversations: storeConversations,
      preferredSessionId,
      documentId,
      viewId,
    })
    if (!nextKey) return
    autoSelectionIntentRef.current = selectionIntentKey
    if (storeActiveConversationKey === nextKey) return
    setStoreActiveConversationKey(nextKey)
    setConversationResetSignal(Date.now())
  }, [conversationsLoaded, documentId, preferredSessionId, setStoreActiveConversationKey, storeActiveConversationKey, storeConversations, viewId])

  const upsertConversation = useCallback(
    (key: string, updater: (prev: AgentConversationMeta) => AgentConversationMeta) => {
      setStoreConversations((prev) =>
        prev.map((conv) => {
          if (conv.key !== key) return conv
          return updater(conv)
        }),
      )
    },
    [setStoreConversations],
  )

  const handleConversationMessagesChange = useCallback(
    (key: string | null, nextMessages: AgentRunMessage[], sessionIdOverride?: string | null) => {
      if (!key) return
      setStoreConversationMessages((prev) => ({
        ...prev,
        [key]: nextMessages,
      }))

      const now = Date.now()
      const firstUserMessage = nextMessages.find(
        (msg) => msg.role === 'user' && getMessageText(msg).trim(),
      )
      const lastAssistantMessage = [...nextMessages]
        .reverse()
        .find((msg) => msg.role === 'assistant' && getMessageText(msg).trim())

      upsertConversation(key, (prev) => {
        const next: AgentConversationMeta = {
          ...prev,
          messageCount: nextMessages.length,
          updatedAt: now,
        }
        if (sessionIdOverride != null) {
          next.sessionId = sessionIdOverride
        }

        if (key === storeActiveConversationKey && firstUserMessage) {
          const snippet = getMessageText(firstUserMessage).trim().slice(0, 32)
          if (!next.title) {
            next.title = snippet || next.title
          }
        }

        if (nextMessages.length === 0) {
          next.lastMessagePreview = null
        } else if (lastAssistantMessage) {
          next.lastMessagePreview = getMessageText(lastAssistantMessage).trim().slice(0, 48)
        } else if (firstUserMessage) {
          next.lastMessagePreview = getMessageText(firstUserMessage).trim().slice(0, 48)
        }

        return next
      })
    },
    [setStoreConversationMessages, storeActiveConversationKey, upsertConversation],
  )

  const handleCreateConversation = useCallback(
    (documentId: string | number | null) => {
      const key = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const now = Date.now()
      const meta: AgentConversationMeta = {
        key,
        title: '',
        sessionId: null,
        tenantId: tenantId ?? 0,
        userId: userId ?? 0,
        documentId: documentId ?? null,
        viewId,
        lastMessagePreview: null,
        messageCount: 0,
        status: 'active',
        archived: false,
        createdAt: now,
        updatedAt: now,
        selectedModel: null,
      }
      setStoreConversations((prev) => [meta, ...prev])
      setStoreConversationMessages((prev) => ({ ...prev, [key]: [] }))
      setStoreActiveConversationKey(key)
      setConversationResetSignal(now)
    },
    [setStoreActiveConversationKey, setStoreConversationMessages, setStoreConversations, tenantId, userId, viewId],
  )

  const handleSelectConversation = useCallback(
    async (key: string) => {
      const meta = storeConversations.find((conv) => conv.key === key)
      if (!meta) return
      const alreadyActive = storeActiveConversationKey === key
      if (alreadyActive && storeConversationMessages[key] !== undefined) {
        return
      }
      setStoreActiveConversationKey(key)

      if (storeConversationMessages[key] !== undefined) {
        setConversationResetSignal(Date.now())
        return
      }

      if (backendBaseUrl && workroomId != null && meta.sessionId) {
        try {
          const historyMessages = await fetchHistoryMessages(meta.sessionId)
          setStoreConversationMessages((prev) => ({
            ...prev,
            [key]: historyMessages,
          }))
        } catch (error) {
          console.warn('[agent conversations] load messages failed', error)
        }
      }

      setConversationResetSignal(Date.now())
    },
    [backendBaseUrl, fetchHistoryMessages, setStoreActiveConversationKey, setStoreConversationMessages, storeActiveConversationKey, storeConversationMessages, storeConversations, workroomId],
  )

  const cleanupConversationThread = useCallback(async (_threadId?: string | null) => {
    return
  }, [])

  const handleDeleteConversation = useCallback(
    async (key: string) => {
      const meta = storeConversations.find((conv) => conv.key === key)
      if (!meta) return

      if (backendBaseUrl && workroomId != null && meta.sessionId) {
        try {
          await deleteAgentSession(backendBaseUrl, meta.sessionId, {
            workroomId,
          })
        } catch (error) {
          console.warn('[agent conversations] delete session failed', error)
        }
      }

      setStoreConversations((prev) => prev.filter((conv) => conv.key !== key))
      setStoreConversationMessages((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      if (storeActiveConversationKey === key) {
        const fallback = storeConversations.find((conv) => conv.key !== key)
        if (fallback) {
          setStoreActiveConversationKey(fallback.key)
          setConversationResetSignal(Date.now())
        } else {
          handleCreateConversation(null)
        }
      }
    },
    [backendBaseUrl, handleCreateConversation, setStoreActiveConversationKey, setStoreConversationMessages, setStoreConversations, storeActiveConversationKey, storeConversations, workroomId],
  )

  const handleRenameConversation = useCallback(
    async (key: string, title: string) => {
      const meta = storeConversations.find((conv) => conv.key === key)
      if (!meta) return

      const nextTitle = title.trim()
      setStoreConversations((prev) =>
        prev.map((conv) => (conv.key === key ? { ...conv, title: nextTitle } : conv)),
      )

      if (backendBaseUrl && workroomId != null && meta.sessionId) {
        try {
          await updateAgentSession(backendBaseUrl, meta.sessionId, {
            workroomId,
            title: nextTitle,
          })
        } catch (error) {
          console.warn('[agent conversations] rename session failed', error)
        }
      }
    },
    [backendBaseUrl, setStoreConversations, storeConversations, workroomId],
  )

  return {
    conversations: storeConversations,
    setConversations: setStoreConversations,
    conversationMessages: storeConversationMessages,
    setConversationMessages: setStoreConversationMessages,
    activeConversationKey: storeActiveConversationKey,
    setActiveConversationKey: setStoreActiveConversationKey,
    conversationResetSignal,
    setConversationResetSignal,
    conversationsLoaded,
    activeConversation,
    activeConversationMessages,
    upsertConversation,
    handleConversationMessagesChange,
    handleCreateConversation,
    handleSelectConversation,
    handleDeleteConversation,
    cleanupConversationThread,
    handleRenameConversation,
  }
}
