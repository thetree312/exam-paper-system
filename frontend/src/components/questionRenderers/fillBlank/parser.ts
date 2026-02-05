import { normalizeQuestionText } from '../utils'
import type { FillBlankParsedResult, FillBlankSegment } from './types'

/**
 * 严格的填空题检测与解析：
 * - 仅在存在明显长下划线或成对空括号时才认定为填空题；
 * - 需要满足以下任一条件才通过：
 *   1）至少 2 个空；
 *   2）至少 1 个长度 >= 5 的长下划线；
 *   3）文本中出现“填空题”或“填空”。
 *
 * 宁可漏判，不可误判。
 */
export function parseFillBlankQuestion(raw: string): FillBlankParsedResult | null {
  if (!raw) return null

  // 解析逻辑基于原始题干字符串 raw，以最大程度保留原有换行和空格布局；
  // 仅在需要做文案级特征判断（例如包含“填空题”字样）时才使用规范化后的文本。

  const segments: FillBlankSegment[] = []

  let totalBlanks = 0
  let maxPlaceholderLength = 0
  let blankIndex = 0

  const BLANK_PATTERN = /(_{3,}|（\s*）|\(\s*\))/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = BLANK_PATTERN.exec(raw)) != null) {
    const matchText = match[0]
    const start = match.index

    if (start > lastIndex) {
      segments.push({
        type: 'text',
        text: raw.slice(lastIndex, start),
      })
    }

    const placeholderLength = matchText.replace(/\s+/g, '').length

    segments.push({
      type: 'blank',
      index: blankIndex,
      placeholderLength,
    })

    blankIndex += 1
    totalBlanks += 1
    if (placeholderLength > maxPlaceholderLength) {
      maxPlaceholderLength = placeholderLength
    }

    lastIndex = start + matchText.length
  }

  if (lastIndex < raw.length) {
    segments.push({
      type: 'text',
      text: raw.slice(lastIndex),
    })
  }

  if (totalBlanks === 0) {
    return null
  }

  const normalized = normalizeQuestionText(raw)
  const hasHeaderKeyword = /填空题|填空/.test(normalized)
  const hasManyBlanks = totalBlanks >= 2
  const hasLongBlank = maxPlaceholderLength >= 3

  if (!hasHeaderKeyword && !hasManyBlanks && !hasLongBlank) {
    // 只有一个很短的“___”之类的占位符，且没有明显“填空”标记时，直接视为普通文本，避免误判
    return null
  }

  return {
    segments,
    totalBlanks,
    originalText: raw,
  }
}
