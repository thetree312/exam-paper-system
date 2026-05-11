/**
 * 安全存储工具类
 * 
 * 使用 sessionStorage 而非 localStorage 存储敏感数据，
 * sessionStorage 在浏览器标签页关闭后自动清除，更安全。
 * 
 * 对于需要持久化的非敏感数据（如租户代码），仍使用 localStorage。
 */

const STORAGE_KEYS = {
  USER: 'exam_user',
  AUTH_REMEMBER: 'exam_auth_remember',
} as const

export interface StoredUser {
  id: string | number
  tenant_id: number
  email: string
  display_name: string
  token?: string
  session_id?: string
}

export type AuthRememberPolicy = '30d' | '365d' | 'forever'

interface StoredAuthRemember {
  email: string
  password: string
  policy: AuthRememberPolicy
  savedAt: number
  expiresAt: number | null
}

/**
 * 保存用户信息到 sessionStorage（敏感数据）
 */
export function saveUser(user: StoredUser): void {
  try {
    sessionStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user))
  } catch (error) {
    console.error('[secureStorage] Failed to save user:', error)
  }
}

/**
 * 从 sessionStorage 读取用户信息
 */
export function loadUser(): StoredUser | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.USER)
    if (!raw) return null
    return JSON.parse(raw) as StoredUser
  } catch (error) {
    console.error('[secureStorage] Failed to load user:', error)
    return null
  }
}

/**
 * 清除用户信息
 */
export function clearUser(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEYS.USER)
  } catch (error) {
    console.error('[secureStorage] Failed to clear user:', error)
  }
}

/**
 * 清除所有存储数据
 */
export function clearAll(): void {
  clearUser()
}

export function getAuthToken(): string | null {
  const user = loadUser()
  const token = typeof user?.token === 'string' ? user.token.trim() : ''
  return token || null
}

function toRememberExpiresAt(policy: AuthRememberPolicy, now = Date.now()): number | null {
  if (policy === 'forever') return null
  const days = policy === '365d' ? 365 : 30
  return now + days * 24 * 60 * 60 * 1000
}

export function saveRememberedAuthCredential(input: {
  email: string
  password: string
  policy: AuthRememberPolicy
}): void {
  const email = String(input.email || '').trim()
  const password = String(input.password || '')
  if (!email || !password) return
  try {
    const now = Date.now()
    const payload: StoredAuthRemember = {
      email,
      password,
      policy: input.policy,
      savedAt: now,
      expiresAt: toRememberExpiresAt(input.policy, now),
    }
    window.localStorage.setItem(STORAGE_KEYS.AUTH_REMEMBER, JSON.stringify(payload))
  } catch (error) {
    console.error('[secureStorage] Failed to save remembered auth credential:', error)
  }
}

export function loadRememberedAuthCredential(): (StoredAuthRemember & { expired: boolean }) | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.AUTH_REMEMBER)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredAuthRemember
    const email = String(parsed?.email || '').trim()
    const password = String(parsed?.password || '')
    const policy = parsed?.policy
    const savedAt = Number(parsed?.savedAt || 0)
    const expiresAt = parsed?.expiresAt == null ? null : Number(parsed.expiresAt)
    if (!email || !password || (policy !== '30d' && policy !== '365d' && policy !== 'forever') || !Number.isFinite(savedAt)) {
      clearRememberedAuthCredential()
      return null
    }
    const expired = typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? Date.now() > expiresAt : false
    if (expired) {
      clearRememberedAuthCredential()
      return null
    }
    return {
      email,
      password,
      policy,
      savedAt,
      expiresAt,
      expired: false,
    }
  } catch (error) {
    console.error('[secureStorage] Failed to load remembered auth credential:', error)
    return null
  }
}

export function clearRememberedAuthCredential(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEYS.AUTH_REMEMBER)
  } catch (error) {
    console.error('[secureStorage] Failed to clear remembered auth credential:', error)
  }
}
