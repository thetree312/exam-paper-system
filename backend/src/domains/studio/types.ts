import type { MathContentDocument } from "../../lib/math-content"

export type StudioSelectionRegion = {
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
}

export type StudioLegendRegion = {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export type StudioDocumentRecord = {
  id: string
  userID: string
  workroomID: string
  sourceDocumentID?: string | null
  title: string
  status: "active"
  createdAt: string
  updatedAt: string
}

export type StudioQuestionCardRecord = {
  id: string
  userID: string
  workroomID: string
  studioDocumentID: string
  sourceDocumentID?: string | null
  cardGroupID: string
  sequenceIndex: number
  page: number
  text: string
  originalText: string
  questionType?: string | null
  difficulty?: string | null
  knowledgePoints: string[]
  answerContent: MathContentDocument
  answerText: string
  canonicalAnswer: string
  explanation?: string | null
  legendImages: string[]
  derivedFromCardID?: string | null
  relationType?: "primary" | "practice_generated" | "variant" | "explanation_followup" | null
  originTask?: {
    kind: string
    sessionID?: string | null
    messageID?: string | null
  } | null
  sourceSelection: {
    regions: StudioSelectionRegion[]
    legends: StudioLegendRegion[]
  }
  answerEvidence: {
    status: "verified_unique" | "ambiguous" | "missing" | "unsupported"
    sourcePackagePath?: string | null
    page?: number | null
    layoutUnitKey?: string | null
    rawMarkdownRange?: {
      startOffset: number
      endOffset: number
      startLine: number
      endLine: number
      excerpt: string
    } | null
    notes?: string | null
  }
  learningSnapshot: {
    masteryScore: number
    masteryLevel: "unknown" | "struggling" | "reviewing" | "good" | "mastered"
    masteryTrend7d: number
    attemptCount: number
    correctCount: number
    incorrectCount: number
    diagnosisFailedCount: number
    firstAttemptAt?: string | null
    lastAttemptAt?: string | null
    lastReviewedAt?: string | null
    lastJudgement?: "correct" | "incorrect" | "skipped" | "uncertain" | "error" | "diagnosis_failed" | null
    latestDiagnosisSummary?: string | null
    weaknessSummary: Array<{
      weaknessKey: string
      label: string
      status: "open" | "improving" | "resolved" | "relapsed"
      severity: "low" | "medium" | "high"
      count: number
      note?: string | null
    }>
    reviewHeatmap180d: Array<{
      date: string
      intensity: number
    }>
  }
  createdAt: string
  updatedAt: string
}

export type QuestionCardAttemptRecord = {
  id: string
  userID: string
  workroomID: string
  cardID: string
  studioDocumentID: string
  sequenceIndex: number
  sourceDocumentID?: string | null
  answerText: string
  judgement: "correct" | "incorrect" | "skipped" | "uncertain" | "error" | "diagnosis_failed"
  predictedAnswer?: string | null
  scoreNumerator: number
  scoreDenominator: number
  scorePercent: number
  gradingMode: "reference_based" | "llm_freeform"
  referenceEvidenceStatus: "verified_unique" | "ambiguous" | "missing" | "unsupported"
  reasoning?: string | null
  submittedAt: string
  createdAt: string
  updatedAt: string
}

export type QuestionCardDiagnosisRecord = {
  id: string
  userID: string
  workroomID: string
  cardID: string
  attemptID: string
  rootCauseType:
    | "concept_gap"
    | "misread_question"
    | "method_gap"
    | "calculation_error"
    | "expression_issue"
    | "careless_mistake"
    | "unknown"
  conclusion: string
  evidenceSnippets: string[]
  confidence: number
  improvementAdvice: string
  weaknessItems: Array<{
    weaknessKey: string
    label: string
    severity: "low" | "medium" | "high"
    statusSuggestion: "open" | "improving" | "resolved" | "relapsed"
  }>
  modelOutputRawJson: string
  createdAt: string
  updatedAt: string
}

export type QuestionCardWeaknessRecord = {
  id: string
  userID: string
  workroomID: string
  cardID: string
  weaknessKey: string
  label: string
  category:
    | "concept_gap"
    | "misread_question"
    | "method_gap"
    | "calculation_error"
    | "expression_issue"
    | "careless_mistake"
    | "unknown"
  status: "open" | "improving" | "resolved" | "relapsed"
  severity: "low" | "medium" | "high"
  count: number
  note?: string | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt?: string | null
  evidenceAttemptIDs: string[]
  evidenceDiagnosisIDs: string[]
  createdAt: string
  updatedAt: string
}
