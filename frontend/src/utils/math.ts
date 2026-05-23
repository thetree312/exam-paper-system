export function shouldParseAsInlineMath(raw: string): boolean {
  const formula = raw.trim()
  if (!formula) return false

  const maxLength = 256
  if (formula.length > maxLength) return false

  const hasWhitespace = /\s/.test(formula)
  const looksLikeTeXCommand = /\\[a-zA-Z]+/.test(formula)
  const looksLikeSimpleExpression = /[=^_∝≈≤≥×·]/.test(formula) || /[+\-*/±]/.test(formula) || /√/.test(formula)
  const looksLikeSingleSymbol = /^[a-zA-Z][a-zA-Z0-9_]*$/.test(formula)

  return !hasWhitespace || looksLikeTeXCommand || looksLikeSimpleExpression || looksLikeSingleSymbol
}

const CJK_PATTERN = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u
const INLINE_MATH_FRAGMENT_PATTERN =
  /(?<![\p{L}\p{N}_$])((?:[A-Za-z0-9_²³⁴⁵⁶⁷⁸⁹⁰₀-₉]+(?:\s*[=^_\/+\-×·∝≈≤≥±]\s*[A-Za-z0-9_²³⁴⁵⁶⁷⁸⁹⁰₀-₉()]+)+)|(?:\d+\s*\/\s*\d+)|(?:√\s*[A-Za-z0-9_²³⁴⁵⁶⁷⁸⁹⁰₀-₉()]+))(?![\p{L}\p{N}_$])/gu

export function wrapMathLikeFragments(raw: string): string {
  if (!raw) return raw

  return raw
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (line.includes('$')) return line

      const prefix = line.match(/^\s*/)?.[0] ?? ''
      const suffix = line.match(/\s*$/)?.[0] ?? ''

      if (!CJK_PATTERN.test(trimmed) && shouldParseAsInlineMath(trimmed)) {
        return `${prefix}$$${trimmed}$$${suffix}`
      }

      let changed = false
      let cursor = 0
      let result = ''
      for (const match of line.matchAll(INLINE_MATH_FRAGMENT_PATTERN)) {
        const fragment = match[1]?.trim() ?? ''
        if (!fragment || !shouldParseAsInlineMath(fragment)) continue
        changed = true
        const start = match.index ?? 0
        result += line.slice(cursor, start)
        result += `$${fragment}$`
        cursor = start + match[0].length
      }

      if (!changed) return line
      result += line.slice(cursor)
      return result
    })
    .join('\n')
}
