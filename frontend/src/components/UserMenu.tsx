import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserInfo } from '../types'

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

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute right-4 top-16 w-80 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-slate-100 bg-gradient-to-br from-slate-50 to-slate-100 p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-xl font-bold text-white shadow-lg">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-bold text-slate-900">{user.display_name}</p>
              <p className="truncate text-sm text-slate-500">{user.email}</p>
              <p className="mt-1 text-xs text-slate-400">Tenant #{user.tenant_id}</p>
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
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
            >
              <span className="material-symbols-outlined text-[18px] text-slate-400">bookmark</span>
              <span>{t('user_menu.favorites', '我的收藏')}</span>
            </button>
          )}

          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-rose-600 transition hover:bg-rose-50"
          >
            <span className="material-symbols-outlined text-[18px]">logout</span>
            <span>{t('user_menu.logout', '退出登录')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
