import React from 'react'
import aliasMap from '../../scripts/icon-aliases.json'

export interface IconProps extends React.HTMLAttributes<HTMLSpanElement> {
  name?: string
  spin?: boolean
  filled?: boolean
}

const svgModules = import.meta.glob('../assets/material-symbols/outlined/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const svgByName = new Map<string, string>()
const renderedSvgCache = new Map<string, string>()

for (const [filePath, content] of Object.entries(svgModules)) {
  const filename = filePath.split('/').pop()
  if (!filename) continue
  const symbolName = filename.replace(/\.svg$/i, '')
  svgByName.set(symbolName, content)
}

function normalizeSvgMarkup(raw: string) {
  const fromCache = renderedSvgCache.get(raw)
  if (fromCache) return fromCache

  const markup = raw
    .replace(/\swidth="[^"]*"/i, '')
    .replace(/\sheight="[^"]*"/i, '')
    .replace(
      /<svg\b/i,
      '<svg width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"',
    )
  renderedSvgCache.set(raw, markup)
  return markup
}

function shouldUseFilledVariant(style: React.CSSProperties | undefined, explicitFilled: boolean | undefined) {
  if (explicitFilled) return true
  const value = style?.fontVariationSettings
  if (typeof value !== 'string') return false
  return /['"]?FILL['"]?\s*1/.test(value)
}

function resolveSymbolName(name: string) {
  return (aliasMap as Record<string, string>)[name] ?? name
}

function pickSvg(name: string, wantsFilled: boolean) {
  const resolved = resolveSymbolName(name)
  const candidates = wantsFilled
    ? [`${resolved}-fill`, resolved, `${resolved}_fill`, 'help']
    : [resolved, `${resolved}-fill`, `${resolved}_fill`, 'help']

  for (const candidate of candidates) {
    const svg = svgByName.get(candidate)
    if (svg) {
      return {
        svg,
        resolved,
        usedFallback: candidate === 'help' && resolved !== 'help',
      }
    }
  }
  return null
}

const warnedMissingIcons = new Set<string>()

export const Icon: React.FC<IconProps> = ({ name, spin, filled, className, style, ...props }) => {
  const iconName = String(name || '').trim()
  const normalizedName = iconName || 'help'
  const wantsFilled = shouldUseFilledVariant(style, filled)
  const resolvedIcon = pickSvg(normalizedName, wantsFilled)
  if (!resolvedIcon) return null

  if (
    resolvedIcon.usedFallback &&
    import.meta.env.DEV &&
    !warnedMissingIcons.has(normalizedName)
  ) {
    warnedMissingIcons.add(normalizedName)
    console.warn(`[Icon] Missing local SVG for icon "${normalizedName}" (resolved: "${resolvedIcon.resolved}"), fallback to "help".`)
  }

  const sanitizedStyle = { ...(style || {}) }
  delete sanitizedStyle.fontVariationSettings

  return (
    <span
      {...props}
      style={sanitizedStyle}
      className={[className, 'inline-flex items-center justify-center leading-none', spin ? 'animate-spin' : '']
        .filter(Boolean)
        .join(' ')}
      dangerouslySetInnerHTML={{ __html: normalizeSvgMarkup(resolvedIcon.svg) }}
    />
  )
}

export default Icon
