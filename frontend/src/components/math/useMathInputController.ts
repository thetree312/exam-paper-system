import { useCallback, useEffect, useRef, useState } from 'react'
import type { MathTranslationResponse } from '../../types'
import { translateMathInput } from '../../services/mathInputApi'

export type FragmentWindow = {
  start: number
  end: number
  text: string
  left: string
  right: string
  version: number
}

export type MathInputControllerState = {
  isTranslating: boolean
  activeFragment: FragmentWindow | null
  shadowLatex: string
  lastAppliedVersion: number
}

type RequestHandlers = {
  apply: (replacement: string, response: MathTranslationResponse, fragment: FragmentWindow) => void
  validate: () => boolean
}

interface UseMathInputControllerOptions {
  enabled: boolean
  backendBaseUrl?: string
  userId?: string | number
  debounceMs?: number
  stableMs?: number
  highConfidence?: number
}

const DEFAULT_DEBOUNCE = 300
const DEFAULT_STABLE = 260
const DEFAULT_HIGH_CONFIDENCE = 0.85

export function useMathInputController({
  enabled,
  backendBaseUrl,
  userId,
  debounceMs = DEFAULT_DEBOUNCE,
  stableMs = DEFAULT_STABLE,
  highConfidence = DEFAULT_HIGH_CONFIDENCE,
}: UseMathInputControllerOptions) {
  const [state, setState] = useState<MathInputControllerState>({
    isTranslating: false,
    activeFragment: null,
    shadowLatex: '',
    lastAppliedVersion: -1,
  })

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestSeqRef = useRef(0)
  const latestVersionRef = useRef(-1)
  const pendingRef = useRef<{
    fragment: FragmentWindow
    response: MathTranslationResponse
    handlers: RequestHandlers
  } | null>(null)

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const clearStable = useCallback(() => {
    if (stableTimerRef.current) {
      clearTimeout(stableTimerRef.current)
      stableTimerRef.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    clearDebounce()
    clearStable()
    abortRef.current?.abort()
    abortRef.current = null
    pendingRef.current = null
    setState((prev) => ({
      ...prev,
      isTranslating: false,
      activeFragment: null,
      shadowLatex: '',
    }))
  }, [clearDebounce, clearStable])

  const applyIfStable = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    if (pending.fragment.version !== latestVersionRef.current) return
    if ((pending.response.confidence ?? 0) < highConfidence) return
    if (!pending.handlers.validate()) return

    const replacement = pending.response.rendered_latex || pending.response.translated_text || pending.fragment.text
    pending.handlers.apply(replacement, pending.response, pending.fragment)
    pendingRef.current = null
    setState((prev) => ({
      ...prev,
      lastAppliedVersion: pending.fragment.version,
      shadowLatex: replacement,
    }))
  }, [highConfidence])

  const request = useCallback(
    (fragment: FragmentWindow, handlers: RequestHandlers) => {
      if (!enabled || !backendBaseUrl || userId == null) return

      latestVersionRef.current = fragment.version
      clearDebounce()
      clearStable()
      pendingRef.current = null

      setState((prev) => ({
        ...prev,
        activeFragment: fragment,
      }))

      debounceTimerRef.current = setTimeout(async () => {
        requestSeqRef.current += 1
        const seq = requestSeqRef.current
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        setState((prev) => ({
          ...prev,
          isTranslating: true,
          activeFragment: fragment,
        }))

        try {
          const response = await translateMathInput(backendBaseUrl, fragment.text, controller.signal)
          if (seq !== requestSeqRef.current) return
          if (fragment.version !== latestVersionRef.current) return

          const shadowLatex = response.rendered_latex || response.translated_text || fragment.text
          pendingRef.current = {
            fragment,
            response,
            handlers,
          }
          setState((prev) => ({
            ...prev,
            isTranslating: false,
            activeFragment: fragment,
            shadowLatex,
          }))

          stableTimerRef.current = setTimeout(() => {
            applyIfStable()
          }, stableMs)
        } catch (error) {
          if ((error as Error).name !== 'AbortError') {
            pendingRef.current = null
            setState((prev) => ({
              ...prev,
              isTranslating: false,
              shadowLatex: '',
            }))
          }
        } finally {
          if (seq === requestSeqRef.current) {
            setState((prev) => ({
              ...prev,
              isTranslating: false,
            }))
          }
        }
      }, debounceMs)
    },
    [applyIfStable, backendBaseUrl, clearDebounce, clearStable, debounceMs, enabled, stableMs, userId],
  )

  useEffect(() => {
    if (!enabled || !backendBaseUrl || userId == null) {
      cancel()
    }
  }, [backendBaseUrl, cancel, enabled, userId])

  useEffect(() => {
    return () => {
      clearDebounce()
      clearStable()
      abortRef.current?.abort()
    }
  }, [clearDebounce, clearStable])

  return {
    state,
    request,
    cancel,
    applyIfStable,
  }
}

