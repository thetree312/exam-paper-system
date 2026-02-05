/**
 * 速率限制器
 * 防止在指定时间窗口内发送过多请求
 */

export class RateLimiter {
  private requests: number[] = []
  private readonly maxRequests: number
  private readonly windowMs: number

  constructor(maxRequests: number = 10, windowMs: number = 60000) {
    this.maxRequests = maxRequests
    this.windowMs = windowMs
  }

  /**
   * 检查是否允许请求
   * 如果允许，记录请求时间并返回 true
   * 如果超过限制，返回 false
   */
  isAllowed(): boolean {
    const now = Date.now()

    // 清理过期的请求记录（超过时间窗口的）
    this.requests = this.requests.filter((time) => now - time < this.windowMs)

    // 检查是否超过限制
    if (this.requests.length >= this.maxRequests) {
      return false
    }

    // 记录新请求
    this.requests.push(now)
    return true
  }

  /**
   * 获取剩余可用请求数
   */
  getRemaining(): number {
    const now = Date.now()
    this.requests = this.requests.filter((time) => now - time < this.windowMs)
    return Math.max(0, this.maxRequests - this.requests.length)
  }

  /**
   * 获取下一个请求可用的时间（毫秒）
   * 如果当前可用，返回 0
   */
  getRetryAfterMs(): number {
    if (this.requests.length < this.maxRequests) {
      return 0
    }

    const oldestRequest = this.requests[0]
    const retryAfter = oldestRequest + this.windowMs - Date.now()
    return Math.max(0, retryAfter)
  }

  /**
   * 重置限制器
   */
  reset(): void {
    this.requests = []
  }
}
