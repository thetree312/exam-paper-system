import { QuestionsRepository } from "../questions/repository"
import { StudioRepository } from "../studio/repository"
import { DocumentsService } from "../documents/service"
import { WikiService } from "../wiki/service"
import { WorkroomService } from "../workrooms/service"
import type { ArtifactGenerationSource, ArtifactLinkage } from "./types"

export type FlashcardGenerationMaterial = {
  kind: "flashcards"
  title: string
  documentID: string
  pageCount: number
  rawMarkdown: string
  rawMarkdownPath: string
  linkage: ArtifactLinkage
  questions: Array<{
    id: string
    sequenceIndex: number
    content: string
    canonicalAnswer?: string | null
    gradingPredictedAnswer?: string | null
    explanation?: string | null
    page?: number | null
    legendImages: string[]
  }>
}

export type MindmapGenerationMaterial = {
  kind: "mindmap"
  title: string
  sourceType: ArtifactGenerationSource["type"]
  sourceKey: string
  body: string
  linkage: ArtifactLinkage
  sourceMeta: {
    documentIDs: string[]
    wikiPaths: string[]
    studioDocumentID?: string | null
  }
}

function uniqueStrings(items: Array<string | null | undefined>) {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))))
}

function sortDocumentIDs(input: string[]) {
  return uniqueStrings(input).sort((left, right) => left.localeCompare(right))
}

async function readDocumentMarkdown(input: { userID: string; workroomID: string; documentID: string }) {
  const markdown = await DocumentsService.readMarkdownSource(input)
  const document = await DocumentsService.getByWorkroom(input)
  if (!document) throw new Error(`Document not found: ${input.documentID}`)
  return {
    document,
    markdown,
  }
}

export const SourceMaterialService = {
  async buildFlashcardMaterial(input: {
    userID: string
    workroomID: string
    documentID: string
  }): Promise<FlashcardGenerationMaterial> {
    const workroom = await WorkroomService.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)

    const { document, markdown } = await readDocumentMarkdown(input)
    const questions = await QuestionsRepository.listBySourceDocument({
      userID: input.userID,
      sourceDocumentID: input.documentID,
    })

    return {
      kind: "flashcards",
      title: document.name,
      documentID: document.id,
      pageCount: document.previewPages.length,
      rawMarkdown: markdown.content,
      rawMarkdownPath: markdown.relativePath,
      linkage: {
        wikiPaths: [],
        documentIDs: [document.id],
        documentBlocks: uniqueStrings(questions.map((item) => item.id)).length
          ? questions
              .filter((item) => item.page !== null && item.page !== undefined)
              .map((item) => ({
                documentID: document.id,
                pageNumber: item.page as number,
              }))
          : [],
        agentSessionIDs: [],
      },
      questions: questions.map((item) => ({
        id: item.id,
        sequenceIndex: item.sequenceIndex,
        content: item.content,
        canonicalAnswer: item.canonicalAnswer,
        gradingPredictedAnswer: item.gradingPredictedAnswer,
        explanation: item.explanation,
        page: item.page,
        legendImages: item.legendImages,
      })),
    }
  },

  async buildMindmapMaterial(input: {
    userID: string
    workroomID: string
    source: ArtifactGenerationSource
  }): Promise<MindmapGenerationMaterial> {
    const workroom = await WorkroomService.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)

    if (input.source.type === "document") {
      const documentIDs = sortDocumentIDs([input.source.documentID, ...(input.source.documentIDs ?? [])])
      const documents = await Promise.all(
        documentIDs.map((documentID) =>
          readDocumentMarkdown({
            userID: input.userID,
            workroomID: input.workroomID,
            documentID,
          }),
        ),
      )

      return {
        kind: "mindmap",
        title: documents.length === 1 ? documents[0].document.name : `${documents[0].document.name} 等${documents.length}份文档`,
        sourceType: "document",
        sourceKey: `document:${documentIDs.join(",")}`,
        body: documents
          .map(
            ({ document, markdown }) =>
              `# 文档 ${document.id}\n标题: ${document.name}\n\n${markdown.content}`.trim(),
          )
          .join("\n\n---\n\n"),
        linkage: {
          wikiPaths: [],
          documentIDs,
          documentBlocks: [],
          agentSessionIDs: [],
        },
        sourceMeta: {
          documentIDs,
          wikiPaths: [],
          studioDocumentID: null,
        },
      }
    }

    if (input.source.type === "wiki_file") {
      const wikiPaths = uniqueStrings([input.source.wikiPath, ...(input.source.wikiPaths ?? [])]).sort((left, right) =>
        left.localeCompare(right),
      )
      const files = await Promise.all(
        wikiPaths.map((wikiPath) =>
          WikiService.readFile({
            userID: input.userID,
            workroomID: input.workroomID,
            wikiPath,
          }),
        ),
      )

      return {
        kind: "mindmap",
        title: files.length === 1 ? files[0].path : `${files[0].path} 等${files.length}个 Wiki 文件`,
        sourceType: "wiki_file",
        sourceKey: `wiki:${wikiPaths.join(",")}`,
        body: files.map((file) => `# Wiki 文件 ${file.path}\n\n${file.content}`.trim()).join("\n\n---\n\n"),
        linkage: {
          wikiPaths,
          documentIDs: [],
          documentBlocks: [],
          agentSessionIDs: [],
        },
        sourceMeta: {
          documentIDs: [],
          wikiPaths,
          studioDocumentID: null,
        },
      }
    }

    const source = input.source
    if (source.type !== "studio_document") {
      throw new Error(`Unsupported mindmap source type: ${source.type}`)
    }

    const studioDocument = (await StudioRepository.readDocuments()).items.find(
      (item) =>
        item.userID === input.userID &&
        item.workroomID === input.workroomID &&
        item.id === source.studioDocumentID,
    )
    if (!studioDocument) {
      throw new Error(`Studio document not found: ${source.studioDocumentID}`)
    }

    const questionCards = (await StudioRepository.readQuestionCards()).items
      .filter(
        (item) =>
          item.userID === input.userID &&
          item.workroomID === input.workroomID &&
          item.studioDocumentID === source.studioDocumentID,
      )
      .sort((left, right) => left.sequenceIndex - right.sequenceIndex)

    if (questionCards.length === 0) {
      throw new Error(`Studio document has no question cards: ${source.studioDocumentID}`)
    }

    return {
      kind: "mindmap",
      title: studioDocument.title,
      sourceType: "studio_document",
      sourceKey: `studio:${studioDocument.id}`,
      body: questionCards
        .map(
          (item) =>
            `## 题卡 ${item.sequenceIndex + 1}\n页码: ${item.page}\n题目:\n${item.text}\n\n答案:\n${item.canonicalAnswer || "（暂无答案）"}`,
        )
        .join("\n\n"),
      linkage: {
        wikiPaths: [],
        documentIDs: studioDocument.sourceDocumentID ? [studioDocument.sourceDocumentID] : [],
        documentBlocks: questionCards.map((item) => ({
          documentID: item.sourceDocumentID ?? "",
          pageNumber: item.page,
        })).filter((item) => item.documentID),
        agentSessionIDs: [],
      },
      sourceMeta: {
        documentIDs: studioDocument.sourceDocumentID ? [studioDocument.sourceDocumentID] : [],
        wikiPaths: [],
        studioDocumentID: studioDocument.id,
      },
    }
  },
}
