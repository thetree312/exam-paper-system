import React, { useMemo } from 'react'
import { MarkdownWithMath } from '../MarkdownWithMath'

interface McqOption {
  label: string
  text: string
}

interface McqAnswerRendererProps {
  stem: string | null
  options: McqOption[]
  legendImages: string[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

const FIG_RE = /\[\[GLM_FIG_(\d+)\]\]/g

const extractFigureIndices = (raw: string | null | undefined): number[] => {
  if (!raw) return []
  const indices: number[] = []
  let m: RegExpExecArray | null
  FIG_RE.lastIndex = 0
  // eslint-disable-next-line no-cond-assign
  while ((m = FIG_RE.exec(raw)) !== null) {
    const idx = Number(m[1])
    if (Number.isFinite(idx)) {
      indices.push(idx)
    }
  }
  return indices
}

const stripFigurePlaceholders = (raw: string): string => raw.replace(FIG_RE, '').trim()

export const McqAnswerRenderer: React.FC<McqAnswerRendererProps> = ({
  stem,
  options,
  legendImages,
  value,
  onChange,
  disabled = false,
}) => {
  const selected = (value || '').trim().toUpperCase()

  const { optionMeta, headerLegends } = useMemo(() => {
    const used = new Set<number>()
    const meta = options.map((opt) => {
      const indices = extractFigureIndices(opt.text)
      indices.forEach((idx) => used.add(idx))
      const images = indices
        .map((idx) => legendImages[idx])
        .filter((src): src is string => typeof src === 'string' && !!src)
      const textWithoutFigs = stripFigurePlaceholders(opt.text)
      const isImageOnly = images.length > 0 && !textWithoutFigs
      return {
        option: opt,
        images,
        textWithoutFigs,
        isImageOnly,
      }
    })

    // 兜底：在相邻选项之间尽量均匀分配纯图片选项的图例
    // case 1：当前是纯图片且有多张图，后一项完全空白 -> 把一张图挪给后一项
    // case 2：当前完全空白，后一项是纯图片且有多张图 -> 把一张图从后一项挪回当前
    for (let i = 0; i < meta.length - 1; i += 1) {
      const current = meta[i]
      const next = meta[i + 1]

      if (
        current.images.length >= 2 &&
        current.isImageOnly &&
        next.images.length === 0 &&
        !next.textWithoutFigs
      ) {
        const moved = current.images.pop()
        if (moved) {
          next.images.push(moved)
          current.isImageOnly = current.images.length > 0 && !current.textWithoutFigs
          next.isImageOnly = next.images.length > 0 && !next.textWithoutFigs
        }
        continue
      }

      if (
        next.images.length >= 2 &&
        next.isImageOnly &&
        current.images.length === 0 &&
        !current.textWithoutFigs
      ) {
        const moved = next.images.shift()
        if (moved) {
          current.images.push(moved)
          current.isImageOnly = current.images.length > 0 && !current.textWithoutFigs
          next.isImageOnly = next.images.length > 0 && !next.textWithoutFigs
        }
      }
    }

    const header = legendImages.filter((_, idx) => !used.has(idx))

    return { optionMeta: meta, headerLegends: header }
  }, [legendImages, options])

  const handleToggle = (label: string) => {
    const upper = label.trim().toUpperCase()
    if (selected === upper) {
      onChange('')
    } else {
      onChange(upper)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        {stem && (
          <MarkdownWithMath compact className="markdown-body english-serif">
            {stem}
          </MarkdownWithMath>
        )}
        {headerLegends.length > 0 && (
          <div className="mt-2 space-y-2">
            {headerLegends.map((src, idx) => (
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

      <div className="space-y-2">
        <div className="text-xs font-semibold text-slate-500">选择答案</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {optionMeta.map(({ option, images, textWithoutFigs, isImageOnly }) => {
            const isSelected = selected === option.label.toUpperCase()
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
                onClick={() => handleToggle(option.label)}
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
                <div className="flex-1 space-y-2">
                  {!isImageOnly && textWithoutFigs && (
                    <MarkdownWithMath
                      compact
                      className="text-sm text-slate-700 leading-relaxed"
                    >
                      {textWithoutFigs}
                    </MarkdownWithMath>
                  )}
                  {images.length > 0 && (
                    <div className="space-y-2">
                      {images.map((src, idx) => (
                        <img
                          key={idx}
                          src={src}
                          alt={`${option.label} 图 ${idx + 1}`}
                          className="max-w-full h-auto rounded border border-slate-200"
                        />
                      ))}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
        <div className="text-xs text-slate-500">
          {selected ? `已选择：${selected}` : '点击选项即可作答'}
        </div>
      </div>
    </div>
  )
}
