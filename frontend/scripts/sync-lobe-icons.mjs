import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const srcRoot = path.join(root, 'src')
const packageDir = path.join(root, 'node_modules', '@lobehub', 'icons-static-svg', 'icons')
const outDir = path.join(root, 'src', 'assets', 'lobe-icons')

if (!fs.existsSync(packageDir)) {
  throw new Error(`Lobe icons package not found: ${packageDir}`)
}
fs.mkdirSync(outDir, { recursive: true })

const map = {
  bailian: 'alibabacloud-color.svg',
  siliconcloud: 'siliconcloud-color.svg',
  modelscope: 'modelscope-color.svg',
  zai: 'zhipu-color.svg',
  openai: 'openai.svg',
  qwen: 'qwen-color.svg',
  deepseek: 'deepseek-color.svg',
  claude: 'claude-color.svg',
  gemini: 'gemini-color.svg',
  grok: 'grok.svg',
  moonshot: 'moonshot.svg',
  doubao: 'doubao-color.svg',
  mistral: 'mistral-color.svg',
  chatglm: 'chatglm-color.svg',
  kimi: 'kimi-color.svg',
  zhipu: 'zhipu-color.svg',
}

const localKeys = new Set(Object.keys(map))
const queue = [srcRoot]
const codeExt = new Set(['.ts', '.tsx', '.js', '.jsx'])
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
    const regex = /\biconKey\s*[:=]\s*["'`]([a-z0-9_-]+)["'`]/gi
    let match = regex.exec(content)
    while (match) {
      localKeys.add(match[1].toLowerCase())
      match = regex.exec(content)
    }
  }
}

const missing = []
let copiedCount = 0
for (const key of localKeys) {
  const preferred = map[key] ?? `${key}.svg`
  const source = path.join(packageDir, preferred)
  if (!fs.existsSync(source)) {
    missing.push(`${key} -> ${preferred}`)
    continue
  }
  const dest = path.join(outDir, `${key}.svg`)
  fs.copyFileSync(source, dest)
  copiedCount += 1
}

if (missing.length > 0) {
  throw new Error(`[lobe-icons:sync] Missing upstream icon files: ${missing.join(', ')}`)
}

console.log(`[lobe-icons:sync] Synced lobe icons. keys=${localKeys.size}, filesCopied=${copiedCount}`)
