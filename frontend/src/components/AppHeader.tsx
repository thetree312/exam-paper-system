import React from 'react'
import { useTranslation } from 'react-i18next'
import BrandIcon from './BrandIcon'
import Icon from './Icon'

interface AppHeaderProps {
  onExportClick?: () => void
  showExportButton?: boolean
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
