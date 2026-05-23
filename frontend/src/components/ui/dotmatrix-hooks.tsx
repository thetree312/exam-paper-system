import { useEffect, useMemo, useRef, useState } from 'react'

export type DotMatrixPhase = 'idle' | 'collapse' | 'hoverRipple' | 'loadingRipple'

export function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setPrefersReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return prefersReducedMotion
}

export function useCyclePhase(input: {
  active: boolean
  cycleMsBase: number
  speed?: number
}) {
  const [phase, setPhase] = useState(0)
  const frameRef = useRef<number | null>(null)
  const startRef = useRef<number | null>(null)
  const speed = input.speed && input.speed > 0 ? input.speed : 1

  useEffect(() => {
    if (!input.active) {
      setPhase(0)
      startRef.current = null
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      return
    }

    const duration = input.cycleMsBase / speed
    const tick = (timestamp: number) => {
      if (startRef.current == null) startRef.current = timestamp
      const elapsed = timestamp - startRef.current
      setPhase((elapsed % duration) / duration)
      frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      startRef.current = null
    }
  }, [input.active, input.cycleMsBase, speed])

  return phase
}

export function useDotMatrixPhases(input: {
  animated: boolean
  hoverAnimated: boolean
  speed?: number
}) {
  const [hovered, setHovered] = useState(false)
  const phase: DotMatrixPhase = input.animated ? 'loadingRipple' : hovered && input.hoverAnimated ? 'hoverRipple' : 'idle'

  const onMouseEnter = () => {
    if (input.hoverAnimated) setHovered(true)
  }

  const onMouseLeave = () => {
    if (input.hoverAnimated) setHovered(false)
  }

  return useMemo(
    () => ({
      phase,
      onMouseEnter,
      onMouseLeave,
    }),
    [phase],
  )
}
