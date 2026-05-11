import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'src', 'assets', 'lobe-icons')
if (!fs.existsSync(outDir)) {
  throw new Error(`Lobe icon output directory not found: ${outDir}`)
}

const required = [
  'bailian',
  'siliconcloud',
  'modelscope',
  'zai',
  'openai',
  'qwen',
  'deepseek',
  'claude',
  'gemini',
  'grok',
  'moonshot',
  'doubao',
  'mistral',
  'chatglm',
  'kimi',
  'zhipu',
]

const missing = required.filter((name) => !fs.existsSync(path.join(outDir, `${name}.svg`)))
if (missing.length > 0) {
  throw new Error(`[lobe-icons:verify] Missing local lobe icons: ${missing.join(', ')}`)
}

console.log(`[lobe-icons:verify] OK. checked=${required.length}`)
