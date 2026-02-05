import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import { Extension, Node as TiptapNode, mergeAttributes, nodeInputRule } from '@tiptap/core'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import Image from '@tiptap/extension-image'
import type { NodeViewProps } from '@tiptap/react'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { createPortal } from 'react-dom'
import type { Node as PMNode } from '@tiptap/pm/model'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { shouldParseAsInlineMath } from './utils/math'
import { TranslationBlock } from './extensions/TranslationBlock'
import { TranslationFootnote } from './extensions/TranslationFootnote'
import { lookupTranslation, TranslationApiError } from './services/translationApi'
import { TranslationInlineIndicator } from './components/TranslationInlineIndicator'
import type {
  TranslationContext,
  TranslationLookupResponse,
  TranslationQuotaInfo,
  TranslationScope,
} from './types'

interface QuestionEditorProps {
  value: string
  onChange?: (val: string) => void
  title: string
  legendImages?: string[]
  readOnly?: boolean
  translationContext?: TranslationContext
}

type TranslationToolbarState = {
  visible: boolean
  x: number
  y: number
  scope: TranslationScope
  text: string
  isLoading: boolean
  error: string | null
  quota: TranslationQuotaInfo | null
  inlineStatus: 'idle' | 'loading' | 'error'
  inlineX: number
  inlineY: number
}

type SelectionSnapshot = {
  from: number
  to: number
  blockPos: number
  originalText: string
  selectedText: string
  scope: TranslationScope
}

const buildInitialToolbarState = (): TranslationToolbarState => ({
  visible: false,
  x: 0,
  y: 0,
  scope: 'sentence',
  text: '',
  isLoading: false,
  error: null,
  quota: null,
  inlineStatus: 'idle',
  inlineX: 0,
  inlineY: 0,
})

const translationInlinePlaceholderKey = new PluginKey('translation-inline-placeholder')

const createInlinePlaceholderPlugin = () =>
  new Plugin({
    key: translationInlinePlaceholderKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const meta = tr.getMeta(translationInlinePlaceholderKey)
        const mapped = old.map(tr.mapping, tr.doc)
        if (!meta) {
          return mapped
        }
        if (!meta.active || typeof meta.pos !== 'number') {
          return DecorationSet.empty
        }
        const deco = Decoration.widget(
          Math.max(0, Math.min(meta.pos, tr.doc.content.size)),
          () => {
            const span = document.createElement('span')
            span.className = 'translation-inline-placeholder'
            return span
          },
          { side: 1, stopEvent: () => true },
        )
        return DecorationSet.create(tr.doc, [deco])
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)
      },
    },
  })

const WORD_SCOPE_MAX_WORDS = 4
const WORD_SCOPE_MAX_CHARS = 60
const SENTENCE_PUNCTUATION_REGEX = /[。．\.\?!？！；;，,、]/u

const normalizeSelectionText = (text: string) => text.replace(/\s+/g, ' ').trim()

const decideScope = (text: string): TranslationScope => {
  const normalized = normalizeSelectionText(text)
  const words = normalized.split(/\s+/).filter(Boolean)
  const hasSentencePunctuation = SENTENCE_PUNCTUATION_REGEX.test(normalized)
  const isLikelyPhrase = words.length > 1 && words.length <= WORD_SCOPE_MAX_WORDS && !hasSentencePunctuation
  if (!hasSentencePunctuation && normalized.length <= WORD_SCOPE_MAX_CHARS && (words.length === 1 || isLikelyPhrase)) {
    return 'word'
  }
  return 'sentence'
}

type BlockInfo = {
  pos: number
  node: PMNode
}

const resolveBlockInfo = (doc: PMNode, pos: number): BlockInfo | null => {
  const safePos = Math.max(Math.min(pos, doc.content.size), 0)
  let $pos = doc.resolve(safePos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.isBlock) {
      return {
        pos: $pos.before(depth),
        node,
      }
    }
  }

  if (safePos > 0) {
    $pos = doc.resolve(Math.max(0, safePos - 1))
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const node = $pos.node(depth)
      if (node.isBlock) {
        return {
          pos: $pos.before(depth),
          node,
        }
      }
    }
  }
  return null
}

const getInsertionBlockInfo = (selection: TextSelection): BlockInfo | null => {
  const doc = selection.$from.doc
  const blockInfo = resolveBlockInfo(doc, selection.from)
  if (!blockInfo) return null
  if (blockInfo.node.type.name === 'translationBlock') return null
  return blockInfo
}

const computeSelectionCoords = (editor: Editor, from: number, to: number) => {
  if (!editor?.view) return null
  const view = editor.view
  const safeTo = Math.max(from, to - 1)
  try {
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(Math.max(from, safeTo))
    const x = (start.left + end.right) / 2 + window.scrollX
    const y = Math.min(start.top, end.top) + window.scrollY
    return { x, y }
  } catch {
    return null
  }
}

const formatQuotaMessage = (quota?: TranslationQuotaInfo | null) => {
  if (!quota) return null
  if (quota.limit == null) {
    return '订阅用户可无限次使用沉浸式翻译'
  }
  const remaining = typeof quota.remaining === 'number' ? Math.max(quota.remaining, 0) : null
  const limit = quota.limit
  const resetLabel = quota.reset_at
    ? `，将在 ${new Date(quota.reset_at).toLocaleTimeString()} 重置`
    : ''
  if (remaining == null) {
    return `免费额度上限 ${limit} 次${resetLabel}`
  }
  return `免费额度：剩余 ${remaining}/${limit} 次${resetLabel}`
}

const insertTranslationBlockNode = (
  editor: Editor,
  snapshot: SelectionSnapshot,
  payload: TranslationLookupResponse,
  scope: TranslationScope,
) => {
  const { state, view } = editor
  const nodeType = state.schema.nodes.translationBlock
  if (!nodeType) {
    return false
  }
  const blockNode = state.doc.nodeAt(snapshot.blockPos)
  if (!blockNode) {
    return false
  }
  const insertPos = Math.min(snapshot.blockPos + blockNode.nodeSize, state.doc.content.size)
  const attrs = {
    scope,
    translation: payload.translation ?? '',
    wordTranslation: payload.word?.translation ?? null,
    phonetic: payload.word?.phonetic ?? null,
    example: payload.word?.example ?? null,
    originalText: snapshot.selectedText,
    createdAt: Date.now(),
  }
  const tr = state.tr
  const nextNode = state.doc.nodeAt(insertPos)
  if (nextNode?.type.name === 'translationBlock') {
    tr.delete(insertPos, insertPos + nextNode.nodeSize)
  }
  tr.insert(insertPos, nodeType.create(attrs))
  view.dispatch(tr)
  return true
}

const insertTranslationFootnoteNode = (
  editor: Editor,
  snapshot: SelectionSnapshot,
  payload: TranslationLookupResponse,
) => {
  const { state, view } = editor
  const nodeType = state.schema.nodes.translationFootnote
  if (!nodeType) {
    return false
  }
  const attrs = {
    originalText: snapshot.selectedText,
    translation: payload.word?.translation ?? payload.translation ?? '',
    phonetic: payload.word?.phonetic ?? null,
    example: payload.word?.example ?? null,
    lemma: payload.word?.lemma ?? null,
    morphology: payload.word?.morphology ?? null,
    forms: payload.word?.forms ?? [],
    senses: payload.word?.senses ?? [],
    createdAt: Date.now(),
  }
  const insertPos = snapshot.to
  const tr = state.tr.insert(insertPos, nodeType.create(attrs))
  view.dispatch(tr)
  return true
}

const MathInlineComponent: React.FC<NodeViewProps> = ({ node }) => {
  const ref = useRef<HTMLSpanElement | null>(null)
  const formula = (node.attrs.formula as string) || ''

  useEffect(() => {
    if (!ref.current) return
    try {
      katex.render(formula, ref.current, {
        throwOnError: false,
        strict: 'ignore',
      })
    } catch {
      if (ref.current) {
        ref.current.textContent = formula
      }
    }
  }, [formula])

  return (
    <NodeViewWrapper as="span" data-math-inline ref={ref} />
  )
}

// 将纯文本中的 $...$ 片段预先转换为 mathInline 节点，避免只有重新输入时才触发渲染
const TABLE_SEPARATOR_REGEX = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/

function parseMarkdownTable(lines: string[], startIndex: number) {
  const headerLine = lines[startIndex] ?? ''
  const separatorLine = lines[startIndex + 1] ?? ''
  const headerMatch = headerLine.trim().startsWith('|') && headerLine.includes('|')
  const separatorMatch = TABLE_SEPARATOR_REGEX.test(separatorLine)

  if (!headerMatch || !separatorMatch) {
    return null
  }

  const toCells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())

  const headerCells = toCells(headerLine)
  const bodyRows: string[][] = []
  let index = startIndex + 2

  while (index < lines.length) {
    const current = lines[index]
    if (!(current.trim().startsWith('|') && current.includes('|'))) break
    if (TABLE_SEPARATOR_REGEX.test(current)) {
      index += 1
      continue
    }
    bodyRows.push(toCells(current))
    index += 1
  }

  const tableNode = {
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: headerCells.map((cell) => ({
          type: 'tableHeader',
          content: cell ? [{ type: 'text', text: cell }] : [],
        })),
      },
      ...bodyRows.map((row) => ({
        type: 'tableRow',
        content: row.map((cell) => ({
          type: 'tableCell',
          content: cell ? [{ type: 'text', text: cell }] : [],
        })),
      })),
    ],
  }

  return { node: tableNode, nextIndex: index }
}

function docToPlainTextWithMath(doc: PMNode, legendImages?: string[]): string {
  const lines: string[] = []

  doc.forEach((block) => {
    const parts: string[] = []

    block.forEach((node) => {
      if (node.type.name === 'text') {
        const raw = typeof (node as any).text === 'string' ? ((node as any).text as string) : ''
        if (raw) {
          const cleaned = raw.replace(/\uFFFC/g, '')
          if (cleaned) {
            parts.push(cleaned)
          }
        }
        return
      }
      if (node.type.name === 'mathInline') {
        const formula = (node.attrs as any)?.formula ?? ''
        if (formula) {
          parts.push(`$${String(formula)}$`)
        }
        return
      }
      if (node.type.name === 'legendImage') {
        const src = (node.attrs as any)?.src as string | undefined
        if (src && Array.isArray(legendImages)) {
          const idx = legendImages.indexOf(src)
          if (idx >= 0) {
            parts.push(`[[GLM_FIG_${idx}]]`)
          }
        }
        return
      }
      // 其他节点（如表格等）在纯文本中忽略
    })

    lines.push(parts.join(''))
  })

  return lines.join('\n')
}

function buildDocFromText(value: string) {
  const nodes: any[] = []
  const lines = value.split(/\r?\n/)

  let lineIndex = 0
  while (lineIndex < lines.length) {
    const line = lines[lineIndex]

    if (line.trim().startsWith('|') && line.includes('|')) {
      const tableParse = parseMarkdownTable(lines, lineIndex)
      if (tableParse) {
        nodes.push(tableParse.node)
        lineIndex = tableParse.nextIndex
        continue
      }
    }

    const content: any[] = []
    const regex = /(\$(.+?)\$)|(<sub>(.*?)<\/sub>)|(<sup>(.*?)<\/sup>)/gi
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(line)) !== null) {
      const start = match.index
      const full = match[0]

      if (start > lastIndex) {
        const textPart = line.slice(lastIndex, start)
        if (textPart.length > 0) {
          content.push({ type: 'text', text: textPart })
        }
      }

      if (match[1]) {
        const formulaRaw = match[2] ?? ''
        if (shouldParseAsInlineMath(formulaRaw)) {
          content.push({ type: 'mathInline', attrs: { formula: formulaRaw.trim() } })
        } else {
          const asText = `$${formulaRaw}$`
          content.push({ type: 'text', text: asText })
        }
      } else if (match[3]) {
        const subText = match[4] ?? ''
        if (subText) {
          content.push({
            type: 'text',
            text: subText,
            marks: [{ type: 'subscript' }],
          })
        }
      } else if (match[5]) {
        const supText = match[6] ?? ''
        if (supText) {
          content.push({
            type: 'text',
            text: supText,
            marks: [{ type: 'superscript' }],
          })
        }
      }

      lastIndex = start + full.length
    }

    if (lastIndex < line.length) {
      const tail = line.slice(lastIndex)
      if (tail.length > 0) {
        content.push({ type: 'text', text: tail })
      }
    }

    nodes.push(
      content.length
        ? { type: 'paragraph', content }
        : { type: 'paragraph' },
    )

    lineIndex += 1
  }

  return {
    type: 'doc',
    content: nodes,
  }
}

function buildDocWithLegends(value: string, legendImages?: string[]) {
  const base = buildDocFromText(value)
  if (!legendImages || legendImages.length === 0) return base

  const used = new Set<number>()
  const FIG_RE = /^\[\[GLM_FIG_(\d+)\]\]$/

  const content: any[] = []
  for (const node of base.content as any[]) {
    // 将仅包含占位符 [[GLM_FIG_i]] 的段落替换为对应的 legendImage
    if (
      node?.type === 'paragraph' &&
      Array.isArray(node.content) &&
      node.content.length === 1 &&
      node.content[0]?.type === 'text'
    ) {
      const text = String(node.content[0].text ?? '')
      const m = FIG_RE.exec(text.trim())
      if (m) {
        const idx = Number(m[1])
        const src = legendImages[idx]
        if (src) {
          used.add(idx)
          content.push({
            type: 'paragraph',
            content: [
              {
                type: 'legendImage',
                attrs: {
                  src,
                  alt: `图例 ${idx + 1}`,
                  title: '',
                  width: 200,
                },
              },
            ],
          })
          continue
        }
      }
    }

    content.push(node)
  }

  // 兼容旧数据：将未被占位符引用的图例统一附加在文末
  const trailingLegends: any[] = []
  legendImages.forEach((src, idx) => {
    if (used.has(idx)) return
    trailingLegends.push({
      type: 'paragraph',
      content: [
        {
          type: 'legendImage',
          attrs: {
            src,
            alt: `图例 ${idx + 1}`,
            title: '',
            width: 200,
          },
        },
      ],
    })
  })

  return {
    type: 'doc',
    content: trailingLegends.length ? [...content, ...trailingLegends] : content,
  }
}

const MathInline = TiptapNode.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      formula: {
        default: '',
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-math-inline]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math-inline': 'true' }), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineComponent)
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /\$(.+?)\$$/,
        type: this.type,
        getAttributes: (match) => ({
          formula: match[1] ?? '',
        }),
      }),
    ]
  },
})

const LegendImageComponent: React.FC<NodeViewProps> = ({ node, updateAttributes }) => {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const startRef = useRef<{ x: number; width: number }>({ x: 0, width: node.attrs.width ?? 200 })
  const [isDragging, setIsDragging] = useState(false)
  const [hovered, setHovered] = useState(false)

  const getCurrentWidth = () => {
    if (node.attrs.width) return node.attrs.width as number
    const rect = imgRef.current?.getBoundingClientRect()
    return rect?.width ?? 200
  }

  const handleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(true)

    const startWidth = getCurrentWidth()
    startRef.current = { x: event.clientX, width: startWidth }
    console.debug('[legendImage] drag-start', {
      src: node.attrs.src,
      startWidth,
      pageX: event.pageX,
      pageY: event.pageY,
    })

    let lastReportedWidth = startWidth

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startRef.current.x
      const next = Math.max(80, Math.min(480, Math.round(startRef.current.width + dx)))
      updateAttributes({ width: next })
      if (Math.abs(next - lastReportedWidth) >= 1) {
        console.debug('[legendImage] resizing', {
          src: node.attrs.src,
          delta: dx,
          width: next,
          clientX: e.clientX,
          clientY: e.clientY,
        })
        lastReportedWidth = next
      }
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setIsDragging(false)
      console.debug('[legendImage] drag-end', {
        src: node.attrs.src,
        finalWidth: lastReportedWidth,
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <NodeViewWrapper
      className="legend-image-wrapper"
      style={{ position: 'relative', display: 'inline-block' }}
      contentEditable={false}
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault()
        e.stopPropagation()
        console.debug('[legendImage] native dragstart blocked')
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        ref={imgRef}
        src={node.attrs.src}
        alt={node.attrs.alt ?? ''}
        title={node.attrs.title ?? ''}
        width={node.attrs.width ?? undefined}
        draggable={false}
        style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
        data-type="legendImage"
      />
      <button
        type="button"
        className="legend-handle"
        onMouseDown={handleMouseDown}
        style={{
          position: 'absolute',
          right: '-8px',
          bottom: '-8px',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          border: '1px solid #64748b',
          background: '#fff',
          cursor: 'nwse-resize',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          opacity: hovered || isDragging ? 1 : 0,
          pointerEvents: hovered || isDragging ? 'auto' : 'none',
          transition: 'opacity 120ms ease-out',
        }}
      />
    </NodeViewWrapper>
  )
}

const LegendImage = Image.extend({
  name: 'legendImage',
  addOptions() {
    return {
      ...this.parent?.(),
      inline: false,
      allowBase64: true,
    }
  },
  selectable: false,
  draggable: false,
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => {
          const width = element.getAttribute('width') || element.style.width || ''
          const numeric = parseInt(width, 10)
          return Number.isNaN(numeric) ? null : numeric
        },
        renderHTML: (attributes) => {
          const { width, ...rest } = attributes
          const htmlAttrs: Record<string, any> = {
            ...rest,
            class: 'legend-image',
            style: 'max-width: 100%; height: auto; display: block;',
            'data-type': 'legendImage',
          }
          if (width) {
            htmlAttrs.width = width
          }
          return htmlAttrs
        },
      },
    }
  },
  parseHTML() {
    return [
      { tag: 'img[data-type="legendImage"]' },
      { tag: 'img.legend-image' },
      { tag: 'img' },
    ]
  },
  addNodeView() {
    return ReactNodeViewRenderer(LegendImageComponent)
  },
})

export const QuestionEditor: React.FC<QuestionEditorProps> = ({
  value,
  onChange,
  title,
  legendImages,
  readOnly = false,
  translationContext,
}) => {
  const lastValueRef = useRef<string | null>(null)
  const isSettingContentRef = useRef(false)
  const isInternalChangeRef = useRef(false)

  const [toolbarState, setToolbarState] = useState<TranslationToolbarState>(buildInitialToolbarState())
  const selectionSnapshotRef = useRef<SelectionSnapshot | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const translationContextRef = useRef(translationContext)
  const readOnlyRef = useRef(readOnly)
  const inlineStatusRef = useRef<'idle' | 'loading' | 'error'>('idle')
  const toolbarVisibleRef = useRef(false)
  const lastProcessedSelectionRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 })

  useEffect(() => {
    translationContextRef.current = translationContext
  }, [translationContext])

  useEffect(() => {
    readOnlyRef.current = readOnly
  }, [readOnly])

  useEffect(() => {
    inlineStatusRef.current = toolbarState.inlineStatus
  }, [toolbarState.inlineStatus])

  useEffect(() => {
    toolbarVisibleRef.current = toolbarState.visible
  }, [toolbarState.visible])

  const hideToolbar = useCallback(() => {
    // 已经是完全隐藏且 idle 且没有选区快照时，不再触发更新，避免死循环
    if (!toolbarVisibleRef.current && inlineStatusRef.current === 'idle' && !selectionSnapshotRef.current) {
      return
    }

    toolbarVisibleRef.current = false
    inlineStatusRef.current = 'idle'
    setToolbarState(buildInitialToolbarState())
    selectionSnapshotRef.current = null
    lastProcessedSelectionRef.current = { from: 0, to: 0 }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const showToolbar = useCallback(
    (snapshot: SelectionSnapshot, x: number, y: number, inlineX: number, inlineY: number) => {
      if (!translationContextRef.current || readOnlyRef.current) {
        return
      }
      toolbarVisibleRef.current = true
      selectionSnapshotRef.current = snapshot
      inlineStatusRef.current = 'idle'
      setToolbarState({
        visible: true,
        x,
        y,
        scope: snapshot.scope,
        text: snapshot.selectedText,
        isLoading: false,
        error: null,
        quota: null,
        inlineStatus: 'idle',
        inlineX,
        inlineY,
      })
    },
    [],
  )

  const translationToolbarExtension = useMemo(
    () =>
      Extension.create({
        name: 'translation-toolbar',
        addProseMirrorPlugins() {
          return [
            new Plugin({
              key: new PluginKey('translation-toolbar'),
              view: (view) => ({
                update: (view) => {
                  if (readOnlyRef.current || !translationContextRef.current) {
                    hideToolbar()
                    return
                  }

                  const { state } = view
                  const { selection } = state

                  const selectionUnchanged =
                    lastProcessedSelectionRef.current.from === selection.from &&
                    lastProcessedSelectionRef.current.to === selection.to

                  if (
                    selectionUnchanged &&
                    toolbarVisibleRef.current &&
                    inlineStatusRef.current === 'idle'
                  ) {
                    return
                  }

                  if (!(selection instanceof TextSelection)) {
                    hideToolbar()
                    return
                  }

                  if (selection.empty || selection.from === selection.to) {
                    hideToolbar()
                    return
                  }

                  const raw = state.doc.textBetween(selection.from, selection.to, ' ')
                  const normalized = normalizeSelectionText(raw)
                  if (!normalized) {
                    hideToolbar()
                    return
                  }

                  // 当正在加载或展示错误时，只要选区发生变化就视为失焦，取消请求并清理状态
                  if (inlineStatusRef.current === 'loading' || inlineStatusRef.current === 'error') {
                    const snapshot = selectionSnapshotRef.current
                    if (
                      !snapshot ||
                      selection.from !== snapshot.from ||
                      selection.to !== snapshot.to
                    ) {
                      hideToolbar()
                    }
                    return
                  }

                  const blockInfo = getInsertionBlockInfo(selection)
                  if (!blockInfo) {
                    hideToolbar()
                    return
                  }

                  const scope = decideScope(normalized)

                  let x: number
                  let y: number
                  let inlineX: number
                  let inlineY: number
                  try {
                    const safeTo = Math.max(selection.from, selection.to - 1)
                    const fromCoords = view.coordsAtPos(selection.from)
                    const toCoords = view.coordsAtPos(safeTo)
                    x = (fromCoords.left + toCoords.right) / 2 + window.scrollX
                    y = Math.min(fromCoords.top, toCoords.top) + window.scrollY - 8

                    // 先按字符坐标估算一个大致位置，真实位置会在 handleTranslate 里用占位 DOM 修正
                    const inlinePos = Math.max(selection.from, selection.to - 1)
                    const inlineCoords = view.coordsAtPos(inlinePos)
                    inlineX = inlineCoords.right + window.scrollX
                    inlineY = (inlineCoords.top + inlineCoords.bottom) / 2 + window.scrollY
                  } catch {
                    hideToolbar()
                    return
                  }

                  const snapshot: SelectionSnapshot = {
                    from: selection.from,
                    to: selection.to,
                    blockPos: blockInfo.pos,
                    originalText: blockInfo.node.textContent || '',
                    selectedText: normalized,
                    scope,
                  }

                  lastProcessedSelectionRef.current = { from: selection.from, to: selection.to }
                  showToolbar(snapshot, x, y, inlineX, inlineY)
                },
              }),
            }),
          ]
        },
      }),
    [hideToolbar, showToolbar],
  )

  const inlinePlaceholderExtension = useMemo(
    () =>
      Extension.create({
        name: 'translation-inline-placeholder-wrapper',
        addProseMirrorPlugins() {
          return [createInlinePlaceholderPlugin()]
        },
      }),
    [],
  )

  const resizeSelectedImage = (editorInstance: any, factor: number) => {
    if (!editorInstance) return
    const { state, view } = editorInstance
    const { selection } = state
    if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'legendImage') return
    const attrs = selection.node.attrs as { width?: number }
    const current = attrs.width ?? 360
    const next = Math.max(160, Math.min(1200, Math.round(current * factor)))
    const tr = state.tr.setNodeMarkup(selection.from, undefined, { ...attrs, width: next })
    view.dispatch(tr)
  }

  const setSelectedImageWidth = (editorInstance: any, width: number) => {
    if (!editorInstance) return
    const { state, view } = editorInstance
    const { selection } = state
    if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'legendImage') return
    const attrs = selection.node.attrs as { width?: number }
    const clamped = Math.max(160, Math.min(1200, Math.round(width)))
    const tr = state.tr.setNodeMarkup(selection.from, undefined, { ...attrs, width: clamped })
    view.dispatch(tr)
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        table: false,
      }),
      Table.configure({
        resizable: false,
      }),
      TableRow,
      TableHeader,
      TableCell,
      Subscript,
      Superscript,
      MathInline,
      LegendImage,
      TranslationBlock,
      TranslationFootnote,
      translationToolbarExtension,
      inlinePlaceholderExtension,
    ],
    content: buildDocWithLegends(value, legendImages),
    editable: !readOnly,
    onUpdate:
      readOnly || !onChange
        ? undefined
        : ({ editor: ed }) => {
            if (isSettingContentRef.current) return
            // 如果文档中包含表格节点，则暂不回写文本，避免破坏 Markdown 表格结构
            let hasTable = false
            ed.state.doc.descendants((node: any) => {
              if (node.type && node.type.name === 'table') {
                hasTable = true
                return false
              }
              return true
            })

            if (hasTable) {
              return
            }

            const text = docToPlainTextWithMath(ed.state.doc as any, legendImages)

            const normalizePlain = (input: string | undefined) =>
              typeof input === 'string' ? input.replace(/\s+$/u, '') : ''

            const normalizedPrev = normalizePlain(value)
            const normalizedNext = normalizePlain(text)

            if (normalizedNext === normalizedPrev) {
              console.debug('[editor] skip text update: unchanged after normalize, legend-only mutation')
              lastValueRef.current = normalizedNext
              return
            }
            const preview = (input: string | undefined) =>
              typeof input === 'string'
                ? {
                    len: input.length,
                    head: input.slice(0, 48),
                    tail: input.length > 48 ? input.slice(-48) : input,
                  }
                : { len: 0, head: '', tail: '' }
            if (
              typeof value === 'string' &&
              typeof text === 'string' &&
              Math.abs(value.length - text.length) <= 4
            ) {
              const diffs: Array<{ idx: number; prev: number; next: number }> = []
              const max = Math.max(value.length, text.length)
              for (let i = 0; i < max; i += 1) {
                const pc = value.charCodeAt(i)
                const nc = text.charCodeAt(i)
                if (pc !== nc) {
                  diffs.push({ idx: i, prev: pc, next: nc })
                  if (diffs.length >= 8) break
                }
              }
              console.debug('[editor] tiny_diff_chars', diffs)
            }
            console.debug('[editor] text_changed detected', {
              prev: preview(value),
              next: preview(text),
              normalizedPrev: preview(normalizedPrev),
              normalizedNext: preview(normalizedNext),
            })
            isInternalChangeRef.current = true
            lastValueRef.current = normalizedNext
            onChange(normalizedNext)
          },
  })

  const handleTranslate = useCallback(async () => {
    if (!translationContext || !editor) return
    const snapshot = selectionSnapshotRef.current
    if (!snapshot) return

    const { backendBaseUrl, tenantId, userId } = translationContext
    const scope = snapshot.scope

    // 激活行内占位，提前为指示器腾出空间
    editor.view.dispatch(
      editor.state.tr.setMeta(translationInlinePlaceholderKey, {
        active: true,
        pos: snapshot.to,
      }),
    )

    // 等占位 DOM 插入后再读取真实坐标
    requestAnimationFrame(() => {
      const placeholderEl = editor.view.dom.querySelector(
        'span.translation-inline-placeholder',
      ) as HTMLElement | null
      if (!placeholderEl) return
      const rect = placeholderEl.getBoundingClientRect()
      setToolbarState((prev) => ({
        ...prev,
        inlineX: rect.left + window.scrollX + rect.width / 2,
        inlineY: (rect.top + rect.bottom) / 2 + window.scrollY,
      }))
    })

    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller

    inlineStatusRef.current = 'loading'
    setToolbarState((prev) => ({
      ...prev,
      isLoading: true,
      error: null,
      visible: false,
      inlineStatus: 'loading',
    }))

    try {
      const response = await lookupTranslation(
        backendBaseUrl,
        {
          tenantId,
          userId,
          text: scope === 'word' ? snapshot.selectedText : snapshot.originalText,
          scope,
        },
        controller.signal,
      )

      if (scope === 'word') {
        insertTranslationFootnoteNode(editor, snapshot, response)
      } else {
        insertTranslationBlockNode(editor, snapshot, response, scope)
      }

      // 翻译完成后将光标移到选区末尾，清除选中状态
      editor.commands.setTextSelection(snapshot.to)

      inlineStatusRef.current = 'idle'
      setToolbarState((prev) => ({
        ...prev,
        quota: response.quota ?? null,
        error: null,
        isLoading: false,
        inlineStatus: 'idle',
      }))
      hideToolbar()
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return
      }
      let message = '翻译服务出错，请稍后再试'
      if (err instanceof TranslationApiError) {
        message = err.message
      }
      inlineStatusRef.current = 'error'
      setToolbarState((prev) => ({
        ...prev,
        error: message,
        isLoading: false,
        inlineStatus: 'error',
        visible: false,
      }))
    } finally {
      abortControllerRef.current = null
      editor.view.dispatch(
        editor.state.tr.setMeta(translationInlinePlaceholderKey, { active: false }),
      )
    }
  }, [editor, hideToolbar, translationContext])

  useEffect(() => {
    if (!editor) return

    // 内部编辑导致的 value 变化：只同步 lastValueRef，不重置内容
    if (isInternalChangeRef.current) {
      isInternalChangeRef.current = false
      lastValueRef.current = value
      return
    }

    // 仅当外部传入的 value 发生变化时，才重置内容
    if (lastValueRef.current === value) return

    isSettingContentRef.current = true
    editor.commands.setContent(buildDocWithLegends(value, legendImages), false)
    isSettingContentRef.current = false
    lastValueRef.current = value
  }, [editor, value, legendImages])

  return (
    <div className={`prose prose-slate max-w-none text-[15px] leading-relaxed english-serif ${readOnly ? 'pointer-events-none select-text' : ''}`}>
      {editor && <EditorContent editor={editor} className="tiptap" />}

      {editor &&
        toolbarState.visible &&
        toolbarState.inlineStatus === 'idle' &&
        createPortal(
          <button
            type="button"
            className="translation-toolbar-fab"
            style={{ left: toolbarState.x, top: toolbarState.y }}
            onClick={handleTranslate}
            disabled={!translationContext}
          >
            <span className="material-symbols-outlined translation-toolbar-fab__icon">translate</span>
          </button>,
          document.body,
        )}

      <TranslationInlineIndicator
        active={toolbarState.inlineStatus === 'loading' || toolbarState.inlineStatus === 'error'}
        x={toolbarState.inlineX}
        y={toolbarState.inlineY}
        status={toolbarState.inlineStatus}
        scope={toolbarState.scope}
        onRetry={toolbarState.inlineStatus === 'error' ? handleTranslate : undefined}
      />
    </div>
  )
}
