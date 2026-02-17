import type {
  FlashcardItem,
  FlashcardGenerateResult,
  FlashcardReviewResult,
  FlashcardMasteryStats,
  FlashcardAgentEscalateResult,
} from '../types'

// ── Server DTO → Client 映射 ────────────────────────

interface ServerFlashcardCard {
  card_id: number
  tenant_id: number
  document_id: number
  question_id: number | null
  chunk_id: string | null
  concept_tag: string
  cue: string
  answer: string
  confidence: number | null
  source_ref: Record<string, unknown> | null
  legend_images: string[] | null
  mastery_state: string
  bucket: number | null
  next_review_at: string | null
  last_score: number | null
  review_count: number
}

interface ServerListResponse {
  items: ServerFlashcardCard[]
}

interface ServerGenerateResponse {
  job_id: number
  status: string
  mode: string
  card_count: number
}

interface ServerReviewResponse {
  review_id: number
  card_id: number
  score: number
  bucket: number | null
  interval_days: number
  next_review_at: string | null
}

interface ServerStatsResponse {
  total: number
  never_reviewed: number
  mastered: number
  reviewing: number
  struggling: number
  due_today: number
}

interface ServerEscalateResponse {
  escalated: boolean
  card_id: number
  concept_tag: string
  message: string
}

function normalizeCard(s: ServerFlashcardCard): FlashcardItem {
  return {
    cardId: s.card_id,
    tenantId: s.tenant_id,
    documentId: s.document_id,
    questionId: s.question_id,
    chunkId: s.chunk_id,
    conceptTag: s.concept_tag,
    cue: s.cue,
    answer: s.answer,
    confidence: s.confidence,
    sourceRef: s.source_ref,
    legendImages: s.legend_images,
    masteryState: (s.mastery_state as FlashcardItem['masteryState']) || 'new',
    bucket: s.bucket,
    nextReviewAt: s.next_review_at,
    lastScore: s.last_score,
    reviewCount: s.review_count,
  }
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return
    search.set(key, String(value))
  })
  const query = search.toString()
  return query ? `?${query}` : ''
}

// ── API 方法 ─────────────────────────────────────────

export async function generateFlashcards(
  backendBaseUrl: string,
  tenantId: number,
  userId: number,
  documentId: number,
  maxCards = 40,
  force = false,
): Promise<FlashcardGenerateResult> {
  const query = buildQuery({ tenant_id: tenantId, user_id: userId })
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/generate${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document_id: documentId, max_cards: maxCards, force }),
  })
  if (!resp.ok) throw new Error(await resp.text())
  const data = (await resp.json()) as ServerGenerateResponse
  return {
    jobId: data.job_id,
    status: data.status,
    mode: data.mode,
    cardCount: data.card_count,
  }
}

export async function listFlashcards(
  backendBaseUrl: string,
  tenantId: number,
  userId: number,
  documentId: number,
  conceptTag?: string,
): Promise<FlashcardItem[]> {
  const query = buildQuery({ tenant_id: tenantId, user_id: userId, concept_tag: conceptTag })
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/list/${documentId}${query}`)
  if (!resp.ok) throw new Error(await resp.text())
  const data = (await resp.json()) as ServerListResponse
  return data.items.map(normalizeCard)
}

export async function getDueFlashcards(
  backendBaseUrl: string,
  tenantId: number,
  userId: number,
  documentId?: number,
  limit = 50,
): Promise<FlashcardItem[]> {
  const query = buildQuery({ tenant_id: tenantId, user_id: userId, document_id: documentId, limit })
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/due${query}`)
  if (!resp.ok) throw new Error(await resp.text())
  const data = (await resp.json()) as ServerListResponse
  return data.items.map(normalizeCard)
}

export async function submitReview(
  backendBaseUrl: string,
  tenantId: number,
  userId: number,
  cardId: number,
  score: number,
  memo?: string,
): Promise<FlashcardReviewResult> {
  const query = buildQuery({ tenant_id: tenantId, user_id: userId })
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/review${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_id: cardId, score, memo }),
  })
  if (!resp.ok) throw new Error(await resp.text())
  const data = (await resp.json()) as ServerReviewResponse
  return {
    reviewId: data.review_id,
    cardId: data.card_id,
    score: data.score,
    bucket: data.bucket,
    intervalDays: data.interval_days,
    nextReviewAt: data.next_review_at,
  }
}

export async function getMasteryStats(
  backendBaseUrl: string,
  tenantId: number,
  userId: number,
  documentId: number,
): Promise<FlashcardMasteryStats> {
  const query = buildQuery({ tenant_id: tenantId, user_id: userId })
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/stats/${documentId}${query}`)
  if (!resp.ok) throw new Error(await resp.text())
  const data = (await resp.json()) as ServerStatsResponse
  return {
    total: data.total,
    neverReviewed: data.never_reviewed,
    mastered: data.mastered,
    reviewing: data.reviewing,
    struggling: data.struggling,
    dueToday: data.due_today,
  }
}

export async function agentEscalate(
  backendBaseUrl: string,
  tenantId: number,
  userId: number,
  cardId: number,
  userNote?: string,
): Promise<FlashcardAgentEscalateResult> {
  const query = buildQuery({ tenant_id: tenantId, user_id: userId })
  const resp = await fetch(`${backendBaseUrl}/api/flashcards/agent-escalate${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_id: cardId, user_note: userNote }),
  })
  if (!resp.ok) throw new Error(await resp.text())
  const data = (await resp.json()) as ServerEscalateResponse
  return {
    escalated: data.escalated,
    cardId: data.card_id,
    conceptTag: data.concept_tag,
    message: data.message,
  }
}

export const FlashcardApi = {
  generateFlashcards,
  listFlashcards,
  getDueFlashcards,
  submitReview,
  getMasteryStats,
  agentEscalate,
}
