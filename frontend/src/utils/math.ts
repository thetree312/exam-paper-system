export function shouldParseAsInlineMath(raw: string): boolean {
  const formula = raw.trim()
  if (!formula) return false

  const maxLength = 256
  if (formula.length > maxLength) return false

  const hasWhitespace = /\s/.test(formula)
  const looksLikeTeXCommand = /\\[a-zA-Z]+/.test(formula)
  const looksLikeSimpleExpression = /[=^_]/.test(formula) || /[+\-*/]/.test(formula)
  const looksLikeSingleSymbol = /^[a-zA-Z][a-zA-Z0-9_]*$/.test(formula)

  return !hasWhitespace || looksLikeTeXCommand || looksLikeSimpleExpression || looksLikeSingleSymbol
}
