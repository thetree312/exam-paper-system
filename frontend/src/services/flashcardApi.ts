import type {
  FlashcardAgentEscalateResult,
  FlashcardGenerateResult,
  FlashcardItem,
  FlashcardMasteryStats,
  FlashcardReviewResult,
} from '../types'
import { apiJson, withJsonBody } from '../lib/api'

type LearningArtifactRecord = {
  id: string
  linkage: {
    documentIDs: string[]
  }
  payload: {
    title: string
    front: string
    back: string
    hint?: string
    masteryState: FlashcardItem['masteryState']
    bucket: number | null
    lastScore: number | null
    nextReviewAt: string | null
    reviewCount: number
    conceptTag?: string
    confidence?: number | null
    sourceRef?: {
      questionID?: string
      sequenceIndex?: number
      page?: number | null
      documentID: string
    }
  }
}

function normalizeCard(item: LearningArtifactRecord): FlashcardItem {
  return {
    cardId: item.id,
    documentId: item.linkage.documentIDs[0] ?? item.payload.sourceRef?.documentID ?? null,
    questionId: item.payload.sourceRef?.questionID ?? null,
    sequenceIndex: item.payload.sourceRef?.sequenceIndex ?? null,
    page: item.payload.sourceRef?.page ?? null,
    conceptTag: item.payload.conceptTag ?? item.payload.title,
    cue: item.payload.front,
    answer: item.payload.back,
    confidence: item.payload.confidence ?? null,
    masteryState: item.payload.masteryState,
    bucket: item.payload.bucket,
    nextReviewAt: item.payload.nextReviewAt,
    lastScore: item.payload.lastScore,
    reviewCount: item.payload.reviewCount,
    sourceRef: item.payload.sourceRef ?? null,
  }
}

export async function generateFlashcards(
  baseUrl: string,
  workroomID: string,
  documentID: string,
  maxCards = 40,
  force = false,
): Promise<FlashcardGenerateResult> {
  const data = await apiJson<{ mode: 'cached' | 'generated'; generatedCount: number }>(
    `${baseUrl}/api/learning-artifacts/flashcards/generate`,
    {
      method: 'POST',
      ...withJsonBody({
        workroomID,
        documentID,
        maxCards,
        force,
      }),
    },
  )

  return {
    mode: data.mode,
    cardCount: data.generatedCount,
  }
}

export async function listFlashcards(
  baseUrl: string,
  workroomID: string,
  documentID: string,
): Promise<FlashcardItem[]> {
  const data = await apiJson<{ items: LearningArtifactRecord[] }>(
    `${baseUrl}/api/learning-artifacts?workroom_id=${encodeURIComponent(workroomID)}&type=flashcard`,
    {
      method: 'GET',
    },
  )
  return (data.items ?? [])
    .filter((item) => item.linkage.documentIDs.includes(documentID))
    .map(normalizeCard)
}

export async function getDueFlashcards(
  baseUrl: string,
  workroomID: string,
  documentID?: string,
  limit = 50,
): Promise<FlashcardItem[]> {
  const search = new URLSearchParams({
    workroom_id: workroomID,
    limit: String(limit),
  })
  if (documentID) {
    search.set('document_id', documentID)
  }
  const data = await apiJson<{ items: LearningArtifactRecord[] }>(
    `${baseUrl}/api/learning-artifacts/flashcards/due?${search.toString()}`,
    {
      method: 'GET',
    },
  )
  return (data.items ?? []).map(normalizeCard)
}

export async function submitReview(
  baseUrl: string,
  workroomID: string,
  artifactID: string,
  score: number,
): Promise<FlashcardReviewResult> {
  const data = await apiJson<LearningArtifactRecord>(
    `${baseUrl}/api/learning-artifacts/${artifactID}/review`,
    {
      method: 'POST',
      ...withJsonBody({
        workroomID,
        score,
      }),
    },
  )
  return {
    artifactID: data.id,
    score,
    bucket: data.payload.bucket,
    nextReviewAt: data.payload.nextReviewAt,
  }
}

export async function getMasteryStats(
  baseUrl: string,
  workroomID: string,
  documentID?: string,
): Promise<FlashcardMasteryStats> {
  const search = new URLSearchParams({
    workroom_id: workroomID,
  })
  if (documentID) {
    search.set('document_id', documentID)
  }
  return apiJson<FlashcardMasteryStats>(
    `${baseUrl}/api/learning-artifacts/flashcards/stats?${search.toString()}`,
    {
      method: 'GET',
    },
  )
}

export async function agentEscalate(
  baseUrl: string,
  workroomID: string,
  artifactID: string,
  userNote?: string,
): Promise<FlashcardAgentEscalateResult> {
  return apiJson<FlashcardAgentEscalateResult>(
    `${baseUrl}/api/learning-artifacts/flashcards/${artifactID}/agent-escalate`,
    {
      method: 'POST',
      ...withJsonBody({
        workroomID,
        userNote,
      }),
    },
  )
}

export const FlashcardApi = {
  generateFlashcards,
  listFlashcards,
  getDueFlashcards,
  submitReview,
  getMasteryStats,
  agentEscalate,
}
