import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, {
  defaultSchema as defaultSanitizeSchema,
} from 'rehype-sanitize'
import type { Options as RehypeSanitizeOptions } from 'rehype-sanitize'

import 'katex/dist/katex.min.css'

interface MarkdownWithMathProps {
  children: string
  className?: string
  compact?: boolean
}

const FRACTION_PATTERN = /\\d?frac\s*\{[^{}]+\}\s*\{[^{}]+\}/g
const CURRENCY_DOLLAR_PATTERN = /\$(?=\s?\d+(?:[,\.]\d+)?(?![\^_\\{]))/g

function wrapBareFractions(text: string): string {
  if (!text) return text
  return text.replace(FRACTION_PATTERN, (match) => `${match}`)
}

function escapeCurrencyDollars(text: string): string {
  if (!text) return text
  return text.replace(CURRENCY_DOLLAR_PATTERN, '\\$')
}

function normalizeMathMarkdown(raw: string): string {
  if (!raw) return ''

  let result = ''
  let cursor = 0
  const length = raw.length

  while (cursor < length) {
    if (raw[cursor] === '$') {
      const isDisplay = raw.startsWith('$$', cursor)
      const delimiter = isDisplay ? '$$' : '$'
      const end = raw.indexOf(delimiter, cursor + delimiter.length)
      if (end === -1) {
        // 未能找到闭合符号，将剩余内容视为普通文本并兜底处理
        result += wrapBareFractions(raw.slice(cursor))
        break
      }
      result += raw.slice(cursor, end + delimiter.length)
      cursor = end + delimiter.length
      continue
    }

    const nextDollar = raw.indexOf('$', cursor)
    if (nextDollar === -1) {
      result += wrapBareFractions(raw.slice(cursor))
      break
    }
    result += wrapBareFractions(raw.slice(cursor, nextDollar))
    cursor = nextDollar
  }

  return result
}

const sanitizeSchema: RehypeSanitizeOptions = (() => {
  const mathTags = [
    'math',
    'mi',
    'mn',
    'mo',
    'ms',
    'mtext',
    'mover',
    'munder',
    'munderover',
    'msup',
    'msub',
    'msubsup',
    'mfrac',
    'mtable',
    'mtr',
    'mtd',
    'annotation',
    'semantics',
  ]

  const allowAttr = (
    current: (string | [string, ...unknown[]])[] | undefined,
    additions: (string | [string, ...unknown[]])[],
  ) => [...(current || []), ...additions]

  return {
    ...defaultSanitizeSchema,
    tagNames: Array.from(
      new Set([...(defaultSanitizeSchema.tagNames || []), ...mathTags]),
    ),
    attributes: {
      ...defaultSanitizeSchema.attributes,
      span: allowAttr(defaultSanitizeSchema.attributes?.span, [
        'className',
        'style',
      ]),
      div: allowAttr(defaultSanitizeSchema.attributes?.div, [['className']]),
      math: allowAttr(defaultSanitizeSchema.attributes?.math, [
        ['xmlns'],
        ['display'],
      ]),
      annotation: allowAttr(defaultSanitizeSchema.attributes?.annotation, [
        ['encoding'],
      ]),
      semantics: allowAttr(defaultSanitizeSchema.attributes?.semantics, []),
      '*': allowAttr(defaultSanitizeSchema.attributes?.['*'], ['className']),
    },
  }
})()

const MarkdownWithMathComponent: React.FC<MarkdownWithMathProps & { disableMath?: boolean }> = ({
  children,
  className,
  compact = false,
  disableMath = false,
}) => {
  const rootClass = ['markdown-body', 'english-serif', compact ? 'markdown-body--compact' : '', className]
    .filter(Boolean)
    .join(' ')

  const processedContent = disableMath ? escapeCurrencyDollars(children) : children
  const normalized = disableMath ? processedContent : normalizeMathMarkdown(processedContent)

  const remarkPlugins = disableMath ? [remarkGfm] : [remarkMath, remarkGfm]
  
  // 数学渲染路径下只使用 rehype-katex，避免 rehype-sanitize 将 KaTeX 生成的 SVG / MathML 结构裁剪掉
  const rehypePlugins: any[] = disableMath ? [[rehypeSanitize, sanitizeSchema]] : [[rehypeKatex]]

  return (
    <div className={rootClass}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          p: ({ children }) => (
            <p className={`whitespace-pre-wrap ${compact ? 'mb-0 leading-snug' : 'leading-relaxed mb-1 last:mb-0'}`}>
              {children}
            </p>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse border border-slate-300">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-slate-300 bg-slate-50 px-2 py-1 text-sm font-medium text-slate-700">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-slate-300 px-2 py-1 text-sm text-slate-700 align-top">
              {children}
            </td>
          ),
          img: ({ ...props }) => <img {...props} style={{ maxWidth: '100%', height: 'auto' }} />,
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

class MarkdownErrorBoundary extends React.Component<
  { fallback: React.ReactNode; debug?: { preview: string } },
  { hasError: boolean }
> {
  constructor(props: { fallback: React.ReactNode; debug?: { preview: string } }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    try {
      // 统一记录 Markdown 渲染异常，并附带触发内容预览，便于排查复杂题干（如表格题）导致的崩溃
      console.error('[MarkdownWithMath.error]', {
        error,
        preview: this.props.debug?.preview,
      })
    } catch {
      // ignore
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback
    }
    return this.props.children
  }
}

export const MarkdownWithMath: React.FC<MarkdownWithMathProps & { disableMath?: boolean }> = React.memo(
  (props) => {
    const { children, className, compact } = props
    const fallbackClass = ['markdown-body', 'english-serif', compact ? 'markdown-body--compact' : '', className]
      .filter(Boolean)
      .join(' ')

    return (
      <MarkdownErrorBoundary
        fallback={<div className={fallbackClass}>{children}</div>}
        debug={{ preview: typeof children === 'string' ? children.slice(0, 400) : '' }}
      >
        <MarkdownWithMathComponent {...props} />
      </MarkdownErrorBoundary>
    )
  },
)
