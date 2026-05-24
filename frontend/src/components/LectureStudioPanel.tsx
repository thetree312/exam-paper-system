import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudioLectureTabPayload } from '../types'
import {
  getLectureSession,
  replyLectureRuntimeQuestion,
  type LectureBlockDto,
  type LectureDraftBlockDto,
  type LectureHighlightSpanDto,
  type LectureReasoningDraftDto,
  type LectureRuntimeQuestionDto,
  type LectureSessionDto,
  type LectureStreamEventDto,
  type LectureSourceBlockDto,
  type LectureVisualizationPatchDto,
} from '../services/lectureApi'
import { useAppStore } from '../store/appStore'
import { getAuthToken } from '../utils/secureStorage'
import { MarkdownWithMath } from './MarkdownWithMath'
import { LectureGateShiftIndicator } from './LectureGateShiftIndicator'
import { QuestionTextView } from './QuestionTextView'
import { normalizeLectureVisualizationHTML } from './lecture-visualization-html'
import { buildLectureStreamRenderItems } from './lecture-stream-layout'
import {
  advanceLectureContinuationWait,
  shouldClearLectureReasoning,
  shouldCollapseLectureReasoningForDraft,
  shouldShowLectureContinuationWait,
} from './lecture-stream-state'
import katexCssText from 'katex/dist/katex.min.css?inline'
import katexScriptUrl from 'katex/dist/katex.min.js?url'
import katexAutoRenderScriptUrl from 'katex/dist/contrib/auto-render.min.js?url'

interface LectureStudioPanelProps {
  backendBaseUrl: string
  workroomId: string
  tab: StudioLectureTabPayload
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
}

type HighlightMode = 'focus' | 'related'

type BridgeMessage =
  | {
      channel: 'lecture-bridge'
      type: 'set-highlights'
      targetIds?: string[]
      mode?: HighlightMode
    }
  | {
      channel: 'lecture-bridge'
      type: 'report-visualization-snapshot'
      html: string
    }
  | {
      channel: 'lecture-bridge'
      type: 'report-visualization-zoom'
      zoom: number
      panX?: number
      panY?: number
    }
  | {
      channel: 'lecture-bridge'
      type: 'report-visualization-patch-result'
      ok: boolean
      failed?: Array<{ index: number; targetId: string; op: string; reason: string }>
    }

type LectureHostMessage =
  | {
      channel: 'lecture-host'
      type: 'lecture-theme'
      theme: 'light' | 'dark'
    }
  | {
      channel: 'lecture-host'
      type: 'lecture-state'
      payload: unknown
    }
  | {
      channel: 'lecture-host'
      type: 'lecture-visualization-reset'
      html: string
    }
  | {
      channel: 'lecture-host'
      type: 'lecture-visualization-request-snapshot'
    }
  | {
      channel: 'lecture-host'
      type: 'lecture-visualization-patch'
      patches: LectureVisualizationPatchDto[]
    }
  | {
      channel: 'lecture-host'
      type: 'lecture-visualization-zoom'
      zoom: number
      panX?: number
      panY?: number
    }

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const HIGHLIGHT_COLORS = [
  'rgba(255, 216, 107, 0.16)',
  'rgba(134, 227, 255, 0.16)',
  'rgba(167, 243, 161, 0.15)',
  'rgba(248, 168, 255, 0.15)',
  'rgba(255, 179, 138, 0.15)',
  'rgba(182, 166, 255, 0.15)',
]

type QuotedSegment = {
  text: string
  color: string | null
}

function buildQuotedSegments(
  text: string,
  spans: LectureHighlightSpanDto[],
  colorByKey: Map<string, string>,
): QuotedSegment[] {
  if (!spans.length) return [{ text, color: null }]
  const entries = spans
    .map((span) => ({
      key: `${span.sourceId}\u0000${span.quote.trim()}`,
      quote: span.quote.trim(),
      color: colorByKey.get(`${span.sourceId}\u0000${span.quote.trim()}`) ?? HIGHLIGHT_COLORS[0],
    }))
    .filter((entry) => Boolean(entry.quote))
    .sort((a, b) => b.quote.length - a.quote.length)
  if (!entries.length) return [{ text, color: null }]
  const matcher = new RegExp(`(${entries.map((entry) => escapeRegExp(entry.quote)).join('|')})`, 'g')
  const parts = text.split(matcher).filter(Boolean)
  return parts.map((part) => {
    const match = entries.find((entry) => entry.quote === part)
    return {
      text: part,
      color: match?.color ?? null,
    }
  })
}

function formatBlockTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function blockLabel(role: LectureBlockDto['role']) {
  if (role === 'student_question') return '学生'
  if (role === 'answer') return '老师答疑'
  if (role === 'system') return '系统'
  return '老师'
}

function blockTone(role: LectureBlockDto['role']) {
  if (role === 'student_question') return 'text-sky-700'
  if (role === 'answer') return 'text-amber-700'
  if (role === 'system') return 'text-[var(--ui-text-secondary)]'
  return 'text-[var(--ui-text-secondary)]'
}

function formatReasoningSeconds(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0'
  return (ms / 1000).toFixed(1)
}

function LectureReasoningTrace(input: {
  draft: LectureReasoningDraftDto
  expanded: boolean
  elapsedMs: number
  onToggle: () => void
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const text = input.draft.text.trim()
  const traceHeight = 96
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [text])

  if (!text) return null
  const isThinking = input.draft.status === 'thinking'
  return (
    <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-4">
      <div />
      <div className="min-w-0 space-y-1.5">
        <button
          type="button"
          disabled={isThinking}
          onClick={input.onToggle}
          className={`flex items-center gap-2 font-mono text-[11px] leading-none transition-colors ${
            isThinking
              ? 'cursor-default text-[color-mix(in_srgb,var(--ui-text-secondary)_58%,transparent)]'
              : 'text-[color-mix(in_srgb,var(--ui-text-secondary)_70%,transparent)] hover:text-[var(--ui-text-secondary)]'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isThinking
                ? 'animate-pulse bg-[color-mix(in_srgb,var(--ui-text-secondary)_60%,transparent)]'
                : 'bg-[color-mix(in_srgb,var(--ui-text-secondary)_38%,transparent)]'
            }`}
          />
          <span>{isThinking ? `思考中 ${formatReasoningSeconds(input.elapsedMs)}s` : `已思考 ${formatReasoningSeconds(input.draft.elapsedMs)}s`}</span>
        </button>
        <div
          ref={scrollContainerRef}
          className="pr-1 transition-[height,max-height,opacity] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] [&::-webkit-scrollbar]:hidden"
          style={{
            height: input.expanded ? traceHeight : 0,
            maxHeight: input.expanded ? traceHeight : 0,
            opacity: input.expanded ? 1 : 0,
            overflowY: input.expanded ? 'auto' : 'hidden',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          <pre className="m-0 whitespace-pre-wrap pl-3 font-mono text-[12px] leading-6 text-[color-mix(in_srgb,var(--ui-text-secondary)_62%,transparent)]">
            {text}
            {isThinking ? <span className="ml-0.5 inline-block h-3 w-px translate-y-0.5 animate-pulse bg-[color-mix(in_srgb,var(--ui-text-secondary)_58%,transparent)]" /> : null}
          </pre>
        </div>
      </div>
    </div>
  )
}

function questionChoiceLabel(index: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  return alphabet[index] ?? String(index + 1)
}

const CUSTOM_QUESTION_CHOICE = '__custom__'

function QuestionOptionGrid(input: {
  options: Array<{
    label: string
    description: string
  }>
  customEnabled: boolean
  customPlaceholder: string
  selectedChoiceLabel: string | null
  customValue: string
  isBusy: boolean
  onSelect: (label: string) => void
  onCustomValueChange: (value: string) => void
  onCustomFocus: () => void
  onSubmitCustom: () => void
}) {
  const customTextareaRef = useRef<HTMLInputElement | null>(null)

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div className="flex w-full flex-1 min-h-0 flex-col gap-1.5 overflow-auto pr-1">
        {input.options.map((option, index) => {
          const pressed = input.selectedChoiceLabel === option.label
          return (
            <button
              key={`question-option-${index}-${option.label}`}
              type="button"
              disabled={input.isBusy}
              onClick={() => input.onSelect(option.label)}
              className={`flex w-full min-w-0 items-start gap-2 overflow-hidden border px-2.5 py-1.5 text-left text-[12px] leading-5 transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
                pressed
                  ? 'border-[var(--ui-text-primary)] bg-[color-mix(in_srgb,var(--ui-text-primary)_10%,var(--ui-bg-panel))]'
                  : 'border-[var(--ui-border-default)] bg-transparent hover:border-[var(--ui-text-primary)] hover:bg-[color-mix(in_srgb,var(--ui-text-primary)_4%,var(--ui-bg-panel))] active:scale-[0.995]'
              }`}
              style={{ color: 'var(--ui-text-primary)' }}
            >
              <span className="shrink-0 text-[11px] leading-5 text-[var(--ui-text-secondary)]">
                {questionChoiceLabel(index)}
              </span>
              <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ellipsis">
                <QuestionTextView
                  className="inline-block text-[12px] leading-5"
                  text={option.description ? `${option.label} · ${option.description}` : option.label}
                />
              </span>
            </button>
          )
        })}
      </div>
      {input.customEnabled ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => customTextareaRef.current?.focus()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              customTextareaRef.current?.focus()
            }
          }}
          className={`shrink-0 min-w-0 border px-2.5 py-2 text-left text-[12px] leading-5 transition-all duration-150 ${
            input.selectedChoiceLabel === CUSTOM_QUESTION_CHOICE
              ? 'border-[var(--ui-text-primary)] bg-[color-mix(in_srgb,var(--ui-text-primary)_10%,var(--ui-bg-panel))]'
              : 'border-[var(--ui-border-default)] bg-[color-mix(in_srgb,var(--ui-bg-panel)_94%,transparent)] hover:border-[var(--ui-text-primary)] hover:bg-[color-mix(in_srgb,var(--ui-text-primary)_4%,var(--ui-bg-panel))]'
          }`}
          style={{ color: 'var(--ui-text-primary)', overflowWrap: 'anywhere' }}
        >
          <div className="flex min-w-0 items-center gap-2">
            {input.options.length > 0 ? (
              <span className="shrink-0 text-[11px] text-[var(--ui-text-secondary)]">
                {questionChoiceLabel(input.options.length)}：
              </span>
            ) : null}
            <input
              ref={customTextareaRef}
              type="text"
              value={input.customValue}
              disabled={input.isBusy}
              onFocus={input.onCustomFocus}
              onChange={(event) => input.onCustomValueChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  input.onSubmitCustom()
                }
              }}
              placeholder={input.customPlaceholder}
              className="h-10 min-w-0 flex-1 border border-[var(--ui-border-default)] bg-transparent px-3 text-[12px] text-[var(--ui-text-primary)] outline-none transition-colors placeholder:text-[var(--ui-text-secondary)] focus:border-[var(--ui-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderRadius: '14px' }}
            />
            <button
              type="button"
              disabled={input.isBusy || !input.customValue.trim()}
              onClick={input.onSubmitCustom}
              className="shrink-0 border border-[var(--ui-text-primary)] px-2.5 py-1 text-[12px] leading-5 text-[var(--ui-text-primary)] transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--ui-text-primary)_8%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              发送
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ',
}

const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  a: 'ᵃ',
  b: 'ᵇ',
  d: 'ᵈ',
  e: 'ᵉ',
  g: 'ᵍ',
  h: 'ʰ',
  i: 'ᶦ',
  j: 'ʲ',
  k: 'ᵏ',
  l: 'ˡ',
  m: 'ᵐ',
  n: 'ⁿ',
  o: 'ᵒ',
  p: 'ᵖ',
  r: 'ʳ',
  s: 'ˢ',
  t: 'ᵗ',
  u: 'ᵘ',
  v: 'ᵛ',
  x: 'ˣ',
  y: 'ʸ',
}

function replaceScriptTags(text: string, kind: 'sub' | 'sup') {
  const map = kind === 'sub' ? SUBSCRIPT_MAP : SUPERSCRIPT_MAP
  return text.replace(new RegExp(`<${kind}>(.*?)<\\/${kind}>`, 'gi'), (_match, content: string) =>
    String(content)
      .split('')
      .map((char) => map[char] ?? char)
      .join(''),
  )
}

function normalizeLectureMarkdown(text: string) {
  return replaceScriptTags(replaceScriptTags(text, 'sub'), 'sup')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
}

function buildVisualizationDoc(input: {
  html: string
  theme: 'light' | 'dark'
  cssVariablesText: string
}) {
  const visualizationHTML = normalizeLectureVisualizationHTML(input.html)
  return `<!doctype html>
<html data-theme="${input.theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: ${input.theme};
        ${input.cssVariablesText}
      }
      ${katexCssText}
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: var(--ui-bg-panel, #ffffff);
        color: var(--ui-text-primary, #0f172a);
        font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Hiragino Sans GB", sans-serif;
      }
      body {
        overflow: hidden;
      }
      a {
        color: var(--ui-text-primary, #0f172a);
      }
      #lecture-visualization-stage {
        position: relative;
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        width: 100%;
        height: 100%;
        overflow: auto;
        overscroll-behavior: contain;
      }
      #lecture-visualization-root {
        position: relative;
        display: block;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        min-width: 100%;
        min-height: 100%;
      }
      #lecture-visualization-root svg {
        max-width: none;
      }
      .lecture-focus {
        background: ${input.theme === 'dark' ? 'rgba(245, 189, 39, 0.2)' : '#fff1c7'};
      }
      </style>
      <script defer src="${katexScriptUrl}"></script>
      <script defer src="${katexAutoRenderScriptUrl}"></script>
      <script>
        ;(() => {
          const DEFAULT_FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Hiragino Sans GB", sans-serif'
          const readViewport = (canvas) => {
            const stage = document.getElementById('lecture-visualization-stage')
            const root = document.getElementById('lecture-visualization-root')
            const width = Math.max(1, Math.round(stage?.clientWidth || canvas?.parentElement?.clientWidth || root?.clientWidth || 0))
            const height = Math.max(1, Math.round(stage?.clientHeight || canvas?.parentElement?.clientHeight || root?.clientHeight || 0))
            return {
              zoom: 1,
              panX: 0,
              panY: 0,
              mode: 'canvas-viewport',
              viewBox: null,
              width,
              height,
              devicePixelRatio: window.devicePixelRatio || 1,
            }
          }
          const callDrawScene = (drawScene, context, payload) => {
            if (drawScene.length >= 3) {
              drawScene(context, payload.width, payload.height, payload.dpr, payload.viewport)
              return
            }
            drawScene(context, payload)
          }
          window.LectureCanvasRuntime = {
            fontStack: DEFAULT_FONT_STACK,
            setTextStyle(context, size, weight = 'normal') {
              if (!context) return
              context.font = weight + ' ' + size + 'px ' + DEFAULT_FONT_STACK
              context.textBaseline = 'middle'
            },
            mountCanvas(canvas, drawScene) {
              if (!(canvas instanceof HTMLCanvasElement) || typeof drawScene !== 'function') return null
              const context = canvas.getContext('2d')
              if (!context) return null
              let frame = 0
              let disposed = false
              const render = () => {
                if (disposed) return
                frame = 0
                const viewport = readViewport(canvas)
                const dpr = viewport.devicePixelRatio || 1
                canvas.style.width = viewport.width + 'px'
                canvas.style.height = viewport.height + 'px'
                canvas.width = Math.max(1, Math.round(viewport.width * dpr))
                canvas.height = Math.max(1, Math.round(viewport.height * dpr))
                context.setTransform(dpr, 0, 0, dpr, 0, 0)
                context.font = '14px ' + DEFAULT_FONT_STACK
                context.clearRect(0, 0, viewport.width, viewport.height)
                callDrawScene(drawScene, context, {
                  viewport,
                  width: viewport.width,
                  height: viewport.height,
                  dpr,
                  canvas,
                  stage: document.getElementById('lecture-visualization-stage'),
                  root: document.getElementById('lecture-visualization-root'),
                })
              }
              const schedule = () => {
                if (disposed) return
                if (frame) cancelAnimationFrame(frame)
                frame = requestAnimationFrame(render)
              }
              window.addEventListener('resize', schedule)
              window.addEventListener('lecture-visualization-viewport-change', schedule)
              schedule()
              return {
                redraw: schedule,
                requestDraw: schedule,
                destroy() {
                  disposed = true
                  if (frame) cancelAnimationFrame(frame)
                  window.removeEventListener('resize', schedule)
                  window.removeEventListener('lecture-visualization-viewport-change', schedule)
                },
              }
            },
          }
        })()
      </script>
      <script>
        const DEFAULT_FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Hiragino Sans GB", sans-serif'
      window.addEventListener('DOMContentLoaded', () => {
        const stage = document.getElementById('lecture-visualization-stage')
        const root = document.getElementById('lecture-visualization-root')
        let layoutFrame = 0
        let resizeObserver = null
        let mutationObserver = null
        let manualZoom = 1
        let panX = 0
        let panY = 0
        let activeSvg = null
        let activeSvgBaseViewBox = null
        let activeSvgViewBox = null
        let dragState = null
        const MIN_MANUAL_ZOOM = 0.6
        const MAX_MANUAL_ZOOM = 2.8
        const clampZoom = (value) => Math.min(MAX_MANUAL_ZOOM, Math.max(MIN_MANUAL_ZOOM, Number.isFinite(value) ? value : 1))
        const clampRatio = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5))
        const cloneViewBox = (value) => value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null
        const parseSize = (value) => {
          const parsed = Number.parseFloat(String(value ?? '').replace('px', ''))
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
        }
        const reportZoom = () => {
          parent.postMessage({
            channel: 'lecture-bridge',
            type: 'report-visualization-zoom',
            zoom: manualZoom,
            panX,
            panY,
          }, window.location.origin)
        }
        const dispatchViewportChange = () => {
          const detail = {
            zoom: manualZoom,
            panX,
            panY,
            mode: activeSvg ? 'svg-viewBox' : 'canvas-viewport',
            viewBox: cloneViewBox(activeSvgViewBox),
            width: stage?.clientWidth ?? 0,
            height: stage?.clientHeight ?? 0,
            devicePixelRatio: window.devicePixelRatio || 1,
          }
          window.dispatchEvent(new CustomEvent('lecture-visualization-viewport-change', { detail }))
          root?.dispatchEvent(new CustomEvent('lecture-visualization-viewport-change', { detail }))
        }
        const getPrimarySvg = () => {
          if (!root) return null
          const svg = root.querySelector('svg')
          return svg instanceof SVGSVGElement ? svg : null
        }
        const resolveSvgBaseViewBox = (svg) => {
          const viewBox = svg.viewBox?.baseVal
          if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
            return { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height }
          }
          const width = parseSize(svg.getAttribute('width')) || svg.clientWidth || stage?.clientWidth || 800
          const height = parseSize(svg.getAttribute('height')) || svg.clientHeight || stage?.clientHeight || 450
          return { x: 0, y: 0, width, height }
        }
        const applySvgViewBox = (viewBox) => {
          if (!activeSvg || !viewBox) return
          activeSvgViewBox = viewBox
          activeSvg.setAttribute('viewBox', [viewBox.x, viewBox.y, viewBox.width, viewBox.height].join(' '))
          dispatchViewportChange()
        }
        const applySvgZoom = (zoom, anchor) => {
          if (!activeSvg || !activeSvgBaseViewBox) return false
          const current = activeSvgViewBox ?? activeSvgBaseViewBox
          const rect = activeSvg.getBoundingClientRect()
          const relX = anchor && rect.width > 0 ? clampRatio((anchor.clientX - rect.left) / rect.width) : 0.5
          const relY = anchor && rect.height > 0 ? clampRatio((anchor.clientY - rect.top) / rect.height) : 0.5
          const anchorX = current.x + current.width * relX
          const anchorY = current.y + current.height * relY
          const nextWidth = activeSvgBaseViewBox.width / zoom
          const nextHeight = activeSvgBaseViewBox.height / zoom
          applySvgViewBox({
            x: anchorX - nextWidth * relX,
            y: anchorY - nextHeight * relY,
            width: nextWidth,
            height: nextHeight,
          })
          return true
        }
        const applyCanvasViewportZoom = (previousZoom, anchor) => {
          if (!stage || !root) return
          stage.style.overflow = 'hidden'
          stage.style.cursor = manualZoom > 1 ? 'grab' : ''
          root.style.zoom = '1'
          root.style.transform = ''
          root.style.transformOrigin = ''
          if (anchor && previousZoom > 0) {
            const rect = stage.getBoundingClientRect()
            const anchorX = anchor.clientX - rect.left - rect.width / 2
            const anchorY = anchor.clientY - rect.top - rect.height / 2
            const ratio = manualZoom / previousZoom
            panX = panX * ratio + anchorX * (1 - ratio)
            panY = panY * ratio + anchorY * (1 - ratio)
          }
          if (manualZoom <= 1) {
            panX = 0
            panY = 0
          }
          if (!anchor || previousZoom <= 0) {
            dispatchViewportChange()
            return
          }
          requestAnimationFrame(() => {
            dispatchViewportChange()
          })
        }
        const scheduleLayout = () => {
          if (layoutFrame) cancelAnimationFrame(layoutFrame)
          layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0
            updateLayout()
          })
        }
        const updateLayout = () => {
          if (!stage || !root) return
          const nextSvg = getPrimarySvg()
          if (nextSvg) {
            stage.style.overflow = 'hidden'
            stage.style.cursor = manualZoom > 1 ? 'grab' : ''
            root.style.zoom = '1'
            root.style.transform = ''
            nextSvg.style.width = '100%'
            nextSvg.style.height = '100%'
            nextSvg.style.maxWidth = 'none'
            if (activeSvg !== nextSvg) {
              activeSvg = nextSvg
              activeSvgBaseViewBox = resolveSvgBaseViewBox(nextSvg)
              activeSvgViewBox = cloneViewBox(activeSvgBaseViewBox)
            }
            applySvgZoom(manualZoom)
            return
          }
          activeSvg = null
          activeSvgBaseViewBox = null
          activeSvgViewBox = null
          stage.style.cursor = manualZoom > 1 ? 'grab' : ''
          applyCanvasViewportZoom(manualZoom)
        }
        const setManualZoom = (value, notifyParent = true, anchor = null) => {
          const previousZoom = manualZoom
          manualZoom = clampZoom(value)
          if (activeSvg && applySvgZoom(manualZoom, anchor)) {
            // SVG remains vector-sharp because zoom changes the viewBox, not a bitmap layer.
          } else {
            applyCanvasViewportZoom(previousZoom, anchor)
            scheduleLayout()
          }
          if (notifyParent) reportZoom()
        }
        const renderMath = (target) => {
          const renderer = window.renderMathInElement
          if (typeof renderer !== 'function') return
          try {
            renderer(target ?? root ?? document.body, {
              delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\\\(', right: '\\\\)', display: false },
                { left: '\\\\[', right: '\\\\]', display: true }
              ],
              throwOnError: false
            })
          } catch {}
        }
        const serializeSnapshot = () => {
          const target = root ?? document.body
          return target ? target.innerHTML : document.body.innerHTML
        }
        const reportSnapshot = () => {
          parent.postMessage({
            channel: 'lecture-bridge',
            type: 'report-visualization-snapshot',
            html: serializeSnapshot(),
          }, window.location.origin)
        }
        const reportPatchResult = (ok, failed) => {
          parent.postMessage({
            channel: 'lecture-bridge',
            type: 'report-visualization-patch-result',
            ok: Boolean(ok),
            failed: Array.isArray(failed) ? failed : [],
          }, window.location.origin)
        }
        const applyPatch = (patch) => {
          if (!patch || !root) return false
          const target = document.getElementById(patch.targetId)
          if (!target || (target !== root && !root.contains(target))) return false
          if (patch.op === 'set_html') {
            target.innerHTML = patch.html
            return true
          }
          if (patch.op === 'set_text') {
            target.textContent = patch.text
            return true
          }
          if (patch.op === 'set_attr') {
            if (patch.value == null) target.removeAttribute(patch.name)
            else target.setAttribute(patch.name, patch.value)
            return true
          }
          if (patch.op === 'remove_node') {
            target.remove()
            return true
          }
          if (patch.op === 'append_child') {
            target.insertAdjacentHTML('beforeend', patch.html)
            return true
          }
          if (patch.op === 'scene_state') {
            const stateText = JSON.stringify(patch.state ?? {})
            target.setAttribute('data-lecture-scene-state', stateText)
            target.dispatchEvent(new CustomEvent('lecture-scene-state-change', { detail: patch.state ?? {} }))
            return true
          }
          return false
        }
        const applyPatches = (patches) => {
          if (!Array.isArray(patches) || patches.length === 0) return
          let changed = false
          const failed = []
          patches.forEach((patch, index) => {
            const applied = applyPatch(patch)
            if (!applied) {
              failed.push({
                index,
                targetId: String(patch?.targetId ?? ''),
                op: String(patch?.op ?? ''),
                reason: 'target_not_found_or_invalid',
              })
              return
            }
            changed = true
          })
          reportPatchResult(failed.length === 0, failed)
          if (failed.length === patches.length) {
            return
          }
          if (changed) {
            renderMath(root)
            scheduleLayout()
          }
        }
        const bridge = {
          setHighlights(targetIds, mode) {
            parent.postMessage({
              channel: 'lecture-bridge',
              type: 'set-highlights',
              targetIds: Array.isArray(targetIds) ? targetIds : [],
              mode: mode === 'related' ? 'related' : 'focus',
            }, '*')
          },
          onLectureStateChange(handler) {
            if (typeof handler !== 'function') return () => {}
            const listener = (event) => {
              if (event?.data?.channel !== 'lecture-host' || event?.data?.type !== 'lecture-state') return
              handler(event.data.payload)
            }
            window.addEventListener('message', listener)
            return () => window.removeEventListener('message', listener)
          },
          getLectureState() {
            return window.__LECTURE_STATE__ ?? null
          },
          getViewportState() {
            return {
              zoom: manualZoom,
              panX,
              panY,
              mode: activeSvg ? 'svg-viewBox' : 'canvas-viewport',
              viewBox: cloneViewBox(activeSvgViewBox),
              width: stage?.clientWidth ?? 0,
              height: stage?.clientHeight ?? 0,
              devicePixelRatio: window.devicePixelRatio || 1,
            }
          },
          getSize() {
            return {
              width: stage?.clientWidth ?? 0,
              height: stage?.clientHeight ?? 0,
              devicePixelRatio: window.devicePixelRatio || 1,
            }
          },
          onViewportChange(handler) {
            if (typeof handler !== 'function') return () => {}
            const listener = (event) => handler(event.detail)
            window.addEventListener('lecture-visualization-viewport-change', listener)
            return () => window.removeEventListener('lecture-visualization-viewport-change', listener)
          },
          requestSnapshot() {
            reportSnapshot()
          },
          setZoom(zoom) {
            setManualZoom(zoom, false)
          },
          resetViewport() {
            manualZoom = 1
            panX = 0
            panY = 0
            if (activeSvgBaseViewBox) applySvgViewBox(cloneViewBox(activeSvgBaseViewBox))
            dispatchViewportChange()
            reportZoom()
          },
        }
        window.LectureBridge = bridge
        window.LectureCanvasRuntime = {
          fontStack: DEFAULT_FONT_STACK,
          setTextStyle(context, size, weight = 'normal') {
            if (!context) return
            context.font = weight + ' ' + size + 'px ' + DEFAULT_FONT_STACK
            context.textBaseline = 'middle'
          },
          mountCanvas(canvas, drawScene) {
            if (!(canvas instanceof HTMLCanvasElement) || typeof drawScene !== 'function') return null
            const context = canvas.getContext('2d')
            if (!context) return null
            let frame = 0
            let disposed = false

            const readViewport = () => {
              try {
                const viewport = bridge.getViewportState()
                if (viewport && typeof viewport === 'object') return viewport
              } catch {}
              return {
                zoom: 1,
                panX: 0,
                panY: 0,
                mode: 'canvas-viewport',
                viewBox: null,
                width: stage?.clientWidth ?? 0,
                height: stage?.clientHeight ?? 0,
                devicePixelRatio: window.devicePixelRatio || 1,
              }
            }

            const render = () => {
              if (disposed) return
              frame = 0
              const viewport = readViewport()
              const width = Math.max(1, Math.round(viewport.width || canvas.parentElement?.clientWidth || stage?.clientWidth || 0))
              const height = Math.max(1, Math.round(viewport.height || canvas.parentElement?.clientHeight || stage?.clientHeight || 0))
              const dpr = viewport.devicePixelRatio || window.devicePixelRatio || 1
              const zoom = Number.isFinite(viewport.zoom) ? Math.max(0.01, viewport.zoom) : 1

              canvas.style.width = width + 'px'
              canvas.style.height = height + 'px'
              canvas.width = Math.max(1, Math.round(width * dpr * zoom))
              canvas.height = Math.max(1, Math.round(height * dpr * zoom))

              context.setTransform(dpr * zoom, 0, 0, dpr * zoom, viewport.panX || 0, viewport.panY || 0)
              context.font = '14px ' + DEFAULT_FONT_STACK
              context.clearRect(0, 0, width, height)
              const payload = {
                viewport,
                width,
                height,
                dpr,
                canvas,
                stage,
                root,
              }
              if (drawScene.length >= 3) {
                drawScene(context, width, height, dpr, viewport)
              } else {
                drawScene(context, payload)
              }
            }

            const schedule = () => {
              if (disposed) return
              if (frame) cancelAnimationFrame(frame)
              frame = requestAnimationFrame(render)
            }

            const unsubscribeViewport = bridge.onViewportChange(() => schedule())
            window.addEventListener('resize', schedule)
            schedule()

            return {
              redraw: schedule,
              requestDraw: schedule,
              destroy() {
                disposed = true
                if (frame) cancelAnimationFrame(frame)
                unsubscribeViewport?.()
                window.removeEventListener('resize', schedule)
              },
            }
          },
        }
        const notifyTheme = () => {
          document.documentElement.setAttribute('data-theme', window.__LECTURE_THEME__ || '${input.theme}')
        }
        window.addEventListener('message', (event) => {
          if (event.source !== parent) return
          if (!event?.data || typeof event.data !== 'object') return
          if (event?.data?.channel === 'lecture-host' && event?.data?.type === 'lecture-theme') {
            window.__LECTURE_THEME__ = event.data.theme
            notifyTheme()
            return
          }
          if (event?.data?.channel !== 'lecture-host') return
          if (event?.data?.type === 'lecture-state') {
            window.__LECTURE_STATE__ = event.data.payload
            window.dispatchEvent(new CustomEvent('lecture-state-change', { detail: event.data.payload }))
            return
          }
          if (event?.data?.type === 'lecture-visualization-patch') {
            if (!Array.isArray(event.data.patches)) {
              reportPatchResult(false, [{ index: -1, targetId: '', op: 'unknown', reason: 'invalid_patch_payload' }])
              return
            }
            applyPatches(event.data.patches)
            return
          }
          if (event?.data?.type === 'lecture-visualization-zoom') {
            if (typeof event.data.zoom !== 'number' || !Number.isFinite(event.data.zoom)) return
            if (typeof event.data.panX === 'number' && Number.isFinite(event.data.panX)) panX = event.data.panX
            if (typeof event.data.panY === 'number' && Number.isFinite(event.data.panY)) panY = event.data.panY
            setManualZoom(event.data.zoom, false)
            return
          }
          if (event?.data?.type === 'lecture-visualization-reset') {
            if (root) {
              root.innerHTML = event.data.html ?? ''
              panX = 0
              panY = 0
              setManualZoom(1, true)
              renderMath(root)
              scheduleLayout()
            }
            return
          }
          if (event?.data?.type === 'lecture-visualization-request-snapshot') {
            reportSnapshot()
          }
        })
        window.addEventListener('load', () => {
          notifyTheme()
          setTimeout(() => {
            renderMath(root)
            scheduleLayout()
          }, 0)
        })
        window.addEventListener(
          'wheel',
          (event) => {
            if (!event.cancelable) return
            event.preventDefault()
            const nextZoom = manualZoom * (event.deltaY < 0 ? 1.08 : 0.92)
            setManualZoom(nextZoom, true, { clientX: event.clientX, clientY: event.clientY })
          },
          { passive: false },
        )
        if (stage) {
          stage.addEventListener('pointerdown', (event) => {
            if (manualZoom <= 1 || event.button !== 0) return
            const viewBox = activeSvg ? cloneViewBox(activeSvgViewBox) : null
            dragState = {
              pointerId: event.pointerId,
              clientX: event.clientX,
              clientY: event.clientY,
              panX,
              panY,
              viewBox,
            }
            stage.setPointerCapture?.(event.pointerId)
            stage.style.cursor = 'grabbing'
            event.preventDefault()
          })
          stage.addEventListener('pointermove', (event) => {
            if (!dragState || dragState.pointerId !== event.pointerId) return
            if (activeSvg && dragState.viewBox) {
              const rect = activeSvg.getBoundingClientRect()
              if (rect.width <= 0 || rect.height <= 0) return
              const dx = ((event.clientX - dragState.clientX) / rect.width) * dragState.viewBox.width
              const dy = ((event.clientY - dragState.clientY) / rect.height) * dragState.viewBox.height
              applySvgViewBox({
                x: dragState.viewBox.x - dx,
                y: dragState.viewBox.y - dy,
                width: dragState.viewBox.width,
                height: dragState.viewBox.height,
              })
            } else {
              panX = dragState.panX + (event.clientX - dragState.clientX)
              panY = dragState.panY + (event.clientY - dragState.clientY)
              dispatchViewportChange()
            }
            event.preventDefault()
          })
          const finishDrag = (event) => {
            if (!dragState || dragState.pointerId !== event.pointerId) return
            dragState = null
            stage.releasePointerCapture?.(event.pointerId)
            stage.style.cursor = manualZoom > 1 ? 'grab' : ''
          }
          stage.addEventListener('pointerup', finishDrag)
          stage.addEventListener('pointercancel', finishDrag)
        }
        window.addEventListener('resize', scheduleLayout)
        if (typeof ResizeObserver === 'function' && stage && root) {
          resizeObserver = new ResizeObserver(() => scheduleLayout())
          resizeObserver.observe(stage)
          resizeObserver.observe(root)
        }
        if (typeof MutationObserver === 'function' && root) {
          mutationObserver = new MutationObserver(() => scheduleLayout())
          mutationObserver.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
          })
        }
        window.addEventListener('beforeunload', () => {
          if (layoutFrame) cancelAnimationFrame(layoutFrame)
          if (resizeObserver) resizeObserver.disconnect()
          if (mutationObserver) mutationObserver.disconnect()
        })
      })
    </script>
  </head>
  <body><div id="lecture-visualization-stage"><div id="lecture-visualization-root">${visualizationHTML}</div></div></body>
</html>`
}

export const LectureStudioPanel: React.FC<LectureStudioPanelProps> = ({
  backendBaseUrl,
  workroomId,
  tab,
  onToast,
}) => {
  const [session, setSession] = useState<LectureSessionDto | null>(null)
  const [blocks, setBlocks] = useState<LectureBlockDto[]>([])
  const [sourceBlocks, setSourceBlocks] = useState<LectureSourceBlockDto[]>([])
  const [legendImages, setLegendImages] = useState<string[]>([])
  const [pendingQuestion, setPendingQuestion] = useState<LectureRuntimeQuestionDto | null>(null)
  const [draftBlock, setDraftBlock] = useState<LectureDraftBlockDto | null>(null)
  const [reasoningDraft, setReasoningDraft] = useState<LectureReasoningDraftDto | null>(null)
  const [isReasoningExpanded, setIsReasoningExpanded] = useState(true)
  const [reasoningClock, setReasoningClock] = useState(Date.now())
  const [awaitingLectureContinuation, setAwaitingLectureContinuation] = useState(false)
  const [selectedChoiceLabel, setSelectedChoiceLabel] = useState<string | null>(null)
  const [customQuestionReply, setCustomQuestionReply] = useState('')
  const [isQuestionDockExpanded, setIsQuestionDockExpanded] = useState(true)
  const [isVisualizationFullscreen, setIsVisualizationFullscreen] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visualizationHTML, setVisualizationHTML] = useState<string | null>(null)
  const [visualizationZoom, setVisualizationZoom] = useState(1)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const lectureStreamRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const refreshedLectureAgentSessionIdsRef = useRef<Set<string>>(new Set())
  const visualizationFrameReadyRef = useRef(false)
  const visualizationMessageQueueRef = useRef<LectureHostMessage[]>([])
  const visualizationHTMLRef = useRef<string | null>(null)
  const visualizationSnapshotVersionRef = useRef<string | null>(null)
  const reasoningCollapseTimerRef = useRef<number | null>(null)
  const theme = useAppStore((state) => state.theme)

  const cssVariablesText = useMemo(() => {
    if (typeof window === 'undefined') return ''
    const computed = window.getComputedStyle(document.documentElement)
    const names = [
      '--ui-bg-app',
      '--ui-bg-panel',
      '--ui-bg-panel-muted',
      '--ui-border-default',
      '--ui-text-primary',
      '--ui-text-secondary',
    ]
    return names
      .map((name) => `${name}: ${computed.getPropertyValue(name).trim() || ''};`)
      .join('\n')
  }, [theme])

  const clampVisualizationZoom = useCallback((value: number) => {
    if (!Number.isFinite(value)) return 1
    return Math.min(2.8, Math.max(0.6, value))
  }, [])

  const activeHighlightSpans = session?.activeHighlightSpans ?? []
  const displayHighlightSpans = activeHighlightSpans

  const pendingQuestionItem = pendingQuestion?.questions?.[0] ?? null
  const lectureHasStarted = blocks.length > 0 || Boolean(draftBlock) || Boolean(reasoningDraft?.text.trim())
  const streamRenderItems = useMemo(
    () =>
      buildLectureStreamRenderItems({
        blocks,
        reasoningDraft,
        draftBlock,
      }),
    [blocks, reasoningDraft, draftBlock],
  )
  const shouldShowPendingQuestionDock = Boolean(pendingQuestionItem) && lectureHasStarted
  const showLectureContinuationWait = shouldShowLectureContinuationWait({
    awaitingContinuation: awaitingLectureContinuation,
    hasDraftBlock: Boolean(draftBlock),
    hasReasoningDraft: Boolean(reasoningDraft?.text.trim()),
    hasPendingQuestion: Boolean(pendingQuestionItem),
  })
  const reasoningStartedAtMs = reasoningDraft ? Date.parse(reasoningDraft.createdAt) : Number.NaN
  const reasoningElapsedMs =
    reasoningDraft?.status === 'thinking' && Number.isFinite(reasoningStartedAtMs)
      ? Math.max(0, reasoningClock - reasoningStartedAtMs)
      : (reasoningDraft?.elapsedMs ?? 0)

  const completeCurrentReasoningDraft = useCallback(() => {
    if (reasoningCollapseTimerRef.current != null) {
      window.clearTimeout(reasoningCollapseTimerRef.current)
      reasoningCollapseTimerRef.current = null
    }
    setReasoningDraft((current) => {
      if (!current || current.status === 'complete') return current
      const startedAt = Date.parse(current.createdAt)
      const elapsedMs = Number.isFinite(startedAt)
        ? Math.max(current.elapsedMs, Date.now() - startedAt)
        : current.elapsedMs
      return { ...current, status: 'complete', elapsedMs }
    })
    setIsReasoningExpanded(false)
  }, [])

  const stemBlock = useMemo(() => sourceBlocks.find((block) => block.id === 'stem') ?? null, [sourceBlocks])
  const optionBlocks = useMemo(() => sourceBlocks.filter((block) => block.kind === 'option'), [sourceBlocks])
  const stemHighlightSpans = useMemo(
    () => displayHighlightSpans.filter((span) => span.sourceId === 'stem'),
    [displayHighlightSpans],
  )

  const iframeDoc = useMemo(() => {
    if (!visualizationHTML?.trim()) return null
    return buildVisualizationDoc({
      html: visualizationHTML,
      theme,
      cssVariablesText,
    })
  }, [cssVariablesText, theme, visualizationHTML])
  const highlightColorByKey = useMemo(() => {
    const map = new Map<string, string>()
    displayHighlightSpans.forEach((span, index) => {
      const key = `${span.sourceId}\u0000${span.quote.trim()}`
      if (!map.has(key)) {
        map.set(key, HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length])
      }
    })
    return map
  }, [displayHighlightSpans])

  useEffect(() => {
    visualizationHTMLRef.current = visualizationHTML
  }, [visualizationHTML])

  useEffect(() => {
    visualizationFrameReadyRef.current = false
  }, [iframeDoc])

  const highlightTextStyle = (color: string | null) =>
    color
      ? {
          display: 'inline',
          backgroundColor: color,
          boxShadow: `inset 0 -0.38em 0 color-mix(in srgb, ${color} 65%, transparent)`,
          borderRadius: '4px',
          padding: '0 0.08em',
        }
      : undefined

  const postVisualizationMessage = useCallback((message: LectureHostMessage) => {
    const iframe = iframeRef.current
    if (!visualizationFrameReadyRef.current || !iframe?.contentWindow) {
      visualizationMessageQueueRef.current.push(message)
      return
    }
    iframe.contentWindow.postMessage(message, window.location.origin)
  }, [])

  const flushVisualizationMessageQueue = useCallback(() => {
    const iframe = iframeRef.current
    if (!visualizationFrameReadyRef.current || !iframe?.contentWindow) return
    const pending = visualizationMessageQueueRef.current.splice(0)
    pending.forEach((message) => {
      iframe.contentWindow?.postMessage(message, window.location.origin)
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    setVisualizationHTML(null)
    visualizationHTMLRef.current = null
    visualizationSnapshotVersionRef.current = null
    visualizationFrameReadyRef.current = false
    visualizationMessageQueueRef.current = []
    setDraftBlock(null)
    setReasoningDraft(null)
    setIsReasoningExpanded(true)
    if (reasoningCollapseTimerRef.current != null) {
      window.clearTimeout(reasoningCollapseTimerRef.current)
      reasoningCollapseTimerRef.current = null
    }
    void getLectureSession(backendBaseUrl, {
      workroomID: workroomId,
      lectureSessionId: tab.lectureSessionId,
    })
      .then((payload) => {
        if (cancelled) return
        setSession(payload.session)
        setBlocks(payload.blocks)
        setSourceBlocks(payload.sourceBlocks)
        setPendingQuestion(payload.pendingQuestion)
        setLegendImages(payload.questionCard.content.legendImages ?? [])
        const initialVisualizationHTML = payload.session.visualizationHTML?.trim() ? payload.session.visualizationHTML : null
        visualizationSnapshotVersionRef.current = payload.session.updatedAt
        if (!visualizationHTMLRef.current && initialVisualizationHTML) {
          setVisualizationHTML(initialVisualizationHTML)
          visualizationHTMLRef.current = initialVisualizationHTML
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '讲解加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, completeCurrentReasoningDraft, tab.lectureSessionId, workroomId])

  useEffect(() => {
    setSelectedChoiceLabel(null)
    setCustomQuestionReply('')
    setIsQuestionDockExpanded(true)
    setIsVisualizationFullscreen(false)
    setDraftBlock(null)
    setAwaitingLectureContinuation(false)
  }, [pendingQuestion?.requestID])

  useEffect(() => {
    if (reasoningDraft?.status !== 'thinking') return
    const interval = window.setInterval(() => setReasoningClock(Date.now()), 100)
    return () => window.clearInterval(interval)
  }, [reasoningDraft?.status])

  useEffect(() => {
    return () => {
      if (reasoningCollapseTimerRef.current != null) {
        window.clearTimeout(reasoningCollapseTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    setVisualizationZoom(1)
  }, [tab.lectureSessionId])

  useEffect(() => {
    const token = getAuthToken()
    if (!token) return
    const url = `${backendBaseUrl}/api/lectures/${encodeURIComponent(tab.lectureSessionId)}/stream?workroom_id=${encodeURIComponent(workroomId)}&access_token=${encodeURIComponent(token)}`
    const eventSource = new EventSource(url)
    const handleEvent = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as LectureStreamEventDto
        if (
          event.type === 'lecture.visualization.updated' &&
          event.snapshotVersion &&
          visualizationSnapshotVersionRef.current &&
          event.snapshotVersion < visualizationSnapshotVersionRef.current
        ) {
          return
        }
        if (event.type === 'lecture.visualization.updated' && event.snapshotVersion) {
          visualizationSnapshotVersionRef.current = event.snapshotVersion
        }
        setSession(event.session)
        const nextVisualizationHTML = event.session.visualizationHTML?.trim() ? event.session.visualizationHTML : null
        const previousVisualizationHTML = visualizationHTMLRef.current
        if (event.type === 'lecture.session.ready') {
          if (!visualizationHTMLRef.current && nextVisualizationHTML) {
            setVisualizationHTML(nextVisualizationHTML)
            visualizationHTMLRef.current = nextVisualizationHTML
          }
          setBlocks(event.blocks ?? [])
          setPendingQuestion(event.pendingQuestion ?? null)
          setDraftBlock(null)
          setAwaitingLectureContinuation((current) => advanceLectureContinuationWait(current, 'lecture.session.ready'))
          return
        }
        if (event.type === 'question_asked') {
          if (!event.request) return
          setDraftBlock(null)
          if (shouldClearLectureReasoning(event.type)) {
            setReasoningDraft(null)
            setIsReasoningExpanded(true)
          } else {
            completeCurrentReasoningDraft()
          }
          setAwaitingLectureContinuation((current) => advanceLectureContinuationWait(current, 'question_asked'))
          setPendingQuestion({
            requestID: event.request.id,
            sessionID: event.request.session_id,
            questions: event.request.questions,
          })
          return
        }
        if (event.type === 'question_replied' || event.type === 'question_rejected') {
          setDraftBlock(null)
          if (shouldClearLectureReasoning(event.type)) {
            setReasoningDraft(null)
            setIsReasoningExpanded(true)
          }
          setAwaitingLectureContinuation((current) =>
            advanceLectureContinuationWait(current, event.type === 'question_replied' ? 'question_replied' : 'question_asked'),
          )
          setPendingQuestion((current) => (current?.requestID === event.requestId ? null : current))
          return
        }
        if (event.type === 'lecture.reasoning.streaming') {
          setAwaitingLectureContinuation((current) => advanceLectureContinuationWait(current, 'lecture.reasoning.streaming'))
          if (!event.reasoningDraft?.text.trim()) return
          setReasoningDraft(event.reasoningDraft)
          if (event.reasoningDraft.status === 'thinking') {
            if (reasoningCollapseTimerRef.current != null) {
              window.clearTimeout(reasoningCollapseTimerRef.current)
              reasoningCollapseTimerRef.current = null
            }
            setIsReasoningExpanded(true)
          } else {
            if (reasoningCollapseTimerRef.current != null) {
              window.clearTimeout(reasoningCollapseTimerRef.current)
            }
            reasoningCollapseTimerRef.current = window.setTimeout(() => {
              setIsReasoningExpanded(false)
              reasoningCollapseTimerRef.current = null
            }, 520)
          }
          return
        }
        if (event.type === 'lecture.block.streaming') {
          setAwaitingLectureContinuation((current) => advanceLectureContinuationWait(current, 'lecture.block.streaming'))
          if (shouldCollapseLectureReasoningForDraft(event.draftBlock?.text)) {
            completeCurrentReasoningDraft()
          }
          setDraftBlock(event.draftBlock ?? null)
          return
        }
        if (event.type === 'lecture.completed') {
          setDraftBlock(null)
          setAwaitingLectureContinuation((current) => advanceLectureContinuationWait(current, 'lecture.completed'))
        }
        if (event.type === 'lecture.visualization.updated') {
          if (nextVisualizationHTML) {
            visualizationHTMLRef.current = nextVisualizationHTML
          }
          if (!visualizationFrameReadyRef.current) {
            if (nextVisualizationHTML !== previousVisualizationHTML) {
              setVisualizationHTML(nextVisualizationHTML)
              visualizationHTMLRef.current = nextVisualizationHTML
            }
            return
          }
          if (event.mode === 'patch' && event.patches?.length) {
            postVisualizationMessage({
              channel: 'lecture-host',
              type: 'lecture-visualization-patch',
              patches: event.patches,
            })
          } else if (nextVisualizationHTML !== visualizationHTMLRef.current) {
            setVisualizationHTML(nextVisualizationHTML)
            visualizationHTMLRef.current = nextVisualizationHTML
            visualizationFrameReadyRef.current = false
          }
          return
        }
        if (!visualizationHTMLRef.current && nextVisualizationHTML) {
          setVisualizationHTML(nextVisualizationHTML)
          visualizationHTMLRef.current = nextVisualizationHTML
        }
        if (event.block) {
          const nextBlock = event.block
          setDraftBlock(null)
          setAwaitingLectureContinuation((current) => advanceLectureContinuationWait(current, 'lecture.block.appended'))
          setBlocks((prev) => {
            if (prev.some((item) => item.id === nextBlock.id)) return prev
            return [...prev, nextBlock]
          })
        }
      } catch {}
    }
    ;[
      'lecture.session.ready',
      'lecture.block.appended',
      'lecture.highlight.changed',
      'lecture.resumed',
      'lecture.block.streaming',
      'lecture.reasoning.streaming',
      'lecture.visualization.updated',
      'lecture.completed',
      'question_asked',
      'question_replied',
      'question_rejected',
    ].forEach((eventName) => {
      eventSource.addEventListener(eventName, handleEvent as EventListener)
    })
    eventSource.onerror = () => {
      console.warn('[lecture.events] event source error, browser will retry')
    }
    return () => {
      ;[
        'lecture.session.ready',
        'lecture.block.appended',
        'lecture.highlight.changed',
        'lecture.resumed',
        'lecture.block.streaming',
        'lecture.reasoning.streaming',
        'lecture.visualization.updated',
        'lecture.completed',
        'question_asked',
        'question_replied',
        'question_rejected',
      ].forEach((eventName) => {
        eventSource.removeEventListener(eventName, handleEvent as EventListener)
      })
      eventSource.close()
    }
  }, [backendBaseUrl, tab.lectureSessionId, workroomId])

  useEffect(() => {
    const lectureAgentSessionID = session?.lectureAgentSessionID?.trim()
    if (!lectureAgentSessionID) return
    if (refreshedLectureAgentSessionIdsRef.current.has(lectureAgentSessionID)) return
    refreshedLectureAgentSessionIdsRef.current.add(lectureAgentSessionID)
    void getLectureSession(backendBaseUrl, {
      workroomID: workroomId,
      lectureSessionId: tab.lectureSessionId,
    })
      .then((payload) => {
        setSession(payload.session)
        setPendingQuestion(payload.pendingQuestion)
      })
      .catch(() => {})
  }, [backendBaseUrl, session?.lectureAgentSessionID, tab.lectureSessionId, workroomId])

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [blocks.length, sourceBlocks.length])

  useEffect(() => {
    lectureStreamRef.current?.scrollTo({
      top: lectureStreamRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [blocks.length, draftBlock?.text, reasoningDraft?.text, isReasoningExpanded])

  useEffect(() => {
    if (!iframeDoc) return
    postVisualizationMessage({
      channel: 'lecture-host',
      type: 'lecture-theme',
      theme,
    })
    postVisualizationMessage({
      channel: 'lecture-host',
      type: 'lecture-state',
      payload: {
        session,
        blocks,
        highlights: displayHighlightSpans,
        pendingQuestion,
        currentBlock: blocks[blocks.length - 1] ?? null,
      },
    })
  }, [blocks, displayHighlightSpans, iframeDoc, pendingQuestion, postVisualizationMessage, session, tab.lectureSessionId, theme])

  useEffect(() => {
    if (!iframeDoc) return
    postVisualizationMessage({
      channel: 'lecture-host',
      type: 'lecture-visualization-zoom',
      zoom: visualizationZoom,
    })
  }, [iframeDoc, postVisualizationMessage, visualizationZoom])

  useEffect(() => {
    const handleMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!data || data.channel !== 'lecture-bridge') return
      if (data.type === 'set-highlights') {
        return
      }
      if (data.type === 'report-visualization-snapshot') {
        const html = typeof data.html === 'string' ? data.html.trim() : ''
        if (!html) return
        console.debug('iframe_snapshot_reported', {
          lectureSessionId: tab.lectureSessionId,
          htmlSize: html.length,
        })
        return
      }
      if (data.type === 'report-visualization-zoom') {
        const nextZoom = clampVisualizationZoom(data.zoom)
        setVisualizationZoom((current) => (Math.abs(current - nextZoom) < 0.0001 ? current : nextZoom))
        return
      }
      if (data.type === 'report-visualization-patch-result') {
        if (data.ok) return
        console.warn('patch_rebuild_fallback', {
          lectureSessionId: tab.lectureSessionId,
          failed: data.failed ?? [],
        })
        if (!visualizationHTMLRef.current) return
        postVisualizationMessage({
          channel: 'lecture-host',
          type: 'lecture-visualization-reset',
          html: visualizationHTMLRef.current,
        })
      }
    }
    window.addEventListener('message', handleMessage as EventListener)
    return () => {
      window.removeEventListener('message', handleMessage as EventListener)
    }
  }, [backendBaseUrl, onToast, tab.lectureSessionId, workroomId])

  const adjustVisualizationZoom = useCallback(
    (delta: number) => {
      setVisualizationZoom((current) => clampVisualizationZoom(current + delta))
    },
    [clampVisualizationZoom],
  )

  const handleVisualizationWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!iframeDoc) return
      event.preventDefault()
      const step = event.deltaMode === 0 ? 0.08 : 0.12
      adjustVisualizationZoom(event.deltaY < 0 ? step : -step)
    },
    [adjustVisualizationZoom, iframeDoc],
  )

  const replyPendingQuestion = async (payload: { answers: string[][]; freeText?: Array<string | null> }) => {
    if (!pendingQuestion) return
    setIsBusy(true)
    try {
      await replyLectureRuntimeQuestion(backendBaseUrl, {
        workroomID: workroomId,
        lectureSessionId: tab.lectureSessionId,
        requestID: pendingQuestion.requestID,
        answers: payload.answers,
        freeText: payload.freeText,
      })
      if (shouldClearLectureReasoning('question_replied')) {
        setReasoningDraft(null)
        setIsReasoningExpanded(true)
      }
      setPendingQuestion(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : '回答提问失败'
      setError(message)
      onToast?.(message, 'error')
    } finally {
      setIsBusy(false)
    }
  }

  const buildChoiceReply = (label: string) => {
    const answers = pendingQuestion?.questions.map(() => [] as string[]) ?? [[]]
    answers[0] = [label]
    const freeText = pendingQuestion?.questions.map(() => null as string | null) ?? [null]
    return { answers, freeText }
  }

  const buildCustomReply = (text: string) => {
    const answers = pendingQuestion?.questions.map(() => [] as string[]) ?? [[]]
    const freeText = pendingQuestion?.questions.map(() => null as string | null) ?? [null]
    freeText[0] = text.trim()
    return { answers, freeText }
  }

  const handleSelectQuestionOption = (label: string) => {
    setSelectedChoiceLabel(label)
    void replyPendingQuestion(buildChoiceReply(label))
  }

  const handleSubmitCustomQuestionReply = () => {
    const value = customQuestionReply.trim()
    if (!value) return
    setSelectedChoiceLabel(CUSTOM_QUESTION_CHOICE)
    void replyPendingQuestion(buildCustomReply(value))
  }

  return (
    <div className="relative flex h-full min-h-0 bg-[var(--ui-bg-app)] text-[var(--ui-text-primary)]">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(380px,0.92fr)_minmax(0,1.08fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden border-r border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)]">
          {error ? (
            <div className="px-8 pt-5">
              <div className="border-b border-[var(--ui-border-default)] pb-3 text-[13px] leading-6 text-[var(--ui-text-primary)]">
                {error}
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden px-7 pb-6 pt-5">
            <div
              className="grid h-full min-w-0 gap-0"
              style={{
                gridTemplateRows: isVisualizationFullscreen ? 'minmax(0,1fr)' : 'minmax(0,1fr) minmax(0,1fr)',
              }}
            >
              <section className={`min-h-0 overflow-auto py-4 ${isVisualizationFullscreen ? 'hidden' : ''}`}>
                <div className="space-y-4 pr-1 text-[14px] leading-[1.65]">
                  {stemBlock ? (
                    <div className="whitespace-pre-wrap break-words">
                      {buildQuotedSegments(stemBlock.text, stemHighlightSpans, highlightColorByKey).map((segment, index) => (
                        <span
                          key={`${index}-${segment.text}`}
                          className="inline whitespace-pre-wrap align-baseline"
                          style={{
                            ...(segment.color ? highlightTextStyle(segment.color) : null),
                          }}
                        >
                          <QuestionTextView className="text-[15px] leading-[1.65]" text={segment.text} />
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {optionBlocks.length > 0 ? (
                    <div className="grid gap-3">
                      {optionBlocks.map((block) => {
                        const spans = displayHighlightSpans.filter((span) => span.sourceId === block.id)
                        const optionLabel = block.id.startsWith('option.')
                          ? block.id.slice('option.'.length)
                          : block.label ?? block.id
                        return (
                          <div key={block.id} className="min-w-0">
                            <div className="flex min-w-0 items-start gap-2">
                              <span className="shrink-0 pt-0.5 text-[12px] font-medium leading-6 text-[var(--ui-text-secondary)]">
                                {optionLabel}
                              </span>
                              <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[15px] leading-[1.65]">
                                {buildQuotedSegments(block.text, spans, highlightColorByKey).map((segment, index) => (
                                  <span
                                    key={`${block.id}-${index}-${segment.text}`}
                                    className="inline whitespace-pre-wrap align-baseline"
                                    style={segment.color ? highlightTextStyle(segment.color) : undefined}
                                  >
                                    <QuestionTextView className="text-[15px] leading-[1.65]" text={segment.text} />
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              </section>

              <section
                className="relative min-h-0 overflow-hidden border-t border-[var(--ui-border-default)] pt-4"
                onWheel={handleVisualizationWheel}
              >
                <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[color-mix(in_srgb,var(--ui-bg-panel)_88%,transparent)] px-2 py-1 text-[11px] text-[var(--ui-text-secondary)] shadow-sm backdrop-blur-md">
                  <span className="tabular-nums">{Math.round(visualizationZoom * 100)}%</span>
                  <button
                    type="button"
                    className="pointer-events-auto rounded-full px-2 py-1 text-[12px] leading-none text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-bg-panel-muted)]"
                    onClick={() => adjustVisualizationZoom(0.1)}
                    title="放大讲解可视化（也可在该区域使用滚轮缩放）"
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    className="pointer-events-auto rounded-full px-2 py-1 text-[12px] leading-none text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-bg-panel-muted)]"
                    onClick={() => setIsVisualizationFullscreen((value) => !value)}
                    title={isVisualizationFullscreen ? '退出全屏' : '全屏展示动画区域'}
                  >
                    {isVisualizationFullscreen ? '退出' : '全屏'}
                  </button>
                </div>
                {iframeDoc ? (
                  <iframe
                    ref={iframeRef}
                    title={`${tab.title}-visualization`}
                    sandbox="allow-scripts allow-same-origin"
                    onLoad={() => {
                      visualizationFrameReadyRef.current = true
                      flushVisualizationMessageQueue()
                    }}
                    srcDoc={iframeDoc}
                    className="h-full w-full border-0 bg-[var(--ui-bg-panel)]"
                  />
                ) : legendImages.length > 0 ? (
                  <div className="grid h-full auto-rows-fr gap-4 overflow-auto">
                    {legendImages.map((image, index) => (
                      <div key={`${index}-${image}`} className="flex items-center justify-center overflow-hidden">
                        <img src={image} alt={`legend-${index + 1}`} className="max-h-full max-w-full object-contain" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-full w-full" />
                )}
              </section>
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col border-l border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)]">
          {!isVisualizationFullscreen ? <div className="px-8 py-6" /> : null}
          <div ref={lectureStreamRef} className={`min-h-0 ${isVisualizationFullscreen ? 'flex-1' : 'flex-1'} overflow-auto px-8 pb-8`}>
            <div className="mx-auto max-w-4xl space-y-6">
              {streamRenderItems.map((item) => {
                if (item.kind === 'reasoning') {
                  return (
                    <LectureReasoningTrace
                      key={`reasoning-${item.draft.id}`}
                      draft={item.draft}
                      expanded={isReasoningExpanded}
                      elapsedMs={reasoningElapsedMs}
                      onToggle={() => setIsReasoningExpanded((current) => !current)}
                    />
                  )
                }

                const block = item.block
                return (
                  <div key={`${item.streaming ? 'streaming' : 'block'}-${block.id}`} className="grid grid-cols-[86px_minmax(0,1fr)] gap-4">
                    <div className="pt-0.5 text-[12px] text-[var(--ui-text-secondary)]">{formatBlockTime(block.createdAt)}</div>
                    <div className="min-w-0">
                      <div className={`mb-2 text-[12px] ${blockTone(block.role)}`}>{blockLabel(block.role)}</div>
                      <MarkdownWithMath
                        className="text-[17px] leading-[1.95] text-[var(--ui-text-primary)]"
                        transformMarkdown={normalizeLectureMarkdown}
                      >
                        {block.text}
                      </MarkdownWithMath>
                      {block.highlightSpans.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--ui-text-secondary)]">
                          {block.highlightSpans.map((span, index) => (
                            <span key={`${block.id}-${index}-${span.sourceId}`}>{span.quote}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}

              {showLectureContinuationWait ? (
                <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-4">
                  <div />
                  <div className="min-w-0">
                    <LectureGateShiftIndicator />
                  </div>
                </div>
              ) : null}

              {!blocks.length && !draftBlock && !reasoningDraft?.text.trim() && !showLectureContinuationWait ? (
                <div className="text-[14px] text-[var(--ui-text-secondary)]">等待讲解开始。</div>
              ) : null}
            </div>
          </div>

          {shouldShowPendingQuestionDock && pendingQuestionItem ? (
          <div className="shrink-0 px-8 pb-6 pt-4">
          <div
            className="relative mx-auto flex w-full max-w-4xl flex-col overflow-hidden border border-[var(--ui-border-default)] bg-[color-mix(in_srgb,var(--ui-bg-panel)_94%,transparent)] backdrop-blur-xl transition-[transform,opacity,box-shadow,border-radius] duration-[500ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{
              borderRadius: '18px',
              boxShadow: isQuestionDockExpanded ? '0 12px 48px rgba(0, 0, 0, 0.12)' : '0 8px 28px rgba(0, 0, 0, 0.08)',
              maxHeight: isQuestionDockExpanded ? '42dvh' : '56px',
            }}
          >
            <div className="flex items-center gap-3 border-b border-[var(--ui-border-default)] px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 text-[10px] font-medium tracking-[0.12em] text-[var(--ui-text-secondary)]">
                  讲解提问
                </div>
                <div
                  className="text-[13px] leading-5 text-[var(--ui-text-primary)]"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <QuestionTextView className="leading-6" text={pendingQuestionItem.question} />
                </div>
              </div>
              <button
                type="button"
                className="shrink-0 text-[11px] text-[var(--ui-text-secondary)]"
                onClick={() => setIsQuestionDockExpanded((value) => !value)}
                aria-label={isQuestionDockExpanded ? '收起提问栏' : '展开提问栏'}
              >
                {isQuestionDockExpanded ? '收起' : '展开'}
              </button>
            </div>

            {isQuestionDockExpanded ? (
              <div className="flex min-h-0 flex-1 overflow-hidden px-4 py-2.5">
                <QuestionOptionGrid
                  options={pendingQuestionItem.options}
                  customEnabled={pendingQuestionItem.custom !== false}
                  customPlaceholder="输入你的想法或自己的回答"
                  selectedChoiceLabel={selectedChoiceLabel}
                  customValue={customQuestionReply}
                  isBusy={isBusy}
                  onSelect={handleSelectQuestionOption}
                  onCustomValueChange={setCustomQuestionReply}
                  onCustomFocus={() => setSelectedChoiceLabel(CUSTOM_QUESTION_CHOICE)}
                  onSubmitCustom={handleSubmitCustomQuestionReply}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
        </aside>
      </div>
    </div>
  )
}
