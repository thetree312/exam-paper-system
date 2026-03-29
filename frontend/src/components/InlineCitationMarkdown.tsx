import React, { useMemo } from 'react'
import type { AgentCitationAnchor } from '../types'
import { MarkdownWithMath } from './MarkdownWithMath'

interface InlineCitationMarkdownProps {
  content: string
  citations?: AgentCitationAnchor[]
  className?: string
  compact?: boolean
  onCitationClick?: (citation: AgentCitationAnchor) => void
}

const INLINE_CITATION_RE = /\[(\d+)\](?!\()/g
const CITATION_HASH_PREFIX = '#citation-'

function buildCitationMarkdown(content: string, citationIndexes: Set<number>): string {
  if (!content || citationIndexes.size === 0) return content
  return content.replace(INLINE_CITATION_RE, (match, rawIndex: string) => {
    const index = Number.parseInt(rawIndex, 10)
    if (!Number.isFinite(index) || !citationIndexes.has(index)) {
      return match
    }
    return `[\\[${index}\\]](${CITATION_HASH_PREFIX}${index})`
  })
}

export const InlineCitationMarkdown: React.FC<InlineCitationMarkdownProps> = ({
  content,
  citations,
  className,
  compact = false,
  onCitationClick,
}) => {
  const citationMap = useMemo(() => {
    const map = new Map<number, AgentCitationAnchor>()
    for (const citation of citations || []) {
      if (!citation || typeof citation.citation_index !== 'number') continue
      map.set(citation.citation_index, citation)
    }
    return map
  }, [citations])

  const transformed = useMemo(
    () => buildCitationMarkdown(content, new Set(citationMap.keys())),
    [citationMap, content],
  )

  return (
    <MarkdownWithMath
      className={className}
      compact={compact}
      transformMarkdown={() => transformed}
      components={{
        a: ({ href, children }) => {
          if (typeof href === 'string' && href.startsWith(CITATION_HASH_PREFIX)) {
            const index = Number.parseInt(href.slice(CITATION_HASH_PREFIX.length), 10)
            const citation = Number.isFinite(index) ? citationMap.get(index) : undefined
            if (!citation) {
              return <span>{children}</span>
            }
            return (
              <button
                type="button"
                className="mx-0.5 inline-flex items-center rounded-md bg-amber-100 px-1.5 py-0.5 text-[0.85em] font-semibold text-amber-900 ring-1 ring-amber-300 transition hover:bg-amber-200"
                onClick={() => onCitationClick?.(citation)}
                data-citation-id={citation.citation_id}
                data-citation-index={citation.citation_index}
              >
                {children}
              </button>
            )
          }
          return (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          )
        },
      }}
    >
      {transformed}
    </MarkdownWithMath>
  )
}
