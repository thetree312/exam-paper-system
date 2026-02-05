import React, { useMemo } from 'react'
import { MarkdownWithMath } from '../MarkdownWithMath'
import { parseReadingAnswerMap, serializeAnswerMap } from './utils'
import type { ReadingParseResult } from './utils'

interface ReadingQuestionRendererProps {
  data: ReadingParseResult
  value: string
  onChange: (value: string) => void
  legendImages: string[]
  disabled?: boolean
}

export const ReadingQuestionRenderer: React.FC<ReadingQuestionRendererProps> = ({
  data,
  value,
  onChange,
  legendImages,
  disabled = false,
}) => {
  const answerMap = useMemo(() => parseReadingAnswerMap(value), [value])

  const handleToggle = (questionId: string, optionLabel: string) => {
    const next = { ...answerMap }
    const upper = optionLabel.trim().toUpperCase()
    if (next[questionId] === upper) {
      delete next[questionId]
    } else {
      next[questionId] = upper
    }
    onChange(serializeAnswerMap(next))
  }

  return (
    <div className="space-y-4">
      <div>
        <MarkdownWithMath disableMath>{data.passage}</MarkdownWithMath>
        {legendImages.length > 0 && (
          <div className="mt-2 space-y-2">
            {legendImages.map((src, idx) => (
              <img
                key={idx}
                src={src}
                alt={`图例 ${idx + 1}`}
                className="max-w-full h-auto rounded border border-slate-200"
              />
            ))}
          </div>
        )}
      </div>
      <div className="space-y-4">
        {data.questions.map((q) => {
          const selected = (answerMap[q.id] || '').trim().toUpperCase()
          return (
            <section key={q.id} className="space-y-2">
              <div className="text-sm font-medium text-slate-700">
                {q.id}. {q.stem}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {q.options.map((option) => {
                  const isSelected = selected === option.label
                  return (
                    <button
                      key={option.label}
                      type="button"
                      disabled={disabled}
                      className={`text-left rounded-xl border p-3 flex gap-3 items-start transition ${
                        isSelected
                          ? 'border-emerald-400 bg-emerald-50 shadow-sm'
                          : 'border-slate-200 hover:border-slate-400 bg-white'
                      } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                      onClick={() => handleToggle(q.id, option.label)}
                    >
                      <span
                        className={`mt-0.5 inline-flex items-center justify-center size-7 rounded-full border text-sm font-semibold ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : 'border-slate-300 text-slate-600'
                        }`}
                      >
                        {option.label}
                      </span>
                      <MarkdownWithMath disableMath compact className="flex-1 text-sm text-slate-700 leading-relaxed">
                        {option.text}
                      </MarkdownWithMath>
                    </button>
                  )
                })}
              </div>
              <div className="text-xs text-slate-500">
                {selected ? `已选择：${selected}` : '点击选项即可作答'}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
