import React, { useEffect, useMemo, useState } from 'react'

interface QuestionTypeSelectFieldProps {
  label?: string
  value: string
  options: string[]
  placeholder?: string
  disabled?: boolean
  isLoading?: boolean
  error?: string | null
  onChange: (value: string) => void
}

const CUSTOM_VALUE = '__custom__'

export const QuestionTypeSelectField: React.FC<QuestionTypeSelectFieldProps> = ({
  label,
  value,
  options,
  placeholder = '选择题型',
  disabled,
  isLoading,
  error,
  onChange,
}) => {
  const optionSet = useMemo(() => new Set(options), [options])
  const [isCustomMode, setIsCustomMode] = useState(() => Boolean(value) && !optionSet.has(value))
  const [customValue, setCustomValue] = useState(() => (isCustomMode ? value : ''))

  useEffect(() => {
    const shouldBeCustom = Boolean(value) && !optionSet.has(value)
    setIsCustomMode(shouldBeCustom)
    if (shouldBeCustom) {
      setCustomValue(value)
    } else if (!value) {
      setCustomValue('')
    }
  }, [value, optionSet])

  const selectValue = isCustomMode ? CUSTOM_VALUE : value

  const handleSelectChange = (selected: string) => {
    if (selected === CUSTOM_VALUE) {
      setIsCustomMode(true)
      if (!customValue) {
        setCustomValue(value && !optionSet.has(value) ? value : '')
      }
      onChange(customValue)
    } else {
      setIsCustomMode(false)
      onChange(selected)
    }
  }

  const handleCustomChange = (next: string) => {
    setCustomValue(next)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-xs text-slate-500">{label}</label>}
      <div className="space-y-2">
        <select
          value={selectValue}
          disabled={disabled}
          onChange={(e) => handleSelectChange(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
        >
          <option value="">{placeholder}</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
          <option value={CUSTOM_VALUE}>自定义题型…</option>
        </select>
        {isCustomMode && (
          <input
            type="text"
            value={customValue}
            disabled={disabled}
            onChange={(e) => handleCustomChange(e.target.value)}
            placeholder="输入自定义题型"
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
          />
        )}
      </div>
      {isLoading && <span className="text-[11px] text-slate-400">题型加载中…</span>}
      {error && <span className="text-[11px] text-red-500">{error}</span>}
    </div>
  )}
