"use client"

import type { CSSProperties } from 'react'

import '../../styles/dotmatrix-loader.css'

export type DotMatrixPhase = 'idle' | 'collapse' | 'hoverRipple' | 'loadingRipple'
export type DotShape = 'circle' | 'square' | 'diamond' | 'hearts'
export type MatrixPattern = 'diamond' | 'full' | 'outline' | 'rose' | 'cross' | 'rings'

export interface DotMatrixCommonProps {
  size?: number
  dotSize?: number
  color?: string
  speed?: number
  ariaLabel?: string
  className?: string
  pattern?: MatrixPattern
  muted?: boolean
  bloom?: boolean
  halo?: number
  animated?: boolean
  hoverAnimated?: boolean
  dotClassName?: string
  dotShape?: DotShape
  opacityBase?: number
  opacityMid?: number
  opacityPeak?: number
  cellPadding?: number
  boxSize?: number
  minSize?: number
}

export interface DotAnimationContext {
  index: number
  row: number
  col: number
  distanceFromCenter: number
  angleFromCenter: number
  radiusNormalized: number
  manhattanDistance: number
  phase: DotMatrixPhase
  isActive: boolean
  reducedMotion: boolean
}

export interface DotAnimationState {
  className?: string
  style?: CSSProperties
}

export type DotAnimationResolver = (ctx: DotAnimationContext) => DotAnimationState

export const MATRIX_SIZE = 5
const CENTER = Math.floor(MATRIX_SIZE / 2)
const CORNER_COORDS = new Set(['0,0', '0,4', '4,0', '4,4'])

export function isWithinCircularMask(row: number, col: number) {
  return !CORNER_COORDS.has(`${row},${col}`)
}

function indexToCoord(index: number) {
  return {
    row: Math.floor(index / MATRIX_SIZE),
    col: index % MATRIX_SIZE,
  }
}

function cx(...values: Array<string | undefined | null | false>) {
  return values.filter(Boolean).join(' ')
}

function remapOpacityToTriplet(
  opacity: number,
  opacityBase: number | undefined,
  opacityMid: number | undefined,
  opacityPeak: number | undefined,
) {
  const sourceBase = 0.08
  const sourceMid = 0.34
  const sourcePeak = 0.94
  const targetBase = opacityBase ?? sourceBase
  const targetMid = opacityMid ?? sourceMid
  const targetPeak = opacityPeak ?? sourcePeak
  const safeOpacity = Math.min(1, Math.max(0, opacity))

  const lerp = (start: number, end: number, progress: number) => start + (end - start) * progress
  const normalize = (value: number, start: number, end: number) => Math.min(1, Math.max(0, (value - start) / (end - start)))

  if (safeOpacity <= sourceBase) return lerp(0, targetBase, normalize(safeOpacity, 0, sourceBase))
  if (safeOpacity <= sourceMid) return lerp(targetBase, targetMid, normalize(safeOpacity, sourceBase, sourceMid))
  if (safeOpacity <= sourcePeak) return lerp(targetMid, targetPeak, normalize(safeOpacity, sourceMid, sourcePeak))
  return lerp(targetPeak, 1, normalize(safeOpacity, sourcePeak, 1))
}

function opacityToBloomLevel(remappedOpacity: number) {
  const min = 0.6
  return Math.max(0, Math.min(1, (remappedOpacity - min) / (1 - min)))
}

interface DotMatrixBaseProps extends DotMatrixCommonProps {
  phase: DotMatrixPhase
  reducedMotion?: boolean
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  animationResolver?: DotAnimationResolver
}

export function DotMatrixBase({
  size = 24,
  dotSize = 3,
  color = 'currentColor',
  speed = 1,
  ariaLabel = 'Loading',
  className,
  bloom = false,
  halo = 0,
  dotClassName,
  dotShape = 'circle',
  phase,
  reducedMotion = false,
  onMouseEnter,
  onMouseLeave,
  animationResolver,
  opacityBase,
  opacityMid,
  opacityPeak,
  cellPadding,
  boxSize,
  minSize,
}: DotMatrixBaseProps) {
  const safeSpeed = speed > 0 ? speed : 1
  const gap = cellPadding ?? Math.max(1, Math.floor((size - dotSize * MATRIX_SIZE) / (MATRIX_SIZE - 1)))
  const matrixSpan = dotSize * MATRIX_SIZE + gap * (MATRIX_SIZE - 1)
  const outerDim = boxSize && boxSize > 0 ? Math.max(boxSize, minSize ?? 0) : 0
  const scale = outerDim > 0 ? outerDim / matrixSpan : 1

  const dots = Array.from({ length: MATRIX_SIZE * MATRIX_SIZE }).map((_, index) => {
    const { row, col } = indexToCoord(index)
    const isActive = true
    const distance = Math.hypot(row - CENTER, col - CENTER)
    const angle = Math.atan2(row - CENTER, col - CENTER)
    const radiusNormalized = Math.hypot(row - CENTER, col - CENTER) / Math.hypot(CENTER, CENTER)
    const manhattanDistance = Math.abs(row - CENTER) + Math.abs(col - CENTER)
    const animationState = animationResolver?.({
      index,
      row,
      col,
      distanceFromCenter: distance,
      angleFromCenter: angle,
      radiusNormalized,
      manhattanDistance,
      phase,
      isActive,
      reducedMotion,
    }) ?? {}
    const resolvedStyle = animationState.style ? { ...animationState.style } : {}
    const rawOpacity = typeof resolvedStyle.opacity === 'number' ? resolvedStyle.opacity : 0.16
    const remappedOpacity = remapOpacityToTriplet(rawOpacity, opacityBase, opacityMid, opacityPeak)
    const bloomLevel = bloom ? opacityToBloomLevel(remappedOpacity) : 0

    const style = {
      width: dotSize,
      height: dotSize,
      opacity: remappedOpacity,
      '--dmx-bloom-level': bloomLevel,
      ...resolvedStyle,
    } as CSSProperties

    return (
      <span
        key={index}
        aria-hidden="true"
        className={cx('dmx-dot', `dmx-dot-shape-${dotShape}`, dotClassName, animationState.className)}
        style={style}
      />
    )
  })

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={cx('dmx-root', bloom && 'dmx-bloom', halo > 0 && 'dmx-bloom-halo', className)}
      style={
        {
          '--dmx-speed': 1 / safeSpeed,
          '--dmx-dot-size': `${dotSize}px`,
          '--dmx-halo-level': halo,
          '--dmx-dot-fill': color,
          width: matrixSpan,
          height: matrixSpan,
          color,
          minWidth: outerDim > 0 ? outerDim : minSize,
          minHeight: outerDim > 0 ? outerDim : minSize,
          transform: outerDim > 0 ? `scale(${scale})` : undefined,
          transformOrigin: outerDim > 0 ? 'center center' : undefined,
        } as CSSProperties
      }
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="dmx-grid" style={{ gap }}>
        {dots}
      </div>
    </div>
  )
}
