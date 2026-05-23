import React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, {
  defaultSchema as defaultSanitizeSchema,
} from 'rehype-sanitize'
import type { Options as RehypeSanitizeOptions } from 'rehype-sanitize'
import { normalizeMathMarkdown } from '../lib/mathRecovery'

import 'katex/dist/katex.min.css'

interface MarkdownWithMathProps {
  children: string
  className?: string
  compact?: boolean
  components?: Components
  transformMarkdown?: (content: string) => string
}

const CURRENCY_DOLLAR_PATTERN = /\$(?=\s?\d+(?:[,\.]\d+)?(?![\^_\\{]))/g

function escapeCurrencyDollars(text: string): string {
  if (!text) return text
  return text.replace(CURRENCY_DOLLAR_PATTERN, '\\$')
}

const sanitizeSchema: RehypeSanitizeOptions = (() => {
  type SanitizeAttrValue = string | number | boolean | RegExp | null | undefined
  type SanitizeAttr = string | [string, ...SanitizeAttrValue[]]
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
    current: SanitizeAttr[] | undefined,
    additions: SanitizeAttr[],
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

function getNodeText(node: any): string {
  if (!node) return ''
  if (typeof node.value === 'string') return node.value
  if (!Array.isArray(node.children)) return ''
  return node.children.map(getNodeText).join('')
}

function hasKatexErrorClass(node: any): boolean {
  if (node?.tagName === 'merror') return true
  const className = node?.properties?.className
  if (typeof className === 'string') return className.split(/\s+/).includes('katex-error')
  if (Array.isArray(className)) return className.map(String).includes('katex-error')
  return false
}

function rehypeRecoverKatexErrors() {
  return (tree: any) => {
    const visit = (node: any, parent: any, index: number | null) => {
      if (!node || !Array.isArray(node.children)) return
      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i]
        if (hasKatexErrorClass(child)) {
          node.children[i] = {
            type: 'element',
            tagName: child.tagName === 'span' ? 'code' : 'code',
            properties: {
              className: ['math-katex-error-fallback'],
            },
            children: [
              {
                type: 'text',
                value: getNodeText(child).trim(),
              },
            ],
          }
          continue
        }
        visit(child, node, i)
      }
      if (parent && index != null && hasKatexErrorClass(node)) {
        parent.children[index] = {
          type: 'element',
          tagName: 'code',
          properties: {
            className: ['math-katex-error-fallback'],
          },
          children: [
            {
              type: 'text',
              value: getNodeText(node).trim(),
            },
          ],
        }
      }
    }

    visit(tree, null, null)
  }
}

const MarkdownWithMathComponent: React.FC<MarkdownWithMathProps & { disableMath?: boolean }> = ({
  children,
  className,
  compact = false,
  disableMath = false,
  components,
  transformMarkdown,
}) => {
  const rootClass = ['markdown-body', 'english-serif', compact ? 'markdown-body--compact' : '', className]
    .filter(Boolean)
    .join(' ')

  const input = transformMarkdown ? transformMarkdown(children) : children
  const processedContent = disableMath ? escapeCurrencyDollars(input) : input
  const normalized = disableMath ? processedContent : normalizeMathMarkdown(processedContent)

  const remarkPlugins = disableMath ? [remarkGfm] : [remarkMath, remarkGfm]
  
  // 数学渲染路径下只使用 rehype-katex，避免 rehype-sanitize 将 KaTeX 生成的 SVG / MathML 结构裁剪掉
  const rehypePlugins: any[] = disableMath
    ? [[rehypeSanitize, sanitizeSchema]]
    : [[rehypeKatex], rehypeRecoverKatexErrors]

  const mergedComponents: Components = {
    p: ({ children }) => (
      <p className={`whitespace-pre-wrap ${compact ? 'mb-0 leading-snug' : 'leading-relaxed mb-1 last:mb-0'}`}>
        {children}
      </p>
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm border-collapse border border-[var(--ui-border-strong)]">
          {children}
        </table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-[var(--ui-border-strong)] bg-[var(--ui-bg-panel-muted)] px-2 py-1 text-sm font-medium text-[var(--ui-text-primary)]">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-[var(--ui-border-strong)] px-2 py-1 text-sm text-[var(--ui-text-primary)] align-top">
        {children}
      </td>
    ),
    img: ({ ...props }) => <img {...props} style={{ maxWidth: '100%', height: 'auto' }} />,
    ...(components || {}),
  }

  return (
    <div className={rootClass}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={mergedComponents}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

class MarkdownErrorBoundary extends React.Component<
  { fallback: React.ReactNode; debug?: { preview: string }; children?: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: React.ReactNode; debug?: { preview: string }; children?: React.ReactNode }) {
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


