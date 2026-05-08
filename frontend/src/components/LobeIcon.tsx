import React from 'react'
import Icon from './Icon'

export interface LobeIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  iconKey?: string | null
  fallbackIconName?: string
}

const lobeSvgModules = import.meta.glob('../assets/lobe-icons/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const lobeSvgByKey = new Map<string, string>()
const lobeRenderedSvgCache = new Map<string, string>()

for (const [filePath, content] of Object.entries(lobeSvgModules)) {
  const filename = filePath.split('/').pop()
  if (!filename) continue
  const key = filename.replace(/\.svg$/i, '')
  lobeSvgByKey.set(key, content)
}

function normalizeLobeSvgMarkup(raw: string) {
  const fromCache = lobeRenderedSvgCache.get(raw)
  if (fromCache) return fromCache
  const markup = raw
    .replace(/\swidth="[^"]*"/i, '')
    .replace(/\sheight="[^"]*"/i, '')
    .replace(/<svg\b/i, '<svg width="1em" height="1em" aria-hidden="true" focusable="false"')
  lobeRenderedSvgCache.set(raw, markup)
  return markup
}

export const LobeIcon: React.FC<LobeIconProps> = ({
  iconKey,
  fallbackIconName = 'help',
  className,
  ...props
}) => {
  const key = String(iconKey || '').trim().toLowerCase()
  const svg = key ? lobeSvgByKey.get(key) : undefined
  if (!svg) {
    return <Icon {...props} name={fallbackIconName} className={className} />
  }
  return (
    <span
      {...props}
      className={[className, 'inline-flex items-center justify-center leading-none'].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: normalizeLobeSvgMarkup(svg) }}
    />
  )
}

export default LobeIcon


