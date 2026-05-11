import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const srcDir = path.join(root, 'src')
const aliasPath = path.join(root, 'scripts', 'icon-aliases.json')
const packageDir = path.join(root, 'node_modules', '@material-symbols', 'svg-400', 'outlined')
const outDir = path.join(root, 'src', 'assets', 'material-symbols', 'outlined')

if (!fs.existsSync(aliasPath)) throw new Error(`Alias file not found: ${aliasPath}`)
if (!fs.existsSync(packageDir)) throw new Error(`Material Symbols package not found: ${packageDir}`)

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

fs.mkdirSync(outDir, { recursive: true })

const missing = []
let copiedCount = 0
for (const iconName of iconNames) {
  const clean = String(iconName).trim()
  if (!clean) continue
  const candidates = [clean, `${clean}-fill`]
  let baseFound = false
  for (const candidate of candidates) {
    const srcFile = path.join(packageDir, `${candidate}.svg`)
    if (!fs.existsSync(srcFile)) continue
    const destFile = path.join(outDir, `${candidate}.svg`)
    fs.copyFileSync(srcFile, destFile)
    copiedCount += 1
    if (candidate === clean) baseFound = true
  }
  if (!baseFound) missing.push(clean)
}

if (missing.length > 0) {
  throw new Error(`Missing Material Symbols in package: ${[...new Set(missing)].sort().join(', ')}`)
}

console.log(`[icons:sync] Material symbols synced. icons=${iconNames.size}, filesCopied=${copiedCount}`)
