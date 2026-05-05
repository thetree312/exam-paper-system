import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AggregatedOcrItem,
  ExportQuestionPayload,
  ExportTemplateInfo,
  ExportTemplatesResponse,
  ExportWordRequestPayload,
  UserInfo,
} from '../types'
import type { StatusMessageSetter } from '../types'
import Icon from './Icon'


interface ExportTemplateDialogProps {
  open: boolean
  onClose: () => void
  backendBaseUrl: string
  ocrItems: AggregatedOcrItem[]
  documentTitle: string | null
  user: UserInfo | null
  onStatusMessage: StatusMessageSetter
}

export const ExportTemplateDialog: React.FC<ExportTemplateDialogProps> = ({
  open,
  onClose,
  backendBaseUrl,
  ocrItems,
  documentTitle,
  user,
  onStatusMessage,
}) => {
  const { t } = useTranslation('common')
  const [templates, setTemplates] = useState<ExportTemplateInfo[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(`${backendBaseUrl}/api/export/templates`)
        if (!resp.ok) return
        const data = (await resp.json()) as ExportTemplatesResponse
        if (!cancelled) {
          setTemplates(data.templates ?? [])
        }
      } catch (err) {
        console.error('[export] load templates failed', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, open])

  const handleSubmit = useCallback(async () => {
    if (!user) return
    if (!ocrItems.length) {
      onStatusMessage('export_none')
      return
    }

    const title = documentTitle ?? '导出试卷'
    const questions: ExportQuestionPayload[] = ocrItems
      .map((item, idx) => {
        const parts: string[] = []
        const text = (item.text || '').trim()
        if (text) {
          parts.push(text)
        }

        const legends = item.legendImages ?? []
        legends.forEach((img) => {
          if (!img) return
          parts.push(`![](data:image/png;base64,${img})`)
        })

        const markdown = parts.join('\n\n').trim()
        if (!markdown) return null

        const index = idx + 1
        return { index, markdown }
      })
      .filter((q): q is ExportQuestionPayload => q !== null)

    if (!questions.length) {
      onStatusMessage('export_none')
      return
    }

    const payload: ExportWordRequestPayload = {
      title,
      questions,
      templateKey: selectedKey ?? undefined,
    }

    try {
      setIsLoading(true)
      onStatusMessage('export_running')
      const resp = await fetch(`${backendBaseUrl}/api/export/word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text || '导出失败')
      }

      const blob = await resp.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title || t('export.title')}.docx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)

      onStatusMessage('export_done')
      onClose()
    } catch (err) {
      console.error('[export] failed', err)
      onStatusMessage('export_failed')
    } finally {
      setIsLoading(false)
    }
  }, [backendBaseUrl, documentTitle, ocrItems, onClose, onStatusMessage, selectedKey, user, t])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">{t('export.title')}</h3>
            <p className="text-sm text-slate-500 mt-1">{t('export.subtitle')}</p>
          </div>
          <button
            type="button"
            className="size-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-500"
            onClick={onClose}
            disabled={isLoading}
          >
            <Icon name={"close"} className="text-[20px]" />
          </button>
        </div>

        <label className="block text-sm font-medium text-slate-700">
          {t('export.template_label')}
          <select
            className="mt-1 w-full h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            value={selectedKey ?? ''}
            onChange={(e) => setSelectedKey(e.target.value || null)}
            disabled={isLoading}
          >
            <option value="">{t('export.template_default')}</option>
            {templates.map((tpl) => (
              <option key={tpl.key} value={tpl.key}>
                {tpl.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            className="px-4 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            onClick={onClose}
            disabled={isLoading}
          >
            {t('export.buttons.cancel')}
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-black disabled:opacity-50"
            onClick={handleSubmit}
            disabled={isLoading}
          >
            {isLoading ? t('export.buttons.exporting') : t('export.buttons.export')}
          </button>
        </div>
      </div>
    </div>
  )
}
