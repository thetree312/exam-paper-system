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
} as const

export interface StoredUser {
  id: string | number
  tenant_id: number
  email: string
  display_name: string
  token?: string
  session_id?: string
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
