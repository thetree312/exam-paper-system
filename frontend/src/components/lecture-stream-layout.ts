import type {
  LectureBlockDto,
  LectureDraftBlockDto,
  LectureReasoningDraftDto,
} from '../services/lectureApi'

export type LectureStreamRenderItem =
  | { kind: 'block'; block: LectureBlockDto; streaming: boolean }
  | { kind: 'reasoning'; draft: LectureReasoningDraftDto }

function normalizeDraftBlock(block: LectureDraftBlockDto): LectureBlockDto {
  return {
    id: block.id,
    sessionID: block.sessionID,
    role: block.role,
    text: block.text,
    createdAt: block.createdAt,
    highlightSpans: [],
    pauseAfter: false,
  }
}

export function buildLectureStreamRenderItems(input: {
  blocks: LectureBlockDto[]
  reasoningDraft: LectureReasoningDraftDto | null
  draftBlock: LectureDraftBlockDto | null
}) {
  const reasoningText = input.reasoningDraft?.text.trim() ?? ''
  const items: LectureStreamRenderItem[] = []
  const hasReasoning = Boolean(reasoningText)
  const shouldInsertReasoningBeforeLatestBlock =
    hasReasoning &&
    !input.draftBlock?.text.trim() &&
    input.reasoningDraft?.status !== 'thinking' &&
    input.blocks.length > 0

  input.blocks.forEach((block, index) => {
    if (shouldInsertReasoningBeforeLatestBlock && index === input.blocks.length - 1 && input.reasoningDraft) {
      items.push({ kind: 'reasoning', draft: input.reasoningDraft })
    }
    items.push({ kind: 'block', block, streaming: false })
  })

  if (hasReasoning && !shouldInsertReasoningBeforeLatestBlock && input.reasoningDraft) {
    items.push({ kind: 'reasoning', draft: input.reasoningDraft })
  }

  if (input.draftBlock?.text.trim()) {
    items.push({ kind: 'block', block: normalizeDraftBlock(input.draftBlock), streaming: true })
  }

  return items
}
