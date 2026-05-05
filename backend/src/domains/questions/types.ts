export type QuestionRecord = {
  id: string
  userID: string
  workroomID: string
  studioDocumentID: string
  sourceDocumentID?: string | null
  sequenceIndex: number
  content: string
  legendImages: string[]
  page: number | null
  studentAnswer?: string | null
  canonicalAnswer?: string | null
  explanation?: string | null
  gradingJudgement?: "pending" | "correct" | "incorrect" | "skipped" | "uncertain" | "error" | null
  gradingPredictedAnswer?: string | null
  gradingReasoning?: string | null
  gradingConfidence?: number | null
  createdAt: string
  updatedAt: string
}

export type QuestionsState = {
  items: QuestionRecord[]
}
