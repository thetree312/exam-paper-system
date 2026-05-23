export type LectureContinuationTrigger =
  | 'question_replied'
  | 'lecture.block.streaming'
  | 'lecture.reasoning.streaming'
  | 'lecture.block.appended'
  | 'question_asked'
  | 'lecture.session.ready'
  | 'lecture.completed'

export function advanceLectureContinuationWait(
  current: boolean,
  trigger: LectureContinuationTrigger,
) {
  if (trigger === 'question_replied') return true
  if (
    trigger === 'lecture.block.streaming' ||
    trigger === 'lecture.reasoning.streaming' ||
    trigger === 'lecture.block.appended' ||
    trigger === 'question_asked' ||
    trigger === 'lecture.session.ready' ||
    trigger === 'lecture.completed'
  ) {
    return false
  }
  return current
}

export function shouldShowLectureContinuationWait(input: {
  awaitingContinuation: boolean
  hasDraftBlock: boolean
  hasReasoningDraft?: boolean
  hasPendingQuestion: boolean
}) {
  return input.awaitingContinuation && !input.hasDraftBlock && !input.hasReasoningDraft && !input.hasPendingQuestion
}

export type LectureReasoningLifecycleTrigger =
  | 'question_asked'
  | 'question_replied'
  | 'question_rejected'

export function shouldClearLectureReasoning(trigger: LectureReasoningLifecycleTrigger) {
  return trigger === 'question_replied' || trigger === 'question_rejected'
}

export function shouldCollapseLectureReasoningForDraft(text: string | null | undefined) {
  return Boolean(text?.trim())
}
