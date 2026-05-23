import { apiJson, withJsonBody } from '../lib/api'

export type LectureSessionStatus =
  | 'idle'
  | 'running'
  | 'paused_for_question'
  | 'answering'
  | 'completed'
  | 'archived'

export type LectureBlockRole = 'lecture' | 'answer' | 'student_question' | 'system'

export interface LectureRuntimeQuestionDto {
  requestID: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean
    custom?: boolean
  }>
}

export interface LectureHighlightSpanDto {
  sourceId: string
  quote: string
}

export type LectureVisualizationPatchDto =
  | {
      op: 'set_html'
      targetId: string
      html: string
    }
  | {
      op: 'set_text'
      targetId: string
      text: string
    }
  | {
      op: 'set_attr'
      targetId: string
      name: string
      value: string | null
    }
  | {
      op: 'remove_node'
      targetId: string
    }
  | {
      op: 'append_child'
      targetId: string
      html: string
    }
  | {
      op: 'scene_state'
      targetId: string
      state: Record<string, unknown>
    }

export interface LectureSourceBlockDto {
  id: string
  kind: 'stem' | 'option' | 'legend' | 'figure'
  text: string
  label?: string | null
}

export interface LectureBlockDto {
  id: string
  sessionID: string
  role: LectureBlockRole
  text: string
  highlightSpans: LectureHighlightSpanDto[]
  pauseAfter: boolean
  createdAt: string
}

export interface LectureDraftBlockDto {
  id: string
  sessionID: string
  role: LectureBlockRole
  text: string
  createdAt: string
}

export interface LectureReasoningDraftDto {
  id: string
  sessionID: string
  text: string
  status: 'thinking' | 'complete'
  elapsedMs: number
  createdAt: string
}

export interface LectureSessionDto {
  id: string
  userID: string
  workroomID: string
  studioDocumentID: string
  cardID: string
  originAgentSessionID: string | null
  lectureAgentSessionID?: string | null
  originMessageID: string | null
  status: LectureSessionStatus
  resumeCursor: number
  lastBlockID: string | null
  activeHighlightSpans: LectureHighlightSpanDto[]
  visualizationHTML: string | null
  summaryStatus: 'pending' | 'completed'
  summary: {
    lectureSessionId: string
    cardID: string
    completed: boolean
    coveredSpans: LectureHighlightSpanDto[]
    studentQuestions: string[]
    teachingSummary: string
    nextSuggestion: string | null
  } | null
  closedAt: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LectureQuestionCardDetailDto {
  anchor: {
    cardID: string
    questionNumber: number
    studioDocumentID: string
    sourceDocumentID: string | null
    cardGroupID: string
    sequenceIndex: number
    page: number
    relationType: string | null
    derivedFromCardID: string | null
    sourceSelection: Record<string, unknown>
    answerEvidence: Record<string, unknown>
    timestamps: {
      createdAt: string
      updatedAt: string
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
    legendImages: string[]
    derivedFromCardID: string | null
    relationType: string | null
  }
  learningProfile: Record<string, unknown>
}

export interface LectureSessionPayloadDto {
  session: LectureSessionDto
  blocks: LectureBlockDto[]
  questionCard: LectureQuestionCardDetailDto
  pendingQuestion: LectureRuntimeQuestionDto | null
  sourceBlocks: LectureSourceBlockDto[]
}

export interface LectureStreamEventDto {
  type:
    | 'lecture.session.ready'
    | 'lecture.block.appended'
    | 'lecture.highlight.changed'
  | 'lecture.resumed'
  | 'lecture.block.streaming'
  | 'lecture.reasoning.streaming'
  | 'lecture.visualization.updated'
  | 'lecture.completed'
  | 'question_asked'
  | 'question_replied'
  | 'question_rejected'
  session: LectureSessionDto
  blocks?: LectureBlockDto[]
  block?: LectureBlockDto
  draftBlock?: LectureDraftBlockDto | null
  reasoningDraft?: LectureReasoningDraftDto | null
  pendingQuestion?: LectureRuntimeQuestionDto | null
  request?: {
    id: string
    session_id: string
    questions: LectureRuntimeQuestionDto['questions']
  }
  requestId?: string
  freeText?: Array<string | null>
  mode?: 'snapshot' | 'patch'
  patches?: LectureVisualizationPatchDto[]
  snapshotVersion?: string
  at: string
}

export async function getLectureSession(
  baseUrl: string,
  params: { workroomID: string; lectureSessionId: string },
): Promise<LectureSessionPayloadDto> {
  const search = new URLSearchParams({
    workroom_id: params.workroomID,
  })
  return apiJson(`${baseUrl}/api/lectures/${params.lectureSessionId}?${search.toString()}`, {
    method: 'GET',
  })
}

export async function closeLectureSession(
  baseUrl: string,
  payload: { workroomID: string; lectureSessionId: string },
) {
  return apiJson(`${baseUrl}/api/lectures/${payload.lectureSessionId}/close`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
    }),
  })
}

export async function setLectureVisualization(
  baseUrl: string,
  payload: { workroomID: string; lectureSessionId: string; html: string | null },
): Promise<{ session: LectureSessionDto }> {
  return apiJson(`${baseUrl}/api/lectures/${payload.lectureSessionId}/visualization`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
      html: payload.html,
    }),
  })
}

export async function replyLectureRuntimeQuestion(
  baseUrl: string,
  payload: {
    workroomID: string
    lectureSessionId: string
    requestID: string
    answers: string[][]
    freeText?: Array<string | null>
  },
) {
  return apiJson(`${baseUrl}/api/lectures/${payload.lectureSessionId}/runtime-question/${encodeURIComponent(payload.requestID)}/reply`, {
    method: 'POST',
    ...withJsonBody({
      workroomID: payload.workroomID,
      answers: payload.answers,
      freeText: payload.freeText,
    }),
  })
}
