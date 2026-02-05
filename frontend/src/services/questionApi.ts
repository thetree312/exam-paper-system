/**
 * 题目 API 服务
 * 包含请求去重、自动重试、缓存、并发控制、速率限制等功能
 */

import type { Question } from '../types'
import { LRUCache } from '../utils/lruCache'
import { ConcurrencyController } from '../utils/concurrency'
import { RateLimiter } from '../utils/rateLimiter'

// ===== 错误类型 =====

export class TimeoutError extends Error {
  constructor(message: string = '请求超时') {
    super(message)
    this.name = 'TimeoutError'
  }
}

export class NotFoundError extends Error {
  constructor(message: string = '题目不存在') {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class ForbiddenError extends Error {
  constructor(message: string = '无权访问该题目') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export class RateLimitError extends Error {
  constructor(message: string = '请求过于频繁') {
    super(message)
    this.name = 'RateLimitError'
  }
}

// ===== 配置常量 =====

const CACHE_MAX_SIZE = 100  // 最多缓存 100 个题目
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 分钟过期
const REQUEST_TIMEOUT_MS = 5000  // 5 秒超时
const MAX_RETRIES = 3  // 最多重试 3 次
const RETRY_DELAYS = [100, 200, 400]  // 重试延迟：100ms, 200ms, 400ms
const MAX_CONCURRENT = 1  // 平台并发受限时，将所有题目请求串行化
// 为了支持一次性批量加载多道题（例如 GLM-OCR 导入 20~30 题），放宽速率限制
const RATE_LIMIT_MAX = 1000  // 60 秒内最多 1000 个请求，基本等于对当前场景关闭限制
const RATE_LIMIT_WINDOW = 60000  // 60 秒

// ===== 全局实例 =====

const cache = new LRUCache<number, Question>(CACHE_MAX_SIZE, CACHE_TTL_MS)
const concurrency = new ConcurrencyController(MAX_CONCURRENT)
const rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW)

// 存储正在进行的请求，用于请求去重
const pendingRequests = new Map<number, Promise<Question>>()

// ===== 辅助函数 =====

/**
 * 延迟指定毫秒数
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return response
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TimeoutError()
    }
    throw err
  }
}

/**
 * 带重试的 fetch
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries: number = MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options)

      // 4xx 错误不重试
      if (response.status >= 400 && response.status < 500) {
        return response
      }

      // 5xx 错误重试
      if (response.ok) {
        return response
      }

      lastError = new Error(`HTTP ${response.status}`)
    } catch (err) {
      lastError = err as Error

      // 最后一次尝试不等待
      if (attempt < maxRetries - 1) {
        const delayMs = RETRY_DELAYS[attempt] || 1000
        await delay(delayMs)
      }
    }
  }

  throw lastError || new Error('Unknown error')
}

/**
 * 处理 API 响应
 */
async function handleResponse(response: Response): Promise<Question> {
  if (response.status === 404) {
    throw new NotFoundError()
  }

  if (response.status === 403) {
    throw new ForbiddenError()
  }

  if (response.status === 429) {
    throw new RateLimitError()
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  return response.json()
}

// ===== 公开 API =====

/**
 * 获取题目详情
 * 包含缓存、请求去重、重试、并发控制、速率限制
 */
export async function getQuestion(
  questionId: number,
  tenantId: number,
  backendBaseUrl: string
): Promise<Question> {
  // 检查速率限制
  if (!rateLimiter.isAllowed()) {
    throw new RateLimitError(
      `请求过于频繁，请在 ${Math.ceil(rateLimiter.getRetryAfterMs() / 1000)} 秒后重试`
    )
  }

  // 检查本地缓存
  const cached = cache.get(questionId)
  if (cached) {
    return cached
  }

  // 检查是否已有相同的请求在进行
  if (pendingRequests.has(questionId)) {
    return pendingRequests.get(questionId)!
  }

  // 创建新请求
  const promise = concurrency.run(async () => {
    try {
      const url = `${backendBaseUrl}/api/questions/${questionId}?tenant_id=${tenantId}`
      const response = await fetchWithRetry(url)
      const question = await handleResponse(response)

      // 缓存结果
      cache.set(questionId, question)

      return question
    } finally {
      // 请求完成后清理
      pendingRequests.delete(questionId)
    }
  })

  pendingRequests.set(questionId, promise)
  return promise
}

/**
 * 清空缓存
 */
export function clearCache(): void {
  cache.clear()
}

/**
 * 获取缓存统计信息
 */
export function getCacheStats(): {
  size: number
  maxSize: number
  activeRequests: number
  waitingRequests: number
  rateLimitRemaining: number
} {
  return {
    size: cache.size(),
    maxSize: CACHE_MAX_SIZE,
    activeRequests: concurrency.getActiveCount(),
    waitingRequests: concurrency.getWaitingCount(),
    rateLimitRemaining: rateLimiter.getRemaining(),
  }
}

/**
 * 重置速率限制器
 */
export function resetRateLimit(): void {
  rateLimiter.reset()
}
