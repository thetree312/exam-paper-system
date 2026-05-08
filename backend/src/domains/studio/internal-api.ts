import { StudioService } from "./service"
import type { StudioQuestionCardRecord } from "./types"
import { WorkroomService } from "../workrooms/service"
import { createLogger } from "../../lib/logger"

type AppendDraft = {
  text: string
  page?: number | null
  originalText?: string | null
  answerText?: string | null
  canonicalAnswer?: string | null
  explanation?: string | null
  legendImages?: string[]
  derivedFromCardID?: string | null
  relationType?: StudioQuestionCardRecord["relationType"]
  originTask?: StudioQuestionCardRecord["originTask"]
}

const logger = createLogger({ domain: "studio-internal-api" })

export const StudioQuestionCardApi = {
  async createStudioDocumentContainer(input: {
    userID: string
    workroomID: string
    sourceDocumentID?: string | null
    title?: string | null
  }) {
    return StudioService.createDocument(input)
  },

  async resolveExistingStudioDocument(input: {
    userID: string
    workroomID: string
    studioDocumentID?: string | null
    sourceDocumentID?: string | null
  }) {
    logger.info("resolve existing studio document start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID ?? null,
      source_document_id: input.sourceDocumentID ?? null,
    })
    if (input.studioDocumentID) {
      const explicit = await StudioService.getDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: input.studioDocumentID,
      })
      if (!explicit) {
        throw new Error(`TARGET_STUDIO_DOCUMENT_NOT_FOUND: ${input.studioDocumentID}`)
      }
      return {
        studioDocument: explicit,
        resolvedBy: "explicit",
      } as const
    }

    const runtimeState = await WorkroomService.getRuntimeState({
      userID: input.userID,
      workroomID: input.workroomID,
    }).catch(() => null)

    const activeStudioDocumentID = runtimeState?.active_studio_document_id ?? null
    if (activeStudioDocumentID) {
      const active = await StudioService.getDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: String(activeStudioDocumentID),
      })
      if (active) {
        logger.info("resolve existing studio document hit runtime active", {
          user_id: input.userID,
          workroom_id: input.workroomID,
          studio_document_id: active.id,
        })
        return {
          studioDocument: active,
          resolvedBy: "runtime_active",
        } as const
      }
    }

    if (input.sourceDocumentID) {
      const bySource = await StudioService.listDocuments({
        userID: input.userID,
        workroomID: input.workroomID,
        sourceDocumentID: input.sourceDocumentID,
      })
      if (bySource[0]) {
        logger.info("resolve existing studio document hit source document", {
          user_id: input.userID,
          workroom_id: input.workroomID,
          studio_document_id: bySource[0].id,
          source_document_id: input.sourceDocumentID,
        })
        return {
          studioDocument: bySource[0],
          resolvedBy: "source_document",
        } as const
      }
      throw new Error(`TARGET_STUDIO_DOCUMENT_NOT_FOUND_FOR_SOURCE: ${input.sourceDocumentID}`)
    }

    const latest = (await StudioService.listDocuments({
      userID: input.userID,
      workroomID: input.workroomID,
    }))[0]
    if (latest) {
      logger.info("resolve existing studio document hit latest in workroom", {
        user_id: input.userID,
        workroom_id: input.workroomID,
        studio_document_id: latest.id,
      })
      return {
        studioDocument: latest,
        resolvedBy: "latest_in_workroom",
      } as const
    }
    throw new Error("TARGET_STUDIO_DOCUMENT_UNRESOLVED: no existing studio document in this workroom")
  },

  async resolveTargetStudioDocument(input: {
    userID: string
    workroomID: string
    studioDocumentID?: string | null
    sourceDocumentID?: string | null
    title?: string | null
  }) {
    logger.info("resolve target studio document start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID ?? null,
      source_document_id: input.sourceDocumentID ?? null,
      has_title: Boolean(input.title),
    })
    if (input.studioDocumentID) {
      const explicit = await StudioService.getDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: input.studioDocumentID,
      })
      if (!explicit) {
        throw new Error(`TARGET_STUDIO_DOCUMENT_NOT_FOUND: ${input.studioDocumentID}`)
      }
      return {
        studioDocument: explicit,
        resolvedBy: "explicit",
      } as const
    }

    const runtimeState = await WorkroomService.getRuntimeState({
      userID: input.userID,
      workroomID: input.workroomID,
    }).catch(() => null)

    const activeStudioDocumentID = runtimeState?.active_studio_document_id ?? null
    if (activeStudioDocumentID) {
      const active = await StudioService.getDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        studioDocumentID: String(activeStudioDocumentID),
      })
      if (active) {
        return {
          studioDocument: active,
          resolvedBy: "runtime_active",
        } as const
      }
    }

    if (input.sourceDocumentID) {
      const bySource = await StudioService.listDocuments({
        userID: input.userID,
        workroomID: input.workroomID,
        sourceDocumentID: input.sourceDocumentID,
      })
      if (bySource[0]) {
        return {
          studioDocument: bySource[0],
          resolvedBy: "source_document",
        } as const
      }
      const created = await StudioService.createDocument({
        userID: input.userID,
        workroomID: input.workroomID,
        sourceDocumentID: input.sourceDocumentID,
        title: input.title ?? null,
      })
      return {
        studioDocument: created,
        resolvedBy: "created_from_source",
      } as const
    }

    const latest = (await StudioService.listDocuments({
      userID: input.userID,
      workroomID: input.workroomID,
    }))[0]
    if (latest) {
      return {
        studioDocument: latest,
        resolvedBy: "latest_in_workroom",
      } as const
    }

    throw new Error("TARGET_STUDIO_DOCUMENT_UNRESOLVED: provide sourceDocumentID or create a studio document first")
  },

  async getStudioDocument(input: { userID: string; workroomID: string; studioDocumentID: string }) {
    return StudioService.getDocument(input)
  },

  async listStudioQuestionCards(input: { userID: string; workroomID: string; studioDocumentID: string }) {
    return StudioService.listQuestionCards(input)
  },

  async getStudioQuestionCard(input: { userID: string; workroomID: string; cardID: string }) {
    return StudioService.getQuestionCardDetail(input)
  },

  async appendStudioQuestionCards(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    drafts: AppendDraft[]
  }) {
    return StudioService.appendQuestionCards(input)
  },

  async insertStudioQuestionCards(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    anchorCardID: string
    position: "before" | "after"
    drafts: AppendDraft[]
  }) {
    return StudioService.insertQuestionCards(input)
  },

  async updateStudioQuestionCard(input: {
    userID: string
    workroomID: string
    cardID: string
    text?: string
    answerText?: string
    canonicalAnswer?: string | null
    explanation?: string | null
    legendImages?: string[]
    derivedFromCardID?: string | null
    relationType?: StudioQuestionCardRecord["relationType"]
    originTask?: StudioQuestionCardRecord["originTask"]
  }) {
    return StudioService.updateQuestionCard(input)
  },

  async writeStudioQuestionExplanation(input: {
    userID: string
    workroomID: string
    cardID: string
    explanation: string
  }) {
    return StudioService.writeQuestionExplanation(input)
  },

  async attachDerivedPracticeCards(input: {
    userID: string
    workroomID: string
    sourceCardID: string
    createdCardIDs: string[]
  }) {
    return StudioService.attachDerivedPracticeCards(input)
  },
}
