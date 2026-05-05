import React from 'react'
import Icon from '../../../components/Icon'


interface MindMapNodeQuickActionsProps {
  anchor: {
    x: number
    y: number
  } | null
  visible: boolean
  onEdit: () => void
  onAddChild: () => void
  onAddSibling: () => void
  onDelete: () => void
}

const QuickButton: React.FC<{
  icon: string
  title: string
  onClick: () => void
  tone?: 'default' | 'danger'
}> = ({ icon, title, onClick, tone = 'default' }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className={`flex h-9 w-9 items-center justify-center rounded-full border shadow-sm transition-colors ${
      tone === 'danger'
        ? 'border-rose-200 bg-white text-rose-600 hover:bg-rose-50'
        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
    }`}
  >
    <Icon name={icon} className="text-[18px] leading-none" />
  </button>
)

const MindMapNodeQuickActions: React.FC<MindMapNodeQuickActionsProps> = ({
  anchor,
  visible,
  onEdit,
  onAddChild,
  onAddSibling,
  onDelete,
}) => {
  if (!visible || !anchor) return null

  return (
    <div
      className="pointer-events-none absolute z-20"
      style={{
        left: anchor.x,
        top: anchor.y,
        transform: 'translate(10px, -10px)',
      }}
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-2 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.14)] backdrop-blur">
        <QuickButton icon="edit_note" title="编辑节点" onClick={onEdit} />
        <QuickButton icon="account_tree" title="新增子节点" onClick={onAddChild} />
        <QuickButton icon="add_2" title="新增同级" onClick={onAddSibling} />
        <QuickButton icon="delete" title="删除节点" onClick={onDelete} tone="danger" />
      </div>
    </div>
  )
}

export default MindMapNodeQuickActions
