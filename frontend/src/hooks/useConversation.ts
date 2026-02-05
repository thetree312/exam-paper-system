import { useState, useEffect, useCallback, useMemo } from 'react'
import type {
  AgentConversationMeta,
  AgentHistoryMessageDto,
  AgentRunMessage,
} from '../types'
import { useAppStore } from '../store/appStore'
import {
  fetchAgentSessions,
  fetchAgentSessionMessages,
  deleteAgentSession,
  updateAgentSession,
} from '../services/agentApi'

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
    sessionId?: number | null,
  ) => void
  handleCreateConversation: (agentDocumentId: number | null) => void
  handleSelectConversation: (key: string) => void
  handleDeleteConversation: (key: string) => Promise<void>
  cleanupConversationThread: (threadId?: string | null) => Promise<void>
  handleRenameConversation: (key: string, title: string) => Promise<void>
}

const debug = (...args: any[]) => {
  if (import.meta.env?.DEV) {
    console.info('[agent conversations]', ...args)
  }
}

export const useConversation = (
  backendBaseUrl: string,
  options: { tenantId: number | null | undefined; userId: number | null | undefined; documentId: number | null },
): UseConversationReturn => {
  const storeConversations = useAppStore((state) => state.conversations)
  const setStoreConversations = useAppStore((state) => state.setConversations)
  const storeConversationMessages = useAppStore((state) => state.conversationMessages)
  const setStoreConversationMessages = useAppStore((state) => state.setConversationMessages)
  const storeActiveConversationKey = useAppStore((state) => state.activeConversationKey)
  const setStoreActiveConversationKey = useAppStore((state) => state.setActiveConversationKey)

  const [conversationResetSignal, setConversationResetSignal] = useState<number | null>(null)
  const [conversationsLoaded, setConversationsLoaded] = useState(false)

  const tenantId = options.tenantId ?? null
  const userId = options.userId ?? null
  const documentId = options.documentId ?? null

  const activeConversation = useMemo(
    () => storeConversations.find((conv) => conv.key === storeActiveConversationKey) ?? null,
    [storeConversations, storeActiveConversationKey],
  )

  const activeConversationMessages = useMemo(
    () => (storeActiveConversationKey ? storeConversationMessages[storeActiveConversationKey] ?? [] : []),
    [storeConversationMessages, storeActiveConversationKey],
  )

  // 加载会话数据
  useEffect(() => {
    if (conversationsLoaded) return
    if (!backendBaseUrl || tenantId == null || userId == null) return

    const load = async () => {
      debug('load start', { tenantId, userId, documentId })
      try {
        const resp = await fetchAgentSessions(backendBaseUrl, {
          tenantId,
          userId,
          documentId: documentId ?? undefined,
          viewId: undefined,
          includeArchived: false,
        })

        debug('sessions fetched', resp.sessions.length, resp.sessions)

        const now = Date.now()
        const mapped: AgentConversationMeta[] = resp.sessions.map((s, index) => ({
          key: `s-${s.id}-${index}`,
          sessionId: s.id,
          tenantId: s.tenant_id,
          userId: s.user_id,
          documentId: s.document_id ?? null,
          viewId: s.view_id ?? null,
          title: s.title || '新的会话',
          lastMessagePreview: s.last_message_preview ?? null,
          messageCount: s.message_count,
          status: s.status,
          archived: s.archived,
          createdAt: Date.parse(s.created_at) || now,
          updatedAt: Date.parse(s.updated_at) || now,
        }))

        let initialKey: string | null = null
        if (mapped.length > 0) {
          initialKey = mapped[0].key
        } else {
          const fallbackKey = `conv-${now}`
          mapped.push({
            key: fallbackKey,
            sessionId: null,
            tenantId: tenantId,
            userId: userId,
            documentId: documentId,
            viewId: null,
            title: '新的会话',
            lastMessagePreview: null,
            messageCount: 0,
            status: 'active',
            archived: false,
            createdAt: now,
            updatedAt: now,
          })
          initialKey = fallbackKey
        }

        // 为初始激活会话预取历史消息，保证刷新后能立即展示历史
        const initialMessages: Record<string, AgentRunMessage[]> = {}
        if (initialKey) {
          const initialMeta = mapped.find((m) => m.key === initialKey)
          if (initialMeta && initialMeta.sessionId && backendBaseUrl && tenantId != null && userId != null) {
            try {
              const historyResp = await fetchAgentSessionMessages(backendBaseUrl, {
                tenantId,
                userId,
                sessionId: initialMeta.sessionId,
                limit: 200,
              })
              initialMessages[initialKey] = historyResp.messages.map((m: AgentHistoryMessageDto) => ({
                role: m.role === 'assistant' || m.role === 'user' ? m.role : 'assistant',
                content: m.content,
                id: m.id,
                created_at: m.created_at,
              }))
              debug('initial history fetched', { key: initialKey, count: historyResp.messages.length })
            } catch (e) {
              console.warn('[agent conversations] preload messages failed', e)
              initialMessages[initialKey] = []
            }
          } else {
            initialMessages[initialKey] = []
          }
        }

        setStoreConversations(mapped)
        setStoreConversationMessages(initialMessages)
        setStoreActiveConversationKey(initialKey)
        if (initialKey) {
          debug('initial active conversation set', {
            key: initialKey,
            sessionId: mapped.find((m) => m.key === initialKey)?.sessionId,
            messageCount: initialMessages[initialKey]?.length ?? 0,
          })
          setConversationResetSignal(Date.now())
        }
      } catch (err) {
        console.warn('[agent conversations] load failed', err)
        const now = Date.now()
        const fallbackKey = `conv-${now}`
        const fallback: AgentConversationMeta = {
          key: fallbackKey,
          sessionId: null,
          tenantId: tenantId ?? 0,
          userId: userId ?? 0,
          documentId: documentId,
          viewId: null,
          title: '新的会话',
          lastMessagePreview: null,
          messageCount: 0,
          status: 'active',
          archived: false,
          createdAt: now,
          updatedAt: now,
        }
        setStoreConversations([fallback])
        setStoreConversationMessages({ [fallbackKey]: [] })
        setStoreActiveConversationKey(fallbackKey)
        setConversationResetSignal(now)
      } finally {
        setConversationsLoaded(true)
      }
    }

    load()
  }, [backendBaseUrl, tenantId, userId, documentId, conversationsLoaded, setStoreActiveConversationKey, setStoreConversationMessages, setStoreConversations])

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
    (key: string | null, nextMessages: AgentRunMessage[], sessionIdOverride?: number | null) => {
      if (!key) return
      debug('messages change', {
        key,
        sessionIdOverride,
        nextMessageCount: nextMessages.length,
        firstMessage: nextMessages[0],
      })
      setStoreConversationMessages((prev) => ({
        ...prev,
        [key]: nextMessages,
      }))

      const now = Date.now()
      const firstUserMessage = nextMessages.find(
        (msg) => msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim(),
      )
      const lastAssistantMessage = [...nextMessages]
        .reverse()
        .find((msg) => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim())

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
          const snippet = firstUserMessage.content.trim().slice(0, 32)
          if (!next.title || next.title === '新的会话') {
            next.title = snippet || next.title
          }
        }

        if (nextMessages.length === 0) {
          next.lastMessagePreview = null
        } else if (lastAssistantMessage?.content) {
          next.lastMessagePreview = lastAssistantMessage.content.trim().slice(0, 48)
        } else if (firstUserMessage?.content) {
          next.lastMessagePreview = firstUserMessage.content.trim().slice(0, 48)
        }

        return next
      })
    },
    [storeActiveConversationKey, upsertConversation, setStoreConversationMessages],
  )

  const handleCreateConversation = useCallback(
    (agentDocumentId: number | null) => {
      const key = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const now = Date.now()
      const meta: AgentConversationMeta = {
        key,
        title: '新的会话',
        sessionId: null,
        tenantId: tenantId ?? 0,
        userId: userId ?? 0,
        documentId: agentDocumentId ?? null,
        viewId: null,
        lastMessagePreview: null,
        messageCount: 0,
        status: 'active',
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      setStoreConversations((prev) => [meta, ...prev])
      setStoreConversationMessages((prev) => ({ ...prev, [key]: [] }))
      setStoreActiveConversationKey(key)
      setConversationResetSignal(now)
      debug('created local conversation', { key })
    },
    [setStoreConversations, setStoreConversationMessages, setStoreActiveConversationKey, tenantId, userId],
  )

  const handleSelectConversation = useCallback(
    async (key: string) => {
      const meta = storeConversations.find((conv) => conv.key === key)
      if (!meta) return
      setStoreActiveConversationKey(key)
      debug('select conversation', { key, sessionId: meta.sessionId })

      if (backendBaseUrl && tenantId != null && userId != null && meta.sessionId) {
        try {
          const resp = await fetchAgentSessionMessages(backendBaseUrl, {
            tenantId,
            userId,
            sessionId: meta.sessionId,
            limit: 200,
          })

          const historyMessages: AgentRunMessage[] = resp.messages.map((m: AgentHistoryMessageDto) => ({
            role: m.role === 'assistant' || m.role === 'user' ? m.role : 'assistant',
            content: m.content,
            id: m.id,
            created_at: m.created_at,
          }))

          setStoreConversationMessages((prev) => ({
            ...prev,
            [key]: historyMessages,
          }))
          debug('loaded history for selection', { key, sessionId: meta.sessionId, count: historyMessages.length })
        } catch (err) {
          console.warn('[agent conversations] load messages failed', err)
        }
      }

      setConversationResetSignal(Date.now())
      debug('emit conversation reset after select', { key })
    },
    [
      backendBaseUrl,
      storeConversations,
      setStoreActiveConversationKey,
      setStoreConversationMessages,
      setConversationResetSignal,
      tenantId,
      userId,
    ],
  )

  const cleanupConversationThread = useCallback(async (_threadId?: string | null) => {
    // 线程已由后端按 sessionId 管理，这里不再做额外清理
  }, [])

  const handleDeleteConversation = useCallback(
    async (key: string) => {
      const meta = storeConversations.find((conv) => conv.key === key)
      if (!meta) return

      if (backendBaseUrl && tenantId != null && userId != null && meta.sessionId) {
        try {
          await deleteAgentSession(backendBaseUrl, meta.sessionId, {
            tenantId,
            userId,
          })
          debug('deleted session', { key, sessionId: meta.sessionId })
        } catch (err) {
          console.warn('[agent conversations] delete session failed', err)
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
          debug('switch to fallback after delete', { fallbackKey: fallback.key })
        } else {
          handleCreateConversation(null)
        }
      }
    },
    [
      backendBaseUrl,
      storeActiveConversationKey,
      storeConversations,
      handleCreateConversation,
      setStoreConversations,
      setStoreConversationMessages,
      setStoreActiveConversationKey,
      tenantId,
      userId,
    ],
  )

  const handleRenameConversation = useCallback(
    async (key: string, title: string) => {
      const meta = storeConversations.find((conv) => conv.key === key)
      if (!meta) return

      const nextTitle = title.trim() || '新的会话'
      setStoreConversations((prev) =>
        prev.map((conv) => (conv.key === key ? { ...conv, title: nextTitle } : conv)),
      )
      debug('rename conversation', { key, nextTitle })

      if (backendBaseUrl && tenantId != null && userId != null && meta.sessionId) {
        try {
          await updateAgentSession(backendBaseUrl, meta.sessionId, {
            tenantId,
            userId,
            title: nextTitle,
          })
        } catch (err) {
          console.warn('[agent conversations] rename session failed', err)
        }
      }
    },
    [backendBaseUrl, storeConversations, setStoreConversations, tenantId, userId],
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
