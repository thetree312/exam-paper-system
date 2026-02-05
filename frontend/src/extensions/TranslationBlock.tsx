import React from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'

import type { TranslationScope } from '../types'

interface TranslationAttrs {
  scope: TranslationScope
  translation: string
  wordTranslation?: string | null
  phonetic?: string | null
  example?: string | null
  createdAt?: number | null
}

const TranslationBlockComponent: React.FC<NodeViewProps> = ({ node, editor, getPos }) => {
  const attrs = node.attrs as TranslationAttrs
  const scope = attrs.scope ?? 'sentence'
  const translation = attrs.translation ?? ''
  const wordTranslation = attrs.wordTranslation ?? ''
  const phonetic = attrs.phonetic ?? ''
  const example = attrs.example ?? ''

  const label = scope === 'word' ? '单词释义' : '沉浸式翻译'

  const handleRemove = () => {
    if (!editor || typeof getPos !== 'function') {
      return
    }
    const pos = getPos()
    if (typeof pos !== 'number') return
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .run()
  }

  return (
    <NodeViewWrapper
      className="immersive-translation-block"
      data-scope={scope}
      contentEditable={false}
      as="div"
    >
      <div className="translation-block-header">
        <div className="translation-block-label">
          <span className="material-symbols-outlined text-[14px]">sparkles</span>
          {label}
        </div>
        <div className="translation-block-actions">
          <button
            type="button"
            className="translation-block-action"
            title="朗读（即将支持）"
            aria-label="朗读"
            disabled
          >
            <span className="material-symbols-outlined text-[16px]">volume_up</span>
          </button>
          <button
            type="button"
            className="translation-block-action"
            title="移除译文"
            aria-label="移除译文"
            onClick={handleRemove}
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      </div>
      {scope === 'word' ? (
        <div className="translation-word-body">
          <div className="translation-word-heading">
            <span className="translation-word-term">{node.attrs.originalText ?? ''}</span>
            {phonetic && <span className="translation-word-phonetic">{phonetic}</span>}
          </div>
          <div className="translation-word-meaning">{wordTranslation || translation}</div>
          {example && <div className="translation-word-example">{example}</div>}
        </div>
      ) : (
        <div className="translation-sentence-body">{translation}</div>
      )}
    </NodeViewWrapper>
  )
}

export const TranslationBlock = Node.create({
  name: 'translationBlock',
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      scope: {
        default: 'sentence',
      },
      translation: {
        default: '',
      },
      wordTranslation: {
        default: null,
      },
      phonetic: {
        default: null,
      },
      example: {
        default: null,
      },
      originalText: {
        default: '',
      },
      createdAt: {
        default: null,
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-translation-block="true"]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-translation-block': 'true',
        class: 'immersive-translation-block',
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(TranslationBlockComponent)
  },
})
