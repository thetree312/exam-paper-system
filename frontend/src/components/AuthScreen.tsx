import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuthMode } from '../types'
import type { AuthRememberPolicy } from '../utils/secureStorage'
import { validateEmail, validatePassword, validateDisplayName } from '../utils/validation'
import BrandIcon from './BrandIcon'
import Icon from './Icon'

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
  rememberCredentialEnabled?: boolean
  onRememberCredentialEnabledChange?: (enabled: boolean) => void
  authRememberPolicy?: AuthRememberPolicy
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
  rememberCredentialEnabled = false,
  onRememberCredentialEnabledChange,
  authRememberPolicy = '30d',
  onSubmit,
}) => {
  const { t } = useTranslation('common')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [displayNameError, setDisplayNameError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [rememberToast, setRememberToast] = useState<string | null>(null)

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

  const rememberPolicyText =
    authRememberPolicy === '365d'
      ? t('settings_modal.security.remember_365d')
      : authRememberPolicy === 'forever'
        ? t('settings_modal.security.remember_forever')
        : t('settings_modal.security.remember_30d')

  const handleRememberToggle = () => {
    const next = !rememberCredentialEnabled
    onRememberCredentialEnabledChange?.(next)
    const message = next
      ? t('auth.remember_toast_enabled', { policy: rememberPolicyText })
      : t('auth.remember_toast_disabled')
    setRememberToast(message)
    window.setTimeout(() => {
      setRememberToast((current) => (current === message ? null : current))
    }, 2800)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--ui-bg-panel-muted)] px-4">
      {rememberToast && (
        <div className="fixed right-5 top-5 z-[120] rounded-xl bg-slate-900 px-4 py-2 text-xs text-white shadow-xl">
          {rememberToast}
        </div>
      )}
      <div className="w-full max-w-md bg-[var(--ui-bg-panel)] shadow-xl rounded-2xl p-6 sm:p-8 border border-[var(--ui-border-default)]">
        <div className="flex items-center gap-3 mb-6">
          <div className="scale-110">
            <BrandIcon />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[var(--ui-text-primary)]">{t('auth.logo_title')}</h1>
            <p className="text-xs text-[var(--ui-text-primary)] mt-1">{t('auth.logo_subtitle')}</p>
          </div>
        </div>

        <div className="flex mb-4 rounded-full bg-[var(--ui-bg-panel-muted)] p-1 text-sm font-medium">
          <button
            type="button"
            className={`flex-1 py-1.5 rounded-full ${authMode === 'login' ? 'bg-[var(--ui-bg-panel)] shadow text-[var(--ui-text-primary)]' : 'text-[var(--ui-text-primary)]'}`}
            onClick={() => onAuthModeChange('login')}
          >
            {t('auth.tabs.login')}
          </button>
          <button
            type="button"
            className={`flex-1 py-1.5 rounded-full ${authMode === 'register' ? 'bg-[var(--ui-bg-panel)] shadow text-[var(--ui-text-primary)]' : 'text-[var(--ui-text-primary)]'}`}
            onClick={() => onAuthModeChange('register')}
          >
            {t('auth.tabs.register')}
          </button>
        </div>

        <form className="space-y-4" onSubmit={handleFormSubmit}>
          <div>
            <label className="block text-xs font-medium text-[var(--ui-text-primary)] mb-1">{t('auth.fields.email')}</label>
            <input
              type="email"
              required
              className={`w-full h-9 px-3 rounded-lg border ${emailError ? 'border-red-500' : 'border-[var(--ui-border-default)]'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
              value={authEmail}
              onChange={(e) => onAuthEmailChange(e.target.value)}
              onBlur={handleEmailBlur}
              placeholder={t('auth.placeholders.email')}
              maxLength={254}
            />
            {emailError && <p className="text-xs text-red-500 mt-1">{emailError}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--ui-text-primary)] mb-1">{t('auth.fields.password')}</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                className={`w-full h-9 px-3 pr-10 rounded-lg border ${passwordError ? 'border-red-500' : 'border-[var(--ui-border-default)]'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
                value={authPassword}
                onChange={(e) => onAuthPasswordChange(e.target.value)}
                onBlur={handlePasswordBlur}
                placeholder={t('auth.placeholders.password')}
                minLength={8}
                maxLength={128}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0 text-[var(--ui-text-primary)]"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? t('auth.hide_password') : t('auth.show_password')}
                title={showPassword ? t('auth.hide_password') : t('auth.show_password')}
              >
                <span className="relative inline-flex h-4 w-4 items-center justify-center">
                  <Icon name="visibility" className="text-[16px]" />
                  {!showPassword && (
                    <span className="absolute h-[2px] w-4 rotate-[-35deg] rounded bg-current" />
                  )}
                </span>
              </button>
            </div>
            {passwordError && <p className="text-xs text-red-500 mt-1">{passwordError}</p>}
          </div>
          {authMode === 'login' && (
            <button
              type="button"
              onClick={handleRememberToggle}
              className="inline-flex items-center gap-2 rounded-md px-1 py-1 text-xs text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]"
            >
              <span className="relative inline-flex h-5 w-5 items-center justify-center overflow-hidden">
                <span
                  className={`absolute inset-0 inline-flex items-center justify-center transition-all duration-300 ${
                    rememberCredentialEnabled ? 'rotate-90 opacity-0 scale-75' : 'rotate-0 opacity-100 scale-100'
                  }`}
                >
                  <Icon name="key" className="text-[16px] text-slate-500" />
                </span>
                <span
                  className={`absolute inset-0 inline-flex items-center justify-center transition-all duration-300 ${
                    rememberCredentialEnabled ? 'rotate-0 opacity-100 scale-100' : '-rotate-90 opacity-0 scale-75'
                  }`}
                >
                  <Icon name="verified_user" className="text-[16px] text-emerald-600" />
                </span>
              </span>
              <span>{t('auth.remember_credentials_toggle')}</span>
            </button>
          )}
          {authMode === 'register' && (
            <div>
              <label className="block text-xs font-medium text-[var(--ui-text-primary)] mb-1">{t('auth.fields.display_name')}</label>
              <input
                type="text"
                className={`w-full h-9 px-3 rounded-lg border ${displayNameError ? 'border-red-500' : 'border-[var(--ui-border-default)]'} focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm`}
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

          <p className="text-[11px] text-[var(--ui-text-primary)] mt-2">{t('auth.footnote')}</p>
        </form>
      </div>
    </div>
  )
}


