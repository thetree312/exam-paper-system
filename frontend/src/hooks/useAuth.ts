import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { apiJson } from '../lib/api'
import type { AuthMode, UserInfo } from '../types'
import { useAppStore } from '../store/appStore'
import {
  loadUser as secureLoadUser,
  saveUser as secureSaveUser,
  clearUser as secureClearUser,
  clearRememberedAuthCredential,
  loadRememberedAuthCredential,
  saveRememberedAuthCredential,
  type AuthRememberPolicy,
} from '../utils/secureStorage'

interface UseAuthReturn {
  user: UserInfo | null
  setUser: (user: UserInfo | null) => void
  authMode: AuthMode
  setAuthMode: (mode: AuthMode) => void
  authEmail: string
  setAuthEmail: (email: string) => void
  authPassword: string
  setAuthPassword: (password: string) => void
  authDisplayName: string
  setAuthDisplayName: (name: string) => void
  authError: string | null
  setAuthError: (error: string | null) => void
  authLoading: boolean
  setAuthLoading: (loading: boolean) => void
  authRememberPolicy: AuthRememberPolicy
  setAuthRememberPolicy: (policy: AuthRememberPolicy) => void
  rememberCredentialEnabled: boolean
  setRememberCredentialEnabled: (enabled: boolean) => void
  hasRememberedCredential: boolean
  rememberedEmail: string
  applyRememberedCredential: () => void
  handleAuthSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
  handleLogout: () => void
}

export const useAuth = (backendBaseUrl: string): UseAuthReturn => {
  const { t } = useTranslation('common')
  const storeUser = useAppStore((state) => state.user)
  const setStoreUser = useAppStore((state) => state.setUser)

  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authDisplayName, setAuthDisplayName] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authRememberPolicy, setAuthRememberPolicyState] = useState<AuthRememberPolicy>('30d')
  const [rememberCredentialEnabled, setRememberCredentialEnabledState] = useState(true)
  const [rememberedCredential, setRememberedCredential] = useState<{ email: string; password: string } | null>(null)

  // 加载登录用户信息
  useEffect(() => {
    const restoreUser = () => {
      const stored = secureLoadUser()
      if (stored) {
        setStoreUser(stored)
        return true
      }
      return false
    }

    const restored = restoreUser()
    if (restored) {
      return
    }

    // 兼容旧版本存储在 localStorage 的用户信息，并迁移到 sessionStorage
    try {
      const legacyRaw = window.localStorage.getItem('exam_user')
      if (legacyRaw) {
        const parsed = JSON.parse(legacyRaw) as UserInfo
        setStoreUser(parsed)
        secureSaveUser(parsed)
        window.localStorage.removeItem('exam_user')
      }
    } catch (e) {
      console.error('migrate legacy user failed', e)
    }
  }, [setStoreUser])

  useEffect(() => {
    const remembered = loadRememberedAuthCredential()
    if (!remembered) {
      setRememberCredentialEnabledState(false)
      setRememberedCredential(null)
      return
    }
    setRememberCredentialEnabledState(true)
    setAuthRememberPolicyState(remembered.policy)
    setRememberedCredential({
      email: remembered.email,
      password: remembered.password,
    })
    setAuthEmail((prev) => prev || remembered.email)
    setAuthPassword((prev) => prev || remembered.password)
  }, [])

  const setAuthRememberPolicy = useCallback((policy: AuthRememberPolicy) => {
    setAuthRememberPolicyState(policy)
    const remembered = loadRememberedAuthCredential()
    if (remembered) {
      saveRememberedAuthCredential({
        email: remembered.email,
        password: remembered.password,
        policy,
      })
      return
    }
    if (authEmail.trim() && authPassword.trim()) {
      saveRememberedAuthCredential({
        email: authEmail,
        password: authPassword,
        policy,
      })
    }
  }, [authEmail, authPassword])

  const setRememberCredentialEnabled = useCallback((enabled: boolean) => {
    setRememberCredentialEnabledState(enabled)
    if (!enabled) {
      clearRememberedAuthCredential()
      setRememberedCredential(null)
    }
  }, [])

  const applyRememberedCredential = useCallback(() => {
    const remembered = loadRememberedAuthCredential()
    if (!remembered) {
      setRememberedCredential(null)
      return
    }
    setAuthMode('login')
    setAuthEmail(remembered.email)
    setAuthPassword(remembered.password)
    setRememberedCredential({
      email: remembered.email,
      password: remembered.password,
    })
  }, [])

  const handleAuthSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setAuthError(null)
      setAuthLoading(true)

      const mode = authMode
      const url = `${backendBaseUrl}/api/auth/${mode === 'login' ? 'login' : 'register'}`

      const payload: Record<string, unknown> = {
        email: authEmail,
        password: authPassword,
      }

      if (mode === 'register') {
        if (authDisplayName.trim()) {
          payload.displayName = authDisplayName.trim()
        }
      }

      try {
        const data = (await apiJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })) as {
          user: {
            id: string
            email: string
            displayName: string
            tenantID?: number
          }
          token: string
          sessionID: string
        }
        const nextUser: UserInfo = {
          id: data.user.id,
          tenant_id: data.user.tenantID ?? 0,
          email: data.user.email,
          display_name: data.user.displayName,
          token: data.token,
          session_id: data.sessionID,
        }
        setStoreUser(nextUser)
        secureSaveUser(nextUser)
        if (mode === 'login' && rememberCredentialEnabled) {
          saveRememberedAuthCredential({
            email: authEmail,
            password: authPassword,
            policy: authRememberPolicy,
          })
          setRememberedCredential({
            email: authEmail,
            password: authPassword,
          })
        } else if (mode === 'login' && !rememberCredentialEnabled) {
          clearRememberedAuthCredential()
          setRememberedCredential(null)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : ''
        if (mode === 'login' && message === 'Invalid email or password') {
          setAuthError(t('auth.error.invalid_credentials'))
        } else if (message === 'Registration is disabled in local development. Please use the cloud account system.') {
          setAuthError(t('auth.error.register_disabled'))
        } else if (message === 'Account is disabled') {
          setAuthError(t('auth.error.account_disabled'))
        } else if (mode === 'register' && message.startsWith('Email already registered')) {
          setAuthError(t('auth.error.email_registered'))
        } else {
          setAuthError(t('auth.error.generic'))
        }
      } finally {
        setAuthLoading(false)
      }
    },
    [authMode, authEmail, authPassword, authDisplayName, authRememberPolicy, backendBaseUrl, rememberCredentialEnabled, setStoreUser, t],
  )

  const handleLogout = useCallback(() => {
    const run = async () => {
      try {
        await apiJson(`${backendBaseUrl}/api/auth/logout`, {
          method: 'POST',
        })
      } catch {}
      setStoreUser(null)
      secureClearUser()
    }
    void run()
    if (rememberCredentialEnabled) {
      const remembered = loadRememberedAuthCredential()
      if (remembered) {
        setAuthMode('login')
        setAuthEmail(remembered.email)
        setAuthPassword(remembered.password)
      } else {
        setAuthEmail('')
        setAuthPassword('')
      }
    } else {
      setAuthEmail('')
      setAuthPassword('')
    }
    setAuthDisplayName('')
  }, [backendBaseUrl, rememberCredentialEnabled, setStoreUser])

  useEffect(() => {
    const stored = secureLoadUser()
    if (!stored?.token) return

    void apiJson<{ user: { id: string; email: string; displayName: string; tenantID?: number }; sessionID: string }>(
      `${backendBaseUrl}/api/auth/me`,
      {
        method: 'GET',
      },
    )
      .then((data) => {
        const nextUser: UserInfo = {
          id: data.user.id,
          tenant_id: data.user.tenantID ?? 0,
          email: data.user.email,
          display_name: data.user.displayName,
          token: stored.token,
          session_id: data.sessionID,
        }
        setStoreUser(nextUser)
        secureSaveUser(nextUser)
      })
      .catch(() => {
        setStoreUser(null)
        secureClearUser()
      })
  }, [backendBaseUrl, setStoreUser])

  return {
    user: storeUser,
    setUser: setStoreUser,
    authMode,
    setAuthMode,
    authEmail,
    setAuthEmail,
    authPassword,
    setAuthPassword,
    authDisplayName,
    setAuthDisplayName,
    authError,
    setAuthError,
    authLoading,
    setAuthLoading,
    authRememberPolicy,
    setAuthRememberPolicy,
    rememberCredentialEnabled,
    setRememberCredentialEnabled,
    hasRememberedCredential: Boolean(rememberedCredential?.email && rememberedCredential?.password),
    rememberedEmail: rememberedCredential?.email ?? '',
    applyRememberedCredential,
    handleAuthSubmit,
    handleLogout,
  }
}
