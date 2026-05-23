import { expect, test } from "bun:test"
import {
  advanceLectureContinuationWait,
  shouldClearLectureReasoning,
  shouldCollapseLectureReasoningForDraft,
  shouldShowLectureContinuationWait,
} from "./lecture-stream-state"

test("turns on continuation wait after question reply and clears on first draft chunk", () => {
  const waiting = advanceLectureContinuationWait(false, "question_replied")
  expect(waiting).toBe(true)
  expect(
    shouldShowLectureContinuationWait({
      awaitingContinuation: waiting,
      hasDraftBlock: false,
      hasPendingQuestion: false,
    }),
  ).toBe(true)

  const cleared = advanceLectureContinuationWait(waiting, "lecture.block.streaming")
  expect(cleared).toBe(false)
})

test("reasoning stream counts as activity while the teacher is thinking", () => {
  const waiting = advanceLectureContinuationWait(false, "question_replied")
  expect(advanceLectureContinuationWait(waiting, "lecture.reasoning.streaming")).toBe(false)
  expect(
    shouldShowLectureContinuationWait({
      awaitingContinuation: waiting,
      hasDraftBlock: false,
      hasReasoningDraft: true,
      hasPendingQuestion: false,
    }),
  ).toBe(false)
})

test("does not show continuation wait while the next question is already pending", () => {
  expect(
    shouldShowLectureContinuationWait({
      awaitingContinuation: true,
      hasDraftBlock: false,
      hasPendingQuestion: true,
    }),
  ).toBe(false)
})

test("keeps completed reasoning visible when the teacher asks a question", () => {
  expect(shouldClearLectureReasoning("question_asked")).toBe(false)
})

test("clears old reasoning only when a new user reply starts the next cycle", () => {
  expect(shouldClearLectureReasoning("question_replied")).toBe(true)
  expect(shouldClearLectureReasoning("question_rejected")).toBe(true)
})

test("collapses reasoning as soon as real answer draft text starts streaming", () => {
  expect(shouldCollapseLectureReasoningForDraft("")).toBe(false)
  expect(shouldCollapseLectureReasoningForDraft("   ")).toBe(false)
  expect(shouldCollapseLectureReasoningForDraft("我们来看第一步")).toBe(true)
})
