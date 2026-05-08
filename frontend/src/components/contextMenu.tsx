import React from 'react'

export interface ContextMenuAction {
  key: string
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  onSelect: () => void | Promise<void>
}

interface ContextMenuListProps {
  actions: ContextMenuAction[]
  onClose: () => void
  x: number
  y: number
  className?: string
}

export const ContextMenuList: React.FC<ContextMenuListProps> = ({ actions, onClose, x, y, className }) => {
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = React.useState({ x, y })

  React.useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin)
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin)
    setPosition({
      x: Math.min(Math.max(margin, x), maxX),
      y: Math.min(Math.max(margin, y), maxY),
    })
  }, [actions, x, y])

  return (
    <div
      ref={menuRef}
      className={`fixed z-[220] min-w-[240px] rounded-md border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] py-1 text-sm shadow-xl ${className ?? ''}`}
      style={{ left: position.x, top: position.y }}
    >
      {actions.map((action) => (
        <React.Fragment key={action.key}>
          {action.separatorBefore ? <div className="my-1 h-px bg-[var(--ui-bg-panel-muted)]" /> : null}
          <button
            type="button"
            disabled={action.disabled}
            className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left ${
              action.disabled
                ? 'cursor-not-allowed text-[var(--ui-text-primary)]'
                : action.danger
                  ? 'text-rose-600 hover:bg-rose-50'
                  : 'text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]'
            }`}
            onClick={async () => {
              if (action.disabled) return
              await action.onSelect()
              onClose()
            }}
          >
            <span>{action.label}</span>
            <span className="text-xs text-[var(--ui-text-primary)]">{action.shortcut ?? ''}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}


