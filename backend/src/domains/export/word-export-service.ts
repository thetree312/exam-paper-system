import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ExportWordInput } from "./types"
import { ExportTemplatesService } from "./templates-service"

const execFileAsync = promisify(execFile)

function resolvePandocPath() {
  const configured = process.env.PANDOC_PATH?.trim()
  if (configured) return configured
  return path.join(path.resolve(import.meta.dirname, "../../../.."), "pandoc-3.8.3", "pandoc.exe")
}

function sanitizeTitle(input?: string) {
  const title = (input?.trim() || "导出试卷").trim()
  return title.length > 0 ? title : "导出试卷"
}

function buildMarkdown(input: ExportWordInput) {
  const lines: string[] = []
  const title = sanitizeTitle(input.title)
  lines.push(title, "")

  const sorted = [...input.questions].sort((a, b) => a.index - b.index)
  for (const item of sorted) {
    lines.push(`第${item.index}题`, "")
    const body = item.markdown.trim()
    if (body) {
      lines.push(body, "")
    }
  }

  return `${lines.join("\n").trim()}\n`
}

async function runPandoc(input: { markdown: string; templateKey?: string | null }) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-export-"))
  try {
    const markdownPath = path.join(tempDir, "paper.md")
    const outputPath = path.join(tempDir, "paper.docx")
    await writeFile(markdownPath, input.markdown, "utf8")

    const templatePath = await ExportTemplatesService.requireTemplatePath(input.templateKey)
    const args = [markdownPath, "-o", outputPath, "--standalone"]
    if (templatePath) {
      args.push("--reference-doc", templatePath)
    }

    await execFileAsync(resolvePandocPath(), args, {
      cwd: tempDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    })

    return await readFile(outputPath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function buildDownloadName(title?: string) {
  const safe = sanitizeTitle(title)
  const ascii = Array.from(safe)
    .map((char) => (/[\x20-\x7E]/.test(char) ? char : "_"))
    .join("")
    .replace(/"/g, "_")
  return {
    plainTitle: safe,
    ascii: `${ascii || `export_${randomUUID()}`}.docx`,
    utf8: `${encodeURIComponent(safe)}.docx`,
  }
}

export const ExportWordService = {
  async export(input: ExportWordInput) {
    if (!Array.isArray(input.questions) || input.questions.length === 0) {
      throw new Error("No questions available for export")
    }
    const markdown = buildMarkdown(input)
    const file = await runPandoc({
      markdown,
      templateKey: input.templateKey,
    })
    const name = buildDownloadName(input.title)
    return {
      file,
      contentDisposition: `attachment; filename="${name.ascii}"; filename*=UTF-8''${name.utf8}`,
    }
  },
}
