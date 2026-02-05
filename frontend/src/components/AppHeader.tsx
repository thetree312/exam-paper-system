import React from 'react'
import type { UserInfo } from '../types'

interface AppHeaderProps {
  statusMessage: string
  isUploading: boolean
  isExtracting: boolean
  onExportClick: () => void
  user: UserInfo
  userMenuRef: React.RefObject<HTMLDivElement>
  isUserMenuOpen: boolean
  onToggleUserMenu: () => void
  onLogout: () => void
  rightOffset?: number
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  statusMessage,
  isUploading,
  isExtracting,
  onExportClick,
  user,
  userMenuRef,
  isUserMenuOpen,
  onToggleUserMenu,
  onLogout,
  rightOffset = 0,
}) => {
  const headerStyle =
    rightOffset > 0
      ? {
          paddingRight: `calc(1.5rem + ${rightOffset}px)`,
          transition: 'padding-right 200ms ease',
        }
      : undefined

  return (
    <header
      className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-3"
      style={headerStyle}
    >
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3 text-slate-900 dark:text-white">
          <div className="size-8 bg-primary text-white rounded-lg flex items-center justify-center">
            <span className="material-symbols-outlined text-[20px]">edit_document</span>
          </div>
          <h2 className="text-lg font-bold leading-tight tracking-tight">智卷通</h2>
        </div>
        <div className="h-6 w-px bg-slate-200 dark:bg-slate-700" />
        <div className="flex flex-col">
          <h1 className="text-slate-900 dark:text-white text-sm font-bold leading-none">试卷编辑器</h1>
          <p className="text-[#4c739a] text-xs flex items-center gap-1 mt-1">
            <span className="material-symbols-outlined text-[12px]">
              {isUploading || isExtracting ? 'sync' : 'cloud_done'}
            </span>
            {statusMessage}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="flex items-center gap-2 h-9 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-lg transition-colors"
          type="button"
          onClick={onExportClick}
          disabled={isUploading}
          title="导出"
        >
          <span className="material-symbols-outlined text-[20px]">ios_share</span>
          导出
        </button>
        <div className="relative" ref={userMenuRef}>
          <button
            type="button"
            onClick={onToggleUserMenu}
            className="bg-center bg-cover rounded-full size-9 border-2 border-slate-100 focus:outline-none focus:ring-2 focus:ring-primary/40"
            style={{
              backgroundImage:
                'url("https://lh3.googleusercontent.com/aida-public/AB6AXuDXorlL7aPFxAxnUg-6fOyKNenMwV3EVXhgQp8mPcCkpLfJfQO8bX6f9P6AdyyaE5dslQZyWcdUVuYz7Ff9iL8av5iH6ZVAJIajq1Sv6LbglX5xrzB12RE7Wpyt5R_RdMP5Ql1RHdeLpE3b8xJEO5RSz71dm1THB_Vcj3Bic8-HUlSNZOhNpKU8vQK6f6XyhR6TOkGFUSJ8JN__2HjSh6yzy9CmIYaBQhcY2bac_ZzwWUtMbdfdDjOH87BmpCkC0GRWDf7RilGnVlcD")',
            }}
          />
          {isUserMenuOpen && (
            <div className="absolute right-0 mt-3 w-60 bg-white rounded-2xl shadow-xl border border-slate-100 p-4 z-50">
              <div className="flex items-center gap-3 mb-3">
                <div className="size-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold">
                  {user.display_name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">{user.display_name}</p>
                  <p className="text-xs text-slate-500">{user.email}</p>
                </div>
              </div>
              <div className="text-xs text-slate-400 mb-3">租户编码：{user.tenant_code ?? `#${user.tenant_id}`}</div>
              <button
                type="button"
                className="w-full h-9 rounded-lg bg-slate-900 text-white text-sm font-bold flex items-center justify-center gap-2 hover:bg-slate-800 transition-colors"
                onClick={onLogout}
              >
                <span className="material-symbols-outlined text-[18px]">logout</span>
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
