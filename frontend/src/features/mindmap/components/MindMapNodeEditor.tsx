import React from 'react'
import { useTranslation } from 'react-i18next'
import type { MindMapNodePayload } from '../../types'
import { NODE_TYPE_OPTIONS, getDescriptionLimit } from '../constants'

interface MindMapNodeEditorProps {
  node: MindMapNodePayload | null
  onClose: () => void
  onSubmit: (updated: MindMapNodePayload) => void
  onNavigate?: (node: MindMapNodePayload) => void
}

const MindMapNodeEditor: React.FC<MindMapNodeEditorProps> = ({ node, onClose, onSubmit, onNavigate }) => {
  const { t } = useTranslation('common')
  const [label, setLabel] = React.useState('')
  const [type, setType] = React.useState('concept')
  const [description, setDescription] = React.useState('')
  const [source, setSource] = React.useState('')
  const [parentId, setParentId] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!node) return
    setLabel(node.label)
    setType(node.type ?? 'concept')
    setDescription(node.data?.description ?? '')
    setSource(node.data?.source ?? '')
    setParentId(node.parentId ?? null)
  }, [node])

  if (!node) return null

  const limit = getDescriptionLimit(node)
  const remaining = Math.max(0, limit - description.length)

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const updated: MindMapNodePayload = {
      ...node,
      label: label.trim() || node.label,
      type,
      parentId: parentId && parentId.length > 0 ? parentId : null,
      data: {
        ...node.data,
        description: description.slice(0, limit),
        source: source,
      },
    }
    onSubmit(updated)
  }

  const stopScrollPropagation = (event: React.UIEvent<HTMLDivElement>) => {
    event.stopPropagation()
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-xl border border-slate-200 flex flex-col pointer-events-auto max-h-[calc(100vh-80px)]"
        onWheelCapture={stopScrollPropagation}
        onTouchMoveCapture={stopScrollPropagation}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{t('mindmap_node_editor.edit_node')}</p>
            <h3 className="text-base font-semibold text-slate-900">{node.label}</h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-900 material-symbols-outlined"
            type="button"
          >
            close
          </button>
        </div>
        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 flex flex-col gap-3 text-[13px]"
        >
        <label className="flex flex-col gap-1 text-[12px] text-slate-600">
          {t('mindmap_node_editor.name_label')}
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-slate-600">
          {t('mindmap_node_editor.type_label')}
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
          >
            {NODE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-slate-600">
          {t('mindmap_node_editor.description_label', { remaining })}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, limit))}
            rows={4}
            className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-slate-600">
          {t('mindmap_node_editor.source_label')}
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-slate-600">
          {t('mindmap_node_editor.parent_id_label')}
          <input
            value={parentId ?? ''}
            onChange={(e) => setParentId(e.target.value.trim() === '' ? null : e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
        </label>
          <div className="flex items-center justify-between pt-4">
            <button
              type="button"
              onClick={() => onNavigate?.(node)}
              className="px-3 py-1.5 rounded-full border border-slate-200 text-[12px] text-slate-600 hover:border-slate-400"
            >
              {t('mindmap_node_editor.view_question')}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-full border border-slate-200 text-[12px] text-slate-600 hover:border-slate-400"
              >
                {t('mindmap_node_editor.cancel')}
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 rounded-full bg-slate-900 text-white text-[12px] shadow-lg hover:bg-slate-800"
              >
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
