import React from 'react'
import { useTranslation } from 'react-i18next'

import Icon from '../../../components/Icon'
import type { MindMapNodeTree } from '../domain/types'

interface MindMapNodeEditorProps {
  node: MindMapNodeTree | null
  onClose: () => void
  onSubmit: (updated: MindMapNodeTree) => void
  onNavigate?: (node: MindMapNodeTree) => void
}

const MindMapNodeEditor: React.FC<MindMapNodeEditorProps> = ({ node, onClose, onSubmit, onNavigate }) => {
  const { t } = useTranslation('common')
  const [topic, setTopic] = React.useState('')
  const [summary, setSummary] = React.useState('')
  const [side, setSide] = React.useState<'left' | 'right' | ''>('')

  React.useEffect(() => {
    if (!node) return
    setTopic(node.topic)
    setSummary(node.summary ?? '')
    setSide(node.side ?? '')
  }, [node])

  if (!node) return null

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex w-full max-w-sm flex-col rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{t('mindmap_node_editor.edit_node')}</p>
            <h3 className="text-base font-semibold text-slate-900">{node.topic}</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900" type="button">
            <Icon name="close" className="text-[20px]" />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit({
              ...node,
              topic: topic.trim() || node.topic,
              summary: summary.trim() || null,
              side: side || null,
            })
          }}
          className="flex flex-col gap-3 px-4 py-4 text-[13px]"
        >
          <label className="flex flex-col gap-1 text-[12px] text-slate-600">
            {t('mindmap_node_editor.name_label')}
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-slate-600">
            {t('mindmap_node_editor.description_label', { remaining: Math.max(0, 240 - summary.length) })}
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value.slice(0, 240))}
              rows={4}
              className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-slate-600">
            Branch Side
            <select
              value={side}
              onChange={(e) => setSide((e.target.value as 'left' | 'right' | '') || '')}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
            >
              <option value="">Auto</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => onNavigate?.(node)}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] text-slate-600 hover:border-slate-400"
            >
              {t('mindmap_node_editor.view_question')}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] text-slate-600 hover:border-slate-400"
              >
                {t('mindmap_node_editor.cancel')}
              </button>
              <button type="submit" className="rounded-full bg-slate-900 px-3 py-1.5 text-[12px] text-white shadow-lg hover:bg-slate-800">
                {t('mindmap_node_editor.save')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

export default MindMapNodeEditor
