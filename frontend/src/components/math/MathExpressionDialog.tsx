import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MathfieldElement } from 'mathlive'
import 'mathlive/static.css'

interface MathExpressionDialogProps {
  open: boolean
  initialLatex?: string
  initialMode?: 'inline' | 'block'
  onClose: () => void
  onConfirm: (payload: { latex: string; mode: 'inline' | 'block' }) => void
}

export const MathExpressionDialog: React.FC<MathExpressionDialogProps> = ({
  open,
  initialLatex = '',
  initialMode = 'inline',
  onClose,
  onConfirm,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mathfieldRef = useRef<MathfieldElement | null>(null)
  const [mode, setMode] = useState<'inline' | 'block'>(initialMode)

  useEffect(() => {
    if (!open) return
    setMode(initialMode)
  }, [initialMode, open])

  useEffect(() => {
    if (!open || !hostRef.current) return
    hostRef.current.innerHTML = ''
    const field = new MathfieldElement()
    field.value = initialLatex
    ;(field as any).setOptions?.({
      virtualKeyboardMode: 'manual',
    })
    field.className = 'w-full min-h-[56px] rounded-xl border border-slate-200 bg-white px-3 py-3 text-lg'
    hostRef.current.appendChild(field)
    mathfieldRef.current = field
    queueMicrotask(() => field.focus())

    return () => {
      mathfieldRef.current = null
      field.remove()
    }
  }, [initialLatex, open])

  const dialog = useMemo(() => {
    if (!open) return null

    return (
      <div className="fixed inset-0 z-[90] bg-slate-950/35 flex items-center justify-center px-4">
        <div className="w-full max-w-xl rounded-3xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <div>
              <div className="text-sm font-semibold text-slate-900">插入公式</div>
              <div className="text-xs text-slate-500">使用 MathLive 编辑 LaTeX 公式</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
            >
              关闭
            </button>
          </div>
          <div className="px-5 py-4 space-y-4">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('inline')}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  mode === 'inline' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                行内公式
              </button>
              <button
                type="button"
                onClick={() => setMode('block')}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  mode === 'block' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                块级公式
              </button>
            </div>
            <div ref={hostRef} />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                const latex = mathfieldRef.current?.value?.trim() ?? ''
                if (!latex) {
                  onClose()
                  return
                }
                onConfirm({ latex, mode })
                onClose()
              }}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
            >
              插入
            </button>
          </div>
        </div>
      </div>
    )
  }, [mode, onClose, onConfirm, open])

  return dialog
}
