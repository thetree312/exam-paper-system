import type { FlashcardItem } from '../types'

interface FlashcardListResponseDto {
  items: ServerFlashcardItem[]
}

interface ServerFlashcardItem {
  question_id: number | null
  document_id: number
  sequence_index: number
  page?: number | null
  front_markdown: string
  back_markdown?: string | null
  legend_images?: string[] | null
  answer_status?: string | null
  answer_source?: string | null
}

interface CompleteAnswersResponseDto {
  updated_question_ids: number[]
}

function normalizeFlashcard(item: ServerFlashcardItem): FlashcardItem {
  return {
    questionId: item.question_id,
    documentId: item.document_id,
    sequenceIndex: item.sequence_index,
    page: item.page ?? null,
    frontMarkdown: item.front_markdown,
    backMarkdown: item.back_markdown ?? null,
    legendImages: item.legend_images ?? [],
    answerStatus: item.answer_status ?? null,
    answerSource: item.answer_source ?? null,
  }
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return
    search.set(key, String(value))
  })
  const query = search.toString()
  return query ? `?${query}` : ''
}

export async function fetchExamFlashcards(
  backendBaseUrl: string,
  tenantId: number,
  documentId: number,
  includeLegend = true,
): Promise<FlashcardItem[]> {
  const query = buildQuery({ tenant_id: tenantId, include_legend: includeLegend })
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/by-document/${documentId}${query}`)
  if (!resp.ok) {
    throw new Error(await resp.text())
  }
  const data = (await resp.json()) as FlashcardListResponseDto
  return data.items.map(normalizeFlashcard)
}

export async function fetchArticleFlashcards(
  backendBaseUrl: string,
  tenantId: number,
  documentId: number,
  maxCards = 20,
): Promise<FlashcardItem[]> {
  const query = buildQuery({ tenant_id: tenantId, max_cards: maxCards })
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/article/${documentId}${query}`)
  if (!resp.ok) {
    throw new Error(await resp.text())
  }
  const data = (await resp.json()) as FlashcardListResponseDto
  return data.items.map(normalizeFlashcard)
}

export async function completeFlashcardAnswers(
  backendBaseUrl: string,
  tenantId: number,
  documentId: number,
  questionIds?: number[],
  maxQuestions = 20,
): Promise<number[]> {
  const query = buildQuery({ tenant_id: tenantId })
  const payload: Record<string, unknown> = {
    document_id: documentId,
    max_questions: maxQuestions,
  }
  if (questionIds && questionIds.length > 0) {
    payload.question_ids = questionIds
  }
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/complete-answers${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    throw new Error(await resp.text())
  }
  const data = (await resp.json()) as CompleteAnswersResponseDto
  return data.updated_question_ids
}

export const FlashcardApi = {
  fetchExamFlashcards,
  fetchArticleFlashcards,
  completeFlashcardAnswers,
}
