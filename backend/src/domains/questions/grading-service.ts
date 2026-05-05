import { QuestionsService } from "./service"
import { StudioRepository } from "../studio/repository"
import { ProblemCardService } from "../problem-cards/service"

export type GradeRunQuestionInput = {
  sequenceIndex: number
  content: string
  userAnswer?: string | null
  canonicalAnswer?: string | null
}

export type GradeRunQuestionResult = {
  sequenceIndex: number
  judgement: "correct" | "incorrect" | "skipped" | "uncertain" | "error"
  predictedAnswer?: string | null
  reasoning?: string | null
  confidence?: number | null
  error?: string | null
}

export const QuestionGradingService = {
  async gradeRun(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    sourceDocumentID?: string | null
    questions: GradeRunQuestionInput[]
  }) {
    const results: GradeRunQuestionResult[] = []
    const cards = (await StudioRepository.readQuestionCards()).items.filter(
      (card) =>
        card.userID === input.userID &&
        card.workroomID === input.workroomID &&
        card.studioDocumentID === input.studioDocumentID,
    )
    const cardBySequence = new Map<number, string>(cards.map((card) => [card.sequenceIndex, card.id]))

    for (const item of input.questions) {
      const content = item.content.trim()
      const userAnswer = item.userAnswer?.trim() ?? ""

      if (!content) {
        results.push({
          sequenceIndex: item.sequenceIndex,
          judgement: "error",
          error: "题目内容为空，无法批改",
        })
        continue
      }

      if (!userAnswer) {
        const skipped: GradeRunQuestionResult = {
          sequenceIndex: item.sequenceIndex,
          judgement: "skipped",
          reasoning: "学生未作答",
          predictedAnswer: null,
          confidence: null,
        }
        results.push(skipped)
        await QuestionsService.sync({
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: input.studioDocumentID,
          sourceDocumentID: input.sourceDocumentID,
          sequenceIndex: item.sequenceIndex,
          content,
          studentAnswer: null,
          gradingJudgement: "skipped",
          gradingPredictedAnswer: null,
          gradingReasoning: "学生未作答",
          gradingConfidence: null,
        })
        continue
      }

      try {
        const cardID = cardBySequence.get(item.sequenceIndex)
        if (!cardID) throw new Error(`ProblemCard not found by sequenceIndex=${item.sequenceIndex}`)
        const learning = await ProblemCardService.submit({
          userID: input.userID,
          workroomID: input.workroomID,
          problemCardID: cardID,
          userAnswer,
          inputSource: "text",
        })
        const latest = learning.latestGradingRecord
        const result: GradeRunQuestionResult = {
          sequenceIndex: item.sequenceIndex,
          judgement:
            latest?.is_correct === true
              ? "correct"
              : latest?.is_correct === false
                ? "incorrect"
                : "uncertain",
          predictedAnswer: null,
          reasoning: latest?.diagnosis ?? null,
          confidence: null,
        }
        results.push(result)

        await QuestionsService.sync({
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: input.studioDocumentID,
          sourceDocumentID: input.sourceDocumentID,
          sequenceIndex: item.sequenceIndex,
          content,
          studentAnswer: userAnswer,
          canonicalAnswer: item.canonicalAnswer ?? null,
          gradingJudgement: result.judgement,
          gradingPredictedAnswer: result.predictedAnswer ?? null,
          gradingReasoning: result.reasoning,
          gradingConfidence: result.confidence,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : "批改失败"
        results.push({
          sequenceIndex: item.sequenceIndex,
          judgement: "error",
          error: message,
        })
        await QuestionsService.sync({
          userID: input.userID,
          workroomID: input.workroomID,
          studioDocumentID: input.studioDocumentID,
          sourceDocumentID: input.sourceDocumentID,
          sequenceIndex: item.sequenceIndex,
          content,
          studentAnswer: userAnswer,
          canonicalAnswer: item.canonicalAnswer ?? null,
          gradingJudgement: "error",
          gradingPredictedAnswer: null,
          gradingReasoning: message,
          gradingConfidence: null,
        })
      }
    }

    return results
  },
}
