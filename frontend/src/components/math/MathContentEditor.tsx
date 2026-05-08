import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSONContent, NodeViewProps } from '@tiptap/react'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Node as TiptapNode, mergeAttributes } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import katex from 'katex'

import 'katex/dist/katex.min.css'

import { normalizeMathExpression } from '../../lib/mathRecovery'
import {
  createTextMathDocument,
  ensureMathContentDocument,
  mathContentToPromptText,
  type MathContentDocument,
} from '../../lib/mathContent'
import { type FragmentWindow, useMathInputController } from './useMathInputController'

type MathEditorHandle = {
  focus: () => void
  insertFormula: (latex: string, mode: 'inline' | 'block') => void
  element: HTMLElement | null
}

interface MathContentEditorProps {
  value: MathContentDocument | null | undefined
  onChange: (value: MathContentDocument) => void
  placeholder?: string
  disabled?: boolean
  minHeight?: number
  maxHeight?: number
  singleLine?: boolean
  className?: string
  contentClassName?: string
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void
  onEditorReady?: (handle: MathEditorHandle | null) => void
  mathInputEnabled?: boolean
  backendBaseUrl?: string
  userId?: string | number
}

const HARD_DELIMITER_RE = /[\n。！？!?；;]/
const SOFT_DELIMITER_RE = /[,，]/
const MAX_WINDOW_LENGTH = 160

const MathInlineComponent: React.FC<NodeViewProps> = ({ node }) => {
  const ref = useRef<HTMLSpanElement | null>(null)
  const formula = ((node.attrs.formula as string) || '').trim()
  const recoveredFormula = normalizeMathExpression(formula)

  useEffect(() => {
    if (!ref.current) return
    try {
      katex.render(recoveredFormula, ref.current, {
        throwOnError: true,
        strict: 'ignore',
      })
    } catch {
      ref.current.textContent = formula
    }
  }, [formula, recoveredFormula])

  return <NodeViewWrapper as="span" data-math-inline ref={ref} />
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
})

function parseLineToParagraph(line: string): JSONContent {
  const content: JSONContent[] = []
  const tokenRe = /\$([^$\n]+)\$/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(line)) !== null) {
    const start = match.index
    if (start > lastIndex) {
      const text = line.slice(lastIndex, start)
      if (text) {
        content.push({ type: 'text', text })
      }
    }

    const formula = (match[1] || '').trim()
    if (formula) {
      content.push({
        type: 'mathInline',
        attrs: { formula },
      })
    } else {
      content.push({ type: 'text', text: match[0] })
    }
    lastIndex = start + match[0].length
  }

  if (lastIndex < line.length) {
    const tail = line.slice(lastIndex)
    if (tail) {
      content.push({ type: 'text', text: tail })
    }
  }

  if (!content.length) {
    return { type: 'paragraph' }
  }
  return { type: 'paragraph', content }
}

function sourceTextToTiptapContent(text: string): JSONContent {
  const lines = text.split('\n')
  const content = lines.map((line) => parseLineToParagraph(line))
  return {
    type: 'doc',
    content: content.length ? content : [{ type: 'paragraph' }],
  }
}

function docToSourceText(editor: NonNullable<ReturnType<typeof useEditor>>): string {
  const lines: string[] = []
  const doc = editor.state.doc

  doc.forEach((block) => {
    if (block.type.name !== 'paragraph') {
      return
    }

    let line = ''
    block.forEach((child) => {
      if (child.type.name === 'text') {
        line += child.text || ''
      } else if (child.type.name === 'mathInline') {
        const formula = ((child.attrs.formula as string) || '').trim()
        if (formula) {
          line += `$${formula}$`
        }
      }
    })
    lines.push(line)
  })

  return lines.join('\n')
}

type SourceSegment = {
  sourceStart: number
  sourceEnd: number
  fromPos: number
  toPos: number
  kind: 'text' | 'math' | 'newline'
}

function buildSourceSegments(editor: NonNullable<ReturnType<typeof useEditor>>): SourceSegment[] {
  const segments: SourceSegment[] = []
  const doc = editor.state.doc
  let cursor = 0

  doc.forEach((block, blockOffset, blockIndex) => {
    if (block.type.name !== 'paragraph') return

    const blockPos = blockOffset + 1
    block.forEach((child, childOffset) => {
      const fromPos = blockPos + 1 + childOffset
      const toPos = fromPos + child.nodeSize

      if (child.type.name === 'text') {
        const text = child.text || ''
        if (!text) return
        segments.push({
          sourceStart: cursor,
          sourceEnd: cursor + text.length,
          fromPos,
          toPos,
          kind: 'text',
        })
        cursor += text.length
        return
      }

      if (child.type.name === 'mathInline') {
        const formula = ((child.attrs.formula as string) || '').trim()
        const token = formula ? `$${formula}$` : ''
        if (!token) return
        segments.push({
          sourceStart: cursor,
          sourceEnd: cursor + token.length,
          fromPos,
          toPos,
          kind: 'math',
        })
        cursor += token.length
      }
    })

    const isLast = blockIndex >= doc.childCount - 1
    if (!isLast) {
      segments.push({
        sourceStart: cursor,
        sourceEnd: cursor + 1,
        fromPos: blockPos + block.nodeSize - 1,
        toPos: blockPos + block.nodeSize - 1,
        kind: 'newline',
      })
      cursor += 1
    }
  })

  return segments
}

function sourceIndexToDocPos(editor: NonNullable<ReturnType<typeof useEditor>>, index: number): number {
  const safeIndex = Math.max(0, index)
  const segments = buildSourceSegments(editor)
  const docSize = editor.state.doc.content.size
  if (!segments.length) return Math.min(safeIndex, docSize)

  for (const segment of segments) {
    if (safeIndex < segment.sourceStart) {
      return segment.fromPos
    }
    if (safeIndex > segment.sourceEnd) {
      continue
    }
    if (safeIndex === segment.sourceEnd) {
      return segment.toPos
    }
    if (segment.kind === 'text') {
      return Math.max(segment.fromPos, Math.min(segment.toPos, segment.fromPos + (safeIndex - segment.sourceStart)))
    }
    return segment.fromPos
  }

  return docSize
}

function docPosToSourceIndex(editor: NonNullable<ReturnType<typeof useEditor>>, docPos: number): number {
  const safeDocPos = Math.max(0, Math.min(docPos, editor.state.doc.content.size))
  const segments = buildSourceSegments(editor)
  if (!segments.length) return 0

  for (const segment of segments) {
    if (safeDocPos < segment.fromPos) {
      return segment.sourceStart
    }
    if (safeDocPos > segment.toPos) {
      continue
    }
    if (segment.kind === 'text') {
      return Math.max(
        segment.sourceStart,
        Math.min(segment.sourceEnd, segment.sourceStart + (safeDocPos - segment.fromPos)),
      )
    }
    if (safeDocPos === segment.toPos) {
      return segment.sourceEnd
    }
    return segment.sourceStart
  }

  return segments[segments.length - 1]?.sourceEnd ?? 0
}

function extractFragmentWindow(value: string, caret: number, version: number): FragmentWindow | null {
  if (!value.trim()) return null
  const safeCaret = Math.max(0, Math.min(caret, value.length))

  let start = safeCaret
  let end = safeCaret
  let leftLen = 0
  while (start > 0) {
    const ch = value[start - 1] || ''
    if (HARD_DELIMITER_RE.test(ch)) break
    if (leftLen >= MAX_WINDOW_LENGTH && SOFT_DELIMITER_RE.test(ch)) break
    start -= 1
    leftLen += 1
  }
  let rightLen = 0
  while (end < value.length) {
    const ch = value[end] || ''
    if (HARD_DELIMITER_RE.test(ch)) break
    if (rightLen >= MAX_WINDOW_LENGTH && SOFT_DELIMITER_RE.test(ch)) break
    end += 1
    rightLen += 1
  }

  const text = value.slice(start, end).trim()
  if (!text || text.length < 2 || text.length > MAX_WINDOW_LENGTH * 2) return null

  return {
    start,
    end,
    text,
    left: value.slice(Math.max(0, start - 12), start),
    right: value.slice(end, Math.min(value.length, end + 12)),
    version,
  }
}

function normalizeFragmentForModel(input: string): string {
  return input
    .replace(/\$([^$\n]+)\$/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeFragmentForCompare(input: string): string {
  return normalizeFragmentForModel(input).replace(/\s+/g, '')
}

function normalizeReplacementToSource(latex: string): string {
  const value = latex.trim()
  if (!value) return ''
  const unwrapped = value.replace(/^\$+/, '').replace(/\$+$/, '').trim()
  if (!unwrapped) return ''
  return `$${unwrapped}$`
}

function isWhitespaceChar(ch: string) {
  return /\s/.test(ch)
}

function skipSpacesBackward(input: string, from: number) {
  let cursor = from
  while (cursor > 0 && isWhitespaceChar(input[cursor - 1] || '')) cursor -= 1
  return cursor
}

function skipSpacesForward(input: string, from: number) {
  let cursor = from
  while (cursor < input.length && isWhitespaceChar(input[cursor] || '')) cursor += 1
  return cursor
}

function findOpeningBrace(input: string, closeExclusive: number): number | null {
  let depth = 0
  for (let i = closeExclusive - 1; i >= 0; i -= 1) {
    const ch = input[i]
    if (ch === '}') {
      depth += 1
      continue
    }
    if (ch === '{') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return null
}

function findClosingBrace(input: string, openIndex: number): number | null {
  let depth = 0
  for (let i = openIndex; i < input.length; i += 1) {
    const ch = input[i]
    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return null
}

function readCommandBackward(input: string, endExclusive: number): { start: number; end: number } | null {
  if (endExclusive <= 0) return null
  const charBefore = input[endExclusive - 1] || ''
  if (!/[A-Za-z]/.test(charBefore)) {
    if (endExclusive >= 2 && input[endExclusive - 2] === '\\') {
      return { start: endExclusive - 2, end: endExclusive }
    }
    return null
  }

  let start = endExclusive - 1
  while (start > 0 && /[A-Za-z]/.test(input[start - 1] || '')) start -= 1
  if (start > 0 && input[start - 1] === '\\') {
    return { start: start - 1, end: endExclusive }
  }
  return null
}

function readCommandForward(input: string, start: number): { start: number; end: number } | null {
  if (input[start] !== '\\') return null
  let cursor = start + 1
  while (cursor < input.length && /[A-Za-z]/.test(input[cursor] || '')) cursor += 1
  if (cursor === start + 1 && cursor < input.length) cursor += 1
  return { start, end: cursor }
}

function deleteLatexTokenBackward(formula: string): string {
  let end = skipSpacesBackward(formula, formula.length)
  if (end <= 0) return formula
  const suffix = formula.slice(end)

  const rightPair = formula
    .slice(0, end)
    .match(/\\right(?:\\[{}]|[()|[\].])$/)
  if (rightPair?.index != null) {
    return formula.slice(0, rightPair.index) + suffix
  }

  if (formula[end - 1] === '}') {
    const groupStart = findOpeningBrace(formula, end)
    if (groupStart != null) {
      let cursor = skipSpacesBackward(formula, groupStart)

      if (cursor > 0 && formula[cursor - 1] === '}') {
        const prevGroupStart = findOpeningBrace(formula, cursor)
        if (prevGroupStart != null) {
          const commandEnd = skipSpacesBackward(formula, prevGroupStart)
          const command = readCommandBackward(formula, commandEnd)
          if (command) {
            const commandName = formula.slice(command.start, command.end)
            if (/^\\(?:d?frac|tfrac|cfrac|binom)$/.test(commandName)) {
              return formula.slice(0, command.start) + suffix
            }
          }
        }
      }

      const command = readCommandBackward(formula, cursor)
      if (command) {
        const commandName = formula.slice(command.start, command.end)
        if (/^\\(?:sqrt|text|operatorname|overline|underline|hat|bar|vec|tilde|dot|ddot|mathbf|mathrm|mathit|mathbb|mathcal|mathsf|mathtt)$/.test(commandName)) {
          return formula.slice(0, command.start) + suffix
        }
      }

      if (cursor > 0 && (formula[cursor - 1] === '^' || formula[cursor - 1] === '_')) {
        return formula.slice(0, cursor - 1) + suffix
      }

      return formula.slice(0, groupStart) + suffix
    }
  }

  const command = readCommandBackward(formula, end)
  if (command) {
    return formula.slice(0, command.start) + suffix
  }

  const plainMatch = formula
    .slice(0, end)
    .match(/[\p{L}\p{N}]+$/u)
  if (plainMatch?.index != null) {
    return formula.slice(0, plainMatch.index) + suffix
  }

  return formula.slice(0, Math.max(0, end - 1)) + suffix
}

function deleteLatexTokenForward(formula: string): string {
  let start = skipSpacesForward(formula, 0)
  if (start >= formula.length) return formula
  const prefix = formula.slice(0, start)

  const leftPair = formula
    .slice(start)
    .match(/^\\left(?:\\[{}]|[()|[\].])/)
  if (leftPair) {
    return prefix + formula.slice(start + leftPair[0].length)
  }

  const command = readCommandForward(formula, start)
  if (command) {
    const commandName = formula.slice(command.start, command.end)
    let cursor = skipSpacesForward(formula, command.end)

    if (/^\\(?:d?frac|tfrac|cfrac|binom)$/.test(commandName) && formula[cursor] === '{') {
      const firstEnd = findClosingBrace(formula, cursor)
      if (firstEnd != null) {
        cursor = skipSpacesForward(formula, firstEnd + 1)
        if (formula[cursor] === '{') {
          const secondEnd = findClosingBrace(formula, cursor)
          if (secondEnd != null) {
            return prefix + formula.slice(secondEnd + 1)
          }
        }
      }
    }

    if (/^\\(?:sqrt|text|operatorname|overline|underline|hat|bar|vec|tilde|dot|ddot|mathbf|mathrm|mathit|mathbb|mathcal|mathsf|mathtt)$/.test(commandName) && formula[cursor] === '{') {
      const blockEnd = findClosingBrace(formula, cursor)
      if (blockEnd != null) {
        return prefix + formula.slice(blockEnd + 1)
      }
    }

    return prefix + formula.slice(command.end)
  }

  if ((formula[start] === '^' || formula[start] === '_') && formula[start + 1] === '{') {
    const blockEnd = findClosingBrace(formula, start + 1)
    if (blockEnd != null) {
      return prefix + formula.slice(blockEnd + 1)
    }
  }

  if (formula[start] === '{') {
    const blockEnd = findClosingBrace(formula, start)
    if (blockEnd != null) {
      return prefix + formula.slice(blockEnd + 1)
    }
  }

  const plainMatch = formula
    .slice(start)
    .match(/^[\p{L}\p{N}]+/u)
  if (plainMatch) {
    return prefix + formula.slice(start + plainMatch[0].length)
  }

  return prefix + formula.slice(start + 1)
}

export const MathContentEditor: React.FC<MathContentEditorProps> = ({
  value,
  onChange,
  placeholder = '输入内容',
  disabled = false,
  minHeight = 44,
  maxHeight,
  singleLine = false,
  className = '',
  contentClassName = '',
  onKeyDown,
  onEditorReady,
  mathInputEnabled = false,
  backendBaseUrl,
  userId,
}) => {
  const normalizedValue = useMemo(() => ensureMathContentDocument(value), [value])
  const sourceText = useMemo(() => mathContentToPromptText(normalizedValue), [normalizedValue])
  const onChangeRef = useRef(onChange)
  const onKeyDownRef = useRef(onKeyDown)
  const onEditorReadyRef = useRef(onEditorReady)
  const syncGuardRef = useRef(false)
  const composingRef = useRef(false)
  const inputVersionRef = useRef(0)
  const suppressTranslateUntilRef = useRef(0)
  const editorWrapRef = useRef<HTMLDivElement | null>(null)
  const [spinnerPos, setSpinnerPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onKeyDownRef.current = onKeyDown
  }, [onKeyDown])

  useEffect(() => {
    onEditorReadyRef.current = onEditorReady
  }, [onEditorReady])

  const controller = useMathInputController({
    enabled: Boolean(mathInputEnabled && !disabled),
    backendBaseUrl,
    userId,
    debounceMs: 300,
    stableMs: 220,
    highConfidence: 0.7,
  })
  const { state: controllerState, request: requestTranslate, cancel: cancelTranslate } = controller

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: false,
          bulletList: false,
          orderedList: false,
          blockquote: false,
          code: false,
          codeBlock: false,
          horizontalRule: false,
        }),
        MathInline,
      ],
      editable: !disabled,
      content: sourceTextToTiptapContent(sourceText),
      editorProps: {
        attributes: {
          class: [
            'math-content-editor prose prose-slate max-w-none rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] px-4 py-3 text-sm text-[var(--ui-text-primary)] outline-none focus-within:border-[var(--ui-border-strong)]',
            singleLine ? 'min-h-[44px]' : '',
            contentClassName,
          ]
            .filter(Boolean)
            .join(' '),
          'data-placeholder': placeholder,
        },
        handleKeyDown: (_view, event) => {
          const synthetic = event as unknown as React.KeyboardEvent<HTMLElement>
          onKeyDownRef.current?.(synthetic)
          if (event.defaultPrevented) return true

          if (!composingRef.current && (event.key === 'Backspace' || event.key === 'Delete') && _view.state.selection.empty) {
            const { state, dispatch } = _view
            const { selection } = state
            const $from = selection.$from
            const isBackspace = event.key === 'Backspace'
            const targetNode = isBackspace ? $from.nodeBefore : $from.nodeAfter

            if (targetNode?.type.name === 'mathInline') {
              const formula = String(targetNode.attrs.formula ?? '')
              const nodePos = isBackspace ? selection.from - targetNode.nodeSize : selection.from
              const nextFormula = isBackspace ? deleteLatexTokenBackward(formula) : deleteLatexTokenForward(formula)

              event.preventDefault()
              if (!nextFormula.trim()) {
                suppressTranslateUntilRef.current = Date.now() + 1200
                dispatch(state.tr.delete(nodePos, nodePos + targetNode.nodeSize))
                return true
              }

              const tr = state.tr.setNodeMarkup(nodePos, undefined, {
                ...targetNode.attrs,
                formula: nextFormula,
              })
              const nextDoc = tr.doc
              const nextNode = nextDoc.nodeAt(nodePos)
              const cursorPos = isBackspace
                ? nodePos + (nextNode?.nodeSize ?? 1)
                : nodePos
              suppressTranslateUntilRef.current = Date.now() + 1200
              tr.setSelection(TextSelection.create(nextDoc, cursorPos))
              dispatch(tr)
              return true
            }
          }

          if (singleLine && event.key === 'Enter') {
            event.preventDefault()
            return true
          }
          return false
        },
        handleDOMEvents: {
          compositionstart: () => {
            composingRef.current = true
            return false
          },
          compositionend: () => {
            composingRef.current = false
            return false
          },
        },
      },
      onCreate: ({ editor }) => {
        onEditorReadyRef.current?.({
          focus: () => editor.commands.focus(),
          insertFormula: (latex, mode) => {
            const formula = normalizeMathExpression(latex.trim())
            if (!formula) return
            if (mode === 'block') {
              editor.chain().focus().insertContent(`\n$$${formula}$$\n`).run()
              return
            }
            editor.chain().focus().insertContent({ type: 'mathInline', attrs: { formula } }).run()
          },
          element: editor.view.dom as HTMLElement,
        })
      },
      onUpdate: ({ editor }) => {
        if (syncGuardRef.current) return
        const text = docToSourceText(editor)
        onChangeRef.current(createTextMathDocument(text))

        if (!mathInputEnabled || disabled || composingRef.current || !backendBaseUrl || userId == null) {
          cancelTranslate()
          return
        }
        if (Date.now() < suppressTranslateUntilRef.current) {
          cancelTranslate()
          return
        }

        inputVersionRef.current += 1
        const version = inputVersionRef.current
        const caret = docPosToSourceIndex(editor, editor.state.selection.from)
        const fragment = extractFragmentWindow(text, caret, version)
        if (!fragment) {
          cancelTranslate()
          return
        }

        const modelFragmentText = normalizeFragmentForModel(fragment.text)
        if (!modelFragmentText || modelFragmentText.length < 2) {
          cancelTranslate()
          return
        }

        requestTranslate(
          {
            ...fragment,
            text: modelFragmentText,
          },
          {
            apply: (_replacement, response, target) => {
              if (!editor || !editor.isEditable) return
              if (inputVersionRef.current !== target.version) return

              const currentText = docToSourceText(editor)
              const currentFragment = currentText.slice(target.start, target.end).trim()
              if (normalizeFragmentForCompare(currentFragment) !== normalizeFragmentForCompare(target.text)) return

              const normalized = normalizeReplacementToSource(response.rendered_latex || response.translated_text || '')
              if (!normalized) return

              const nextText = `${currentText.slice(0, target.start)}${normalized}${currentText.slice(target.end)}`

              syncGuardRef.current = true
              editor.commands.setContent(sourceTextToTiptapContent(nextText), { emitUpdate: false })
              const nextPos = sourceIndexToDocPos(editor, target.start + normalized.length)
              editor.commands.setTextSelection(nextPos)
              syncGuardRef.current = false

              onChangeRef.current(createTextMathDocument(nextText))
            },
            validate: () => {
              if (!editor) return false
              const currentText = docToSourceText(editor)
              const left = currentText.slice(Math.max(0, fragment.start - 12), fragment.start)
              const right = currentText.slice(fragment.end, Math.min(currentText.length, fragment.end + 12))
              return left === fragment.left && right === fragment.right && inputVersionRef.current === fragment.version
            },
          },
        )
      },
    },
    [backendBaseUrl, cancelTranslate, contentClassName, disabled, mathInputEnabled, placeholder, requestTranslate, singleLine, userId],
  )

  const updateSpinnerPosition = useCallback(() => {
    if (!editor || !editorWrapRef.current) {
      setSpinnerPos(null)
      return
    }
    try {
      const caretPos = editor.state.selection.from
      const caretRect = editor.view.coordsAtPos(caretPos)
      const wrapRect = editorWrapRef.current.getBoundingClientRect()
      setSpinnerPos({
        left: Math.max(0, caretRect.left - wrapRect.left + 2),
        top: Math.max(0, (caretRect.top + caretRect.bottom) / 2 - wrapRect.top),
      })
    } catch {
      setSpinnerPos(null)
    }
  }, [editor])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [disabled, editor])

  useEffect(() => {
    if (!editor) return
    const onEditorSelection = () => {
      if (controllerState.isTranslating) updateSpinnerPosition()
    }
    const onEditorUpdate = () => {
      if (controllerState.isTranslating) updateSpinnerPosition()
    }
    editor.on('selectionUpdate', onEditorSelection)
    editor.on('update', onEditorUpdate)
    return () => {
      editor.off('selectionUpdate', onEditorSelection)
      editor.off('update', onEditorUpdate)
    }
  }, [controllerState.isTranslating, editor, updateSpinnerPosition])

  useEffect(() => {
    if (!controllerState.isTranslating) {
      setSpinnerPos(null)
      return
    }
    updateSpinnerPosition()
    const onWindowChange = () => updateSpinnerPosition()
    window.addEventListener('resize', onWindowChange)
    window.addEventListener('scroll', onWindowChange, true)
    return () => {
      window.removeEventListener('resize', onWindowChange)
      window.removeEventListener('scroll', onWindowChange, true)
    }
  }, [controllerState.isTranslating, updateSpinnerPosition])

  useEffect(() => {
    if (!editor) return
    const current = docToSourceText(editor)
    if (current === sourceText) return
    syncGuardRef.current = true
    editor.commands.setContent(sourceTextToTiptapContent(sourceText), { emitUpdate: false })
    syncGuardRef.current = false
  }, [editor, sourceText])

  useEffect(() => {
    if (!mathInputEnabled) {
      cancelTranslate()
    }
  }, [cancelTranslate, mathInputEnabled])

  useEffect(() => {
    return () => {
      cancelTranslate()
      onEditorReadyRef.current?.(null)
    }
  }, [cancelTranslate])

  return (
    <>
      <style>{`
        @keyframes math-input-spinner-rotate {
          to {
            transform: rotate(360deg);
          }
        }
        .math-content-editor {
          white-space: pre-wrap;
          word-break: break-word;
          text-align: left;
        }
        .math-content-editor p {
          margin: 0;
        }
        .math-content-editor p + p {
          margin-top: 0.5rem;
        }
        .math-content-editor.ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          color: #94a3b8;
          pointer-events: none;
          float: left;
          height: 0;
        }
      `}</style>
      <div
        ref={editorWrapRef}
        className={className}
        style={{
          position: 'relative',
          minHeight,
          maxHeight,
          overflowY: maxHeight ? 'auto' : undefined,
        }}
      >
        <EditorContent editor={editor} />
        {mathInputEnabled && controllerState.isTranslating && spinnerPos ? (
          <span
            aria-label="数理化输入处理中"
            style={{
              position: 'absolute',
              left: spinnerPos.left,
              top: spinnerPos.top,
              width: 16,
              height: 16,
              transform: 'translate(2px, -50%)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.94)',
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: '2px solid #cbd5e1',
                borderTopColor: '#334155',
                animation: 'math-input-spinner-rotate 0.9s linear infinite',
                boxSizing: 'border-box',
              }}
            />
          </span>
        ) : null}
      </div>
    </>
  )
}


