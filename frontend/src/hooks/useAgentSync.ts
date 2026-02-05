import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSnapshotResponse, QuestionSyncPayload, QuestionSyncResponse } from '../types'
import { fetchSnapshot, syncQuestion as syncQuestionApi } from '../services/agentApi'

interface UseAgentSyncOptions {
  backendBaseUrl: string
  tenantId?: number | null
  userId?: number | null
  initialDocumentId?: number | null
  debounceMs?: number
}

interface SyncQuestionInput
  extends Omit<QuestionSyncPayload, 'tenantId' | 'userId' | 'documentId'> {
  documentId?: number | null
}

export function useAgentSync({
  backendBaseUrl,
  tenantId,
  userId,
  initialDocumentId = null,
  debounceMs = 800,
}: UseAgentSyncOptions) {
  const [documentId, setDocumentId] = useState<number | null>(initialDocumentId)
  const [isSyncing, setIsSyncing] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<AgentSnapshotResponse | null>(null)

  const pendingPayload = useRef<QuestionSyncPayload | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isReady = useMemo(() => Boolean(backendBaseUrl && tenantId && userId), [backendBaseUrl, tenantId, userId])

  useEffect(() => {
    if (initialDocumentId === undefined) return
    setDocumentId(initialDocumentId ?? null)
  }, [initialDocumentId])

  const runSync = useCallback(
    async (payload: QuestionSyncPayload): Promise<QuestionSyncResponse> => {
      if (!isReady) {
        throw new Error('Agent sync is not ready (missing tenant/user/backend url)')
      }
      setIsSyncing(true)
      setError(null)
      try {
        const resp = await syncQuestionApi(backendBaseUrl, payload)
        setDocumentId(resp.document_id)
        setLastSavedAt(Date.now())
        return resp
      } catch (err) {
        const message = err instanceof Error ? err.message : '同步失败'
        setError(message)
        throw err
      } finally {
        setIsSyncing(false)
      }
    },
    [backendBaseUrl, isReady],
  )

  const syncImmediate = useCallback(
    async (input: SyncQuestionInput) => {
      if (!tenantId || !userId) {
        throw new Error('缺少 tenantId 或 userId，无法同步题目')
      }
      const payload: QuestionSyncPayload = {
        tenantId,
        userId,
        documentId: input.documentId ?? documentId ?? undefined,
        ...input,
      }
      return runSync(payload)
    },
    [documentId, runSync, tenantId, userId],
  )

  const flushPending = useCallback(async () => {
    if (!pendingPayload.current) return
    const payload = pendingPayload.current
    pendingPayload.current = null
    await runSync(payload)
  }, [runSync])

  const syncDebounced = useCallback(
    (input: SyncQuestionInput) => {
      if (!tenantId || !userId) return
      pendingPayload.current = {
        tenantId,
        userId,
        documentId: input.documentId ?? documentId ?? undefined,
        ...input,
      }
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
      debounceTimer.current = setTimeout(() => {
        flushPending().catch(() => {
          /* error state already handled */
        })
      }, debounceMs)
    },
    [debounceMs, documentId, flushPending, tenantId, userId],
  )

  const loadSnapshot = useCallback(
    async (targetDocumentId?: number | null) => {
      const resolvedId = targetDocumentId ?? documentId
      if (!resolvedId || !tenantId) return
      try {
        const resp = await fetchSnapshot(backendBaseUrl, tenantId, resolvedId)
        setSnapshot(resp)
        return resp
      } catch (err) {
        setError(err instanceof Error ? err.message : '获取快照失败')
        return null
      }
    },
    [backendBaseUrl, documentId, tenantId],
  )

  return {
    isReady,
    documentId,
    isSyncing,
    lastSavedAt,
    error,
    snapshot,
    syncImmediate,
    syncDebounced,
    flushPending,
    loadSnapshot,
    setDocumentId,
  }
}
