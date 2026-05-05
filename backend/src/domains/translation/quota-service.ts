type TranslationQuotaEntry = {
  timestamps: number[]
}

export type TranslationQuotaStatus = {
  limit: number
  remaining: number
  resetAt: string
}

export class TranslationQuotaExceededError extends Error {
  constructor(public readonly status: TranslationQuotaStatus) {
    super("Translation quota exceeded")
  }
}

const LIMIT = 20
const WINDOW_MS = 60 * 60 * 1000
const entries = new Map<string, TranslationQuotaEntry>()

export const TranslationQuotaService = {
  consume(userID: string): TranslationQuotaStatus {
    const now = Date.now()
    const windowStart = now - WINDOW_MS
    const entry = entries.get(userID) ?? { timestamps: [] }
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp >= windowStart)

    if (entry.timestamps.length >= LIMIT) {
      const resetAt = new Date(entry.timestamps[0] + WINDOW_MS).toISOString()
      const status = {
        limit: LIMIT,
        remaining: 0,
        resetAt,
      }
      entries.set(userID, entry)
      throw new TranslationQuotaExceededError(status)
    }

    entry.timestamps.push(now)
    entries.set(userID, entry)

    return {
      limit: LIMIT,
      remaining: LIMIT - entry.timestamps.length,
      resetAt: new Date(entry.timestamps[0] + WINDOW_MS).toISOString(),
    }
  },
}
