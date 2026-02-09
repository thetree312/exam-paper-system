import { useCallback, useEffect, useMemo, useState } from 'react'
import { createQuestionType, getQuestionTypes } from '../services/questionTypesApi'

const DEFAULT_QUESTION_TYPES = [
  '单选题',
  '多选题',
  '填空题',
  '解答题',
  '判断题',
  '简答题',
]

function sanitizeNames(names: string[] = []): string[] {
  return names
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter((name, index, arr) => Boolean(name) && arr.indexOf(name) === index)
}

function mergeWithDefaults(fetched: string[]): string[] {
  const cleaned = sanitizeNames(fetched)
  const defaultsNotInFetched = DEFAULT_QUESTION_TYPES.filter((name) => !cleaned.includes(name))
  const sortedFetched = [...cleaned].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  return [...defaultsNotInFetched, ...sortedFetched]
}

export interface UseQuestionTypeOptionsParams {
  backendBaseUrl?: string
  tenantId?: number | null
  enabled?: boolean
  seedOptions?: string[]
}

export function useQuestionTypeOptions({
  backendBaseUrl,
  tenantId,
  enabled = true,
  seedOptions = [],
}: UseQuestionTypeOptionsParams) {
  const [fetchedOptions, setFetchedOptions] = useState<string[]>([])
  const [customOptions, setCustomOptions] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const seedNames = useMemo(() => sanitizeNames(seedOptions), [seedOptions])

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false)
      return
    }
    if (!backendBaseUrl || !tenantId) {
      setFetchedOptions([])
      setError(null)
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)
    getQuestionTypes(backendBaseUrl, tenantId)
      .then((types) => {
        if (cancelled) return
        const names = sanitizeNames(types.map((t) => t.name))
        setFetchedOptions(names)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[useQuestionTypeOptions] load failed', err)
        setFetchedOptions([])
        setError(err instanceof Error ? err.message : '加载题型失败')
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, tenantId, enabled, refreshToken])

  const options = useMemo(() => {
    return mergeWithDefaults([...seedNames, ...fetchedOptions, ...customOptions])
  }, [seedNames, fetchedOptions, customOptions])

  const refresh = useCallback(() => {
    setRefreshToken((prev) => prev + 1)
  }, [])

  const ensureQuestionTypeExists = useCallback(
    async (name: string) => {
      const trimmed = (name ?? '').trim()
      if (!trimmed) return ''
      if (!backendBaseUrl || !tenantId) return trimmed

      try {
        const created = await createQuestionType(backendBaseUrl, tenantId, trimmed)
        setCustomOptions((prev) => {
          if (prev.includes(created.name)) {
            return prev
          }
          return [...prev, created.name]
        })
        return created.name
      } catch (err) {
        console.error('[useQuestionTypeOptions] ensure failed', err)
        throw err
      }
    },
    [backendBaseUrl, tenantId],
  )

  return {
    options,
    isLoading,
    error,
    refresh,
    ensureQuestionTypeExists,
  }
}
