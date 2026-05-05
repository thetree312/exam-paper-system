import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSnapshotResponse, QuestionSyncPayload, QuestionSyncResponse } from '../types'
import { fetchSnapshot, syncQuestion as syncQuestionApi } from '../services/agentApi'
import { buildQuestionSyncPayload } from './useAgentSync.helpers'

interface UseAgentSyncOptions {
  backendBaseUrl: string
  tenantId?: number | null
  userId?: string | number | null
  workroomId?: string | number | null
  initialStudioDocumentId?: string | number | null
  initialSourceDocumentId?: string | number | null
  debounceMs?: number
}

interface SyncQuestionInput
  extends Omit<QuestionSyncPayload, 'tenantId' | 'userId' | 'workroomId' | 'studioDocumentId'> {
  studioDocumentId?: string | number | null
}

export function useAgentSync({
  backendBaseUrl,
  tenantId,
  userId,
  workroomId,
  initialStudioDocumentId = null,
  initialSourceDocumentId = null,
  debounceMs = 800,
}: UseAgentSyncOptions) {
  const [studioDocumentId, setStudioDocumentId] = useState<string | number | null>(initialStudioDocumentId)
  const [sourceDocumentId, setSourceDocumentId] = useState<string | number | null>(initialSourceDocumentId)
  const [isSyncing, setIsSyncing] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<AgentSnapshotResponse | null>(null)

  const pendingPayload = useRef<QuestionSyncPayload | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isReady = useMemo(
    () => Boolean(backendBaseUrl && userId != null && workroomId != null),
    [backendBaseUrl, userId, workroomId],
  )

  useEffect(() => {
    if (initialStudioDocumentId === undefined) return
    setStudioDocumentId(initialStudioDocumentId ?? null)
  }, [initialStudioDocumentId])

  useEffect(() => {
    if (initialSourceDocumentId === undefined) return
    setSourceDocumentId(initialSourceDocumentId ?? null)
  }, [initialSourceDocumentId])

  const runSync = useCallback(
    async (payload: QuestionSyncPayload): Promise<QuestionSyncResponse> => {
      if (!isReady) {
        throw new Error('Agent sync is not ready (missing tenant/user/backend url)')
      }
      setIsSyncing(true)
      setError(null)
      try {
        const resp = await syncQuestionApi(backendBaseUrl, payload)
        const resolvedStudioDocumentId = resp.studio_document_id ?? payload.studioDocumentId ?? null
        const resolvedSourceDocumentId = resp.source_document_id ?? payload.sourceDocumentId ?? null
        setStudioDocumentId(resolvedStudioDocumentId)
        setSourceDocumentId(resolvedSourceDocumentId)
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
      if (userId == null || workroomId == null) {
        throw new Error('缺少 userId 或 workroomId，无法同步题目')
      }
      const payload: QuestionSyncPayload = buildQuestionSyncPayload(
        {
          tenantId: tenantId ?? 0,
          userId,
          workroomId,
          fallbackStudioDocumentId: studioDocumentId,
          fallbackSourceDocumentId: sourceDocumentId,
        },
        input,
      )
      return runSync(payload)
    },
    [runSync, sourceDocumentId, studioDocumentId, tenantId, userId, workroomId],
  )

  const flushPending = useCallback(async () => {
    if (!pendingPayload.current) return
    const payload = pendingPayload.current
    pendingPayload.current = null
    await runSync(payload)
  }, [runSync])

  const syncDebounced = useCallback(
    (input: SyncQuestionInput) => {
      if (userId == null || workroomId == null) return
      pendingPayload.current = buildQuestionSyncPayload(
        {
          tenantId: tenantId ?? 0,
          userId,
          workroomId,
          fallbackStudioDocumentId: studioDocumentId,
          fallbackSourceDocumentId: sourceDocumentId,
        },
        input,
      )
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
      debounceTimer.current = setTimeout(() => {
        flushPending().catch(() => {
          /* error state already handled */
        })
      }, debounceMs)
    },
    [debounceMs, flushPending, sourceDocumentId, studioDocumentId, tenantId, userId, workroomId],
  )

  const loadSnapshot = useCallback(
    async (targetStudioDocumentId?: string | number | null) => {
      const resolvedStudioDocumentId = targetStudioDocumentId ?? studioDocumentId
      if (!resolvedStudioDocumentId || userId == null || workroomId == null) return
      try {
        const resp = await fetchSnapshot(
          backendBaseUrl,
          tenantId ?? 0,
          userId,
          workroomId,
          resolvedStudioDocumentId,
        )
        const normalized = {
          ...resp,
          studio_document_id: resp.studio_document_id ?? resolvedStudioDocumentId,
        } as AgentSnapshotResponse
        setSnapshot(normalized)
        return normalized
      } catch (err) {
        setError(err instanceof Error ? err.message : '获取快照失败')
        return null
      }
    },
    [backendBaseUrl, studioDocumentId, tenantId, userId, workroomId],
  )

  return {
    isReady,
    studioDocumentId,
    sourceDocumentId,
    isSyncing,
    lastSavedAt,
    error,
    snapshot,
    syncImmediate,
    syncDebounced,
    flushPending,
    loadSnapshot,
    setStudioDocumentId,
    setSourceDocumentId,
  }
}
