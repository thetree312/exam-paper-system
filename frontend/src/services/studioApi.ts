import { apiFetch, apiJson, withJsonBody } from '../lib/api'
import type { MathContentDocument } from '../lib/mathContent'

export interface StudioDocumentDto {
  id: string
  workroomID: string
  sourceDocumentID?: string | null
  title: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface StudioQuestionCardDto {
  id: string
  studioDocumentID: string
  sourceDocumentID: string
  cardGroupID?: string | null
  projectedQuestionID?: string | null
  sequenceIndex: number
  page: number
  text: string
  originalText: string
  answerContent: MathContentDocument
  answerText: string
  canonicalAnswer: string
  explanation?: string | null
  legendImages: string[]
  derivedFromCardID?: string | null
  relationType?: 'primary' | 'practice_generated' | 'variant' | 'explanation_followup' | null
  originTask?: {
    kind: string
    sessionID?: string | null
    messageID?: string | null
  } | null
  createdAt: string
  updatedAt: string
}

export interface StudioQuestionCardDetailDto {
  card: StudioQuestionCardDto & {
    learningSnapshot: {
      masteryScore: number
      masteryLevel: string
      masteryTrend7d: number
      attemptCount: number
      correctCount: number
      incorrectCount: number
      diagnosisFailedCount: number
      firstAttemptAt: string | null
      lastAttemptAt: string | null
      lastReviewedAt: string | null
      lastJudgement: string | null
      latestDiagnosisSummary: string | null
      weaknessSummary: Array<{
        weaknessKey: string
        label: string
        status: string
        severity: string
        count: number
      }>
      reviewHeatmap180d: Array<{ date: string; intensity: number }>
    }
  }
  attempts: Array<{
    id: string
    answerText: string
    judgement: string
    scorePercent: number
    submittedAt: string
  }>
  diagnoses: Array<{
    id: string
    rootCauseType: string
    conclusion: string
    confidence: number
    improvementAdvice: string
  }>
  weaknesses: Array<{
    id: string
    weaknessKey: string
    label: string
    status: string
    severity: string
    count: number
    lastSeenAt: string
  }>
  reviewHeatmap180d: Array<{ date: string; intensity: number }>
}

export interface StudioQuestionCardsSnapshotDto {
  revision: number
  items: StudioQuestionCardDto[]
}

export async function listStudioDocuments(
  baseUrl: string,
  params: { workroomID: string; sourceDocumentID?: string },
): Promise<StudioDocumentDto[]> {
  const search = new URLSearchParams({
    workroom_id: params.workroomID,
  })
  if (params.sourceDocumentID) {
    search.set('source_document_id', params.sourceDocumentID)
  }
  const response = await apiJson<{ items: StudioDocumentDto[] }>(
    `${baseUrl}/api/studio/documents?${search.toString()}`,
    {
      method: 'GET',
    },
  )
  return response.items ?? []
}

export async function createStudioDocument(
  baseUrl: string,
  payload: { workroomID: string; title?: string | null; sourceDocumentID?: string | null },
): Promise<StudioDocumentDto> {
  return apiJson(`${baseUrl}/api/studio/documents`, {
    method: 'POST',
    ...withJsonBody(payload),
  })
}

export async function listStudioQuestionCards(
  baseUrl: string,
  params: { workroomID: string; studioDocumentID: string },
): Promise<StudioQuestionCardDto[]> {
  const snapshot = await listStudioQuestionCardsWithRevision(baseUrl, params)
  return snapshot.items
}

export async function listStudioQuestionCardsWithRevision(
  baseUrl: string,
  params: { workroomID: string; studioDocumentID: string },
): Promise<StudioQuestionCardsSnapshotDto> {
  const search = new URLSearchParams({
    workroom_id: params.workroomID,
    studio_document_id: params.studioDocumentID,
  })
  const response = await apiJson<{ revision?: number; items: StudioQuestionCardDto[] }>(
    `${baseUrl}/api/studio/question-cards?${search.toString()}`,
    {
      method: 'GET',
    },
  )
  return {
    revision: typeof response.revision === 'number' && Number.isFinite(response.revision) ? response.revision : 0,
    items: response.items ?? [],
  }
}

export async function recognizeStudioSelection(
  baseUrl: string,
  payload: {
    workroomID: string
    sourceDocumentID: string
    studioDocumentID?: string | null
    title?: string | null
    regions: Array<{
      page: number
      x: number
      y: number
      width: number
      height: number
      exclusions?: Array<{
        x: number
        y: number
        width: number
        height: number
      }>
    }>
    legends?: Array<{
      page: number
      x: number
      y: number
      width: number
      height: number
    }>
  },
): Promise<{ studioDocument: StudioDocumentDto; questionCard: StudioQuestionCardDto }> {
  return apiJson(`${baseUrl}/api/studio/question-cards/recognize-selection`, {
    method: 'POST',
    ...withJsonBody(payload),
  })
}

export async function importStudioQuestionCardsFromLayout(
  baseUrl: string,
  payload: {
    workroomID: string
    sourceDocumentID: string
    studioDocumentID?: string | null
    title?: string | null
    replaceExisting?: boolean
  },
): Promise<{
  studioDocument: StudioDocumentDto
  questionCards: StudioQuestionCardDto[]
  importedCount: number
  reusedExisting: boolean
}> {
  return apiJson(`${baseUrl}/api/studio/question-cards/import-from-layout`, {
    method: 'POST',
    ...withJsonBody(payload),
  })
}

export async function updateStudioQuestionCard(
  baseUrl: string,
  params: {
    workroomID: string
    cardID: string
    text?: string
    answerContent?: MathContentDocument
    answerText?: string
    canonicalAnswer?: string | null
    explanation?: string | null
    legendImages?: string[]
    derivedFromCardID?: string | null
    relationType?: StudioQuestionCardDto['relationType']
    originTask?: StudioQuestionCardDto['originTask']
  },
): Promise<StudioQuestionCardDto> {
  const search = new URLSearchParams({
    workroom_id: params.workroomID,
  })
  return apiJson(`${baseUrl}/api/studio/question-cards/${params.cardID}?${search.toString()}`, {
    method: 'PATCH',
    ...withJsonBody({
      text: params.text,
      answerContent: params.answerContent,
      answerText: params.answerText,
      canonicalAnswer: params.canonicalAnswer,
      explanation: params.explanation,
      legendImages: params.legendImages,
      derivedFromCardID: params.derivedFromCardID,
      relationType: params.relationType,
      originTask: params.originTask,
    }),
  })
}

export async function appendStudioQuestionCards(
  baseUrl: string,
  payload: {
    workroomID: string
    studioDocumentID: string
    drafts: Array<{
      text: string
      page?: number | null
      originalText?: string | null
      answerText?: string | null
      canonicalAnswer?: string | null
      explanation?: string | null
      legendImages?: string[]
      derivedFromCardID?: string | null
      relationType?: StudioQuestionCardDto['relationType']
      originTask?: StudioQuestionCardDto['originTask']
    }>
  },
): Promise<StudioQuestionCardDto[]> {
  const response = await apiJson<{ items: StudioQuestionCardDto[] }>(`${baseUrl}/api/studio/question-cards/append`, {
    method: 'POST',
    ...withJsonBody(payload),
  })
  return response.items ?? []
}

export async function insertStudioQuestionCards(
  baseUrl: string,
  payload: {
    workroomID: string
    studioDocumentID: string
    anchorCardID: string
    position: 'before' | 'after'
    drafts: Array<{
      text: string
      page?: number | null
      originalText?: string | null
      answerText?: string | null
      canonicalAnswer?: string | null
      explanation?: string | null
      legendImages?: string[]
      derivedFromCardID?: string | null
      relationType?: StudioQuestionCardDto['relationType']
      originTask?: StudioQuestionCardDto['originTask']
    }>
  },
): Promise<StudioQuestionCardDto[]> {
  const response = await apiJson<{ items: StudioQuestionCardDto[] }>(`${baseUrl}/api/studio/question-cards/insert`, {
    method: 'POST',
    ...withJsonBody(payload),
  })
  return response.items ?? []
}

export async function writeStudioQuestionExplanation(
  baseUrl: string,
  payload: { workroomID: string; cardID: string; explanation: string },
): Promise<StudioQuestionCardDto> {
  return apiJson(`${baseUrl}/api/studio/question-cards/${payload.cardID}/explanation`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
      explanation: payload.explanation,
    }),
  })
}

export async function attachDerivedPracticeCards(
  baseUrl: string,
  payload: { workroomID: string; sourceCardID: string; createdCardIDs: string[] },
): Promise<StudioQuestionCardDto[]> {
  const response = await apiJson<{ items: StudioQuestionCardDto[] }>(
    `${baseUrl}/api/studio/question-cards/${payload.sourceCardID}/derived-practice`,
    {
      method: 'POST',
      ...withJsonBody({
        workroomID: payload.workroomID,
        createdCardIDs: payload.createdCardIDs,
      }),
    },
  )
  return response.items ?? []
}

export async function deleteStudioQuestionCard(
  baseUrl: string,
  params: { workroomID: string; cardID: string },
): Promise<void> {
  const search = new URLSearchParams({
    workroom_id: params.workroomID,
  })
  await apiFetch(`${baseUrl}/api/studio/question-cards/${params.cardID}?${search.toString()}`, {
    method: 'DELETE',
  })
}

export async function getStudioQuestionCardDetail(
  baseUrl: string,
  params: { workroomID: string; cardID: string },
): Promise<StudioQuestionCardDetailDto> {
  const search = new URLSearchParams({
    workroom_id: params.workroomID,
  })
  return apiJson(`${baseUrl}/api/studio/question-cards/${params.cardID}/detail?${search.toString()}`, {
    method: 'GET',
  })
}

export async function submitStudioQuestionCardAttempt(
  baseUrl: string,
  payload: { workroomID: string; cardID: string; answerText: string },
): Promise<StudioQuestionCardDetailDto> {
  return apiJson(`${baseUrl}/api/studio/question-cards/${payload.cardID}/attempts`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
      answerText: payload.answerText,
    }),
  })
}
