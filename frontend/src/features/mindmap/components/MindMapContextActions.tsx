import React from 'react'
import Icon from '../../../components/Icon'


interface MindMapContextActionsProps {
  canEditNode?: boolean
  canAddChild?: boolean
  canAddSibling?: boolean
  canRemoveSelection?: boolean
  onEditNode?: () => void
  onAddChild?: () => void
  onAddSibling?: () => void
  onRemoveSelection?: () => void
  canCreateArrow: boolean
  canEditArrow: boolean
  canRemoveArrow: boolean
  onCreateArrow: () => void
  onEditArrow: () => void
  onRemoveArrow: () => void
  canCreateSummary: boolean
  canEditSummary: boolean
  canRemoveSummary: boolean
  onCreateSummary: () => void
  onEditSummary: () => void
  onRemoveSummary: () => void
}

const ActionButton: React.FC<{
  icon: string
  label: string
  disabled?: boolean
  onClick: () => void
  tone?: 'default' | 'danger'
}> = ({ icon, label, disabled = false, onClick, tone = 'default' }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
      tone === 'danger'
        ? 'border-rose-300 text-rose-500 hover:bg-[var(--ui-bg-panel-muted)]'
        : 'border-[var(--ui-border-default)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]'
    }`}
  >
    <Icon name={icon} className="text-[18px] leading-none" />
    <span>{label}</span>
  </button>
)

const MindMapContextActions: React.FC<MindMapContextActionsProps> = ({
  canEditNode = false,
  canAddChild = false,
  canAddSibling = false,
  canRemoveSelection = false,
  onEditNode,
  onAddChild,
  onAddSibling,
  onRemoveSelection,
  canCreateArrow,
  canEditArrow,
  canRemoveArrow,
  onCreateArrow,
  onEditArrow,
  onRemoveArrow,
  canCreateSummary,
  canEditSummary,
  canRemoveSummary,
  onCreateSummary,
  onEditSummary,
  onRemoveSummary,
}) => {
  const show =
    canEditNode ||
    canAddChild ||
    canAddSibling ||
    canRemoveSelection ||
    canCreateArrow ||
    canEditArrow ||
    canRemoveArrow ||
    canCreateSummary ||
    canEditSummary ||
    canRemoveSummary

  if (!show) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center px-3 lg:bottom-5 lg:px-4">
      <div className="pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-[22px] border border-[var(--ui-border-default)] bg-[var(--ui-bg-elevated)] px-3 py-2 shadow-none backdrop-blur scrollbar-hidden">
        {(canEditNode || canAddChild || canAddSibling || canRemoveSelection) && (
          <>
            {onEditNode && <ActionButton icon="edit_note" label="编辑节点" disabled={!canEditNode} onClick={onEditNode} />}
            {onAddChild && <ActionButton icon="account_tree" label="新增子节点" disabled={!canAddChild} onClick={onAddChild} />}
            {onAddSibling && <ActionButton icon="add_2" label="新增同级" disabled={!canAddSibling} onClick={onAddSibling} />}
            {onRemoveSelection && (
              <ActionButton icon="delete" label="删除" disabled={!canRemoveSelection} onClick={onRemoveSelection} tone="danger" />
            )}
          </>
        )}
        {(canCreateArrow || canEditArrow || canRemoveArrow) && (
          <>
            <ActionButton icon="timeline" label="连线" disabled={!canCreateArrow} onClick={onCreateArrow} />
            <ActionButton icon="draw" label="编辑连线" disabled={!canEditArrow} onClick={onEditArrow} />
            <ActionButton icon="delete" label="删除连线" disabled={!canRemoveArrow} onClick={onRemoveArrow} tone="danger" />
          </>
        )}
        {(canCreateSummary || canEditSummary || canRemoveSummary) && (
          <>
            <ActionButton icon="join_full" label="总结" disabled={!canCreateSummary} onClick={onCreateSummary} />
            <ActionButton icon="edit_note" label="编辑总结" disabled={!canEditSummary} onClick={onEditSummary} />
            <ActionButton
              icon="delete_sweep"
              label="删除总结"
              disabled={!canRemoveSummary}
              onClick={onRemoveSummary}
              tone="danger"
            />
          </>
        )}
      </div>
    </div>
  )
}

export default MindMapContextActions


