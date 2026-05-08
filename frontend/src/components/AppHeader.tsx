import React from 'react'
import { useTranslation } from 'react-i18next'
import BrandIcon from './BrandIcon'
import Icon from './Icon'


interface AppHeaderProps {
  onExportClick: () => void
  rightOffset?: number
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  onExportClick,
  rightOffset = 0,
}) => {
  const { t } = useTranslation('common')
  const headerStyle =
    rightOffset > 0
      ? {
          paddingRight: `calc(1.5rem + ${rightOffset}px)`,
          transition: 'padding-right 200ms ease',
        }
      : undefined
  return (
    <header
      className="flex h-[46px] items-center justify-between border-b border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] px-6 py-0"
      style={headerStyle}
    >
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3 text-[var(--ui-text-primary)]">
          <BrandIcon />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="flex h-8 items-center gap-2 rounded-lg bg-[var(--ui-bg-panel-muted)] px-4 text-sm font-bold text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-bg-panel-muted)]"
          type="button"
          onClick={onExportClick}
          title={t('app.buttons.export')}
        >
          <Icon name={"ios_share"} className="text-[20px]" />
          {t('app.buttons.export')}
        </button>
      </div>
    </header>
  )
}


