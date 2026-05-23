import React, { useMemo } from 'react'
import katex from 'katex'
import { tokenizeQuestionText } from '../lib/questionMath'

interface QuestionTextViewProps {
  text: string
  className?: string
}

function renderMathToHtml(value: string, displayMode: boolean) {
  try {
    return katex.renderToString(value.trim(), {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    })
  } catch {
    return null
  }
}

export const QuestionTextView: React.FC<QuestionTextViewProps> = React.memo(({ text, className }) => {
  const tokens = useMemo(() => tokenizeQuestionText(text), [text])
  return (
    <span className={className}>
      {tokens.map((token, index) => {
        if (token.kind === 'text') {
          return <React.Fragment key={`text-${index}`}>{token.value}</React.Fragment>
        }
        const html = renderMathToHtml(token.value, token.display)
        if (!html) {
          return <React.Fragment key={`math-fallback-${index}`}>{token.display ? `$$${token.value}$$` : `$${token.value}$`}</React.Fragment>
        }
        return (
          <span
            key={`math-${index}`}
            className={token.display ? 'inline-block w-full align-middle' : 'inline-block align-baseline'}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )
      })}
    </span>
  )
})
