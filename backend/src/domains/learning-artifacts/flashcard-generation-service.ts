import { LearningArtifactsLlmService } from "./llm-service"
import { SourceMaterialService } from "./source-material-service"
import {
  buildFlashcardGenerationSystemPrompt,
  buildFlashcardLongOutlineSystemPrompt,
  buildFlashcardLongOutlineUserPrompt,
} from "./prompts"
import type { FlashcardPayload } from "./types"

type FlashcardGenerationResult = {
  generatedCount: number
  items: Array<{
    title: string
    front: string
    back: string
    hint?: string
    conceptTag?: string
    confidence?: number | null
    sourceRef?: FlashcardPayload["sourceRef"]
  }>
}

const LONG_DOC_PAGE_THRESHOLD = 30
const LONG_CHUNK_TARGET_CHARS = 12000

function normalizeString(value: unknown) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter((item): item is string => Boolean(item))
  }
  const single = normalizeString(value)
  return single ? [single] : []
}

function normalizeCards(payload: Record<string, unknown>) {
  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.cards)
      ? payload.cards
      : Array.isArray(payload.flashcards)
        ? payload.flashcards
        : []
  const items: FlashcardGenerationResult["items"] = []
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue
    const record = rawItem as Record<string, unknown>
    const title = normalizeString(record.title ?? record.conceptTag ?? record.concept_tag)
    const front = normalizeString(record.front ?? record.cue ?? record.question ?? record.prompt)
    const answerLines = normalizeStringList(
      record.back ??
        record.answer ??
        record.answer_points ??
        record.keyPoints ??
        record.key_points,
    )
    const back = answerLines.length > 0 ? answerLines.join("\n") : null
    if (!title || !front || !back) continue
    const sourceRefObject =
      record.sourceRef && typeof record.sourceRef === "object"
        ? (record.sourceRef as Record<string, unknown>)
        : record.source_ref && typeof record.source_ref === "object"
          ? (record.source_ref as Record<string, unknown>)
          : null
    items.push({
      title,
      front,
      back,
      hint: normalizeString(record.hint ?? record.note) ?? undefined,
      conceptTag: normalizeString(record.conceptTag ?? record.concept_tag ?? record.title) ?? undefined,
      confidence:
        typeof record.confidence === "number"
          ? record.confidence
          : typeof record.confidence === "string"
            ? Number(record.confidence)
            : null,
      sourceRef: sourceRefObject
        ? {
            sourceType:
              normalizeString(sourceRefObject.sourceType ?? sourceRefObject.source_type) === "question"
                ? "question"
                : "document_markdown",
            questionID: normalizeString(sourceRefObject.questionID ?? sourceRefObject.question_id) ?? undefined,
            sequenceIndex:
              typeof (sourceRefObject.sequenceIndex ?? sourceRefObject.sequence_index ?? sourceRefObject.questionNumber) === "number"
                ? Number(sourceRefObject.sequenceIndex ?? sourceRefObject.sequence_index ?? sourceRefObject.questionNumber)
                : undefined,
            page:
              typeof sourceRefObject.page === "number"
                ? Number(sourceRefObject.page)
                : null,
            documentID:
              normalizeString(sourceRefObject.documentID ?? sourceRefObject.document_id) ?? "",
          }
        : undefined,
    })
  }
  if (items.length === 0) throw new Error("Flashcard generation returned no valid cards")
  return items
}

function chunkText(content: string, targetChars: number) {
  const chunks: string[] = []
  let buffer = ""
  for (const paragraph of content.split(/\n{2,}/)) {
    const normalized = paragraph.trim()
    if (!normalized) continue
    if ((buffer + "\n\n" + normalized).trim().length > targetChars && buffer.trim()) {
      chunks.push(buffer.trim())
      buffer = normalized
      continue
    }
    buffer = [buffer.trim(), normalized].filter(Boolean).join("\n\n")
  }
  if (buffer.trim()) chunks.push(buffer.trim())
  return chunks
}

async function buildLongOutline(input: {
  userID: string
  title: string
  rawMarkdown: string
  maxCards: number
}) {
  const chunks = chunkText(input.rawMarkdown, LONG_CHUNK_TARGET_CHARS)
  const outlineItems: Array<{ chunkID: string; summary: string }> = []
  for (let index = 0; index < chunks.length; index += 1) {
    const payload = await LearningArtifactsLlmService.chatJson({
      userID: input.userID,
      capability: "flashcard_long_outline",
      system: buildFlashcardLongOutlineSystemPrompt(),
      user: buildFlashcardLongOutlineUserPrompt({
        title: input.title,
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        maxCards: input.maxCards,
        chunkContent: chunks[index],
      }),
      temperature: 0.1,
      topP: 0.7,
      maxTokens: 2000,
    })
    const summary = normalizeString(payload.summary)
    if (!summary) throw new Error(`Flashcard long outline chunk ${index + 1} returned empty summary`)
    outlineItems.push({
      chunkID: `chunk-${index + 1}`,
      summary,
    })
  }
  return outlineItems
}

export const FlashcardGenerationService = {
  async generate(input: {
    userID: string
    workroomID: string
    documentID: string
    maxCards: number
  }): Promise<FlashcardGenerationResult> {
    const material = await SourceMaterialService.buildFlashcardMaterial(input)

    const sourceText =
      material.pageCount > LONG_DOC_PAGE_THRESHOLD
        ? (await buildLongOutline({
            userID: input.userID,
            title: material.title,
            rawMarkdown: material.rawMarkdown,
            maxCards: input.maxCards,
          }))
            .map((item) => `## ${item.chunkID}\n${item.summary}`)
            .join("\n\n")
        : material.questions.length > 0
          ? material.questions
              .map((item) =>
                [
                  `【题目 ${item.sequenceIndex + 1}】`,
                  item.content,
                  item.canonicalAnswer ? `【标准答案】${item.canonicalAnswer}` : "",
                  item.gradingPredictedAnswer ? `【AI 参考答案】${item.gradingPredictedAnswer}` : "",
                  item.explanation ? `【解析】${item.explanation}` : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              )
              .join("\n\n")
          : material.rawMarkdown

    const sourceType = material.pageCount > LONG_DOC_PAGE_THRESHOLD ? "long_doc" : "exam"
    const payload = await LearningArtifactsLlmService.chatJson({
      userID: input.userID,
      capability: "flashcard_generation",
      system: buildFlashcardGenerationSystemPrompt({
        maxCards: input.maxCards,
        sourceType,
      }),
      user: [
        `文档标题: ${material.title}`,
        `文档ID: ${material.documentID}`,
        `页数: ${material.pageCount}`,
        `最多生成: ${input.maxCards}`,
        "材料如下：",
        sourceText,
      ].join("\n\n"),
      temperature: 0.2,
      topP: 0.8,
      maxTokens: 4000,
    })

    const items = normalizeCards(payload).slice(0, input.maxCards)
    return {
      generatedCount: items.length,
      items,
    }
  },
}
