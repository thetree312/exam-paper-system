import type { AgentSnapshotResponse, AggregatedOcrItem, GradingJudgement } from '../types'
import { createTextMathDocument } from '../lib/mathContent'

interface SnapshotRestoreContext {
  sessionId?: string | number | null
  fileId?: string | number | null
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
  const fileId =
    context.fileId ?? String(snapshot.source_document_id ?? snapshot.studio_document_id ?? 'restored-file')
  const sessionId =
    context.sessionId ?? String(snapshot.source_document_id ?? snapshot.studio_document_id ?? 'restored-session')

  return [...(snapshot.questions ?? [])]
    .sort((a, b) => {
      if (a.sequenceIndex !== b.sequenceIndex) return a.sequenceIndex - b.sequenceIndex
      return a.id - b.id
    })
    .map((question, index) => ({
      id: `restored-${snapshot.studio_document_id}-${question.id}`,
      region_index: question.sequenceIndex ?? index,
      text: question.content,
      sessionId,
      fileId,
      fileName,
      page: question.page ?? 1,
      createdAt: baseCreatedAt + index,
      legendImages: question.legendImages ?? [],
      originalText: question.content,
      answerContent: createTextMathDocument(question.studentAnswer ?? ''),
      answerText: question.studentAnswer ?? '',
      canonicalAnswer: question.canonicalAnswer ?? '',
      sourceType: 'upload' as const,
      documentContext: {
        studioDocumentID: String(snapshot.studio_document_id),
        sourceDocumentID:
          snapshot.source_document_id != null ? String(snapshot.source_document_id) : null,
      },
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
