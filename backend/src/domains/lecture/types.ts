export type LectureSessionStatus =
  | "idle"
  | "running"
  | "paused_for_question"
  | "answering"
  | "completed"
  | "archived"

export type LectureSummaryStatus = "pending" | "completed"

export type LectureBlockRole = "lecture" | "answer" | "student_question" | "system"

export type LectureSummaryHandback = {
  lectureSessionId: string
  cardID: string
  completed: boolean
  coveredSpans: LectureHighlightSpan[]
  studentQuestions: string[]
  teachingSummary: string
  nextSuggestion: string | null
}

export type LectureHighlightSpan = {
  sourceId: string
  quote: string
}

export type LectureVisualizationPatch =
  | {
      op: "set_html"
      targetId: string
      html: string
    }
  | {
      op: "set_text"
      targetId: string
      text: string
    }
  | {
      op: "set_attr"
      targetId: string
      name: string
      value: string | null
    }
  | {
      op: "remove_node"
      targetId: string
    }
  | {
      op: "append_child"
      targetId: string
      html: string
    }
  | {
      op: "scene_state"
      targetId: string
      state: Record<string, unknown>
    }

export type LectureSourceBlockKind = "stem" | "option" | "legend" | "figure"

export type LectureSourceBlock = {
  id: string
  kind: LectureSourceBlockKind
  text: string
  label?: string | null
}

export type LectureSessionRecord = {
  id: string
  userID: string
  workroomID: string
  studioDocumentID: string
  cardID: string
  originAgentSessionID: string | null
  lectureAgentSessionID: string | null
  originMessageID: string | null
  status: LectureSessionStatus
  resumeCursor: number
  projectedChildMessageCount: number
  lastBlockID: string | null
  activeHighlightSpans: LectureHighlightSpan[]
  visualizationHTML: string | null
  questionPromptJSON: string | null
  summaryStatus: LectureSummaryStatus
  summary: LectureSummaryHandback | null
  closedAt: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type LectureBlockRecord = {
  id: string
  sessionID: string
  role: LectureBlockRole
  text: string
  highlightSpans: LectureHighlightSpan[]
  pauseAfter: boolean
  createdAt: string
}

export type LectureDraftBlockRecord = {
  id: string
  sessionID: string
  role: LectureBlockRole
  text: string
  createdAt: string
}

export type LectureReasoningDraftRecord = {
  id: string
  sessionID: string
  text: string
  status: "thinking" | "complete"
  elapsedMs: number
  createdAt: string
}

export type LectureRuntimeQuestionOption =
  {
    label: string
    description: string
  }

export type LectureRuntimeQuestionItem = {
  question: string
  header: string
  options: LectureRuntimeQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type LectureRuntimeQuestion = {
  requestID: string
  sessionID: string
  questions: LectureRuntimeQuestionItem[]
}
