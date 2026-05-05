import React, { useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { FillBlankParsedResult, FillBlankAnswerMap } from './types'
import { parseFillBlankAnswer, serializeFillBlankAnswer } from './answerState'
import { useFillBlankNavigation } from './hooks/useFillBlankNavigation'
import { InlineMathAnswerInput } from '../../math/InlineMathAnswerInput'
import type { MathContentDocument } from '../../../lib/mathContent'

interface FillBlankRendererProps {
  parsed: FillBlankParsedResult
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  legendImages?: string[]
  mathInputEnabled?: boolean
  backendBaseUrl?: string
  userId?: string | number
}

/**
 * 下划线行内输入（Underline-only Inline Input）样式的填空题渲染器。
 *
 * - 不增加外套容器和阴影；
 * - 直接在原题文本位置将横线/括号替换为可编辑区域；
 * - 输入框仅保留下边框，背景透明，贴合纸质试卷体验。
 */
export const FillBlankRenderer: React.FC<FillBlankRendererProps> = ({
  parsed,
  value,
  onChange,
  disabled = false,
  legendImages = [],
  mathInputEnabled = false,
  backendBaseUrl,
  userId,
}) => {
  const { t } = useTranslation('common')
  const answerMap: FillBlankAnswerMap = useMemo(
    () => parseFillBlankAnswer(value, parsed.totalBlanks),
    [value, parsed.totalBlanks],
  )

  const { register, focusNext, focusPrev } = useFillBlankNavigation(parsed.totalBlanks)

  const handleBlankChange = useCallback(
    (index: number, content: MathContentDocument) => {
      const nextMap: FillBlankAnswerMap = { ...answerMap, [index]: content }
      const serialized = serializeFillBlankAnswer(nextMap)
      onChange(serialized)
    },
    [answerMap, onChange],
  )

  const handleKeyDown = useCallback(
    (index: number, e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) {
          focusPrev(index)
        } else {
          focusNext(index)
        }
      }
    },
    [focusNext, focusPrev],
  )

  const MarkdownSpan: React.FC<{ content: string }> = ({ content }) => (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
      rehypePlugins={[rehypeKatex]}
      components={{
        root: React.Fragment,
        p: ({ children }) => <span className="inline whitespace-pre-wrap">{children}</span>,
      }}
    >
      {content}
    </ReactMarkdown>
  )

  const renderTextWithLegends = (text: string, keyPrefix: string) => {
    if (!text) return null

    // 没有图例时，直接整段丢给 Markdown 渲染
    if (!legendImages.length) {
      return <MarkdownSpan content={text} />
    }

    const FIG_RE = /\[\[GLM_FIG_(\d+)\]\]/g
    const nodes: React.ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null
    let localKey = 0

    while ((match = FIG_RE.exec(text)) !== null) {
      const start = match.index
      const full = match[0]

      if (start > lastIndex) {
        const slice = text.slice(lastIndex, start)
        if (slice) {
          nodes.push(
            <span key={`${keyPrefix}-text-${localKey}`} className="inline">
              <MarkdownSpan content={slice} />
            </span>,
          )
          localKey += 1
        }
      }

      const idx = Number(match[1])
      const src = Number.isFinite(idx) ? legendImages[idx] : undefined
      if (src) {
        nodes.push(
          <img
            key={`${keyPrefix}-fig-${localKey}`}
            src={src}
            alt={t('question.legend.generic', { index: idx + 1 })}
            className="inline-block max-w-full h-auto align-middle mx-1 rounded border border-slate-200"
          />,
        )
      } else {
        // 找不到对应图例时，保守起见原样输出占位符
        nodes.push(
          <span key={`${keyPrefix}-placeholder-${localKey}`} className="inline">
            <MarkdownSpan content={full} />
          </span>,
        )
      }

      localKey += 1
      lastIndex = FIG_RE.lastIndex
    }

    if (lastIndex < text.length) {
      const tail = text.slice(lastIndex)
      if (tail) {
        nodes.push(
          <span key={`${keyPrefix}-text-${localKey}`} className="inline">
            <MarkdownSpan content={tail} />
          </span>,
        )
      }
    }

    return nodes
  }

  return (
    <div className="text-sm text-slate-700 w-full leading-relaxed">
      {parsed.segments.map((segment, idx) => {
        if (segment.type === 'text') {
          if (!segment.text) {
            return null
          }

          const lines = segment.text.split(/\r?\n/)
          const children: React.ReactNode[] = []

          lines.forEach((line, lineIndex) => {
            if (lineIndex > 0) {
              children.push(<div key={`br-${idx}-${lineIndex}`} className="w-full" />)
            }
            if (!line) return
            children.push(
              <span key={`seg-${idx}-line-${lineIndex}`} className="inline m-0 p-0">
                {renderTextWithLegends(line, `seg-${idx}-line-${lineIndex}`)}
              </span>,
            )
          })

          if (!children.length) return null
          return <React.Fragment key={idx}>{children}</React.Fragment>
        }

        const currentValue = answerMap[segment.index]

        return (
          <span key={idx}>
            <InlineMathAnswerInput
              value={currentValue}
              onChange={(next) => handleBlankChange(segment.index, next)}
              disabled={disabled}
              inputRef={register(segment.index)}
              onInputKeyDown={(e) => handleKeyDown(segment.index, e)}
              mathInputEnabled={mathInputEnabled}
              backendBaseUrl={backendBaseUrl}
              userId={userId}
            />
          </span>
        )
      })}
    </div>
  )
}
