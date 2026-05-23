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
  questionType?: string | null
  difficulty?: string | null
  knowledgePoints?: string[]
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
  content: {
    cardID: string
    studioDocumentID: string
    sourceDocumentID: string | null
    sequenceIndex: number
    cardGroupID: string
    stem: string
    answer: string
    explanation: string | null
    questionType: string | null
    difficulty: string | null
    knowledgePoints: string[]
    derivedFromCardID: string | null
    relationType: 'primary' | 'practice_generated' | 'variant' | 'explanation_followup' | null
  }
  learningProfile: {
    problemCard: {
      id: string
      source_document_id: string
      source_document_title: string
      source_page: number
      source_region: Record<string, unknown>
      question_text: string
      options: string[]
      reference_answer_ref: Record<string, unknown>
      created_at: string
      updated_at: string
    }
    knowledgeProfile: null | {
      problem_card_id: string
      knowledge_points: string[]
      knowledge_system_path: string[]
      common_traps: string[]
      confusing_points: string[]
      solution_strategies: string[]
      prerequisite_knowledge: string[]
      difficulty_estimate: string | null
      generated_by_grading_record_id: string | null
      first_generated_at: string
      version: number
    }
    learningState?: null | {
      problem_card_id: string
      mastery_level: string
      mastery_score: number
      total_attempts: number
      correct_attempts: number
      consecutive_correct_count: number
      last_attempt_at: string | null
      last_review_at: string | null
      unresolved_weaknesses: string[]
      repeated_mistakes: string[]
      progress_signal: string | null
      progress_summary: string | null
      generation_recommendation: Record<string, unknown>
      updated_at: string
    }
    gradingRecords: Array<{
      id: string
      attempt_id: string
      attempt_index: number
      is_correct: boolean | null
      score: number | null
      diagnosis: string
      mistake_type: string | null
      careless_points: string[]
      conceptual_errors: string[]
      fixed_previous_errors: string[]
      remaining_weaknesses: string[]
      new_mistakes: string[]
      comparison_with_previous_attempt: string | null
      next_action_suggestion: string | null
      used_context_summary: Record<string, unknown>
      created_at: string
    }>
    latestGradingRecord: null | {
      id: string
      attempt_id: string
      attempt_index: number
      is_correct: boolean | null
      score: number | null
      diagnosis: string
      mistake_type: string | null
      careless_points: string[]
      conceptual_errors: string[]
      fixed_previous_errors: string[]
      remaining_weaknesses: string[]
      new_mistakes: string[]
      comparison_with_previous_attempt: string | null
      next_action_suggestion: string | null
      used_context_summary: Record<string, unknown>
      created_at: string
    }
    attempts?: Array<{
      id: string
      attempt_index: number
      user_answer: string
      judgement: string
      predicted_answer: string | null
      score_percent: number
      reasoning: string | null
      submitted_at: string
    }>
    weaknesses: Array<{
      id: string
      weakness_key: string
      label: string
      category: string
      status: string
      severity: string
      count: number
      first_seen_at: string
      last_seen_at: string
      resolved_at: string | null
    }>
    reviewHeatmap180d?: Array<{ date: string; intensity: number }>
    attemptStats?: {
      total_attempts: number
    }
    reviewStats?: {
      review_count: number
      grading_count: number
    }
    timelineEvents?: Array<{
      id: string
      event_type: string
      payload: Record<string, unknown>
      created_at: string
    }>
    currentState?: null | {
      problem_card_id: string
      mastery_level: string
      mastery_score: number
      total_attempts: number
      correct_attempts: number
      consecutive_correct_count: number
      last_attempt_at: string | null
      last_review_at: string | null
      unresolved_weaknesses: string[]
      repeated_mistakes: string[]
      progress_signal: string | null
      progress_summary: string | null
      generation_recommendation: Record<string, unknown>
      updated_at: string
    }
    raw_recent_attempts?: Array<{
      id: string
      attempt_index: number
      user_answer: string
      judgement: string
      predicted_answer: string | null
      score_percent: number
      reasoning: string | null
      submitted_at: string
    }>
    summaries?: {
      monthly_summaries: Array<Record<string, unknown>>
      yearly_summaries: Array<Record<string, unknown>>
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
