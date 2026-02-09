import React, { useState, useEffect } from 'react'
import type { AuthMode } from '../types'
import { validateEmail, validatePassword, validateDisplayName } from '../utils/validation'
import BrandIcon from './BrandIcon'

interface AuthScreenProps {
  authMode: AuthMode
  onAuthModeChange: (mode: AuthMode) => void
  authEmail: string
  onAuthEmailChange: (value: string) => void
  authPassword: string
  onAuthPasswordChange: (value: string) => void
  authDisplayName: string
  onAuthDisplayNameChange: (value: string) => void
  authError: string | null
  authLoading: boolean
  onSubmit: React.FormEventHandler<HTMLFormElement>
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  authMode,
  onAuthModeChange,
  authEmail,
  onAuthEmailChange,
  authPassword,
  onAuthPasswordChange,
  authDisplayName,
  onAuthDisplayNameChange,
  authError,
  authLoading,
  onSubmit,
}) => {
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [displayNameError, setDisplayNameError] = useState<string | null>(null)

  // 清除错误信息当切换模式时
  useEffect(() => {
    setEmailError(null)
    setPasswordError(null)
    setDisplayNameError(null)
  }, [authMode])

  const handleEmailBlur = () => {
    const result = validateEmail(authEmail)
    setEmailError(result.valid ? null : result.error || null)
  }

  const handlePasswordBlur = () => {
    const result = validatePassword(authPassword)
    setPasswordError(result.valid ? null : result.error || null)
  }

  const handleDisplayNameBlur = () => {
    if (authMode === 'register' && authDisplayName) {
      const result = validateDisplayName(authDisplayName)
      setDisplayNameError(result.valid ? null : result.error || null)
    }
  }

  const handleFormSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault()

    // 提交前验证所有字段
    const emailValidation = validateEmail(authEmail)
    const passwordValidation = validatePassword(authPassword)
    const displayNameValidation = authMode === 'register' ? validateDisplayName(authDisplayName) : { valid: true }

    setEmailError(emailValidation.valid ? null : emailValidation.error || null)
    setPasswordError(passwordValidation.valid ? null : passwordValidation.error || null)
    setDisplayNameError(displayNameValidation.valid ? null : displayNameValidation.error || null)

    if (!emailValidation.valid || !passwordValidation.valid || !displayNameValidation.valid) {
      return
    }

    onSubmit(e)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md bg-white shadow-xl rounded-2xl p-6 sm:p-8 border border-slate-200">
        <div className="flex items-center gap-3 mb-6">
          <div className="scale-110">
            <BrandIcon />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">智卷通 · 试卷编辑器</h1>
            <p className="text-xs text-slate-500 mt-1">先登录，再上传试卷进行框选识别</p>
          </div>
        </div>

        <div className="flex mb-4 rounded-full bg-slate-100 p-1 text-sm font-medium">
          <button
            type="button"
            className={`flex-1 py-1.5 rounded-full ${authMode === 'login' ? 'bg-white shadow text-slate-900' : 'text-slate-500'}`}
            onClick={() => onAuthModeChange('login')}
          >
            登录
          </button>
          <button
            type="button"
            className={`flex-1 py-1.5 rounded-full ${authMode === 'register' ? 'bg-white shadow text-slate-900' : 'text-slate-500'}`}
            onClick={() => onAuthModeChange('register')}
          >
            注册
          </button>
        </div>

        <form className="space-y-4" onSubmit={handleFormSubmit}>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">邮箱</label>
            <input
              type="email"
              required
              className={`w-full h-9 px-3 rounded-lg border ${emailError ? 'border-red-500' : 'border-slate-200'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
              value={authEmail}
              onChange={(e) => onAuthEmailChange(e.target.value)}
              onBlur={handleEmailBlur}
              placeholder="you@example.com"
              maxLength={254}
            />
            {emailError && <p className="text-xs text-red-500 mt-1">{emailError}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">密码</label>
            <input
              type="password"
              required
              className={`w-full h-9 px-3 rounded-lg border ${passwordError ? 'border-red-500' : 'border-slate-200'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
              value={authPassword}
              onChange={(e) => onAuthPasswordChange(e.target.value)}
              onBlur={handlePasswordBlur}
              placeholder="至少 8 位，包含字母和数字"
              minLength={8}
              maxLength={128}
            />
            {passwordError && <p className="text-xs text-red-500 mt-1">{passwordError}</p>}
          </div>
          {authMode === 'register' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">昵称（可选）</label>
              <input
                type="text"
                className={`w-full h-9 px-3 rounded-lg border ${displayNameError ? 'border-red-500' : 'border-slate-200'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
                value={authDisplayName}
                onChange={(e) => onAuthDisplayNameChange(e.target.value)}
                onBlur={handleDisplayNameBlur}
                placeholder="显示在右上角的名称"
                maxLength={100}
              />
              {displayNameError && <p className="text-xs text-red-500 mt-1">{displayNameError}</p>}
            </div>
          )}

          {authError && <p className="text-xs text-red-500 mt-1">{authError}</p>}

          <button
            type="submit"
            disabled={authLoading}
            className="w-full h-9 mt-2 inline-flex items-center justify-center rounded-lg bg-primary text-white text-sm font-bold disabled:opacity-60"
          >
            {authLoading ? '处理中...' : authMode === 'login' ? '登录' : '注册并登录'}
          </button>

          <p className="text-[11px] text-slate-400 mt-2">已为后续微信 / Google 登录预留账号绑定结构，当前阶段仅支持邮箱密码。</p>
        </form>
      </div>
    </div>
  )
}
