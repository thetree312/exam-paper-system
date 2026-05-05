import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createID } from "../../lib/ids"
import { WorkroomService } from "../workrooms/service"
import { DocumentsRepository } from "./repository"
import {
  DocumentPipelineService,
  type DocumentLayoutBlock,
  type DocumentLayoutPage,
  type SupportedDocumentSourceType,
  type DocumentSourcePackage,
} from "./pipeline/service"

export type DocumentStatus =
  | "uploaded"
  | "preview_ready"
  | "layout_ready"
  | "markdown_ready"
  | "ready"
  | "failed"

export type DocumentErrorInfo = {
  code: string
  message: string
  retryable: boolean
  stage: Exclude<DocumentStatus, "failed" | "ready">
  details?: Record<string, unknown>
}

export class DocumentDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export type DocumentRecord = {
  id: string
  userID: string
  workroomID: string
  name: string
  mimeType: string
  sourceType: SupportedDocumentSourceType
  status: DocumentStatus
  originalPath: string
  originalSha256: string
  originalSizeBytes: number
  previewPages: Array<{
    pageNumber: number
    absolutePath: string
    mimeType: string
    sizeBytes: number
  }>
  extractedTextPages: Array<{
    pageNumber: number
    text: string
    characterCount: number
  }>
  layoutPages: DocumentLayoutPage[]
  rawMarkdownPath: string
  rawMarkdownRelativePath: string
  rawMarkdownCharacterCount: number
  sourcePackagePath: string
  lastError: DocumentErrorInfo | null
  createdAt: string
  updatedAt: string
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")

const allowedMimeTypes: Record<SupportedDocumentSourceType, string[]> = {
  pdf: ["application/pdf"],
  word: [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  image: ["image/png", "image/jpeg", "image/jpg", "image/webp"],
}

function detectSourceType(fileName: string, mimeType: string): SupportedDocumentSourceType {
  const normalizedMime = mimeType.toLowerCase()
  const ext = path.extname(fileName).toLowerCase()

  if (allowedMimeTypes.pdf.includes(normalizedMime) || ext === ".pdf") return "pdf"
  if (allowedMimeTypes.word.includes(normalizedMime) || ext === ".doc" || ext === ".docx") return "word"
  if (allowedMimeTypes.image.includes(normalizedMime) || [".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    return "image"
  }

  throw new DocumentDomainError(`Unsupported document type: ${fileName} (${mimeType})`, "DOCUMENT_UNSUPPORTED_TYPE", 400)
}

function sanitizeFileName(fileName: string) {
  const parsed = path.parse(fileName)
  const base =
    parsed.name
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_{2,}/g, "_") || "document"
  const ext = parsed.ext || ".bin"
  return `${base}${ext}`
}

function relativeToBackendRoot(absolutePath: string) {
  return path.relative(backendRoot, absolutePath)
}

function requireDocumentPage(record: DocumentRecord, pageNumber: number) {
  const page = record.layoutPages.find((item) => item.pageNumber === pageNumber)
  if (!page) {
    throw new DocumentDomainError(`Layout page not found: ${record.id}#${pageNumber}`, "DOCUMENT_PAGE_NOT_FOUND", 404)
  }
  return page
}

function normalizeSelectionBBox(input: {
  page: DocumentLayoutPage
  bboxAbs?: { x1: number; y1: number; x2: number; y2: number }
  bboxNorm?: { x1: number; y1: number; x2: number; y2: number }
}) {
  if (input.bboxNorm) {
    if (!input.page.width || !input.page.height) {
      throw new DocumentDomainError(
        `Page dimensions are unavailable for page ${input.page.pageNumber}`,
        "DOCUMENT_PAGE_DIMENSIONS_UNAVAILABLE",
        409,
      )
    }
    return {
      bboxAbs: {
        x1: Math.round(input.bboxNorm.x1 * input.page.width),
        y1: Math.round(input.bboxNorm.y1 * input.page.height),
        x2: Math.round(input.bboxNorm.x2 * input.page.width),
        y2: Math.round(input.bboxNorm.y2 * input.page.height),
      },
      bboxNorm: input.bboxNorm,
    }
  }

  if (!input.bboxAbs) {
    throw new DocumentDomainError("Selection bbox is required", "DOCUMENT_SELECTION_BBOX_REQUIRED", 400)
  }

  return {
    bboxAbs: input.bboxAbs,
    bboxNorm:
      input.page.width && input.page.height
        ? {
            x1: input.bboxAbs.x1 / input.page.width,
            y1: input.bboxAbs.y1 / input.page.height,
            x2: input.bboxAbs.x2 / input.page.width,
            y2: input.bboxAbs.y2 / input.page.height,
          }
        : null,
  }
}

function intersectArea(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
) {
  const xOverlap = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const yOverlap = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  return xOverlap * yOverlap
}

function bboxArea(bbox: { x1: number; y1: number; x2: number; y2: number }) {
  return Math.max(0, bbox.x2 - bbox.x1) * Math.max(0, bbox.y2 - bbox.y1)
}

function buildEmptyDocumentRecord(input: {
  documentID: string
  userID: string
  workroomID: string
  fileName: string
  mimeType: string
  sourceType: SupportedDocumentSourceType
  inputPath: string
}) {
  const now = new Date().toISOString()
  return {
    id: input.documentID,
    userID: input.userID,
    workroomID: input.workroomID,
    name: input.fileName,
    mimeType: input.mimeType,
    sourceType: input.sourceType,
    status: "uploaded" as const,
    originalPath: input.inputPath,
    originalSha256: "",
    originalSizeBytes: 0,
    previewPages: [],
    extractedTextPages: [],
    layoutPages: [],
    rawMarkdownPath: "",
    rawMarkdownRelativePath: "",
    rawMarkdownCharacterCount: 0,
    sourcePackagePath: "",
    lastError: null,
    createdAt: now,
    updatedAt: now,
  } satisfies DocumentRecord
}

async function updateDocumentRecord(
  documentID: string,
  mutate: (record: DocumentRecord) => void,
) {
  let found = false
  await DocumentsRepository.update((state) => {
    const record = state.items.find((item) => item.id === documentID)
    if (!record) {
      throw new DocumentDomainError(`Document not found: ${documentID}`, "DOCUMENT_NOT_FOUND", 404)
    }
    mutate(record)
    record.updatedAt = new Date().toISOString()
    found = true
  })
  if (!found) throw new DocumentDomainError(`Document not found: ${documentID}`, "DOCUMENT_NOT_FOUND", 404)
}

function requireDocumentRecord(
  record: DocumentRecord | undefined,
  documentID: string,
) {
  if (!record) throw new DocumentDomainError(`Document not found: ${documentID}`, "DOCUMENT_NOT_FOUND", 404)
  return record
}

export const DocumentsService = {
  async listByWorkroom(input: { userID: string; workroomID: string }) {
    const state = await DocumentsRepository.read()
    return state.items.filter((item) => item.userID === input.userID && item.workroomID === input.workroomID)
  },

  async getByWorkroom(input: { userID: string; workroomID: string; documentID: string }) {
    const state = await DocumentsRepository.read()
    return state.items.find(
      (item) =>
        item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.documentID,
    )
  },

  async getByID(input: { userID: string; documentID: string }) {
    const state = await DocumentsRepository.read()
    return state.items.find((item) => item.userID === input.userID && item.id === input.documentID)
  },

  async readSourcePackage(input: {
    userID: string
    workroomID: string
    documentID: string
  }): Promise<DocumentSourcePackage> {
    const record = requireDocumentRecord(await this.getByWorkroom(input), input.documentID)
    const content = await readFile(record.sourcePackagePath, "utf8")
    return JSON.parse(content) as DocumentSourcePackage
  },

  async readMarkdownSource(input: {
    userID: string
    workroomID: string
    documentID: string
  }) {
    const record = requireDocumentRecord(await this.getByWorkroom(input), input.documentID)
    return {
      path: record.rawMarkdownPath,
      relativePath: record.rawMarkdownRelativePath,
      content: await readFile(record.rawMarkdownPath, "utf8"),
    }
  },

  async readPreviewPage(input: { userID: string; workroomID: string; documentID: string; page: number }) {
    const record = requireDocumentRecord(await this.getByWorkroom(input), input.documentID)
    const page = record.previewPages.find((entry) => entry.pageNumber === input.page)
    if (!page) {
      throw new DocumentDomainError(
        `Preview page not found: ${input.documentID}#${input.page}`,
        "DOCUMENT_PREVIEW_PAGE_NOT_FOUND",
        404,
      )
    }
    const content = await readFile(page.absolutePath)
    return {
      mimeType: page.mimeType,
      content,
    }
  },

  async readLayout(input: { userID: string; workroomID: string; documentID: string; pageNumber?: number }) {
    const record = requireDocumentRecord(await this.getByWorkroom(input), input.documentID)
    const pages = input.pageNumber ? [requireDocumentPage(record, input.pageNumber)] : record.layoutPages
    return {
      documentID: record.id,
      rawMarkdownPath: record.rawMarkdownPath,
      rawMarkdownRelativePath: record.rawMarkdownRelativePath,
      pages,
    }
  },

  async listBlocks(input: { userID: string; workroomID: string; documentID: string; pageNumber?: number }) {
    const layout = await this.readLayout(input)
    return {
      documentID: layout.documentID,
      rawMarkdownPath: layout.rawMarkdownPath,
      rawMarkdownRelativePath: layout.rawMarkdownRelativePath,
      items: layout.pages.flatMap((page) =>
        page.blocks.map((block) => ({
          ...block,
          pageWidth: page.width,
          pageHeight: page.height,
        })),
      ),
    }
  },

  async resolveSelection(input: {
    userID: string
    workroomID: string
    documentID: string
    pageNumber: number
    bboxAbs?: { x1: number; y1: number; x2: number; y2: number }
    bboxNorm?: { x1: number; y1: number; x2: number; y2: number }
  }) {
    const record = requireDocumentRecord(await this.getByWorkroom(input), input.documentID)
    const page = requireDocumentPage(record, input.pageNumber)
    const selection = normalizeSelectionBBox({
      page,
      bboxAbs: input.bboxAbs,
      bboxNorm: input.bboxNorm,
    })

    const selectionArea = bboxArea(selection.bboxAbs)
    if (selectionArea <= 0) {
      throw new DocumentDomainError("Selection bbox must have positive area", "DOCUMENT_SELECTION_INVALID", 400)
    }
    const matches = page.blocks
      .filter((block) => block.bboxAbs)
      .map((block) => {
        const overlapArea = intersectArea(selection.bboxAbs, block.bboxAbs!)
        const blockArea = bboxArea(block.bboxAbs!)
        if (overlapArea <= 0 || blockArea <= 0 || selectionArea <= 0) return null
        return {
          ...block,
          overlapArea,
          overlapRatioOfSelection: overlapArea / selectionArea,
          overlapRatioOfBlock: overlapArea / blockArea,
          pageWidth: page.width,
          pageHeight: page.height,
        }
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => b.overlapArea - a.overlapArea || a.blockIndex - b.blockIndex)

    return {
      documentID: record.id,
      pageNumber: page.pageNumber,
      rawMarkdownPath: record.rawMarkdownPath,
      rawMarkdownRelativePath: record.rawMarkdownRelativePath,
      selection,
      matches,
    }
  },

  async upload(input: {
    userID: string
    workroomID: string
    fileName: string
    mimeType: string
    content: Buffer
  }) {
    const workroom = await WorkroomService.getByUser(input.userID, input.workroomID)
    if (!workroom) {
      throw new DocumentDomainError(`Workroom not found: ${input.workroomID}`, "WORKROOM_NOT_FOUND", 404)
    }

    const documentID = createID("document")
    const documentDirectory = path.join(backendRoot, "local-data", "documents", documentID)
    const inputDirectory = path.join(documentDirectory, "input")
    await mkdir(inputDirectory, { recursive: true })

    const normalizedFileName = sanitizeFileName(input.fileName)
    const inputPath = path.join(inputDirectory, normalizedFileName)
    await writeFile(inputPath, input.content)

    const sourceType = detectSourceType(normalizedFileName, input.mimeType)

    await DocumentsRepository.update((state) => {
      state.items.push(
        buildEmptyDocumentRecord({
          documentID,
          userID: input.userID,
          workroomID: input.workroomID,
          fileName: normalizedFileName,
          mimeType: input.mimeType,
          sourceType,
          inputPath,
        }),
      )
    })

    try {
      const pipeline = await DocumentPipelineService.ingest({
        documentID,
        fileName: normalizedFileName,
        mimeType: input.mimeType,
        sourceType,
        inputPath,
        workroom,
        onStage: async (stage, payload) => {
          await updateDocumentRecord(documentID, (record) => {
            record.status = stage
            record.lastError = null
            if (payload.previewPages) record.previewPages = payload.previewPages
            if (payload.extractedTextPages) record.extractedTextPages = payload.extractedTextPages
            if (payload.layoutPages) record.layoutPages = payload.layoutPages
            if (payload.rawMarkdownPath) record.rawMarkdownPath = payload.rawMarkdownPath
            if (payload.rawMarkdownRelativePath) record.rawMarkdownRelativePath = payload.rawMarkdownRelativePath
            if (payload.rawMarkdownCharacterCount !== undefined) {
              record.rawMarkdownCharacterCount = payload.rawMarkdownCharacterCount
            }
            if (payload.sourcePackagePath) record.sourcePackagePath = payload.sourcePackagePath
            if (payload.originalSha256) record.originalSha256 = payload.originalSha256
            if (payload.originalSizeBytes !== undefined) record.originalSizeBytes = payload.originalSizeBytes
          })
        },
      })

      await updateDocumentRecord(documentID, (record) => {
        record.status = "ready"
        record.lastError = null
        record.originalSha256 = pipeline.originalSha256
        record.originalSizeBytes = pipeline.originalSizeBytes
        record.previewPages = pipeline.previewPages
        record.extractedTextPages = pipeline.textPages.map((page) => ({
          pageNumber: page.pageNumber,
          text: page.text,
          characterCount: page.text.length,
        }))
        record.layoutPages = pipeline.layoutPages
        record.rawMarkdownPath = pipeline.rawMarkdownAbsolutePath
        record.rawMarkdownRelativePath = pipeline.rawMarkdownRelativePathFromWorkroom
        record.rawMarkdownCharacterCount = pipeline.rawMarkdownContent.length
        record.sourcePackagePath = pipeline.sourcePackagePath
      })

      await WorkroomService.bindSourceDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        documentID,
        sourcePackagePath: pipeline.sourcePackagePath,
        rawMarkdownPath: pipeline.rawMarkdownAbsolutePath,
      })
      await WorkroomService.rememberOpenDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        documentID,
      })

      const record = requireDocumentRecord(
        await this.getByWorkroom({
          userID: input.userID,
          workroomID: input.workroomID,
          documentID,
        }),
        documentID,
      )

      return {
        ...record,
        sourcePackage: pipeline.sourcePackage,
        backendRelativeOriginalPath: relativeToBackendRoot(record.originalPath),
        backendRelativeSourcePackagePath: relativeToBackendRoot(record.sourcePackagePath),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Document processing failed"
      const knownError =
        error instanceof DocumentDomainError
          ? error
          : new DocumentDomainError(message, "DOCUMENT_PROCESSING_FAILED", 500, true)

      await updateDocumentRecord(documentID, (record) => {
        record.status = "failed"
        record.lastError = {
          code: knownError.code,
          message: knownError.message,
          retryable: knownError.retryable,
          stage: record.status === "failed" || record.status === "ready" ? "uploaded" : record.status,
          details: knownError.details,
        }
      })

      throw new DocumentDomainError(knownError.message, knownError.code, knownError.statusCode, knownError.retryable, {
        ...(knownError.details ?? {}),
        documentID,
      })
    }
  },
}
