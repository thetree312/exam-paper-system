import React from 'react'

interface RadialAction {
  id?: string
  icon: string
  label: string
  tone?: 'default' | 'danger'
  angle?: number
  radius?: number
  disabled?: boolean
  onClick: () => void
}

interface MindMapRadialMenuProps {
  anchor: {
    x: number
    y: number
  } | null
  visible: boolean
  actions: RadialAction[]
  onClose?: () => void
  uiLabels?: {
    close?: string
    more?: string
    back?: string
  }
}

const DEFAULT_RADIUS = 64
const ITEMS_PER_PAGE = 7

const MindMapRadialMenu: React.FC<MindMapRadialMenuProps> = ({ anchor, visible, actions, onClose, uiLabels }) => {
  const [page, setPage] = React.useState(0)

  React.useEffect(() => {
    if (!visible) {
      setPage(0)
      return
    }
    const pageCount = Math.max(1, Math.ceil(actions.length / ITEMS_PER_PAGE))
    if (page >= pageCount) setPage(0)
  }, [actions.length, page, visible])

  if (!visible || !anchor || actions.length === 0) return null

  const pageCount = Math.max(1, Math.ceil(actions.length / ITEMS_PER_PAGE))
  const labels = {
    close: uiLabels?.close ?? 'Close menu',
    more: uiLabels?.more ?? 'More actions',
    back: uiLabels?.back ?? 'Back to primary',
  }
  const pageActions = actions.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE)
  const displayActions =
    pageCount > 1
      ? [
          ...pageActions,
          {
            id: '__pager__',
            icon: page === 0 ? 'more_horiz' : 'undo',
            label: page === 0 ? labels.more : labels.back,
            onClick: () => setPage((prev) => (prev + 1) % pageCount),
          } satisfies RadialAction,
        ]
      : pageActions

  return (
    <div
      className="mindmap-radial-menu pointer-events-none absolute z-30"
      style={{
        left: anchor.x,
        top: anchor.y,
        width: 0,
        height: 0,
      }}
    >
      <div className="absolute -left-6 -top-6 flex h-12 w-12 items-center justify-center rounded-full border border-slate-300 bg-white/96 text-slate-700 shadow-[0_12px_30px_rgba(15,23,42,0.18)] backdrop-blur">
        <button
          type="button"
          title={labels.close}
          className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          onClick={() => onClose?.()}
        >
          <span className="material-symbols-outlined text-[18px] leading-none">close</span>
        </button>
      </div>

      {displayActions.map((action, index) => {
        const fallbackAngle = -90 + (index * 360) / displayActions.length
        const rad = (fallbackAngle * Math.PI) / 180
        const radius = page === 0 ? DEFAULT_RADIUS + 18 : DEFAULT_RADIUS + 6
        const offsetX = Math.cos(rad) * radius
        const offsetY = Math.sin(rad) * radius

        return (
          <button
            key={action.id ?? `${action.label}-${index}`}
            type="button"
            title={action.label}
            onClick={() => {
              action.onClick()
            }}
            disabled={action.disabled}
            className={`pointer-events-auto absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border shadow-[0_12px_30px_rgba(15,23,42,0.18)] transition-transform ${
              action.disabled ? 'cursor-not-allowed opacity-45' : 'hover:scale-105'
            } ${
              action.tone === 'danger'
                ? 'border-rose-200 bg-white text-rose-600 hover:bg-rose-50'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
            style={{
              left: offsetX,
              top: offsetY,
            }}
          >
            <span className="material-symbols-outlined text-[20px] leading-none">{action.icon}</span>
          </button>
        )
      })}
    </div>
  )
}

export default MindMapRadialMenu
