import type { FillBlankAnswerMap } from './types'

export function parseFillBlankAnswer(raw: string | undefined | null, blankCount: number): FillBlankAnswerMap {
  const result: FillBlankAnswerMap = {}
  if (!raw) return result

  // 优先尝试 JSON 结构：{"0":"ans1","1":"ans2"}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        const idx = Number(key)
        if (Number.isInteger(idx) && idx >= 0 && idx < blankCount && typeof value === 'string') {
          result[idx] = value
        }
      }
      return result
    }
  } catch {
    // 忽略 JSON 解析错误，走降级路径
  }

  // 降级：用常见分隔符粗略切分（";"、"|"、"、" 等），顺序对应各空
  const parts = raw
    .split(/[;|；、]/)
    .map((p) => p.trim())
    .filter(Boolean)

  parts.forEach((val, idx) => {
    if (idx < blankCount) {
      result[idx] = val
    }
  })

  return result
}

export function serializeFillBlankAnswer(map: FillBlankAnswerMap): string {
  const clean: FillBlankAnswerMap = {}

  Object.keys(map).forEach((key) => {
    const idx = Number(key)
    const value = map[idx]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        clean[idx] = trimmed
      }
    }
  })

  if (!Object.keys(clean).length) return ''

  return JSON.stringify(clean)
}
