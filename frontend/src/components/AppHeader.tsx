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
      className="flex h-[46px] items-center justify-between border-b border-slate-200 bg-white px-6 py-0"
      style={headerStyle}
    >
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3 text-slate-900">
          <BrandIcon />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="flex h-8 items-center gap-2 rounded-lg bg-slate-100 px-4 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
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
