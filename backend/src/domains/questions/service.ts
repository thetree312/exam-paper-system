import { createID } from "../../lib/ids"
import { StudioService } from "../studio/service"
import { WorkroomService } from "../workrooms/service"
import { QuestionsRepository } from "./repository"

function normalizeOptionalText(input?: string | null) {
  const normalized = input?.trim()
  return normalized ? normalized : null
}

function normalizeOptionalConfidence(input?: number | null) {
  if (input === undefined || input === null) return null
  if (typeof input !== "number" || Number.isNaN(input)) throw new Error("gradingConfidence must be a number")
  if (input < 0 || input > 1) throw new Error("gradingConfidence must be between 0 and 1")
  return input
}

function normalizeLegendImages(input?: string[]) {
  return Array.from(new Set((input ?? []).map((item) => item.trim()).filter(Boolean)))
}

function normalizeSequenceIndex(input: number) {
  if (!Number.isInteger(input) || input < 0) {
    throw new Error("sequenceIndex must be a non-negative integer")
  }
  return input
}

function normalizeContent(content: string) {
  const normalized = content.trim()
  if (!normalized) throw new Error("Question content is required")
  return normalized
}

async function requireStudioDocumentBinding(input: {
  userID: string
  workroomID: string
  studioDocumentID: string
  sourceDocumentID?: string | null
}) {
  const studioDocument = await StudioService.getDocument({
    userID: input.userID,
    workroomID: input.workroomID,
    studioDocumentID: input.studioDocumentID,
  })
  if (!studioDocument) throw new Error(`Studio document not found: ${input.studioDocumentID}`)

  if (
    input.sourceDocumentID !== undefined &&
    input.sourceDocumentID !== null &&
    studioDocument.sourceDocumentID !== null &&
    studioDocument.sourceDocumentID !== input.sourceDocumentID
  ) {
    throw new Error(
      `Studio document/source document mismatch: ${input.studioDocumentID} <> ${input.sourceDocumentID}`,
    )
  }

  return {
    studioDocumentID: studioDocument.id,
    sourceDocumentID: input.sourceDocumentID ?? studioDocument.sourceDocumentID ?? null,
    title: studioDocument.title,
    status: studioDocument.status,
    workroomID: studioDocument.workroomID,
  }
}

export const QuestionsService = {
  async listByStudioDocument(input: { userID: string; studioDocumentID: string }) {
    return QuestionsRepository.listByStudioDocument(input)
  },

  async getByID(input: { userID: string; questionID: string }) {
    return QuestionsRepository.findByID(input)
  },

  async create(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    sourceDocumentID?: string | null
    sequenceIndex: number
    content: string
    legendImages?: string[]
    page?: number | null
    studentAnswer?: string | null
    canonicalAnswer?: string | null
    explanation?: string | null
    gradingJudgement?: "pending" | "correct" | "incorrect" | "skipped" | "uncertain" | "error" | null
    gradingPredictedAnswer?: string | null
    gradingReasoning?: string | null
    gradingConfidence?: number | null
  }) {
    const workroom = await WorkroomService.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)

    const binding = await requireStudioDocumentBinding(input)
    const now = new Date().toISOString()
    return QuestionsRepository.insert({
      id: createID("question"),
      userID: input.userID,
      workroomID: input.workroomID,
      studioDocumentID: binding.studioDocumentID,
      sourceDocumentID: binding.sourceDocumentID,
      sequenceIndex: normalizeSequenceIndex(input.sequenceIndex),
      content: normalizeContent(input.content),
      legendImages: normalizeLegendImages(input.legendImages),
      page: input.page ?? null,
      studentAnswer: normalizeOptionalText(input.studentAnswer),
      canonicalAnswer: normalizeOptionalText(input.canonicalAnswer),
      explanation: normalizeOptionalText(input.explanation),
      gradingJudgement: input.gradingJudgement ?? null,
      gradingPredictedAnswer: normalizeOptionalText(input.gradingPredictedAnswer),
      gradingReasoning: normalizeOptionalText(input.gradingReasoning),
      gradingConfidence: normalizeOptionalConfidence(input.gradingConfidence),
      createdAt: now,
      updatedAt: now,
    })
  },

  async update(input: {
    userID: string
    questionID: string
    content?: string
    legendImages?: string[]
    page?: number | null
    studentAnswer?: string | null
    canonicalAnswer?: string | null
    explanation?: string | null
    gradingJudgement?: "pending" | "correct" | "incorrect" | "skipped" | "uncertain" | "error" | null
    gradingPredictedAnswer?: string | null
    gradingReasoning?: string | null
    gradingConfidence?: number | null
  }) {
    return QuestionsRepository.update({
      userID: input.userID,
      questionID: input.questionID,
      mutate: (record) => {
        if (input.content !== undefined) record.content = normalizeContent(input.content)
        if (input.legendImages !== undefined) record.legendImages = normalizeLegendImages(input.legendImages)
        if (input.page !== undefined) record.page = input.page
        if (input.studentAnswer !== undefined) record.studentAnswer = normalizeOptionalText(input.studentAnswer)
        if (input.canonicalAnswer !== undefined) record.canonicalAnswer = normalizeOptionalText(input.canonicalAnswer)
        if (input.explanation !== undefined) record.explanation = normalizeOptionalText(input.explanation)
        if (input.gradingJudgement !== undefined) record.gradingJudgement = input.gradingJudgement
        if (input.gradingPredictedAnswer !== undefined) {
          record.gradingPredictedAnswer = normalizeOptionalText(input.gradingPredictedAnswer)
        }
        if (input.gradingReasoning !== undefined) record.gradingReasoning = normalizeOptionalText(input.gradingReasoning)
        if (input.gradingConfidence !== undefined) {
          record.gradingConfidence = normalizeOptionalConfidence(input.gradingConfidence)
        }
        record.updatedAt = new Date().toISOString()
      },
    })
  },

  async sync(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    sourceDocumentID?: string | null
    questionID?: string | null
    sequenceIndex: number
    page?: number | null
    content: string
    legendImages?: string[]
    title?: string | null
    studentAnswer?: string | null
    canonicalAnswer?: string | null
    explanation?: string | null
    gradingJudgement?: "pending" | "correct" | "incorrect" | "skipped" | "uncertain" | "error" | null
    gradingPredictedAnswer?: string | null
    gradingReasoning?: string | null
    gradingConfidence?: number | null
  }) {
    const binding = await requireStudioDocumentBinding(input)
    const normalizedSequenceIndex = normalizeSequenceIndex(input.sequenceIndex)
    const existingByID =
      input.questionID?.trim()
        ? await QuestionsRepository.findByID({
            userID: input.userID,
            questionID: input.questionID.trim(),
          })
        : null

    if (existingByID) {
      if (existingByID.studioDocumentID !== binding.studioDocumentID) {
        throw new Error(
          `Question/studio document mismatch: ${existingByID.id} <> ${binding.studioDocumentID}`,
        )
      }
      const updated = await this.update({
        userID: input.userID,
        questionID: existingByID.id,
        content: input.content,
        legendImages: input.legendImages,
        page: input.page,
        studentAnswer: input.studentAnswer,
        canonicalAnswer: input.canonicalAnswer,
        explanation: input.explanation,
        gradingJudgement: input.gradingJudgement,
        gradingPredictedAnswer: input.gradingPredictedAnswer,
        gradingReasoning: input.gradingReasoning,
        gradingConfidence: input.gradingConfidence,
      })
      return {
        studioDocumentID: updated.studioDocumentID,
        sourceDocumentID: updated.sourceDocumentID ?? null,
        question: updated,
      }
    }

    const existingBySequence = await QuestionsRepository.findByStudioDocumentAndSequence({
      userID: input.userID,
      studioDocumentID: binding.studioDocumentID,
      sequenceIndex: normalizedSequenceIndex,
    })
    if (existingBySequence) {
      const updated = await this.update({
        userID: input.userID,
        questionID: existingBySequence.id,
        content: input.content,
        legendImages: input.legendImages,
        page: input.page,
        studentAnswer: input.studentAnswer,
        canonicalAnswer: input.canonicalAnswer,
        explanation: input.explanation,
        gradingJudgement: input.gradingJudgement,
        gradingPredictedAnswer: input.gradingPredictedAnswer,
        gradingReasoning: input.gradingReasoning,
        gradingConfidence: input.gradingConfidence,
      })
      return {
        studioDocumentID: updated.studioDocumentID,
        sourceDocumentID: updated.sourceDocumentID ?? null,
        question: updated,
      }
    }

    const created = await this.create({
      ...input,
      studioDocumentID: binding.studioDocumentID,
      sourceDocumentID: binding.sourceDocumentID,
      sequenceIndex: normalizedSequenceIndex,
    })
    return {
      studioDocumentID: created.studioDocumentID,
      sourceDocumentID: created.sourceDocumentID ?? null,
      question: created,
    }
  },

  async snapshot(input: { userID: string; workroomID: string; studioDocumentID: string }) {
    const questions = await this.listByStudioDocument({
      userID: input.userID,
      studioDocumentID: input.studioDocumentID,
    })
    const binding = await requireStudioDocumentBinding(input)
    return {
      studioDocumentID: binding.studioDocumentID,
      sourceDocumentID: binding.sourceDocumentID,
      title: binding.title,
      status: binding.status,
      questions,
    }
  },

  async remove(input: { userID: string; questionID: string }) {
    await QuestionsRepository.remove(input)
  },
}
