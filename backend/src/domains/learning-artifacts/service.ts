import { createID } from "../../lib/ids"
import { WorkroomService } from "../workrooms/service"
import { FlashcardGenerationService } from "./flashcard-generation-service"
import { MindmapGenerationService } from "./mindmap-generation-service"
import { LearningArtifactsRepository } from "./repository"
import type {
  ArtifactGenerationSource,
  ArtifactLinkage,
  ArtifactType,
  FlashcardPayload,
  LearningArtifactRecord,
  MindmapPayload,
  QuestionCardPayload,
} from "./types"

function normalizeLinkage(input?: Partial<ArtifactLinkage>): ArtifactLinkage {
  return {
    wikiPaths: Array.from(new Set((input?.wikiPaths ?? []).map((item) => item.trim()).filter(Boolean))),
    documentIDs: Array.from(new Set((input?.documentIDs ?? []).map((item) => item.trim()).filter(Boolean))),
    documentBlocks: (input?.documentBlocks ?? [])
      .filter((block) => block.documentID.trim())
      .map((block) => ({
        documentID: block.documentID.trim(),
        pageNumber: block.pageNumber,
        layoutUnitKey: block.layoutUnitKey?.trim() || undefined,
      })),
    agentSessionIDs: Array.from(new Set((input?.agentSessionIDs ?? []).map((item) => item.trim()).filter(Boolean))),
  }
}

function assertQuestionCardPayload(payload: QuestionCardPayload) {
  if (!payload.title.trim()) throw new Error("Question card title is required")
  if (!payload.prompt.trim()) throw new Error("Question card prompt is required")
  if (!payload.answer.trim()) throw new Error("Question card answer is required")
}

function assertMindmapPayload(payload: MindmapPayload) {
  if (!payload.title.trim()) throw new Error("Mindmap title is required")
  if (payload.nodes.length === 0) throw new Error("Mindmap must contain at least one node")
  if (payload.edges.length === 0) throw new Error("Mindmap must contain at least one edge")
}

function assertFlashcardPayload(payload: FlashcardPayload) {
  if (!payload.title.trim()) throw new Error("Flashcard title is required")
  if (!payload.front.trim()) throw new Error("Flashcard front is required")
  if (!payload.back.trim()) throw new Error("Flashcard back is required")
}

function intervalDaysForBucket(bucket: number) {
  if (bucket <= 0) return 1
  if (bucket === 1) return 2
  if (bucket === 2) return 4
  if (bucket === 3) return 7
  if (bucket === 4) return 14
  if (bucket === 5) return 30
  return 60
}

function masteryStateForBucket(bucket: number | null) {
  if (bucket === null) return "new" as const
  if (bucket >= 4) return "mastered" as const
  if (bucket >= 1) return "reviewing" as const
  return "struggling" as const
}

function nextReviewDate(bucket: number) {
  const now = new Date()
  return new Date(now.getTime() + intervalDaysForBucket(bucket) * 24 * 60 * 60 * 1000).toISOString()
}

async function assertWorkroom(userID: string, workroomID: string) {
  const workroom = await WorkroomService.getByUser(userID, workroomID)
  if (!workroom) throw new Error(`Workroom not found: ${workroomID}`)
  return workroom
}

async function persistArtifact(record: LearningArtifactRecord) {
  await WorkroomService.upsertArtifact({
    userID: record.userID,
    workroomID: record.workroomID,
    artifactType: record.type,
    artifactRefID: record.id,
    documentID: record.linkage.documentIDs[0] ?? null,
    payloadJson: {
      linkage: record.linkage,
      payload: record.payload,
    },
  })
}

function createRecord(input: {
  userID: string
  workroomID: string
  type: ArtifactType
  linkage?: Partial<ArtifactLinkage>
  payload: QuestionCardPayload | MindmapPayload | FlashcardPayload
}) {
  const now = new Date().toISOString()
  return {
    id: createID("artifact"),
    userID: input.userID,
    workroomID: input.workroomID,
    type: input.type,
    linkage: normalizeLinkage(input.linkage),
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
  } satisfies LearningArtifactRecord
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

export const LearningArtifactsService = {
  async listByWorkroom(input: { userID: string; workroomID: string; type?: ArtifactType }) {
    return LearningArtifactsRepository.listByWorkroom(input)
  },

  async getByWorkroom(input: { userID: string; workroomID: string; artifactID: string }) {
    return LearningArtifactsRepository.getByWorkroom(input)
  },

  async createQuestionCard(input: {
    userID: string
    workroomID: string
    payload: QuestionCardPayload
    linkage?: Partial<ArtifactLinkage>
  }) {
    await assertWorkroom(input.userID, input.workroomID)
    assertQuestionCardPayload(input.payload)
    const record = createRecord({
      userID: input.userID,
      workroomID: input.workroomID,
      type: "question_card",
      linkage: input.linkage,
      payload: input.payload,
    })
    await LearningArtifactsRepository.update((state) => {
      state.items.push(record)
    })
    await persistArtifact(record)
    return record
  },

  async createMindmap(input: {
    userID: string
    workroomID: string
    payload: MindmapPayload
    linkage?: Partial<ArtifactLinkage>
  }) {
    await assertWorkroom(input.userID, input.workroomID)
    assertMindmapPayload(input.payload)
    const record = createRecord({
      userID: input.userID,
      workroomID: input.workroomID,
      type: "mindmap",
      linkage: input.linkage,
      payload: input.payload,
    })
    await LearningArtifactsRepository.update((state) => {
      state.items.push(record)
    })
    await persistArtifact(record)
    return record
  },

  async createFlashcard(input: {
    userID: string
    workroomID: string
    payload: Omit<FlashcardPayload, "masteryState" | "bucket" | "lastScore" | "nextReviewAt" | "lastReviewedAt" | "reviewCount"> & {
      nextReviewAt?: string | null
      lastReviewedAt?: string | null
      reviewCount?: number
      conceptTag?: string
      confidence?: number | null
      sourceRef?: FlashcardPayload["sourceRef"]
    }
    linkage?: Partial<ArtifactLinkage>
  }) {
    await assertWorkroom(input.userID, input.workroomID)
    const payload: FlashcardPayload = {
      ...input.payload,
      masteryState: "new",
      bucket: null,
      lastScore: null,
      nextReviewAt: input.payload.nextReviewAt ?? null,
      lastReviewedAt: input.payload.lastReviewedAt ?? null,
      reviewCount: input.payload.reviewCount ?? 0,
    }
    assertFlashcardPayload(payload)
    const record = createRecord({
      userID: input.userID,
      workroomID: input.workroomID,
      type: "flashcard",
      linkage: input.linkage,
      payload,
    })
    await LearningArtifactsRepository.update((state) => {
      state.items.push(record)
    })
    await persistArtifact(record)
    return record
  },

  async update(input: {
    userID: string
    workroomID: string
    artifactID: string
    linkage?: Partial<ArtifactLinkage>
    payload?: Partial<QuestionCardPayload & MindmapPayload & FlashcardPayload>
  }) {
    let updated: LearningArtifactRecord | undefined
    await LearningArtifactsRepository.update((state) => {
      const record = state.items.find(
        (item) =>
          item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.artifactID,
      )
      if (!record) throw new Error(`Learning artifact not found: ${input.artifactID}`)

      if (input.linkage) {
        record.linkage = normalizeLinkage({
          ...record.linkage,
          ...input.linkage,
        })
      }

      if (input.payload) {
        record.payload = {
          ...record.payload,
          ...input.payload,
        } as LearningArtifactRecord["payload"]
      }

      if (record.type === "question_card") assertQuestionCardPayload(record.payload as QuestionCardPayload)
      if (record.type === "mindmap") assertMindmapPayload(record.payload as MindmapPayload)
      if (record.type === "flashcard") assertFlashcardPayload(record.payload as FlashcardPayload)

      record.updatedAt = new Date().toISOString()
      updated = record
    })

    if (!updated) throw new Error(`Learning artifact not found: ${input.artifactID}`)
    await persistArtifact(updated)
    return updated
  },

  async reviewFlashcard(input: { userID: string; workroomID: string; artifactID: string; score: 0 | 1 | 2 }) {
    let updated: LearningArtifactRecord | undefined
    await LearningArtifactsRepository.update((state) => {
      const record = state.items.find(
        (item) =>
          item.userID === input.userID && item.workroomID === input.workroomID && item.id === input.artifactID,
      )
      if (!record) throw new Error(`Learning artifact not found: ${input.artifactID}`)
      if (record.type !== "flashcard") throw new Error(`Artifact is not a flashcard: ${input.artifactID}`)

      const payload = record.payload as FlashcardPayload
      const currentBucket = payload.bucket ?? 0
      let nextBucket = currentBucket
      if (input.score === 0) nextBucket = 0
      if (input.score === 1) nextBucket = currentBucket
      if (input.score === 2) nextBucket = Math.min(currentBucket + 1, 6)
      payload.lastReviewedAt = new Date().toISOString()
      payload.bucket = nextBucket
      payload.lastScore = input.score
      payload.masteryState = masteryStateForBucket(nextBucket)
      payload.nextReviewAt = nextReviewDate(nextBucket)
      payload.reviewCount += 1
      record.updatedAt = payload.lastReviewedAt
      updated = record
    })

    if (!updated) throw new Error(`Learning artifact not found: ${input.artifactID}`)
    await persistArtifact(updated)
    return updated
  },

  async listDueFlashcards(input: { userID: string; workroomID: string; documentID?: string; limit: number }) {
    const now = Date.now()
    const items = await LearningArtifactsRepository.listByWorkroom({
      userID: input.userID,
      workroomID: input.workroomID,
      type: "flashcard",
    })
    return items
      .filter((item) => !input.documentID || item.linkage.documentIDs.includes(input.documentID))
      .filter((item) => {
        const payload = item.payload as FlashcardPayload
        if (!payload.lastReviewedAt) return true
        if (!payload.nextReviewAt) return true
        return new Date(payload.nextReviewAt).getTime() <= now
      })
      .sort((left, right) => {
        const leftPayload = left.payload as FlashcardPayload
        const rightPayload = right.payload as FlashcardPayload
        if (!leftPayload.lastReviewedAt && rightPayload.lastReviewedAt) return -1
        if (leftPayload.lastReviewedAt && !rightPayload.lastReviewedAt) return 1
        return (leftPayload.nextReviewAt ?? "").localeCompare(rightPayload.nextReviewAt ?? "")
      })
      .slice(0, input.limit)
  },

  async getFlashcardStats(input: { userID: string; workroomID: string; documentID?: string }) {
    const items = await LearningArtifactsRepository.listByWorkroom({
      userID: input.userID,
      workroomID: input.workroomID,
      type: "flashcard",
    })
    const filtered = items.filter((item) => !input.documentID || item.linkage.documentIDs.includes(input.documentID))

    const now = Date.now()
    let neverReviewed = 0
    let mastered = 0
    let reviewing = 0
    let struggling = 0
    let dueToday = 0

    for (const item of filtered) {
      const payload = item.payload as FlashcardPayload
      if (!payload.lastReviewedAt) {
        neverReviewed += 1
        dueToday += 1
        continue
      }

      if (payload.masteryState === "mastered") mastered += 1
      else if (payload.masteryState === "reviewing") reviewing += 1
      else struggling += 1

      if (!payload.nextReviewAt || new Date(payload.nextReviewAt).getTime() <= now) {
        dueToday += 1
      }
    }

    return {
      total: filtered.length,
      neverReviewed,
      mastered,
      reviewing,
      struggling,
      dueToday,
    }
  },

  async escalateFlashcard(input: { userID: string; workroomID: string; artifactID: string; userNote?: string }) {
    const item = await this.getByWorkroom({
      userID: input.userID,
      workroomID: input.workroomID,
      artifactID: input.artifactID,
    })
    if (!item) throw new Error(`Learning artifact not found: ${input.artifactID}`)
    if (item.type !== "flashcard") throw new Error(`Artifact is not a flashcard: ${input.artifactID}`)
    const payload = item.payload as FlashcardPayload
    return {
      escalated: true,
      artifactID: item.id,
      title: payload.title,
      front: payload.front,
      back: payload.back,
      hint: payload.hint ?? null,
      message: `已将闪卡「${payload.title}」提交给学习教练继续辅导。`,
      context: {
        workroomID: item.workroomID,
        linkage: item.linkage,
        userNote: input.userNote?.trim() || null,
      },
    }
  },

  async getCurrentMindmap(input: {
    userID: string
    workroomID: string
    documentID?: string
    documentIDs?: string[]
    wikiPath?: string
    wikiPaths?: string[]
    studioDocumentID?: string
  }) {
    const items = await this.listByWorkroom({
      userID: input.userID,
      workroomID: input.workroomID,
      type: "mindmap",
    })

    const filterDocumentIDs = Array.from(new Set([input.documentID, ...(input.documentIDs ?? [])].filter(Boolean) as string[])).sort((left, right) => left.localeCompare(right))
    const filterWikiPaths = Array.from(new Set([input.wikiPath, ...(input.wikiPaths ?? [])].filter(Boolean) as string[])).sort((left, right) => left.localeCompare(right))

    const filtered = items.filter((item) => {
      const payload = item.payload as MindmapPayload
      const generatedFrom = payload.generatedFrom
      if (input.studioDocumentID && generatedFrom?.studioDocumentID !== input.studioDocumentID) return false
      if (filterDocumentIDs.length > 0 && !sameStringSet([...item.linkage.documentIDs].sort(), filterDocumentIDs)) return false
      if (filterWikiPaths.length > 0 && !sameStringSet([...item.linkage.wikiPaths].sort(), filterWikiPaths)) return false
      return true
    })

    return filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  },

  async generateFlashcards(input: {
    userID: string
    workroomID: string
    documentID: string
    maxCards: number
    force: boolean
  }) {
    await assertWorkroom(input.userID, input.workroomID)
    if (!input.force) {
      const existing = (await this.listByWorkroom({
        userID: input.userID,
        workroomID: input.workroomID,
        type: "flashcard",
      })).filter((item) => item.linkage.documentIDs.includes(input.documentID))
      if (existing.length > 0) {
        return {
          mode: "cached",
          generatedCount: existing.length,
          items: existing,
        }
      }
    } else {
      await LearningArtifactsRepository.update((state) => {
        state.items = state.items.filter(
          (item) =>
            !(
              item.userID === input.userID &&
              item.workroomID === input.workroomID &&
              item.type === "flashcard" &&
              item.linkage.documentIDs.includes(input.documentID)
            ),
        )
      })
    }

    const generated = await FlashcardGenerationService.generate(input)
    const created: LearningArtifactRecord[] = []
    for (const item of generated.items) {
      created.push(
        await this.createFlashcard({
          userID: input.userID,
          workroomID: input.workroomID,
          linkage: {
            wikiPaths: [],
            documentIDs: item.sourceRef?.documentID ? [item.sourceRef.documentID] : [input.documentID],
            documentBlocks:
              item.sourceRef?.page !== undefined && item.sourceRef.page !== null
                ? [
                    {
                      documentID: item.sourceRef.documentID,
                      pageNumber: item.sourceRef.page,
                    },
                  ]
                : [],
            agentSessionIDs: [],
          },
          payload: {
            title: item.title,
            front: item.front,
            back: item.back,
            hint: item.hint,
            conceptTag: item.conceptTag,
            confidence: item.confidence,
            sourceRef: item.sourceRef,
          },
        }),
      )
    }

    return {
      mode: "generated",
      generatedCount: created.length,
      items: created,
    }
  },

  async generateMindmap(input: {
    userID: string
    workroomID: string
    source: ArtifactGenerationSource
    mode: "knowledge_structure" | "exam_review"
    force: boolean
  }) {
    await assertWorkroom(input.userID, input.workroomID)

    const current = await this.getCurrentMindmap({
      userID: input.userID,
      workroomID: input.workroomID,
      documentID: input.source.type === "document" ? input.source.documentID : undefined,
      documentIDs: input.source.type === "document" ? input.source.documentIDs : undefined,
      wikiPath: input.source.type === "wiki_file" ? input.source.wikiPath : undefined,
      wikiPaths: input.source.type === "wiki_file" ? input.source.wikiPaths : undefined,
      studioDocumentID: input.source.type === "studio_document" ? input.source.studioDocumentID : undefined,
    })

    if (current && !input.force) {
      return {
        mode: "cached",
        item: current,
      }
    }

    const payload = await MindmapGenerationService.generate(input)
    const created = await this.createMindmap({
      userID: input.userID,
      workroomID: input.workroomID,
      payload,
      linkage: {
        wikiPaths: payload.generatedFrom?.wikiPaths ?? [],
        documentIDs: payload.generatedFrom?.documentIDs ?? [],
        documentBlocks: [],
        agentSessionIDs: [],
      },
    })

    return {
      mode: current ? "regenerated" : "generated",
      item: created,
    }
  },
}
