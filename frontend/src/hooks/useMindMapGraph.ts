import { useCallback, useEffect, useRef, useState } from 'react'
import type { MindMapGraphResponse, MindMapSourceRef } from '../types'
import { fetchMindMapGraph } from '../services/mindMapApi'

interface UseMindMapGraphResult {
  data: MindMapGraphResponse | null
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export function useMindMapGraph(
  backendBaseUrl: string,
  source: MindMapSourceRef | null,
  tenantId: number | null,
  userId: number | null,
): UseMindMapGraphResult {
  const [data, setData] = useState<MindMapGraphResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(() => {
    const hasTarget = Boolean(source && tenantId)
    if (!hasTarget) {
      setData(null)
      setError(null)
      setIsLoading(false)
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
      return
    }

    if (abortRef.current) {
      abortRef.current.abort()
    }

    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)
    setError(null)

    const storageKey = source
      ? `mindmap:${source.sourceType}:${source.sourceId}:${source.kind ?? 'knowledge'}`
      : null

    fetchMindMapGraph(
      backendBaseUrl,
      source!,
      {
        tenantId: tenantId!,
        userId: userId ?? null,
        signal: controller.signal,
      },
    )
      .then((resp) => {
        setData(resp)
        if (storageKey && typeof window !== 'undefined') {
          try {
            window.sessionStorage.setItem(storageKey, JSON.stringify(resp))
          } catch {
            // ignore storage errors
          }
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        console.error('[mindmap] fetch failed', err)
        setError(err instanceof Error ? err.message : '未知错误')
        setData(null)
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      })
  }, [backendBaseUrl, source, tenantId, userId])

  useEffect(() => {
    // 每次 source / tenant 变化或重新挂载时，先尝试从 sessionStorage 中恢复缓存，避免重复请求
    const hasTarget = Boolean(source && tenantId)

    if (hasTarget && typeof window !== 'undefined') {
      const storageKey = source
        ? `mindmap:${source.sourceType}:${source.sourceId}:${source.kind ?? 'knowledge'}`
        : null

      if (storageKey) {
        try {
          const raw = window.sessionStorage.getItem(storageKey)
          if (raw) {
            const parsed = JSON.parse(raw) as MindMapGraphResponse
            setData(parsed)
            setError(null)
            setIsLoading(false)
          } else {
            setData(null)
          }
        } catch {
          // ignore parse/storage errors
        }
      }
    } else {
      setData(null)
      setError(null)
      setIsLoading(false)
    }

    return () => {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [source, tenantId])

  return { data, isLoading, error, refresh }
}
