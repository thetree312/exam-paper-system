import React from 'react'

import { mathContentToPromptText, createPlainTextMathDocument, type MathContentDocument } from '../../lib/mathContent'

interface InlineMathAnswerInputProps {
  value: MathContentDocument | null | undefined
  onChange: (value: MathContentDocument) => void
  disabled?: boolean
  inputRef?: React.Ref<HTMLElement>
  onInputKeyDown?: React.KeyboardEventHandler<HTMLElement>
  mathInputEnabled?: boolean
  backendBaseUrl?: string
  userId?: string | number
}

export const InlineMathAnswerInput: React.FC<InlineMathAnswerInputProps> = ({
  value,
  onChange,
  disabled = false,
  inputRef,
  onInputKeyDown,
  mathInputEnabled = false,
  backendBaseUrl,
  userId,
}) => {
  void mathInputEnabled
  void backendBaseUrl
  void userId
  const textValue = mathContentToPromptText(value ?? null)
  const assignRef = (element: HTMLInputElement | null) => {
    if (!inputRef) return
    if (typeof inputRef === 'function') {
      inputRef(element)
      return
    }
    ;(inputRef as React.MutableRefObject<HTMLElement | null>).current = element
  }

  return (
    <span className="mx-1 inline-flex min-w-[180px] max-w-[340px] items-center align-middle">
      <input
        ref={assignRef}
        type="text"
        value={textValue}
        onChange={(event) => onChange(createPlainTextMathDocument(event.target.value))}
        onKeyDown={onInputKeyDown as React.KeyboardEventHandler<HTMLInputElement>}
        disabled={disabled}
        placeholder=""
        className="min-w-[180px] flex-1 border-0 border-b-[1.5px] border-slate-500 bg-transparent px-1 py-1 text-sm text-slate-800 outline-none"
      />
    </span>
  )
}
