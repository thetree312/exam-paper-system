/**
 * 输入验证工具
 * 
 * 提供前端输入验证，防止无效数据和潜在的注入攻击
 */

/**
 * 验证邮箱格式
 */
export function validateEmail(email: string): { valid: boolean; error?: string } {
  if (!email || email.trim().length === 0) {
    return { valid: false, error: 'auth.validation.email_required' }
  }

  const trimmed = email.trim()
  
  // 基本长度检查
  if (trimmed.length > 254) {
    return { valid: false, error: 'auth.validation.email_too_long' }
  }

  // RFC 5322 简化版正则
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  
  if (!emailRegex.test(trimmed)) {
    return { valid: false, error: 'auth.validation.email_invalid' }
  }

  return { valid: true }
}

/**
 * 验证密码强度
 */
export function validatePassword(password: string): { valid: boolean; error?: string } {
  if (!password || password.length === 0) {
    return { valid: false, error: 'auth.validation.password_required' }
  }

  if (password.length < 8) {
    return { valid: false, error: 'auth.validation.password_too_short' }
  }

  if (password.length > 128) {
    return { valid: false, error: 'auth.validation.password_too_long' }
  }

  // 检查是否包含至少一个字母和一个数字
  const hasLetter = /[a-zA-Z]/.test(password)
  const hasNumber = /[0-9]/.test(password)

  if (!hasLetter || !hasNumber) {
    return { valid: false, error: 'auth.validation.password_weak' }
  }

  return { valid: true }
}

/**
 * 验证显示名称
 */
export function validateDisplayName(name: string): { valid: boolean; error?: string } {
  // 显示名称可以为空（可选字段）
  if (!name || name.trim().length === 0) {
    return { valid: true }
  }

  const trimmed = name.trim()

  if (trimmed.length > 100) {
    return { valid: false, error: 'auth.validation.display_name_too_long' }
  }

  // 防止 XSS：不允许 HTML 标签
  if (/<[^>]*>/g.test(trimmed)) {
    return { valid: false, error: 'auth.validation.display_name_invalid' }
  }

  return { valid: true }
}

/**
 * 清理用户输入（移除潜在的 XSS 字符）
 */
export function sanitizeInput(input: string): string {
  if (!input) return ''
  
  return input
    .trim()
    .replace(/[<>]/g, '') // 移除尖括号
    .replace(/javascript:/gi, '') // 移除 javascript: 协议
    .replace(/on\w+\s*=/gi, '') // 移除事件处理器
}

/**
 * 验证文件类型
 */
export function validateFileType(file: File): { valid: boolean; error?: string } {
  const allowedTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]

  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: '不支持的文件类型，仅支持图片、PDF 和 Word 文档' }
  }

  return { valid: true }
}

/**
 * 验证文件大小
 */
export function validateFileSize(file: File, maxSizeMB: number = 50): { valid: boolean; error?: string } {
  const maxSizeBytes = maxSizeMB * 1024 * 1024

  if (file.size > maxSizeBytes) {
    return { valid: false, error: `文件大小不能超过 ${maxSizeMB}MB` }
  }

  if (file.size === 0) {
    return { valid: false, error: '文件不能为空' }
  }

  return { valid: true }
}
