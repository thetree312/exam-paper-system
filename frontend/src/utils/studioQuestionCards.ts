import { createTextMathDocument } from '../lib/mathContent'
import type { AggregatedOcrItem } from '../types'
import type { StudioQuestionCardDto } from '../services/studioApi'

export function buildOcrItemFromStudioQuestionCard(input: {
  card: StudioQuestionCardDto
  fileName?: string | null
}): AggregatedOcrItem {
  const { card } = input
  return {
    id: card.id,
    region_index: card.sequenceIndex,
    text: card.text,
    sessionId: card.sourceDocumentID,
    fileId: card.sourceDocumentID,
    fileName: input.fileName?.trim() || '题卡集',
    page: card.page ?? 1,
    createdAt: new Date(card.createdAt).getTime(),
    legendImages: card.legendImages ?? [],
    originalText: card.originalText ?? card.text,
    answerContent: card.answerContent ?? createTextMathDocument(card.answerText ?? ''),
    answerText: card.answerText ?? '',
    canonicalAnswer: card.canonicalAnswer ?? '',
    documentContext: {
      studioDocumentID: card.studioDocumentID,
      sourceDocumentID: card.sourceDocumentID ?? null,
    },
    questionMeta: {
      questionId: card.projectedQuestionID ?? undefined,
      sequenceIndex: card.sequenceIndex,
      groupId: card.cardGroupID?.trim() || card.sequenceIndex,
    },
  }
}
