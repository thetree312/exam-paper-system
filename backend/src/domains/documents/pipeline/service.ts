import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { OcrProviderClient } from "../../ocr/provider-client"
import { WorkroomRecord } from "../../workrooms/service"

export type SupportedDocumentSourceType = "pdf" | "word" | "image"

export type DocumentPipelineInput = {
  documentID: string
  fileName: string
  mimeType: string
  sourceType: SupportedDocumentSourceType
  inputPath: string
  workroom: WorkroomRecord
  onStage?: (
    stage: "preview_ready" | "layout_ready" | "markdown_ready",
    payload: {
      previewPages?: DocumentPreviewPage[]
      extractedTextPages?: Array<{
        pageNumber: number
        text: string
        characterCount: number
      }>
      layoutPages?: DocumentLayoutPage[]
      rawMarkdownPath?: string
      rawMarkdownRelativePath?: string
      rawMarkdownCharacterCount?: number
      sourcePackagePath?: string
      originalSha256?: string
      originalSizeBytes?: number
    },
  ) => Promise<void>
}

export type DocumentPreviewPage = {
  pageNumber: number
  absolutePath: string
  mimeType: string
  sizeBytes: number
}

export type DocumentTextPage = {
  pageNumber: number
  text: string
}

export type DocumentLayoutBlock = {
  layoutUnitKey: string
  pageNumber: number
  blockIndex: number
  blockLabel: string
  content: string
  bboxAbs: {
    x1: number
    y1: number
    x2: number
    y2: number
  } | null
  bboxNorm: {
    x1: number
    y1: number
    x2: number
    y2: number
  } | null
  cropAssetAbsolutePath?: string
  cropAssetRelativePath?: string
  rawMarkdownRange: {
    startOffset: number
    endOffset: number
    startLine: number
    endLine: number
    excerpt: string
  } | null
}

export type DocumentLayoutPage = {
  pageNumber: number
  width: number | null
  height: number | null
  markdown: string
  blocks: DocumentLayoutBlock[]
}

export type DocumentSourcePackage = {
  id: string
  documentID: string
  userID: string
  workroomID: string
  sourceType: SupportedDocumentSourceType
  mimeType: string
  originalFile: {
    name: string
    absolutePath: string
    sha256: string
    sizeBytes: number
  }
  rawMarkdown: {
    absolutePath: string
    relativePathFromWorkroom: string
    characterCount: number
  }
  previewPages: Array<{
    pageNumber: number
    mimeType: string
    absolutePath: string
    sizeBytes: number
  }>
  textPages: Array<{
    pageNumber: number
    text: string
    characterCount: number
  }>
  layoutPages: DocumentLayoutPage[]
  workspace: {
    rootDirectory: string
    wikiDirectory: string
    sourcePackagePath: string
  }
  createdAt: string
  updatedAt: string
}

export type DocumentPipelineResult = {
  previewPages: DocumentPreviewPage[]
  textPages: DocumentTextPage[]
  layoutPages: DocumentLayoutPage[]
  rawMarkdownAbsolutePath: string
  rawMarkdownRelativePathFromWorkroom: string
  rawMarkdownContent: string
  sourcePackage: DocumentSourcePackage
  sourcePackagePath: string
  originalSha256: string
  originalSizeBytes: number
}

type ResolvedTools = {
  powershell: string
}

type GlmLayoutPayload = {
  layout_details?: Array<Array<Record<string, unknown>>>
  data_info?: {
    pages?: Array<Record<string, unknown>>
  }
  md_results?: string
  code?: number
  message?: string
}

const repoRoot = path.resolve(import.meta.dirname, "../../../../..")
const backendRoot = path.join(repoRoot, "backend")
const localDataRoot = path.join(backendRoot, "local-data")
const figureLabels = new Set(["image", "figure", "chart"])

let resolvedToolsPromise: Promise<ResolvedTools> | undefined
let pdftoppmPromise: Promise<string> | undefined
let pdftotextPromise: Promise<string> | undefined
let docx2pdfPromise: Promise<string> | undefined

async function pathExists(filepath: string) {
  try {
    await access(filepath)
    return true
  } catch {
    return false
  }
}

async function resolveRequiredBinary(name: string, candidates: string[]) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  throw new Error(`Missing required local binary: ${name}`)
}

async function resolveTools(): Promise<ResolvedTools> {
  if (!resolvedToolsPromise) {
    resolvedToolsPromise = (async () => {
      const powershell = process.env.POWERSHELL_PATH?.trim() || "powershell.exe"

      return {
        powershell,
      }
    })()
  }

  return resolvedToolsPromise
}

async function resolvePdftoppm() {
  if (!pdftoppmPromise) {
    pdftoppmPromise = resolveRequiredBinary("pdftoppm", [
      process.env.PDFTOPPM_PATH ?? "",
      "D:\\MikTeX\\miktex\\bin\\x64\\pdftoppm.exe",
    ].filter(Boolean))
  }
  return pdftoppmPromise
}

async function resolvePdftotext() {
  if (!pdftotextPromise) {
    pdftotextPromise = resolveRequiredBinary("pdftotext", [
      process.env.PDFTOTEXT_PATH ?? "",
      "D:\\MikTeX\\miktex\\bin\\x64\\pdftotext.exe",
    ].filter(Boolean))
  }
  return pdftotextPromise
}

async function resolveDocx2pdf() {
  if (!docx2pdfPromise) {
    docx2pdfPromise = resolveRequiredBinary("docx2pdf", [
      process.env.DOCX2PDF_PATH ?? "",
    ].filter(Boolean))
  }
  return docx2pdfPromise
}

function execFileStrict(command: string, args: string[], cwd?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr || stdout}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function inferPreviewMimeType(filepath: string) {
  const ext = path.extname(filepath).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".webp") return "image/webp"
  throw new Error(`Unsupported preview file type: ${filepath}`)
}

function sanitizeFileComponent(value: string) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_")
}

function sourceSlug(fileName: string) {
  const baseName = sanitizeFileComponent(path.parse(fileName).name)
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
  return baseName || "source"
}

function shortDocumentID(documentID: string) {
  return documentID.replace(/^document_/, "").slice(0, 12) || documentID.slice(0, 12)
}

function comparePagePath(a: string, b: string) {
  const aMatch = /-(\d+)\.[^.]+$/.exec(path.basename(a))
  const bMatch = /-(\d+)\.[^.]+$/.exec(path.basename(b))
  return Number(aMatch?.[1] ?? 0) - Number(bMatch?.[1] ?? 0)
}

async function sha256OfFile(filepath: string) {
  const content = await readFile(filepath)
  return createHash("sha256").update(content).digest("hex")
}

async function listPreviewPages(previewDirectory: string) {
  const entries = await readdir(previewDirectory)
  return entries
    .filter((entry) => /-\d+\.(png|jpg|jpeg|webp)$/i.test(entry))
    .map((entry) => path.join(previewDirectory, entry))
    .sort(comparePagePath)
}

async function renderPdfPreviewPages(inputPdfPath: string, previewDirectory: string) {
  const pdftoppm = await resolvePdftoppm()
  const outputPrefix = path.join(previewDirectory, "page")
  await execFileStrict(pdftoppm, ["-r", "144", "-png", inputPdfPath, outputPrefix])
  const previewPaths = await listPreviewPages(previewDirectory)
  if (previewPaths.length === 0) {
    throw new Error(`No preview pages rendered for PDF: ${inputPdfPath}`)
  }
  return previewPaths
}

async function extractPdfTextPages(inputPdfPath: string, pageCount: number, textDirectory: string) {
  const pdftotext = await resolvePdftotext()
  const pages: DocumentTextPage[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const outputPath = path.join(textDirectory, `page-${pageNumber}.txt`)
    await execFileStrict(pdftotext, [
      "-enc",
      "UTF-8",
      "-layout",
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      inputPdfPath,
      outputPath,
    ])
    const text = (await readFile(outputPath, "utf8")).replace(/\u0000/g, "").trim()
    pages.push({
      pageNumber,
      text,
    })
  }

  return pages
}

async function convertWordToPdf(inputWordPath: string, outputPdfPath: string) {
  const docx2pdf = await resolveDocx2pdf()
  await execFileStrict(docx2pdf, [inputWordPath, outputPdfPath], backendRoot)
  if (!(await pathExists(outputPdfPath))) {
    throw new Error(`Word conversion did not produce PDF output: ${outputPdfPath}`)
  }
}

async function collectPreviewMetadata(previewPaths: string[]): Promise<DocumentPreviewPage[]> {
  const pages: DocumentPreviewPage[] = []
  for (let index = 0; index < previewPaths.length; index += 1) {
    const absolutePath = previewPaths[index]
    const fileStat = await stat(absolutePath)
    pages.push({
      pageNumber: index + 1,
      absolutePath,
      mimeType: inferPreviewMimeType(absolutePath),
      sizeBytes: fileStat.size,
    })
  }
  return pages
}

function sourceDirectoryName(documentID: string, fileName: string) {
  return `${sourceSlug(fileName)}--${shortDocumentID(documentID)}`
}

function sourcePackageOutputPath(workroom: WorkroomRecord, documentID: string, fileName: string) {
  return path.join(workroom.rootDirectory, "sources", `${sourceDirectoryName(documentID, fileName)}.source-package.json`)
}

function rawSourceDirectory(workroom: WorkroomRecord, documentID: string, fileName: string) {
  return path.join(workroom.rootDirectory, "raw-sources", sourceDirectoryName(documentID, fileName))
}

function sourceMarkdownPath(workroom: WorkroomRecord, documentID: string, fileName: string) {
  return path.join(rawSourceDirectory(workroom, documentID, fileName), `${sourceSlug(fileName)}.md`)
}

function sourceAssetsDirectory(workroom: WorkroomRecord, documentID: string, fileName: string) {
  return path.join(rawSourceDirectory(workroom, documentID, fileName), "assets")
}

function relativeFromWorkroom(workroom: WorkroomRecord, absolutePath: string) {
  return path.relative(workroom.rootDirectory, absolutePath).replace(/\\/g, "/")
}

function relativeFromMarkdown(markdownPath: string, absolutePath: string) {
  return path.relative(path.dirname(markdownPath), absolutePath).replace(/\\/g, "/")
}

function asFloat(value: unknown) {
  if (value === null || value === undefined) return null
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : null
}

function normalizeBBox(rawBBox: unknown, width: number | null, height: number | null) {
  if (!Array.isArray(rawBBox) || rawBBox.length < 4) {
    return { bboxAbs: null, bboxNorm: null }
  }

  const [x1Raw, y1Raw, x2Raw, y2Raw] = rawBBox.slice(0, 4).map((value) => Number(value))
  if (![x1Raw, y1Raw, x2Raw, y2Raw].every((value) => Number.isFinite(value))) {
    return { bboxAbs: null, bboxNorm: null }
  }

  if (width && height && Math.max(Math.abs(x1Raw), Math.abs(x2Raw), Math.abs(y1Raw), Math.abs(y2Raw)) <= 1) {
    return {
      bboxAbs: {
        x1: Math.round(x1Raw * width),
        y1: Math.round(y1Raw * height),
        x2: Math.round(x2Raw * width),
        y2: Math.round(y2Raw * height),
      },
      bboxNorm: {
        x1: x1Raw,
        y1: y1Raw,
        x2: x2Raw,
        y2: y2Raw,
      },
    }
  }

  const bboxAbs = {
    x1: Math.round(x1Raw),
    y1: Math.round(y1Raw),
    x2: Math.round(x2Raw),
    y2: Math.round(y2Raw),
  }

  return {
    bboxAbs,
    bboxNorm:
      width && height
        ? {
            x1: bboxAbs.x1 / width,
            y1: bboxAbs.y1 / height,
            x2: bboxAbs.x2 / width,
            y2: bboxAbs.y2 / height,
          }
        : null,
  }
}

function stripHtmlTags(text: string) {
  return text.replace(/<[^>]+>/g, "")
}

function htmlTableToMarkdown(html: string) {
  try {
    const tableMatch = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(html)
    if (!tableMatch) return html.trim()
    const rows = Array.from(tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi))
    const matrix = rows
      .map((row) =>
        Array.from(row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((cell) => stripHtmlTags(cell[1]).trim()),
      )
      .filter((row) => row.length > 0)
    if (matrix.length === 0) return html.trim()
    const columnCount = Math.max(...matrix.map((row) => row.length))
    const pad = (row: string[]) => row.concat(Array.from({ length: columnCount - row.length }, () => ""))
    const header = pad(matrix[0])
    const body = matrix.slice(1).map(pad)
    return [
      `| ${header.join(" | ")} |`,
      `| ${Array.from({ length: header.length }, () => "---").join(" | ")} |`,
      ...body.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n")
  } catch {
    return html.trim()
  }
}

function cleanupBlockContent(input: string, blockLabel: string) {
  let content = input.trim()
  if (!content) return ""
  if (blockLabel === "table" && /<table/i.test(content)) {
    content = htmlTableToMarkdown(content)
  }
  content = content.replace(/<div[^>]*>/gi, "").replace(/<\/div>/gi, "")
  content = content.replace(/<span[^>]*>/gi, "").replace(/<\/span>/gi, "")
  return content.trim()
}

async function callGlmLayout(input: { userID: string; imagePath: string }): Promise<GlmLayoutPayload> {
  const { payload } = await OcrProviderClient.recognizeDocumentLayout(input)
  if (payload.code !== undefined && ![0, 200].includes(payload.code)) {
    throw new Error(`OCR layout parsing failed for ${input.imagePath}`)
  }
  if (!payload.layout_details || payload.layout_details.length === 0) {
    throw new Error(`OCR layout returned no layout_details for ${input.imagePath}`)
  }
  return payload
}

async function cropImageBlock(input: {
  sourceImagePath: string
  destinationPath: string
  bboxAbs: { x1: number; y1: number; x2: number; y2: number }
}) {
  const tools = await resolveTools()
  await mkdir(path.dirname(input.destinationPath), { recursive: true })

  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$src = '${input.sourceImagePath.replace(/'/g, "''")}'`,
    `$dst = '${input.destinationPath.replace(/'/g, "''")}'`,
    `$x1 = ${Math.max(0, input.bboxAbs.x1)}`,
    `$y1 = ${Math.max(0, input.bboxAbs.y1)}`,
    `$x2 = ${Math.max(0, input.bboxAbs.x2)}`,
    `$y2 = ${Math.max(0, input.bboxAbs.y2)}`,
    "$img = [System.Drawing.Image]::FromFile($src)",
    "try {",
    "  $w = [Math]::Max(1, $x2 - $x1)",
    "  $h = [Math]::Max(1, $y2 - $y1)",
    "  $bmp = New-Object System.Drawing.Bitmap($w, $h)",
    "  try {",
    "    $g = [System.Drawing.Graphics]::FromImage($bmp)",
    "    try {",
    "      $srcRect = New-Object System.Drawing.Rectangle($x1, $y1, $w, $h)",
    "      $dstRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)",
    "      $g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)",
    "      $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)",
    "    } finally {",
    "      $g.Dispose()",
    "    }",
    "  } finally {",
    "    $bmp.Dispose()",
    "  }",
    "} finally {",
    "  $img.Dispose()",
    "}",
  ].join("; ")

  await execFileStrict(tools.powershell, ["-NoProfile", "-NonInteractive", "-Command", script])
}

async function buildLayoutPages(input: {
  userID: string
  workroom: WorkroomRecord
  documentID: string
  fileName: string
  previewPages: DocumentPreviewPage[]
  markdownPath: string
}) {
  const assetDirectory = sourceAssetsDirectory(input.workroom, input.documentID, input.fileName)
  await mkdir(assetDirectory, { recursive: true })

  const pages: DocumentLayoutPage[] = []

  for (const previewPage of input.previewPages) {
    const payload = await callGlmLayout({
      userID: input.userID,
      imagePath: previewPage.absolutePath,
    })
    const pageBlocks = (payload.layout_details?.[0] ?? []) as Array<Record<string, unknown>>
    const pageMeta = payload.data_info?.pages?.[0] ?? {}
    const width = asFloat(pageMeta.width)
    const height = asFloat(pageMeta.height)

    const normalizedBlocks: DocumentLayoutBlock[] = []

    for (let blockIndex = 0; blockIndex < pageBlocks.length; blockIndex += 1) {
      const rawBlock = pageBlocks[blockIndex]
      const blockLabel = String(rawBlock.label ?? "text").trim().toLowerCase()
      const content = cleanupBlockContent(String(rawBlock.content ?? ""), blockLabel)
      const { bboxAbs, bboxNorm } = normalizeBBox(rawBlock.bbox_2d, width, height)

      const block: DocumentLayoutBlock = {
        layoutUnitKey: `page:${previewPage.pageNumber}/block:${blockIndex}`,
        pageNumber: previewPage.pageNumber,
        blockIndex,
        blockLabel,
        content,
        bboxAbs,
        bboxNorm,
        rawMarkdownRange: null,
      }

      if (figureLabels.has(blockLabel) && bboxAbs) {
        const cropAbsolutePath = path.join(assetDirectory, `page-${previewPage.pageNumber}-block-${String(blockIndex).padStart(4, "0")}.png`)
        await cropImageBlock({
          sourceImagePath: previewPage.absolutePath,
          destinationPath: cropAbsolutePath,
          bboxAbs,
        })
        block.cropAssetAbsolutePath = cropAbsolutePath
        block.cropAssetRelativePath = relativeFromMarkdown(input.markdownPath, cropAbsolutePath)
      }

      normalizedBlocks.push(block)
    }

    pages.push({
      pageNumber: previewPage.pageNumber,
      width,
      height,
      markdown: "",
      blocks: normalizedBlocks,
    })
  }

  return pages
}

function lineNumberAtOffset(content: string, offset: number) {
  return content.slice(0, offset).split("\n").length
}

function renderBlockMarkdown(block: DocumentLayoutBlock) {
  const segments: string[] = []
  if (block.content) segments.push(block.content)
  if (block.cropAssetRelativePath) {
    segments.push(`![page-${block.pageNumber}-block-${block.blockIndex}](${block.cropAssetRelativePath})`)
  }
  return segments.join("\n\n").trim()
}

function renderRawMarkdown(input: {
  fileName: string
  layoutPages: DocumentLayoutPage[]
}) {
  let content = `# ${input.fileName}`

  for (const page of input.layoutPages) {
    content += `\n\n## Page ${page.pageNumber}`
    const pageFragments: string[] = []

    for (const block of page.blocks) {
      const fragment = renderBlockMarkdown(block)
      if (!fragment) continue

      pageFragments.push(fragment)
      const startOffset = content.length + 2
      content += `\n\n${fragment}`
      const endOffset = content.length
      block.rawMarkdownRange = {
        startOffset,
        endOffset,
        startLine: lineNumberAtOffset(content, startOffset),
        endLine: lineNumberAtOffset(content, endOffset),
        excerpt: fragment,
      }
    }

    page.markdown = pageFragments.join("\n\n").trim()
    if (!page.markdown) {
      throw new Error(`Raw markdown is empty for page ${page.pageNumber}`)
    }
  }

  if (!content) {
    throw new Error(`Raw markdown is empty for ${input.fileName}`)
  }
  return content
}

export const DocumentPipelineService = {
  async ingest(input: DocumentPipelineInput): Promise<DocumentPipelineResult> {
    const documentRoot = path.join(localDataRoot, "documents", input.documentID)
    const previewDirectory = path.join(documentRoot, "previews")
    const textDirectory = path.join(documentRoot, "text")
    const derivedDirectory = path.join(documentRoot, "derived")
    const markdownPath = sourceMarkdownPath(input.workroom, input.documentID, input.fileName)

    await mkdir(previewDirectory, { recursive: true })
    await mkdir(textDirectory, { recursive: true })
    await mkdir(derivedDirectory, { recursive: true })
    await mkdir(path.dirname(sourcePackageOutputPath(input.workroom, input.documentID, input.fileName)), { recursive: true })
    await mkdir(path.dirname(markdownPath), { recursive: true })

    const originalStat = await stat(input.inputPath)
    const originalSha256 = await sha256OfFile(input.inputPath)

    let previewPaths: string[] = []
    let textPages: DocumentTextPage[] = []

    if (input.sourceType === "pdf") {
      previewPaths = await renderPdfPreviewPages(input.inputPath, previewDirectory)
      textPages = await extractPdfTextPages(input.inputPath, previewPaths.length, textDirectory)
    }

    if (input.sourceType === "word") {
      const outputPdfPath = path.join(derivedDirectory, `${sanitizeFileComponent(path.parse(input.fileName).name)}.pdf`)
      await convertWordToPdf(input.inputPath, outputPdfPath)
      previewPaths = await renderPdfPreviewPages(outputPdfPath, previewDirectory)
      textPages = await extractPdfTextPages(outputPdfPath, previewPaths.length, textDirectory)
    }

    if (input.sourceType === "image") {
      const ext = path.extname(input.inputPath).toLowerCase() || ".png"
      const imagePreviewPath = path.join(previewDirectory, `page-1${ext}`)
      await copyFile(input.inputPath, imagePreviewPath)
      previewPaths = [imagePreviewPath]
      textPages = []
    }

    const previewPages = await collectPreviewMetadata(previewPaths)
    await input.onStage?.("preview_ready", {
      previewPages,
      extractedTextPages: textPages.map((page) => ({
        pageNumber: page.pageNumber,
        text: page.text,
        characterCount: page.text.length,
      })),
      originalSha256,
      originalSizeBytes: originalStat.size,
    })
    const layoutPages = await buildLayoutPages({
      userID: input.workroom.userID,
      workroom: input.workroom,
      documentID: input.documentID,
      fileName: input.fileName,
      previewPages,
      markdownPath,
    })
    await input.onStage?.("layout_ready", {
      previewPages,
      extractedTextPages: textPages.map((page) => ({
        pageNumber: page.pageNumber,
        text: page.text,
        characterCount: page.text.length,
      })),
      layoutPages,
      originalSha256,
      originalSizeBytes: originalStat.size,
    })
    const markdownContent = renderRawMarkdown({
      fileName: input.fileName,
      layoutPages,
    })
    await writeFile(markdownPath, markdownContent, "utf8")
    await input.onStage?.("markdown_ready", {
      previewPages,
      extractedTextPages: textPages.map((page) => ({
        pageNumber: page.pageNumber,
        text: page.text,
        characterCount: page.text.length,
      })),
      layoutPages,
      rawMarkdownPath: markdownPath,
      rawMarkdownRelativePath: relativeFromWorkroom(input.workroom, markdownPath),
      rawMarkdownCharacterCount: markdownContent.length,
      originalSha256,
      originalSizeBytes: originalStat.size,
    })

    const now = new Date().toISOString()
    const sourcePackagePath = sourcePackageOutputPath(input.workroom, input.documentID, input.fileName)

    const sourcePackage: DocumentSourcePackage = {
      id: `${input.documentID}-source-package`,
      documentID: input.documentID,
      userID: input.workroom.userID,
      workroomID: input.workroom.id,
      sourceType: input.sourceType,
      mimeType: input.mimeType,
      originalFile: {
        name: input.fileName,
        absolutePath: input.inputPath,
        sha256: originalSha256,
        sizeBytes: originalStat.size,
      },
      rawMarkdown: {
        absolutePath: markdownPath,
        relativePathFromWorkroom: relativeFromWorkroom(input.workroom, markdownPath),
        characterCount: markdownContent.length,
      },
      previewPages: previewPages.map((page) => ({
        pageNumber: page.pageNumber,
        mimeType: page.mimeType,
        absolutePath: page.absolutePath,
        sizeBytes: page.sizeBytes,
      })),
      textPages: textPages.map((page) => ({
        pageNumber: page.pageNumber,
        text: page.text,
        characterCount: page.text.length,
      })),
      layoutPages,
      workspace: {
        rootDirectory: input.workroom.rootDirectory,
        wikiDirectory: input.workroom.wikiDirectory,
        sourcePackagePath,
      },
      createdAt: now,
      updatedAt: now,
    }

    await writeFile(sourcePackagePath, JSON.stringify(sourcePackage, null, 2), "utf8")

    return {
      previewPages,
      textPages,
      layoutPages,
      rawMarkdownAbsolutePath: markdownPath,
      rawMarkdownRelativePathFromWorkroom: relativeFromWorkroom(input.workroom, markdownPath),
      rawMarkdownContent: markdownContent,
      sourcePackage,
      sourcePackagePath,
      originalSha256,
      originalSizeBytes: originalStat.size,
    }
  },
}
