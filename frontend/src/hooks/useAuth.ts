import { useState, useEffect, useCallback } from 'react'
import type { AuthMode, UserInfo } from '../types'
import { useAppStore } from '../store/appStore'
import {
  loadUser as secureLoadUser,
  saveUser as secureSaveUser,
  clearUser as secureClearUser,
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
  handleAuthSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
  handleLogout: () => void
}

export const useAuth = (backendBaseUrl: string): UseAuthReturn => {
  const storeUser = useAppStore((state) => state.user)
  const setStoreUser = useAppStore((state) => state.setUser)

  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authDisplayName, setAuthDisplayName] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

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
        if ((parsed as UserInfo | null) == null) return
      }
    } catch (e) {
      console.error('migrate legacy user failed', e)
    }
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
          payload.display_name = authDisplayName.trim()
        }
      }

      try {
        console.log('[auth] request', mode, payload)
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!resp.ok) {
          const text = await resp.text()
          throw new Error(text || '请求失败')
        }
        const data = (await resp.json()) as { user: UserInfo }
        setStoreUser(data.user)
        secureSaveUser(data.user)
        console.log('[auth] success', data.user)
      } catch (err) {
        console.error('[auth] failed', err)
        setAuthError('登录/注册失败，请检查邮箱和密码')
      } finally {
        setAuthLoading(false)
      }
    },
    [authMode, authEmail, authPassword, authDisplayName, backendBaseUrl],
  )

  const handleLogout = useCallback(() => {
    setStoreUser(null)
    secureClearUser()
    setAuthEmail('')
    setAuthPassword('')
    setAuthDisplayName('')
  }, [setStoreUser])

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
    handleAuthSubmit,
    handleLogout,
  }
}
