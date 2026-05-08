import { createID } from "../../lib/ids"
import { QuestionsRepository } from "../questions/repository"
import type { StudioQuestionCardRecord } from "./types"

function toProjectedQuestion(card: StudioQuestionCardRecord) {
  const canonicalAnswer = card.canonicalAnswer?.trim() || card.answerText?.trim() || null
  return {
    userID: card.userID,
    workroomID: card.workroomID,
    studioDocumentID: card.studioDocumentID,
    studioCardID: card.id,
    sourceDocumentID: card.sourceDocumentID ?? null,
    sequenceIndex: card.sequenceIndex,
    content: card.text,
    legendImages: card.legendImages ?? [],
    page: card.page ?? null,
    studentAnswer: null,
    canonicalAnswer,
    explanation: card.explanation ?? null,
    gradingJudgement: null,
    gradingPredictedAnswer: null,
    gradingReasoning: null,
    gradingConfidence: null,
  }
}

export const StudioQuestionsProjection = {
  async syncCard(card: StudioQuestionCardRecord) {
    const existing = await QuestionsRepository.findByStudioCardID({
      userID: card.userID,
      studioCardID: card.id,
    })
    const next = toProjectedQuestion(card)

    if (existing) {
      return QuestionsRepository.update({
        userID: card.userID,
        questionID: existing.id,
        mutate: (record) => {
          record.studioDocumentID = next.studioDocumentID
          record.studioCardID = next.studioCardID
          record.sourceDocumentID = next.sourceDocumentID
          record.sequenceIndex = next.sequenceIndex
          record.content = next.content
          record.legendImages = next.legendImages
          record.page = next.page
          record.canonicalAnswer = next.canonicalAnswer
          record.explanation = next.explanation
          record.updatedAt = card.updatedAt
        },
      })
    }

    return QuestionsRepository.insert({
      id: createID("question"),
      ...next,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    })
  },

  async syncCards(cards: StudioQuestionCardRecord[]) {
    for (const card of cards) {
      await this.syncCard(card)
    }
  },

  async removeCard(input: { userID: string; studioCardID: string }) {
    const existing = await QuestionsRepository.findByStudioCardID(input)
    if (!existing) return
    await QuestionsRepository.remove({
      userID: input.userID,
      questionID: existing.id,
    })
  },
}
