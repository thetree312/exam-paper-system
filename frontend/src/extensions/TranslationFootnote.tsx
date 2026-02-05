import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { createPortal } from 'react-dom'

import type { TranslationWordSense } from '../types'

interface FootnoteAttrs {
  originalText?: string
  translation?: string | null
  phonetic?: string | null
  example?: string | null
  lemma?: string | null
  morphology?: string | null
  forms?: string[]
  senses?: TranslationWordSense[]
  createdAt?: number | null
}

type ParsedSense = {
  label: string
  meaning: string
  note?: string | null
}

const SENSE_REGEX = /^\s*((?:ad[vj]|n|v|vt|vi|prep|conj|pron|num|art|interj|aux)\.?)\s*(.*)$/i

const parseWordSenses = (text?: string | null): ParsedSense[] => {
  if (!text) return []
  return text
    .split(/；|;|\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const match = segment.match(SENSE_REGEX)
      if (!match) {
        return {
          label: '',
          meaning: segment,
        }
      }
      return {
        label: match[1].toLowerCase(),
        meaning: match[2].trim(),
      }
    })
}

const TranslationFootnoteComponent: React.FC<NodeViewProps> = ({ node, editor, getPos }) => {
  const attrs = node.attrs as FootnoteAttrs
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [hovering, setHovering] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [coords, setCoords] = useState({ left: 0, top: 0 })
  const [, forceUpdate] = useState(0)

  const computeOrder = useCallback(() => {
    if (!editor || typeof getPos !== 'function') return 0
    const targetPos = getPos()
    let order = 1
    editor.state.doc.descendants((_node, pos) => {
      if (_node.type.name === 'translationFootnote') {
        if (pos === targetPos) {
          return false
        }
        order += 1
      }
      return true
    })
    return order
  }, [editor, getPos])

  const order = useMemo(() => computeOrder(), [computeOrder])

  useEffect(() => {
    if (!editor) return
    const handler = () => {
      forceUpdate((val) => val + 1)
    }
    editor.on('transaction', handler)
    return () => {
      editor.off('transaction', handler)
    }
  }, [editor])

  const updateTooltipPosition = () => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    setCoords({
      left: rect.left + window.scrollX,
      top: rect.bottom + window.scrollY + 8,
    })
  }

  const handleMouseEnter = () => {
    updateTooltipPosition()
    setHovering(true)
  }

  const handleMouseLeave = () => {
    if (pinned) return
    setHovering(false)
  }

  const handleBadgeClick = (event: React.MouseEvent) => {
    event.preventDefault()
    updateTooltipPosition()
    setPinned(true)
    setHovering(true)
  }

  const handleClose = () => {
    setPinned(false)
    setHovering(false)
  }

  const handleRemove = () => {
    if (!editor || typeof getPos !== 'function') return
    const pos = getPos()
    if (typeof pos !== 'number') return
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .run()
  }

  const senses = useMemo(() => {
    if (attrs.senses && attrs.senses.length > 0) {
      return attrs.senses
        .map((sense) => ({
          label: sense.pos ? sense.pos.replace(/\.$/, '') : '',
          meaning: sense.meaning ?? '',
          note: sense.note,
        }))
        .filter((sense) => sense.meaning)
    }
    return parseWordSenses(attrs.translation)
  }, [attrs.senses, attrs.translation])

  return (
    <>
      <NodeViewWrapper
        as="span"
        ref={anchorRef}
        className="translation-footnote-ref"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        contentEditable={false}
        onClick={handleBadgeClick}
        data-footnote-order={order}
      >
        <span className="translation-footnote-badge">{order}</span>
      </NodeViewWrapper>
      {(hovering || pinned) &&
        createPortal(
          <div
            className="translation-footnote-tooltip"
            style={{ left: coords.left, top: coords.top }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <div className="translation-footnote-header">
              <div className="translation-footnote-term">
                <div className="translation-footnote-term-text">{attrs.originalText || '单词释义'}</div>
                <div className="translation-footnote-term-meta">
                  {attrs.phonetic && <span className="translation-footnote-phonetic">{attrs.phonetic}</span>}
                  {(attrs.lemma || attrs.morphology || (attrs.forms && attrs.forms.length > 0)) && (
                    <span className="translation-footnote-lemma">
                      {attrs.lemma && (
                        <span className="translation-footnote-lemma-base">
                          <span className="translation-footnote-lemma-label">原形：</span>
                          <span className="translation-footnote-lemma-value">{attrs.lemma}</span>
                        </span>
                      )}
                      {attrs.morphology && <span className="ml-1 text-xs text-slate-300">{attrs.morphology}</span>}
                      {attrs.forms && attrs.forms.length > 0 && (
                        <span className="ml-1 text-xs text-slate-400">{attrs.forms.join(' / ')}</span>
                      )}
                    </span>
                  )}
                </div>
              </div>
              <div className="translation-footnote-actions">
                <button type="button" className="translation-footnote-close" onClick={handleClose} title="关闭释义卡片">
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
                <button
                  type="button"
                  className="translation-footnote-remove"
                  onClick={handleRemove}
                  title="删除释义注脚"
                >
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                </button>
              </div>
            </div>
            <div className="translation-footnote-body">
              {senses.length > 0 && (
                <div className="translation-footnote-senses">
                  {senses.map((sense, index) => (
                    <div key={`${sense.label}-${index}`} className="translation-footnote-sense">
                      {sense.label && <span className="translation-footnote-sense-label">{sense.label}</span>}
                      <span className="translation-footnote-sense-text">{sense.meaning}</span>
                      {sense.note && <span className="translation-footnote-sense-note">{sense.note}</span>}
                    </div>
                  ))}
                </div>
              )}
              {senses.length === 0 && attrs.translation && (
                <div className="translation-footnote-meaning">{attrs.translation}</div>
              )}
              {attrs.example && <div className="translation-footnote-example">{attrs.example}</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

export const TranslationFootnote = Node.create({
  name: 'translationFootnote',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      originalText: {
        default: '',
      },
      translation: {
        default: '',
      },
      phonetic: {
        default: null,
      },
      example: {
        default: null,
      },
      lemma: {
        default: null,
      },
      morphology: {
        default: null,
      },
      senses: {
        default: [],
      },
      forms: {
        default: [],
      },
      createdAt: {
        default: null,
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-translation-footnote]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-translation-footnote': 'true',
        class: 'translation-footnote-ref',
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(TranslationFootnoteComponent)
  },
})
