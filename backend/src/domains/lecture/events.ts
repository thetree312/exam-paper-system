import { createLogger } from "../../lib/logger"
import type {
  LectureBlockRecord,
  LectureDraftBlockRecord,
  LectureReasoningDraftRecord,
  LectureSessionRecord,
  LectureVisualizationPatch,
} from "./types"

export type LectureStreamEvent =
  | {
      type: "lecture.session.ready"
      session: LectureSessionRecord
      blocks: LectureBlockRecord[]
      at: string
    }
  | {
      type: "lecture.visualization.updated"
      session: LectureSessionRecord
      mode?: "snapshot" | "patch"
      patches?: LectureVisualizationPatch[]
      snapshotVersion?: string
      at: string
    }
  | {
      type:
        | "lecture.block.appended"
        | "lecture.block.streaming"
        | "lecture.reasoning.streaming"
        | "lecture.highlight.changed"
        | "lecture.resumed"
        | "lecture.completed"
      session: LectureSessionRecord
      block?: LectureBlockRecord
      draftBlock?: LectureDraftBlockRecord | null
      reasoningDraft?: LectureReasoningDraftRecord | null
      at: string
    }
  | {
      type: "question_asked"
      session: LectureSessionRecord
      request: {
        id: string
        session_id: string
        questions: unknown[]
      }
      at: string
    }
  | {
      type: "question_replied" | "question_rejected"
      session: LectureSessionRecord
      requestId: string
      freeText?: (string | null)[]
      at: string
    }

type LectureStreamEventInput =
  | {
      type: "lecture.session.ready"
      session: LectureSessionRecord
      blocks: LectureBlockRecord[]
    }
  | {
      type: "lecture.visualization.updated"
      session: LectureSessionRecord
      mode?: "snapshot" | "patch"
      patches?: LectureVisualizationPatch[]
      snapshotVersion?: string
    }
  | {
      type:
        | "lecture.block.appended"
        | "lecture.block.streaming"
        | "lecture.reasoning.streaming"
        | "lecture.highlight.changed"
        | "lecture.resumed"
        | "lecture.completed"
      session: LectureSessionRecord
      block?: LectureBlockRecord
      draftBlock?: LectureDraftBlockRecord | null
      reasoningDraft?: LectureReasoningDraftRecord | null
    }
  | {
      type: "question_asked"
      session: LectureSessionRecord
      request: {
        id: string
        session_id: string
        questions: unknown[]
      }
    }
  | {
      type: "question_replied" | "question_rejected"
      session: LectureSessionRecord
      requestId: string
      freeText?: (string | null)[]
    }

type LectureListener = (event: LectureStreamEvent) => void | Promise<void>

const listenersBySession = new Map<string, Set<LectureListener>>()
const logger = createLogger({ domain: "lecture-events" })

export const LectureEvents = {
  subscribe(lectureSessionID: string, listener: LectureListener) {
    const bucket = listenersBySession.get(lectureSessionID) ?? new Set<LectureListener>()
    bucket.add(listener)
    listenersBySession.set(lectureSessionID, bucket)
    return () => {
      const current = listenersBySession.get(lectureSessionID)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) listenersBySession.delete(lectureSessionID)
    }
  },

  async publish(lectureSessionID: string, event: LectureStreamEventInput) {
    const listeners = listenersBySession.get(lectureSessionID)
    const next = {
      ...event,
      at: new Date().toISOString(),
    } as LectureStreamEvent
    logger.info("lecture event published", {
      lecture_session_id: lectureSessionID,
      event_type: next.type,
      listeners: listeners?.size ?? 0,
    })
    if (!listeners || listeners.size === 0) return next
    for (const listener of listeners) {
      Promise.resolve(listener(next)).catch(() => {})
    }
    return next
  },
}
