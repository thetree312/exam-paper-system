import { useCallback, useEffect, useRef } from 'react'

export function useFillBlankNavigation(totalBlanks: number) {
  const refs = useRef<(HTMLInputElement | null)[]>([])

  const register = useCallback(
    (index: number) => (el: HTMLInputElement | null) => {
      refs.current[index] = el
    },
    [],
  )

  const focusAt = useCallback((index: number) => {
    if (index < 0 || index >= totalBlanks) return
    const el = refs.current[index]
    if (el) {
      el.focus()
      const len = el.value.length
      try {
        el.setSelectionRange(len, len)
      } catch {
        // ignore
      }
    }
  }, [totalBlanks])

  const focusNext = useCallback(
    (current: number) => {
      const next = current + 1
      if (next < totalBlanks) {
        focusAt(next)
      }
    },
    [focusAt, totalBlanks],
  )

  const focusPrev = useCallback(
    (current: number) => {
      const prev = current - 1
      if (prev >= 0) {
        focusAt(prev)
      }
    },
    [focusAt],
  )

  // 默认聚焦第一个空
  useEffect(() => {
    if (totalBlanks > 0) {
      focusAt(0)
    }
  }, [totalBlanks, focusAt])

  return { register, focusNext, focusPrev }
}
