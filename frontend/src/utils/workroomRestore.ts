import type { AgentSnapshotResponse, AggregatedOcrItem, GradingJudgement } from '../types'

interface SnapshotRestoreContext {
  sessionId?: number | null
  fileId?: number | null
  fileName?: string | null
  createdAt?: number
}

const toGradingStatus = (value: string | null | undefined): GradingJudgement => {
  if (
    value === 'pending' ||
    value === 'correct' ||
    value === 'incorrect' ||
    value === 'skipped' ||
    value === 'uncertain' ||
    value === 'error'
  ) {
    return value
  }
  return 'pending'
}

export function buildOcrItemsFromSnapshot(
  snapshot: AgentSnapshotResponse,
  context: SnapshotRestoreContext = {},
): AggregatedOcrItem[] {
  const baseCreatedAt = context.createdAt ?? Date.now()
  const fileName = context.fileName?.trim() || snapshot.title || 'Recovered Document'
  const fileId = context.fileId ?? 0
  const sessionId = context.sessionId ?? 0

  return [...(snapshot.questions ?? [])]
    .sort((a, b) => {
      if (a.sequenceIndex !== b.sequenceIndex) return a.sequenceIndex - b.sequenceIndex
      return a.id - b.id
    })
    .map((question, index) => ({
      id: `restored-${snapshot.document_id}-${question.id}`,
      region_index: question.sequenceIndex ?? index,
      text: question.content,
      sessionId,
      fileId,
      fileName,
      page: question.page ?? 1,
      createdAt: baseCreatedAt + index,
      legendImages: question.legendImages ?? [],
      originalText: question.content,
      answerText: question.studentAnswer ?? '',
      sourceType: 'upload' as const,
      questionMeta: {
        questionId: question.id,
        sequenceIndex: question.sequenceIndex,
        groupId: question.groupId ?? question.id,
      },
      grading:
        question.gradingJudgement ||
        question.gradingPredictedAnswer ||
        question.gradingReasoning ||
        question.gradingConfidence != null
          ? {
              status: toGradingStatus(question.gradingJudgement),
              predictedAnswer: question.gradingPredictedAnswer ?? undefined,
              reasoning: question.gradingReasoning ?? undefined,
              confidence: question.gradingConfidence ?? null,
            }
          : undefined,
    }))
}
