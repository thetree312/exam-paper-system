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
  TENANT_CODE: 'exam_tenant_code',
} as const

export interface StoredUser {
  id: number
  tenant_id: number
  email: string
  display_name: string
  tenant_code?: string
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
 * 保存租户代码到 localStorage（非敏感数据，可持久化）
 */
export function saveTenantCode(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS.TENANT_CODE, code)
  } catch (error) {
    console.error('[secureStorage] Failed to save tenant code:', error)
  }
}

/**
 * 从 localStorage 读取租户代码
 */
export function loadTenantCode(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.TENANT_CODE) || 'default'
  } catch (error) {
    console.error('[secureStorage] Failed to load tenant code:', error)
    return 'default'
  }
}

/**
 * 清除租户代码
 */
export function clearTenantCode(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.TENANT_CODE)
  } catch (error) {
    console.error('[secureStorage] Failed to clear tenant code:', error)
  }
}

/**
 * 清除所有存储数据
 */
export function clearAll(): void {
  clearUser()
  clearTenantCode()
}
