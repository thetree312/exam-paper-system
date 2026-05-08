import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserInfo } from '../types'
import Icon from './Icon'


interface UserMenuProps {
  user: UserInfo
  isOpen: boolean
  onClose: () => void
  onLogout: () => void
  onNavigateToFavorites?: () => void
}

export const UserMenu: React.FC<UserMenuProps> = ({
  user,
  isOpen,
  onClose,
  onLogout,
  onNavigateToFavorites,
}) => {
  const { t } = useTranslation('common')

  const initials = useMemo(() => {
    return (user.display_name || user.email || 'U').trim().charAt(0).toUpperCase()
  }, [user.display_name, user.email])
  const hasTenant = typeof user.tenant_id === 'number' && user.tenant_id > 0

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="user-menu-popover absolute right-4 top-16 w-80 overflow-hidden rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--ui-border-default)] bg-gradient-to-br from-slate-50 to-slate-100 p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-xl font-bold text-white shadow-lg">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-bold text-[var(--ui-text-primary)]">{user.display_name}</p>
              <p className="truncate text-sm text-[var(--ui-text-primary)]">{user.email}</p>
              {hasTenant && <p className="mt-1 text-xs text-[var(--ui-text-primary)]">Tenant #{user.tenant_id}</p>}
            </div>
          </div>
        </div>

        <div className="p-3">
          {onNavigateToFavorites && (
            <button
              type="button"
              onClick={() => {
                onNavigateToFavorites()
                onClose()
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-bg-panel-muted)]"
            >
              <Icon name={"bookmark"} className="text-[18px] text-[var(--ui-text-primary)]" />
              <span>{t('user_menu.actions.favorites')}</span>
            </button>
          )}

          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-rose-600 transition hover:bg-rose-50"
          >
            <Icon name={"logout"} className="text-[18px]" />
            <span>{t('user_menu.actions.logout')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}


