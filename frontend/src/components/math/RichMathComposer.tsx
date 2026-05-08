import React from 'react'

import {
  createTextMathDocument,
  createPlainTextMathDocument,
  ensureMathContentDocument,
  mathContentToPromptText,
  type MathContentDocument,
} from '../../lib/mathContent'

interface RichMathComposerProps {
  value: MathContentDocument | null | undefined
  onChange: (value: MathContentDocument) => void
  placeholder?: string
  disabled?: boolean
  minRows?: number
  mathInputEnabled?: boolean
  backendBaseUrl?: string
  userId?: string | number
}

export const RichMathComposer: React.FC<RichMathComposerProps> = ({
  value,
  onChange,
  placeholder = '',
  disabled = false,
  minRows = 4,
  mathInputEnabled = false,
  backendBaseUrl,
  userId,
}) => {
  void mathInputEnabled
  void backendBaseUrl
  void userId
  const textValue = mathContentToPromptText(value ?? null)

  return (
    <textarea
      value={textValue}
      onChange={(event) => onChange(createPlainTextMathDocument(event.target.value))}
      placeholder={placeholder}
      disabled={disabled}
      rows={Math.max(minRows, 4)}
      className="w-full resize-none border-0 bg-transparent px-0 py-0 text-sm text-[var(--ui-text-primary)] outline-none"
      style={{ minHeight: Math.max(minRows * 28, 112) }}
    />
  )
}

export function coerceMathComposerValue(value: unknown, fallbackText = ''): MathContentDocument {
  return ensureMathContentDocument(value, fallbackText) ?? createTextMathDocument(fallbackText)
}


