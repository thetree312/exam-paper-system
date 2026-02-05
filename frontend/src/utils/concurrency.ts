/**
 * 并发控制器
 * 限制同时进行的异步操作数量，防止资源耗尽
 */

export class ConcurrencyController {
  private activeRequests: number = 0
  private readonly maxConcurrent: number
  private waitQueue: Array<() => void> = []

  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent
  }

  /**
   * 运行异步函数，受并发限制
   * 如果已达到并发限制，等待直到有空闲槽位
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // 等待直到有空闲槽位
    while (this.activeRequests >= this.maxConcurrent) {
      await new Promise((resolve) => {
        this.waitQueue.push(resolve)
      })
    }

    this.activeRequests++

    try {
      return await fn()
    } finally {
      this.activeRequests--

      // 唤醒等待队列中的下一个
      const resolve = this.waitQueue.shift()
      if (resolve) {
        resolve()
      }
    }
  }

  /**
   * 获取当前活跃请求数
   */
  getActiveCount(): number {
    return this.activeRequests
  }

  /**
   * 获取等待队列长度
   */
  getWaitingCount(): number {
    return this.waitQueue.length
  }
}
