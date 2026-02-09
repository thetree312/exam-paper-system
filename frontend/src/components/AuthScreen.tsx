import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('common')
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
    setEmailError(result.valid ? null : result.error ? t(result.error) : null)
  }

  const handlePasswordBlur = () => {
    const result = validatePassword(authPassword)
    setPasswordError(result.valid ? null : result.error ? t(result.error) : null)
  }

  const handleDisplayNameBlur = () => {
    if (authMode === 'register' && authDisplayName) {
      const result = validateDisplayName(authDisplayName)
      setDisplayNameError(result.valid ? null : result.error ? t(result.error) : null)
    }
  }

  const handleFormSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault()

    // 提交前验证所有字段
    const emailValidation = validateEmail(authEmail)
    const passwordValidation = validatePassword(authPassword)
    const displayNameValidation = authMode === 'register' ? validateDisplayName(authDisplayName) : { valid: true }

    setEmailError(emailValidation.valid ? null : emailValidation.error ? t(emailValidation.error) : null)
    setPasswordError(passwordValidation.valid ? null : passwordValidation.error ? t(passwordValidation.error) : null)
    setDisplayNameError(
      displayNameValidation.valid ? null : displayNameValidation.error ? t(displayNameValidation.error) : null,
    )

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
            <h1 className="text-lg font-bold text-slate-900">{t('auth.logo_title')}</h1>
            <p className="text-xs text-slate-500 mt-1">{t('auth.logo_subtitle')}</p>
          </div>
        </div>

        <div className="flex mb-4 rounded-full bg-slate-100 p-1 text-sm font-medium">
          <button
            type="button"
            className={`flex-1 py-1.5 rounded-full ${authMode === 'login' ? 'bg-white shadow text-slate-900' : 'text-slate-500'}`}
            onClick={() => onAuthModeChange('login')}
          >
            {t('auth.tabs.login')}
          </button>
          <button
            type="button"
            className={`flex-1 py-1.5 rounded-full ${authMode === 'register' ? 'bg-white shadow text-slate-900' : 'text-slate-500'}`}
            onClick={() => onAuthModeChange('register')}
          >
            {t('auth.tabs.register')}
          </button>
        </div>

        <form className="space-y-4" onSubmit={handleFormSubmit}>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t('auth.fields.email')}</label>
            <input
              type="email"
              required
              className={`w-full h-9 px-3 rounded-lg border ${emailError ? 'border-red-500' : 'border-slate-200'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
              value={authEmail}
              onChange={(e) => onAuthEmailChange(e.target.value)}
              onBlur={handleEmailBlur}
              placeholder={t('auth.placeholders.email')}
              maxLength={254}
            />
            {emailError && <p className="text-xs text-red-500 mt-1">{emailError}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t('auth.fields.password')}</label>
            <input
              type="password"
              required
              className={`w-full h-9 px-3 rounded-lg border ${passwordError ? 'border-red-500' : 'border-slate-200'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
              value={authPassword}
              onChange={(e) => onAuthPasswordChange(e.target.value)}
              onBlur={handlePasswordBlur}
              placeholder={t('auth.placeholders.password')}
              minLength={8}
              maxLength={128}
            />
            {passwordError && <p className="text-xs text-red-500 mt-1">{passwordError}</p>}
          </div>
          {authMode === 'register' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{t('auth.fields.display_name')}</label>
              <input
                type="text"
                className={`w-full h-9 px-3 rounded-lg border ${displayNameError ? 'border-red-500' : 'border-slate-200'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
                value={authDisplayName}
                onChange={(e) => onAuthDisplayNameChange(e.target.value)}
                onBlur={handleDisplayNameBlur}
                placeholder={t('auth.placeholders.display_name')}
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
            {authLoading
              ? t('auth.submit.loading')
              : authMode === 'login'
                ? t('auth.submit.login')
                : t('auth.submit.register')}
          </button>

          <p className="text-[11px] text-slate-400 mt-2">{t('auth.footnote')}</p>
        </form>
      </div>
    </div>
  )
}
