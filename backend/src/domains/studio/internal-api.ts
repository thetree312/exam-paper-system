import { StudioService } from "./service"
import { WorkroomService } from "../workrooms/service"
import { createLogger } from "../../lib/logger"

const logger = createLogger({ domain: "studio-internal-api" })

export const StudioQuestionCardApi = {
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

  async getStudioDocument(input: { userID: string; workroomID: string; studioDocumentID: string }) {
    return StudioService.getDocument(input)
  },

  async listStudioDocuments(input: { userID: string; workroomID: string; sourceDocumentID?: string }) {
    return StudioService.listDocuments(input)
  },

  async listStudioQuestionCards(input: { userID: string; workroomID: string; studioDocumentID: string }) {
    return StudioService.listQuestionCards(input)
  },

  async searchStudioQuestionCards(input: { userID: string; workroomID: string; studioDocumentID: string; query: string }) {
    return StudioService.searchQuestionCards(input)
  },

  async getStudioQuestionCard(input: { userID: string; workroomID: string; cardID: string; full?: boolean }) {
    return StudioService.getQuestionCardDetail(input)
  },
}
