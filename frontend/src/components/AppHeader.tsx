import React from 'react'
import { useTranslation } from 'react-i18next'
import BrandIcon from './BrandIcon'
import Icon from './Icon'
import type { WorkbenchLayoutPreset } from '../lib/workbenchLayout'

interface AppHeaderProps {
  onExportClick?: () => void
  showExportButton?: boolean
  showLayoutButton?: boolean
  layoutPreset?: WorkbenchLayoutPreset
  onLayoutPresetChange?: (preset: WorkbenchLayoutPreset) => void
  titleText?: string
  searchPlaceholder?: string
  searchValue?: string
  onSearchChange?: (value: string) => void
  userDisplayName?: string
  userEmail?: string
  rightOffset?: number
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  onExportClick,
  showExportButton = true,
  showLayoutButton = false,
  layoutPreset = 'source-studio-agent',
  onLayoutPresetChange,
  titleText,
  searchPlaceholder,
  searchValue = '',
  onSearchChange,
  userDisplayName,
  userEmail,
  rightOffset = 0,
}) => {
  const { t } = useTranslation('common')
  const desktopRuntime = (window as any).desktopRuntime
  const canControlWindow = Boolean(desktopRuntime?.isDesktop && desktopRuntime?.window)
  const [maximized, setMaximized] = React.useState(false)
  const [isLayoutMenuOpen, setIsLayoutMenuOpen] = React.useState(false)
  const layoutMenuRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!isLayoutMenuOpen) return
    const close = (event: MouseEvent) => {
      if (!layoutMenuRef.current?.contains(event.target as Node)) {
        setIsLayoutMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLayoutMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [isLayoutMenuOpen])

  const handleMinimize = React.useCallback(() => {
    void desktopRuntime?.window?.minimize?.()
  }, [desktopRuntime])

  const handleMaximizeToggle = React.useCallback(async () => {
    const next = await desktopRuntime?.window?.maximizeToggle?.()
    if (typeof next === 'boolean') {
      setMaximized(next)
    } else {
      setMaximized((prev) => !prev)
    }
  }, [desktopRuntime])

  const handleClose = React.useCallback(() => {
    void desktopRuntime?.window?.close?.()
  }, [desktopRuntime])

  const headerStyle = {
    paddingRight: rightOffset > 0 ? `calc(1.5rem + ${rightOffset}px)` : undefined,
    transition: rightOffset > 0 ? 'padding-right 200ms ease' : undefined,
    WebkitAppRegion: 'drag' as const,
  }

  const layoutOptions: Array<{ preset: WorkbenchLayoutPreset; label: string }> = [
    { preset: 'source-studio-agent', label: '资料 / 工作区 / 对话' },
    { preset: 'agent-studio-source', label: '对话 / 工作区 / 资料' },
    { preset: 'source-agent-studio', label: '资料 / 对话 / 工作区' },
  ]

  return (
    <header
      className="flex h-[38px] items-center justify-between border-b border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] px-6 py-0"
      style={headerStyle}
    >
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3 text-[var(--ui-text-primary)]">
          <BrandIcon />
          {titleText ? <span className="text-sm font-semibold">{titleText}</span> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
        {searchPlaceholder ? (
          <div
            className="flex h-8 min-w-[320px] max-w-[860px] flex-1 items-center gap-2 rounded-[18px] border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)] px-3"
            style={{ WebkitAppRegion: 'no-drag' as const }}
          >
            <Icon name="search" className="text-[18px] text-[var(--ui-text-primary)]" />
            <input
              type="text"
              value={searchValue}
              onChange={(event) => onSearchChange?.(event.target.value)}
              placeholder={searchPlaceholder}
              className="h-full w-full bg-transparent text-sm text-[var(--ui-text-primary)] outline-none placeholder:text-[var(--ui-text-primary)]"
            />
          </div>
        ) : null}
        {userDisplayName || userEmail ? (
          <div className="ml-2 flex items-center border-l border-[var(--ui-border-default)] pl-4 text-right">
            <div>
              {userDisplayName ? <div className="text-sm font-medium text-[var(--ui-text-primary)]">{userDisplayName}</div> : null}
              {userEmail ? <div className="text-xs text-[var(--ui-text-primary)]">{userEmail}</div> : null}
            </div>
          </div>
        ) : null}
        {showLayoutButton && onLayoutPresetChange ? (
          <div
            ref={layoutMenuRef}
            className="relative"
            style={{ WebkitAppRegion: 'no-drag' as const }}
          >
            <button
              className="flex h-8 items-center gap-2 rounded-lg bg-[var(--ui-bg-panel-muted)] px-3 text-sm font-bold text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-bg-panel-muted)]"
              type="button"
              onClick={() => setIsLayoutMenuOpen((prev) => !prev)}
              title="切换布局"
              aria-label="切换布局"
              aria-expanded={isLayoutMenuOpen}
            >
              <Icon name="splitscreen_add" className="text-[20px]" />
              <span>布局</span>
            </button>
            {isLayoutMenuOpen ? (
              <div className="absolute right-0 top-10 z-50 w-56 rounded-lg border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] py-1 text-sm shadow-xl">
                {layoutOptions.map((option) => {
                  const active = option.preset === layoutPreset
                  return (
                    <button
                      key={option.preset}
                      type="button"
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--ui-bg-panel-muted)] ${
                        active ? 'font-semibold text-[var(--ui-text-primary)]' : 'text-[var(--ui-text-primary)]'
                      }`}
                      onClick={() => {
                        onLayoutPresetChange(option.preset)
                        setIsLayoutMenuOpen(false)
                      }}
                    >
                      <Icon
                        name={active ? 'check' : 'splitscreen_add'}
                        className="text-[18px]"
                      />
                      <span>{option.label}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {showExportButton && onExportClick ? (
          <button
            className="flex h-8 items-center gap-2 rounded-lg bg-[var(--ui-bg-panel-muted)] px-4 text-sm font-bold text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-bg-panel-muted)]"
            type="button"
            onClick={onExportClick}
            title={t('app.buttons.export')}
            style={{ WebkitAppRegion: 'no-drag' as const }}
          >
            <Icon name={'ios_share'} className="text-[20px]" />
            {t('app.buttons.export')}
          </button>
        ) : null}
        {canControlWindow && (
          <div
            className="ml-2 -mr-6 flex h-[38px] items-stretch overflow-hidden border-l border-[var(--ui-border-default)]"
            style={{ WebkitAppRegion: 'no-drag' as const }}
          >
            <button
              type="button"
              className="inline-flex h-full w-12 items-center justify-center text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]"
              onClick={handleMinimize}
              aria-label="Minimize"
              title="Minimize"
            >
              <Icon name="minimize" className="text-[16px]" />
            </button>
            <button
              type="button"
              className="inline-flex h-full w-12 items-center justify-center text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]"
              onClick={handleMaximizeToggle}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'}
            >
              <Icon name={maximized ? 'unfold_more' : 'fit_screen'} className="text-[14px]" />
            </button>
            <button
              type="button"
              className="inline-flex h-full w-12 items-center justify-center text-[var(--ui-text-primary)] hover:bg-rose-500 hover:text-white"
              onClick={handleClose}
              aria-label="Close"
              title="Close"
            >
              <Icon name="close" className="text-[15px]" />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
