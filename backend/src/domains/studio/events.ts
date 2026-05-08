import { StudioRevisionRepository } from "./revision-repository"
import { createLogger } from "../../lib/logger"

export type StudioCardsChangedEvent = {
  type: "studio.cards.changed"
  userID: string
  workroomID: string
  studioDocumentID: string
  revision: number
  reason: "create" | "insert" | "update" | "delete" | "import" | "recognize" | "attach" | "explanation"
  cardIDs?: string[]
  anchorCardID?: string | null
  position?: "before" | "after" | null
  at: string
}

type StudioEventListener = (event: StudioCardsChangedEvent) => void | Promise<void>

const listenersByWorkroom = new Map<string, Set<StudioEventListener>>()
const logger = createLogger({ domain: "studio-events" })

function keyOf(input: { userID: string; workroomID: string }) {
  return `${input.userID}:${input.workroomID}`
}

export const StudioEvents = {
  subscribe(input: { userID: string; workroomID: string }, listener: StudioEventListener) {
    const key = keyOf(input)
    let listeners = listenersByWorkroom.get(key)
    if (!listeners) {
      listeners = new Set()
      listenersByWorkroom.set(key, listeners)
    }
    listeners.add(listener)
    logger.info("studio event listener subscribed", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      listeners: listeners.size,
    })
    return () => {
      const scoped = listenersByWorkroom.get(key)
      if (!scoped) return
      scoped.delete(listener)
      logger.info("studio event listener unsubscribed", {
        user_id: input.userID,
        workroom_id: input.workroomID,
        listeners: scoped.size,
      })
      if (scoped.size === 0) listenersByWorkroom.delete(key)
    }
  },

  async publishChanged(input: Omit<StudioCardsChangedEvent, "type" | "revision" | "at">) {
    const revision = await StudioRevisionRepository.bump({
      workroomID: input.workroomID,
      studioDocumentID: input.studioDocumentID,
    })
    const event: StudioCardsChangedEvent = {
      ...input,
      type: "studio.cards.changed",
      revision,
      at: new Date().toISOString(),
    }
    const key = keyOf({ userID: input.userID, workroomID: input.workroomID })
    const listeners = listenersByWorkroom.get(key)
    logger.info("studio cards changed published", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID,
      revision,
      reason: input.reason,
      card_ids: input.cardIDs ?? [],
      anchor_card_id: input.anchorCardID ?? null,
      position: input.position ?? null,
      listeners: listeners?.size ?? 0,
    })
    if (!listeners || listeners.size === 0) return event
    for (const listener of listeners) {
      Promise.resolve(listener(event)).catch(() => {})
    }
    return event
  },
}
