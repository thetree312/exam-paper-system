import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const srcDir = path.join(root, 'src')
const aliasPath = path.join(root, 'scripts', 'icon-aliases.json')
const outDir = path.join(root, 'src', 'assets', 'material-symbols', 'outlined')

if (!fs.existsSync(aliasPath)) throw new Error(`Alias file not found: ${aliasPath}`)
if (!fs.existsSync(outDir)) throw new Error(`Output icon directory not found: ${outDir}`)

const aliasMap = JSON.parse(fs.readFileSync(aliasPath, 'utf8'))
const resolveAlias = (name) => aliasMap[name] ?? name

const iconNames = new Set(['help'])
for (const value of Object.values(aliasMap)) {
  iconNames.add(String(value).trim())
}

const codeExt = new Set(['.ts', '.tsx', '.js', '.jsx'])
const queue = [srcDir]
while (queue.length > 0) {
  const current = queue.pop()
  if (!current) continue
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      queue.push(fullPath)
      continue
    }
    if (!codeExt.has(path.extname(entry.name))) continue
    const content = fs.readFileSync(fullPath, 'utf8')
    const regexes = [
      /<Icon\b[^>]*\bname\s*=\s*["'`]([a-z0-9_]+)["'`]/gi,
      /<LobeIcon\b[^>]*\bfallbackIconName\s*=\s*["'`]([a-z0-9_]+)["'`]/gi,
    ]
    for (const regex of regexes) {
      let match = regex.exec(content)
      while (match) {
        iconNames.add(resolveAlias(match[1]))
        match = regex.exec(content)
      }
    }
  }
}

const missing = []
for (const iconName of iconNames) {
  const clean = String(iconName).trim()
  if (!clean) continue
  const basePath = path.join(outDir, `${clean}.svg`)
  const fillPath = path.join(outDir, `${clean}-fill.svg`)
  if (!fs.existsSync(basePath) && !fs.existsSync(fillPath)) missing.push(clean)
}

if (missing.length > 0) {
  throw new Error(`[icons:verify] Missing local material icons: ${missing.sort().join(', ')}`)
}

console.log(`[icons:verify] OK. checked=${iconNames.size}`)
