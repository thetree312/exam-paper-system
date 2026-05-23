import { apiJson, withJsonBody } from '../lib/api'

export interface ProblemCardLearningDetailDto {
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
  learningState: null | {
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
  attempts: Array<{
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
  reviewHeatmap180d: Array<{ date: string; intensity: number }>
  attemptStats: {
    total_attempts: number
  }
  reviewStats: {
    review_count: number
    grading_count: number
  }
  timelineEvents: Array<{
    id: string
    event_type: string
    payload: Record<string, unknown>
    created_at: string
  }>
}

export async function getProblemCardLearningDetail(
  baseUrl: string,
  params: { workroomID: string; problemCardID: string },
): Promise<ProblemCardLearningDetailDto> {
  const search = new URLSearchParams({
    workroom_id: params.workroomID,
  })
  return apiJson(`${baseUrl}/api/problem-cards/${params.problemCardID}/learning-detail?${search.toString()}`, {
    method: 'GET',
  })
}

export async function enterProblemCardAnswerMode(
  baseUrl: string,
  payload: { workroomID: string; problemCardID: string },
): Promise<ProblemCardLearningDetailDto> {
  return apiJson(`${baseUrl}/api/problem-cards/${payload.problemCardID}/answer-mode`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
    }),
  })
}

export async function submitProblemCardAnswer(
  baseUrl: string,
  payload: {
    workroomID: string
    problemCardID: string
    userAnswer: string
    inputSource: 'option' | 'text' | 'mixed'
  },
): Promise<ProblemCardLearningDetailDto> {
  return apiJson(`${baseUrl}/api/problem-cards/${payload.problemCardID}/submit`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
      user_answer: payload.userAnswer,
      input_source: payload.inputSource,
    }),
  })
}

export async function addProblemCardToStudio(
  baseUrl: string,
  payload: { workroomID: string; problemCardID: string },
): Promise<{ status: 'ok' }> {
  return apiJson(`${baseUrl}/api/problem-cards/${payload.problemCardID}/studio`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
    }),
  })
}

export async function finishProblemCardReview(
  baseUrl: string,
  payload: { workroomID: string; problemCardID: string },
): Promise<ProblemCardLearningDetailDto> {
  return apiJson(`${baseUrl}/api/problem-cards/${payload.problemCardID}/finish-review`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
    }),
  })
}
