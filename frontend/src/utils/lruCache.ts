/**
 * LRU (Least Recently Used) 缓存实现
 * 用于限制内存使用，防止缓存无限增长
 */

export interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>> = new Map()
  private readonly maxSize: number
  private readonly ttlMs: number

  constructor(maxSize: number = 100, ttlMs: number = 5 * 60 * 1000) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  /**
   * 获取缓存值
   * 如果值已过期，自动删除并返回 undefined
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }

    // 移到最后（最近使用）
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.value
  }

  /**
   * 设置缓存值
   * 如果缓存已满，删除最旧的（最少使用的）条目
   */
  set(key: K, value: V): void {
    // 如果键已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // 删除最旧的（第一个）
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
    }

    // 添加新条目
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  /**
   * 检查键是否存在且未过期
   */
  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size
  }

  /**
   * 清理过期的条目
   */
  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
      }
    }
  }
}
