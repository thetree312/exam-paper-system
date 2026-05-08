import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AggregatedOcrItem,
  AgUiEvent,
  AgUiQuestionInsertEvent,
  AgUiQuestionReplaceEvent,
  GradeRunRequest,
  GradingJudgement,
  SelectionBox,
  UserInfo,
  RegionPayload,
  LegendRegionPayload,
  StatusMessageSetter,
} from '../types'
import { useAppStore } from '../store/appStore'
import { requestGrading, requestSplitQuestions } from '../services/agentApi'
import { submitProblemCardAnswer } from '../services/problemCardsApi'
import {
  deleteStudioQuestionCard,
  listStudioQuestionCardsWithRevision,
  recognizeStudioSelection,
  updateStudioQuestionCard,
} from '../services/studioApi'
import { createTextMathDocument, mathContentToPromptText, type MathContentDocument } from '../lib/mathContent'
import { buildOcrItemFromStudioQuestionCard } from '../utils/studioQuestionCards'
import { getAuthToken } from '../utils/secureStorage'

type SelectionSnapshot = {
  selection: SelectionBox | null
  buildRegionsPayload: () => RegionPayload[] | null
  buildLegendsPayload: () => LegendRegionPayload[] | null
  clearSelection?: () => void
}

type PendingStudioHighlight = {
  cardIDs: string[]
  variant: 'insert'
  expiresAt: number
}

type MaybeWrappedAgUiEvent = AgUiEvent | { type?: string; event?: AgUiEvent }
type GradingDisplayResult = {
  judgement: GradingJudgement
  predictedAnswer?: string | null
  reasoning?: string | null
  confidence?: number | null
  rawResponse?: string | null
  error?: string | null
}

interface UseOcrManagerReturn {
  ocrItems: AggregatedOcrItem[]
  setOcrItems: (items: AggregatedOcrItem[] | ((prev: AggregatedOcrItem[]) => AggregatedOcrItem[])) => void
  isExtracting: boolean
  setIsExtracting: (extracting: boolean) => void
  isGrading: boolean
  setIsGrading: (grading: boolean) => void
  splittingItemId: string | null
  setSplittingItemId: (id: string | null) => void
  selectionSnapshotRef: React.MutableRefObject<SelectionSnapshot | null>
  handleSelectionSnapshotChange: (snapshot: SelectionSnapshot) => void
  handleAddToEditor: (
    sessionId: string | null,
    activeFile: any,
    snapshot: SelectionSnapshot | null,
  ) => Promise<string | null>
  handleOcrItemUpdate: (id: string, updater: (item: AggregatedOcrItem) => AggregatedOcrItem) => void
  handleOcrItemDelete: (id: string) => void
  handleAnswerChange: (id: string, value: MathContentDocument) => void
  handleSplitOcrItem: (target: AggregatedOcrItem, index: number, user: UserInfo | null) => Promise<void>
  handleSubmitGrading: (
    currentFile: any,
    studioDocumentId: string | null,
    sourceDocumentId: string | null,
    user: UserInfo | null,
  ) => Promise<void>
  handleAgUiEvent: (incoming: MaybeWrappedAgUiEvent) => void
}

export const useOcrManager = (
  backendBaseUrl: string,
  onStatusMessage: StatusMessageSetter,
  onToast: (message: string, type: 'info' | 'success' | 'error') => void,
  studioDocumentId: string | null,
): UseOcrManagerReturn => {
  const { t } = useTranslation('common')
  const storeOcrItems = useAppStore((state) => state.ocrItems)
  const setStoreOcrItems = useAppStore((state) => state.setOcrItems)
  const workroom = useAppStore((state) => state.workroom)

  const [isExtracting, setIsExtracting] = useState(false)
  const [isGrading, setIsGrading] = useState(false)
  const [splittingItemId, setSplittingItemId] = useState<string | null>(null)

  const ocrItemsRef = useRef<AggregatedOcrItem[]>([])
  const selectionSnapshotRef = useRef<SelectionSnapshot | null>(null)
  const revisionByStudioDocumentRef = useRef<Record<string, number>>({})
  const pendingHighlightsByStudioDocumentRef = useRef<Record<string, PendingStudioHighlight[]>>({})
  const shinyClearTimersRef = useRef<Record<string, number>>({})

  useEffect(() => {
    ocrItemsRef.current = storeOcrItems
  }, [storeOcrItems])

  useEffect(() => {
    if (!workroom?.id) return
    const token = getAuthToken()
    if (!token) return

    const url = `${backendBaseUrl}/api/studio/events?workroom_id=${encodeURIComponent(String(workroom.id))}&access_token=${encodeURIComponent(token)}`
    const eventSource = new EventSource(url)
    console.info('[studio.events] subscribe', {
      workroomID: String(workroom.id),
      studioDocumentId,
      url,
    })

    const refreshForDocument = (targetStudioDocumentID: string, minRevision?: number) => {
      if (!targetStudioDocumentID) return
      if (studioDocumentId && studioDocumentId !== targetStudioDocumentID) {
        console.info('[studio.events] skip refresh due to active studioDocument mismatch', {
          activeStudioDocumentID: studioDocumentId,
          targetStudioDocumentID,
        })
        return
      }
      console.info('[studio.events] refresh cards start', {
        targetStudioDocumentID,
        activeStudioDocumentID: studioDocumentId ?? null,
        minRevision: minRevision ?? null,
      })
      void listStudioQuestionCardsWithRevision(backendBaseUrl, {
        workroomID: String(workroom.id),
        studioDocumentID: targetStudioDocumentID,
      })
        .then((snapshot) => {
          const cards = snapshot.items ?? []
          const revision = snapshot.revision ?? 0
          const knownRevision = revisionByStudioDocumentRef.current[targetStudioDocumentID] ?? 0
          if (typeof minRevision === 'number' && revision < minRevision) {
            console.info('[studio.events] snapshot older than expected revision, ignore update', {
              targetStudioDocumentID,
              receivedRevision: revision,
              minRevision,
              knownRevision,
            })
            return
          }
          revisionByStudioDocumentRef.current[targetStudioDocumentID] = Math.max(knownRevision, revision)
          const fallbackFileName =
            ocrItemsRef.current.find((item) => item.documentContext?.studioDocumentID === targetStudioDocumentID)?.fileName ?? '题卡集'
          const existingByID = new Map(
            ocrItemsRef.current
              .filter((item) => item.documentContext?.studioDocumentID === targetStudioDocumentID)
              .map((item) => [item.id, item]),
          )
          const now = Date.now()
          const pendingHighlights = (pendingHighlightsByStudioDocumentRef.current[targetStudioDocumentID] ?? []).filter(
            (item) => item.expiresAt > now,
          )
          const pendingHighlightByCardID = new Map<string, PendingStudioHighlight['variant']>()
          for (const pending of pendingHighlights) {
            for (const cardID of pending.cardIDs) {
              pendingHighlightByCardID.set(cardID, pending.variant)
            }
          }
          pendingHighlightsByStudioDocumentRef.current[targetStudioDocumentID] = pendingHighlights
          setStoreOcrItems(
            cards
              .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
              .map((card) => {
                const existing = existingByID.get(card.id)
                const pendingVariant = pendingHighlightByCardID.get(card.id)
                const mapped = buildOcrItemFromStudioQuestionCard({
                  card,
                  fileName: existing?.fileName ?? fallbackFileName,
                })
                const existingShinyUntil =
                  existing?.uiState?.shinyUntil && existing.uiState.shinyUntil > now
                    ? existing.uiState.shinyUntil
                    : undefined
                const existingVariant = existing?.uiState?.variant
                const nextShinyUntil = pendingVariant ? now + 2600 : existingShinyUntil
                return {
                  ...mapped,
                  uiState:
                    nextShinyUntil || existingVariant
                      ? {
                          shinyUntil: nextShinyUntil,
                          variant: pendingVariant ?? existingVariant,
                        }
                      : undefined,
                }
              }),
          )
          if (pendingHighlightByCardID.size > 0) {
            pendingHighlightsByStudioDocumentRef.current[targetStudioDocumentID] = []
            const highlightedCardIDs = [...pendingHighlightByCardID.keys()]
            for (const cardID of highlightedCardIDs) {
              const timerKey = `${targetStudioDocumentID}:${cardID}`
              const existingTimer = shinyClearTimersRef.current[timerKey]
              if (existingTimer) {
                window.clearTimeout(existingTimer)
              }
              shinyClearTimersRef.current[timerKey] = window.setTimeout(() => {
                console.info('[studio.events] clearing legacy question-card shiny effect', {
                  targetStudioDocumentID,
                  cardID,
                })
                setStoreOcrItems((prev) =>
                  prev.map((item) => {
                    if (item.id !== cardID || item.documentContext?.studioDocumentID !== targetStudioDocumentID) {
                      return item
                    }
                    if (!item.uiState) return item
                    return {
                      ...item,
                      uiState: undefined,
                    }
                  }),
                )
                delete shinyClearTimersRef.current[timerKey]
              }, 2800)
            }
          }
          console.info('[studio.events] applied legacy question-card shiny effect', {
            targetStudioDocumentID,
            highlightedCardIDs: [...pendingHighlightByCardID.keys()],
          })
          console.info('[studio.events] refresh cards completed', {
            targetStudioDocumentID,
            revision,
            cardCount: cards.length,
          })
        })
        .catch((error) => {
          console.error('[studio.events] failed to refresh cards', error)
        })
    }

    if (studioDocumentId) {
      refreshForDocument(studioDocumentId)
    }

    eventSource.addEventListener('studio.cards.changed', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data ?? '{}') as {
          studioDocumentID?: string
          revision?: number
          reason?: string
          cardIDs?: string[]
        }
        console.info('[studio.events] received studio.cards.changed', payload)
        if (!payload?.studioDocumentID) return
        if (
          (payload.reason === 'insert' || payload.reason === 'create') &&
          Array.isArray(payload.cardIDs) &&
          payload.cardIDs.length > 0
        ) {
          const nextPending = pendingHighlightsByStudioDocumentRef.current[payload.studioDocumentID] ?? []
          nextPending.push({
            cardIDs: payload.cardIDs.map((item) => String(item)),
            variant: 'insert',
            expiresAt: Date.now() + 10000,
          })
          pendingHighlightsByStudioDocumentRef.current[payload.studioDocumentID] = nextPending
          console.info('[studio.events] queued legacy question-card shiny effect', {
            studioDocumentID: payload.studioDocumentID,
            reason: payload.reason,
            cardIDs: payload.cardIDs,
          })
        }
        const changedRevision = typeof payload.revision === 'number' && Number.isFinite(payload.revision) ? payload.revision : undefined
        if (changedRevision != null) {
          const knownRevision = revisionByStudioDocumentRef.current[payload.studioDocumentID] ?? 0
          revisionByStudioDocumentRef.current[payload.studioDocumentID] = Math.max(knownRevision, changedRevision)
          if (knownRevision >= changedRevision) {
            console.info('[studio.events] revision already applied, skip refresh', {
              studioDocumentID: payload.studioDocumentID,
              knownRevision,
              changedRevision,
            })
            return
          }
        }
        refreshForDocument(payload.studioDocumentID, changedRevision)
      } catch (error) {
        console.error('[studio.events] invalid event payload', error)
      }
    })

    eventSource.onerror = () => {
      console.warn('[studio.events] event source error, browser will retry')
      // let browser retry automatically
    }

    return () => {
      console.info('[studio.events] unsubscribe', {
        workroomID: String(workroom.id),
        studioDocumentId,
      })
      for (const timer of Object.values(shinyClearTimersRef.current)) {
        window.clearTimeout(timer)
      }
      shinyClearTimersRef.current = {}
      eventSource.close()
    }
  }, [backendBaseUrl, workroom?.id, studioDocumentId, setStoreOcrItems])

  const handleSelectionSnapshotChange = useCallback((snapshot: SelectionSnapshot) => {
    selectionSnapshotRef.current = snapshot
  }, [])

  const handleAddToEditor = useCallback(
    async (_sessionId: string | null, activeFile: any, snapshot: SelectionSnapshot | null) => {
      if (!snapshot || !snapshot.selection || snapshot.selection.segments.length === 0) {
        onStatusMessage('selection_missing')
        return null
      }
      const { selection } = snapshot

      // 根据页号选出对应的 sessionId（图片多页情况下每页可能来源不同）
      const sourceDocumentID = typeof activeFile?.fileId === 'string' ? activeFile.fileId : null
      if (!sourceDocumentID || !workroom?.id) {
        onStatusMessage('session_missing')
        return null
      }

      const regions = snapshot.buildRegionsPayload()
      if (!regions || regions.length === 0) {
        onStatusMessage('selection_invalid')
        return null
      }

      const legends = snapshot.buildLegendsPayload() ?? undefined

      const payload = {
        workroomID: String(workroom.id),
        sourceDocumentID,
        studioDocumentID: studioDocumentId ?? undefined,
        title: activeFile?.name ?? null,
        regions,
        legends,
      }

      setIsExtracting(true)
      onStatusMessage('ocr_running')
      console.log('[ocr] request', payload)

      try {
        const recognized = await recognizeStudioSelection(backendBaseUrl, payload)
        const card = recognized.questionCard
        const enriched: AggregatedOcrItem = {
          region_index: card.sequenceIndex,
          text: card.text,
          id: card.id,
          sessionId: sourceDocumentID,
          fileId: sourceDocumentID,
          fileName: activeFile.name,
          page: card.page ?? selection.segments[0]?.page ?? 1,
          createdAt: new Date(card.createdAt).getTime(),
          legendImages: card.legendImages ?? [],
          originalText: card.originalText ?? card.text,
          answerContent: card.answerContent ?? createTextMathDocument(card.answerText ?? ''),
          answerText: card.answerText ?? '',
          canonicalAnswer: card.canonicalAnswer ?? '',
          documentContext: {
            studioDocumentID: recognized.studioDocument.id,
            sourceDocumentID: sourceDocumentID,
          },
          questionMeta: {
            questionId: undefined,
            sequenceIndex: card.sequenceIndex,
            groupId: card.sequenceIndex,
          },
        }

        setStoreOcrItems((prev) => [...prev, enriched])
        onStatusMessage('ocr_done')
        snapshot.clearSelection?.()
        selectionSnapshotRef.current = null
        console.log('[ocr] success card', card.id)
        return recognized.studioDocument.id
      } catch (err) {
        console.error('[ocr] failed', err)
        onStatusMessage('ocr_failed')
        onToast(
          err instanceof Error && err.message ? err.message : t('app.status.ocr_failed'),
          'error',
        )
        return null
      } finally {
        setIsExtracting(false)
      }
    },
    [backendBaseUrl, onStatusMessage, setStoreOcrItems, studioDocumentId, workroom?.id],
  )

  const handleOcrItemUpdate = useCallback(
    (id: string, updater: (item: AggregatedOcrItem) => AggregatedOcrItem) => {
      setStoreOcrItems((prev) => {
        // 如果 id 不存在，则添加新项
        const existingIndex = prev.findIndex((item) => item.id === id)
        if (existingIndex === -1) {
          // 创建一个虚拟的旧项来传给 updater
          const newItem = updater({} as AggregatedOcrItem)
          return [...prev, newItem]
        }
        return prev.map((item) => (item.id === id ? updater(item) : item))
      })
    },
    [setStoreOcrItems],
  )

  const handleOcrItemDelete = useCallback(
    async (id: string) => {
      const items = ocrItemsRef.current
      const target = items.find((item) => item.id === id)

      if (!target || !workroom?.id) {
        setStoreOcrItems((prev) => prev.filter((item) => item.id !== id))
        return
      }

      try {
        await deleteStudioQuestionCard(backendBaseUrl, {
          workroomID: String(workroom.id),
          cardID: id,
        })
      } catch (err) {
        console.error('[studio.delete_question_card] failed', err)
        return
      }

      setStoreOcrItems((prev) => prev.filter((item) => item.id !== id))
    },
    [backendBaseUrl, setStoreOcrItems, workroom?.id],
  )

  const handleAnswerChange = useCallback((id: string, value: MathContentDocument) => {
    const answerText = mathContentToPromptText(value)
    setStoreOcrItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              answerContent: value,
              answerText,
            }
          : item,
      ),
    )
  }, [setStoreOcrItems])

  const handleSplitOcrItem = useCallback(
    async (target: AggregatedOcrItem, _index: number, user: UserInfo | null) => {
      if (!user) return
      if (!workroom?.id) return
      if (splittingItemId) {
        onToast(t('app.toast.split_in_progress'), 'info')
        return
      }
      const sourceText = (target.originalText || target.text || '').trim()
      if (!sourceText) return

      try {
        setSplittingItemId(target.id)
        onStatusMessage('split_running')
        onToast(t('app.toast.split_in_progress'), 'info')
        const resp = await requestSplitQuestions(backendBaseUrl, {
          tenantId: user.tenant_id,
          userId: user.id,
          workroomId: workroom.id,
          documentId: target.fileId ?? undefined,
          text: sourceText,
          maxQuestions: 20,
        })

        const questions = resp.questions && resp.questions.length > 0 ? resp.questions : null
        if (!questions) {
          onStatusMessage('split_failed_keep')
          onToast(t('app.toast.split_failed'), 'error')
          return
        }

        const baseCreatedAt = Date.now()
        setStoreOcrItems((prev) => {
          const currentIndex = prev.findIndex((item) => item.id === target.id)
          if (currentIndex === -1) return prev

          const before = prev.slice(0, currentIndex)
          const after = prev.slice(currentIndex + 1)

          const nextItems: AggregatedOcrItem[] = questions.map((q, i) => {
            const newId = `${target.sessionId}-${baseCreatedAt}-${i}`
            const newGroupId = baseCreatedAt + i
            return {
              ...target,
              region_index: i,
              id: newId,
              text: q.text,
              originalText: q.text,
              createdAt: baseCreatedAt + i,
              answerContent: createTextMathDocument(''),
              answerText: '',
              canonicalAnswer: '',
              documentContext: target.documentContext ?? null,
              grading: undefined,
              questionMeta: {
                questionId: undefined,
                sequenceIndex: undefined,
                groupId: newGroupId,
              },
            }
          })

          return [...before, ...nextItems, ...after]
        })
        onStatusMessage('split_done')
        onToast(t('app.toast.split_success', { count: questions.length }), 'success')
      } catch (err) {
        console.error('[split-questions] failed', err)
        onStatusMessage('split_failed')
        onToast(t('app.toast.split_failed'), 'error')
      } finally {
        setSplittingItemId(null)
      }
    },
    [backendBaseUrl, onStatusMessage, onToast, splittingItemId, t],
  )

  const handleSubmitGrading = useCallback(
    async (
      currentFile: any,
      studioDocumentId: string | null,
      sourceDocumentId: string | null,
      user: UserInfo | null,
    ) => {
      if (!user) return
      if (!workroom?.id) {
        onStatusMessage('grading_failed')
        return
      }
      if (!studioDocumentId) {
        onStatusMessage('grading_failed')
        return
      }
      if (!ocrItemsRef.current.length) {
        onStatusMessage('grading_none')
        return
      }
      setIsGrading(true)
      onStatusMessage('grading_running')
      setStoreOcrItems((prev) =>
        prev.map((item) => ({
          ...item,
          grading: {
            status: 'pending',
          },
        })),
      )
      try {
        const items = ocrItemsRef.current
        let resultMap = new Map<number, GradingDisplayResult>()
        const problemCardItems = items.filter(
          (item): item is AggregatedOcrItem & { documentContext: { studioDocumentID: string; sourceDocumentID?: string | null } } =>
            item.documentContext?.studioDocumentID === studioDocumentId &&
            typeof item.id === 'string' &&
            item.id.trim().length > 0,
        )
        const problemCardIndexSet = new Set(problemCardItems.map((item) => item.id))

        if (problemCardItems.length > 0) {
          const results = await Promise.all(
            problemCardItems.map(async (item) => {
              const idx = items.findIndex((candidate) => candidate.id === item.id)
              const userAnswer = mathContentToPromptText(
                item.answerContent ?? createTextMathDocument(item.answerText ?? ''),
              ).trim()
              if (!userAnswer) {
                return [idx, { judgement: 'skipped', reasoning: '学生未作答' } satisfies GradingDisplayResult] as const
              }
              await updateStudioQuestionCard(backendBaseUrl, {
                workroomID: String(workroom.id),
                cardID: item.id,
                text: item.text,
                answerContent: item.answerContent,
                answerText: item.answerText,
                legendImages: item.legendImages ?? [],
              })
              const learning = await submitProblemCardAnswer(backendBaseUrl, {
                workroomID: String(workroom.id),
                problemCardID: item.id,
                userAnswer,
                inputSource: 'text',
              })
              const latest = learning.latestGradingRecord
              return [
                idx,
                {
                  judgement:
                    latest?.is_correct === true
                      ? 'correct'
                      : latest?.is_correct === false
                        ? 'incorrect'
                        : 'uncertain',
                  predictedAnswer: null,
                  reasoning: latest?.diagnosis ?? null,
                  confidence: null,
                } satisfies GradingDisplayResult,
              ] as const
            }),
          )
          resultMap = new Map<number, GradingDisplayResult>(results)
        }

        const legacyQuestions = items
          .map((item, idx) => ({ item, idx }))
          .filter(({ item }) => !problemCardIndexSet.has(item.id))

        if (legacyQuestions.length > 0) {
          const payload: GradeRunRequest = {
            tenantId: user.tenant_id,
            userId: user.id,
            workroomId: workroom.id,
            studioDocumentId,
            sourceDocumentId: sourceDocumentId ?? undefined,
            title: currentFile?.name ?? undefined,
            questions: legacyQuestions.map(({ item, idx }) => ({
              sequenceIndex: idx,
              content: item.text,
              userAnswer: mathContentToPromptText(item.answerContent ?? createTextMathDocument(item.answerText ?? '')),
              canonicalAnswer: item.canonicalAnswer ?? null,
              legendImages: item.legendImages ?? [],
              page: item.page ?? null,
              fileName: item.fileName,
            })),
          }
          const resp = await requestGrading(backendBaseUrl, payload)
          const nextMap = new Map<number, GradingDisplayResult>(resultMap)
          for (const r of resp.results) {
            const sequence =
              typeof r.sequence_index === 'number'
                ? r.sequence_index
                : typeof r.sequenceIndex === 'number'
                  ? r.sequenceIndex
                  : null
            if (sequence == null) continue
            nextMap.set(sequence, {
              judgement: r.judgement,
              predictedAnswer: r.predicted_answer ?? r.predictedAnswer ?? undefined,
              reasoning: r.reasoning ?? undefined,
              confidence: r.confidence ?? null,
              rawResponse: r.raw_response ?? r.rawResponse ?? undefined,
              error: r.error ?? undefined,
            })
          }
          resultMap = nextMap
        }
        setStoreOcrItems((prev) =>
          prev.map((item, idx) => {
            const result = resultMap.get(idx)
            if (!result) {
              return {
                ...item,
                grading: {
                  status: 'error',
                  error: '未收到批改结果',
                },
              }
            }
            const judgement = result.judgement as GradingJudgement
            return {
              ...item,
              grading: {
                status: judgement,
                predictedAnswer: result.predictedAnswer ?? undefined,
                reasoning: result.reasoning ?? undefined,
                confidence: result.confidence ?? null,
                rawResponse: result.rawResponse ?? undefined,
                error: result.error ?? undefined,
              },
            }
          }),
        )
        onStatusMessage('grading_done')
      } catch (err) {
        console.error('[grading] failed', err)
        onStatusMessage('grading_failed')
        setStoreOcrItems((prev) =>
          prev.map((item) =>
            item.grading?.status === 'pending'
              ? { ...item, grading: { status: 'error', error: '批改失败' } }
              : item,
          ),
        )
      } finally {
        setIsGrading(false)
      }
    },
    [backendBaseUrl, onStatusMessage, setStoreOcrItems, workroom?.id],
  )

  const handleAgUiEvent = useCallback(
    (incoming: MaybeWrappedAgUiEvent) => {
      if (!incoming || typeof incoming !== 'object') return

      const raw =
        'event' in incoming && incoming.event && typeof incoming.event === 'object'
          ? incoming.event
          : incoming

      if (!raw || typeof raw !== 'object') return

      const shinyDuration = 2600

      console.debug('[ag_ui] incoming', raw)

      const action = (raw as any).action
      if (action === 'question.replace') {
        const event = raw as AgUiQuestionReplaceEvent
        const { questionId, sequenceIndex, groupId } = event.target || {}
        const shouldShiny = event.payload.ui?.shinyOverlay !== false
        const shouldResetAnswer = event.payload.ui?.answerModeReset === true
        const now = Date.now()
        let targetItemId: string | null = null

        setStoreOcrItems((prev) => {
          if (!prev.length) {
            return prev
          }
          const next = [...prev]
          let idx = -1
          if (typeof questionId === 'string' || typeof questionId === 'number') {
            idx = next.findIndex((item) => item.questionMeta?.questionId === questionId)
          }
          if (idx === -1 && typeof sequenceIndex === 'number') {
            idx = next.findIndex((item) => item.questionMeta?.sequenceIndex === sequenceIndex)
          }
          if (idx === -1 && typeof sequenceIndex === 'number' && sequenceIndex >= 0 && sequenceIndex < next.length) {
            idx = sequenceIndex
          }
          if (idx === -1) {
            return prev
          }
          const item = next[idx]
          targetItemId = item.id
          const shinyUntil = shouldShiny ? now + shinyDuration : item.uiState?.shinyUntil
          const payloadVersions = Array.isArray(event.payload.versions)
            ? event.payload.versions
            : item.versions ?? []
          const nextVersionIndex =
            typeof event.payload.currentVersionIndex === 'number'
              ? Math.max(0, Math.min(event.payload.currentVersionIndex, Math.max(payloadVersions.length, 0)))
              : 0

          next[idx] = {
            ...item,
            text: event.payload.newContent,
            originalText: event.payload.newContent ?? item.originalText,
            legendImages: event.payload.legendImages ?? item.legendImages,
            versions: payloadVersions,
            activeVersionIndex: nextVersionIndex,
            solution: event.payload.solution ?? item.solution ?? null,
            answerContent: shouldResetAnswer ? createTextMathDocument('') : item.answerContent,
            answerText: shouldResetAnswer ? '' : item.answerText,
            grading: shouldResetAnswer ? undefined : item.grading,
            questionMeta: {
              questionId: questionId ?? item.questionMeta?.questionId,
              sequenceIndex: sequenceIndex ?? item.questionMeta?.sequenceIndex ?? idx,
              groupId: groupId ?? item.questionMeta?.groupId ?? null,
            },
            uiState: shouldShiny
              ? {
                  ...(item.uiState ?? {}),
                  shinyUntil,
                  variant: 'replace',
                }
              : item.uiState,
          }
          return next
        })

        if (shouldShiny && targetItemId) {
          window.setTimeout(() => {
            setStoreOcrItems((prev) =>
              prev.map((item) =>
                item.id === targetItemId
                  ? {
                      ...item,
                      uiState: item.uiState ? { ...item.uiState, shinyUntil: undefined } : item.uiState,
                    }
                  : item,
              ),
            )
          }, shinyDuration)
        }
      } else if (action === 'question.insert') {
        const event = raw as AgUiQuestionInsertEvent
        const { questionId, sequenceIndex, groupId } = event.target || {}
        const now = Date.now()
        const shouldShiny = event.payload.ui?.shinyOverlay === true
        let newItemId: string | null = null

        setStoreOcrItems((prev) => {
          const baseIndex =
            typeof sequenceIndex === 'number'
              ? Math.max(
                  -1,
                  prev.findIndex((item) => item.questionMeta?.sequenceIndex === (sequenceIndex ?? -1) - 1),
                )
              : prev.length - 1

          const baseItem = baseIndex >= 0 && baseIndex < prev.length ? prev[baseIndex] : prev[prev.length - 1]
          const insertIndex = baseIndex >= 0 && baseIndex < prev.length ? baseIndex + 1 : prev.length
          const createdAt = Date.now()
          const id = `generated-${createdAt}-${Math.random().toString(36).slice(2, 8)}`
          newItemId = id

          const newItem: AggregatedOcrItem = {
            id,
            region_index: insertIndex,
            text: event.payload.content,
            originalText: event.payload.content,
            sessionId: baseItem?.sessionId ?? `generated-session-${createdAt}`,
            fileId: baseItem?.fileId ?? `generated-file-${createdAt}`,
            fileName: baseItem?.fileName ?? '生成题目',
            page: baseItem?.page ?? 1,
            createdAt,
            legendImages: event.payload.legendImages ?? [],
            answerContent: createTextMathDocument(''),
            answerText: '',
            canonicalAnswer: '',
            documentContext: baseItem?.documentContext ?? null,
            questionMeta: {
              questionId: questionId,
              sequenceIndex: sequenceIndex,
              groupId: groupId ?? null,
            },
            versions: Array.isArray(event.payload.versions) ? event.payload.versions : [],
            activeVersionIndex:
              typeof event.payload.currentVersionIndex === 'number'
                ? Math.max(0, event.payload.currentVersionIndex)
                : 0,
            solution: event.payload.solution ?? null,
            uiState: shouldShiny
              ? {
                  shinyUntil: now + shinyDuration,
                  variant: 'insert',
                }
              : undefined,
            noteSource: event.payload.noteSource,
            grading: undefined,
          }

          const next = [...prev.slice(0, insertIndex), newItem, ...prev.slice(insertIndex)]
          return next
        })

        if (shouldShiny && newItemId) {
          window.setTimeout(() => {
            setStoreOcrItems((prev) =>
              prev.map((item) =>
                item.id === newItemId
                  ? {
                      ...item,
                      uiState: item.uiState ? { ...item.uiState, shinyUntil: undefined } : item.uiState,
                    }
                  : item,
              ),
            )
          }, shinyDuration)
        }
      }
    },
    [backendBaseUrl, workroom?.id, setStoreOcrItems],
  )

  return {
    ocrItems: storeOcrItems,
    setOcrItems: setStoreOcrItems,
    isExtracting,
    setIsExtracting,
    isGrading,
    setIsGrading,
    splittingItemId,
    setSplittingItemId,
    selectionSnapshotRef,
    handleSelectionSnapshotChange,
    handleAddToEditor,
    handleOcrItemUpdate,
    handleOcrItemDelete,
    handleAnswerChange,
    handleSplitOcrItem,
    handleSubmitGrading,
    handleAgUiEvent,
  }
}
