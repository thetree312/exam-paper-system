import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownWithMath } from '../MarkdownWithMath'
import { parseMatchingAnswerMap, serializeAnswerMap } from './utils'
import type { ParagraphMatchingParseResult } from './utils'

const DESKTOP_BREAKPOINT = 1024
const CONTAINER_HEIGHT_CLAMP = 'clamp(720px, 92vh, 1200px)'

interface ParagraphMatchingRendererProps {
  data: ParagraphMatchingParseResult
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

const ParagraphMatchingRendererComponent: React.FC<ParagraphMatchingRendererProps> = ({
  data,
  value,
  onChange,
  disabled = false,
}) => {
  const { t } = useTranslation('common')
  const answerMap = useMemo(() => parseMatchingAnswerMap(value), [value])
  const [focusedParagraph, setFocusedParagraph] = useState<string | null>(null)
  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT,
  )
  const paragraphRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const paragraphsColumnRef = useRef<HTMLDivElement | null>(null)

  const scrollParagraphIntoView = (paragraphId: string) => {
    const node = paragraphRefs.current[paragraphId]
    if (!node) return

    if (isDesktop && paragraphsColumnRef.current) {
      const container = paragraphsColumnRef.current
      const containerRectTop = container.getBoundingClientRect().top
      const nodeRectTop = node.getBoundingClientRect().top
      const delta = nodeRectTop - containerRectTop
      const targetScrollTop =
        container.scrollTop + delta - Math.max(0, (container.clientHeight - node.offsetHeight) / 2)
      container.scrollTo({
        top: targetScrollTop,
        behavior: 'smooth',
      })
      return
    }

    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  const focusParagraph = (paragraphId: string, { scroll = true }: { scroll?: boolean } = {}) => {
    setFocusedParagraph(paragraphId)
    if (scroll) {
      scrollParagraphIntoView(paragraphId)
    }
  }

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return

    const update = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT)
    }

    update()
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
    }
  }, [])

  const paragraphToStatements = useMemo(() => {
    const mapping: Record<string, string[]> = {}
    for (const [statementId, paragraphId] of Object.entries(answerMap)) {
      if (!paragraphId) continue
      const key = String(paragraphId)
      if (!mapping[key]) {
        mapping[key] = []
      }
      mapping[key].push(String(statementId))
    }
    return mapping
  }, [answerMap])

  const handleSelect = (statementId: string, paragraphId: string) => {
    if (disabled) return
    const next = { ...answerMap }
    if (next[statementId] === paragraphId) {
      delete next[statementId]
    } else {
      next[statementId] = paragraphId
    }
    focusParagraph(paragraphId)
    onChange(serializeAnswerMap(next))
  }

  const handleClear = (statementId: string) => {
    if (disabled) return
    if (!(statementId in answerMap)) return
    const next = { ...answerMap }
    delete next[statementId]
    onChange(serializeAnswerMap(next))
  }

  return (
    <div className="space-y-4">
      {data.instructions && (
        <div className="rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)] p-4 text-sm text-[var(--ui-text-primary)]">
          <MarkdownWithMath disableMath>{data.instructions}</MarkdownWithMath>
        </div>
      )}
      <div
        className={`grid gap-4 lg:grid-cols-[minmax(280px,1fr)_minmax(320px,1.2fr)] ${
          isDesktop ? 'rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-elevated)] p-3' : ''
        }`}
        style={
          isDesktop
            ? {
                height: CONTAINER_HEIGHT_CLAMP,
                maxHeight: CONTAINER_HEIGHT_CLAMP,
                overflow: 'hidden',
              }
            : undefined
        }
      >
        <div
          ref={paragraphsColumnRef}
          className={`space-y-3 ${
            isDesktop
              ? 'h-full min-h-0 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-300'
              : ''
          }`}
        >
          <div className="text-xs font-semibold text-[var(--ui-text-primary)] uppercase tracking-wide">
            {t('question.matching.paragraphs')}
          </div>
          {data.paragraphs.map((paragraph) => {
            const linkedStatements = paragraphToStatements[paragraph.id] ?? []
            const isHighlighted =
              focusedParagraph === paragraph.id || linkedStatements.length > 0
            return (
              <div
                key={paragraph.id}
                ref={(el) => {
                  paragraphRefs.current[paragraph.id] = el
                }}
                className={`rounded-2xl border p-4 transition shadow-sm ${
                  isHighlighted ? 'border-sky-300 bg-sky-50' : 'border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)]'
                }`}
                onMouseEnter={() => focusParagraph(paragraph.id, { scroll: false })}
                onMouseLeave={() =>
                  setFocusedParagraph((prev) => (prev === paragraph.id ? null : prev))
                }
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="inline-flex items-center justify-center size-8 rounded-full bg-slate-900 text-white font-semibold">
                    {paragraph.id}
                  </span>
                  {linkedStatements.length > 0 && (
                    <span className="text-xs text-sky-700">
                      {t('question.matching.linked', {
                        targets: linkedStatements.join(', '),
                      })}
                    </span>
                  )}
                </div>
                <MarkdownWithMath disableMath className="text-sm text-[var(--ui-text-primary)] leading-relaxed">
                  {paragraph.text}
                </MarkdownWithMath>
              </div>
            )
          })}
        </div>
        <div
          className={`space-y-3 ${
            isDesktop
              ? 'h-full min-h-0 overflow-y-auto pl-1 scrollbar-thin scrollbar-thumb-slate-300'
              : ''
          }`}
        >
          <div className="text-xs font-semibold text-[var(--ui-text-primary)] uppercase tracking-wide">
            {t('question.matching.statements')}
          </div>
          {data.statements.map((statement) => {
            const assigned = answerMap[statement.id] ?? null
            return (
              <div
                key={statement.id}
                className={`rounded-2xl border p-4 space-y-3 ${
                  assigned ? 'border-emerald-300 bg-emerald-50' : 'border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center justify-center size-7 rounded-full border border-[var(--ui-border-strong)] text-xs font-semibold text-[var(--ui-text-primary)]">
                      {statement.id}
                    </span>
                    {assigned ? (
                      <span className="text-xs font-medium text-emerald-700">
                        {t('question.matching.selected_paragraph', { id: assigned })}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--ui-text-primary)]">{t('question.matching.unselected')}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="text-xs text-[var(--ui-text-primary)] hover:text-[var(--ui-text-primary)] disabled:opacity-40"
                    onClick={() => handleClear(statement.id)}
                    disabled={disabled || !assigned}
                  >
                    {t('question.matching.clear')}
                  </button>
                </div>
                <MarkdownWithMath disableMath className="text-sm text-[var(--ui-text-primary)] leading-relaxed">
                  {statement.text}
                </MarkdownWithMath>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {data.paragraphs.map((paragraph) => {
                    const isActive = assigned === paragraph.id
                    return (
                      <button
                        key={paragraph.id}
                        type="button"
                        disabled={disabled}
                        className={`text-sm font-semibold rounded-xl border px-3 py-2 transition ${
                          isActive
                            ? 'border-emerald-500 bg-emerald-500 text-white shadow-sm'
                            : 'border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] text-[var(--ui-text-primary)] hover:border-[var(--ui-border-strong)]'
                        }`}
                        onMouseEnter={() => focusParagraph(paragraph.id, { scroll: false })}
                        onMouseLeave={() =>
                          setFocusedParagraph((prev) => (prev === paragraph.id ? null : prev))
                        }
                        onClick={() => handleSelect(statement.id, paragraph.id)}
                      >
                        {paragraph.id}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export const ParagraphMatchingRenderer = React.memo(ParagraphMatchingRendererComponent)


