import React, { useState } from 'react'
import type { UserInfo } from '../types'

interface UserMenuProps {
  user: UserInfo
  isOpen: boolean
  onClose: () => void
  onLogout: () => void
  onNavigateToFavorites?: () => void
}

interface UserStats {
  processedDocuments: number
  favoriteQuestions: number
  monthlyUsage: number
  monthlyLimit: number
}

export const UserMenu: React.FC<UserMenuProps> = ({
  user,
  isOpen,
  onClose,
  onLogout,
  onNavigateToFavorites,
}) => {
  const [stats] = useState<UserStats>({
    processedDocuments: 128,
    favoriteQuestions: 45,
    monthlyUsage: 85,
    monthlyLimit: 100,
  })

  if (!isOpen) return null

  const usagePercentage = (stats.monthlyUsage / stats.monthlyLimit) * 100
  const usageColor = usagePercentage > 90 ? 'text-red-600' : usagePercentage > 70 ? 'text-amber-600' : 'text-emerald-600'

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute right-4 top-16 w-80 bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* 用户信息区 */}
        <div className="bg-gradient-to-br from-slate-50 to-slate-100 p-5 border-b border-slate-200">
          <div className="flex items-center gap-4">
            <div className="size-14 rounded-full bg-primary text-white flex items-center justify-center font-bold text-xl shadow-lg">
              {user.display_name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-slate-900 truncate">{user.display_name}</p>
              <p className="text-sm text-slate-500 truncate">{user.email}</p>
              <div className="flex items-center gap-1 mt-1">
                <span className="material-symbols-outlined text-[14px] text-slate-400">business</span>
                <p className="text-xs text-slate-500">租户：{user.tenant_code ?? `#${user.tenant_id}`}</p>
              </div>
            </div>
          </div>
        </div>

        {/* 数据统计区 */}
        <div className="p-4 border-b border-slate-100">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-[18px] text-slate-600">bar_chart</span>
            <p className="text-sm font-semibold text-slate-700">使用统计</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-50 rounded-lg p-3">
