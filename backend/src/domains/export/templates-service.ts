import { access, readdir } from "node:fs/promises"
import path from "node:path"
import type { ExportTemplateInfo } from "./types"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")

function getTemplatesDirectory() {
  return path.join(backendRoot, "templates", "word_templates")
}

export const ExportTemplatesService = {
  async list(): Promise<ExportTemplateInfo[]> {
    const templatesDir = getTemplatesDirectory()
    const entries = await readdir(templatesDir, {
      withFileTypes: true,
    }).catch(() => [])

    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".docx"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        key: entry.name.replace(/\.docx$/i, ""),
        name: entry.name.replace(/\.docx$/i, ""),
        description: null,
      }))
  },

  resolveTemplatePath(templateKey?: string | null) {
    if (!templateKey) return null
    const normalized = templateKey.trim()
    if (!normalized) return null
    if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
      throw new Error(`Invalid export template key: ${templateKey}`)
    }
    return path.join(getTemplatesDirectory(), `${normalized}.docx`)
  },

  async requireTemplatePath(templateKey?: string | null) {
    const resolved = this.resolveTemplatePath(templateKey)
    if (!resolved) return null
    await access(resolved).catch(() => {
      throw new Error(`Export template not found: ${templateKey}`)
    })
    return resolved
  },
}
