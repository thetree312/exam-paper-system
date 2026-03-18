import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AggregatedOcrItem,
  AgUiEvent,
  AgUiQuestionInsertEvent,
  AgUiQuestionReplaceEvent,
  GradeRunRequest,
  GradingJudgement,
  OcrResult,
  SelectionBox,
  UserInfo,
  RegionPayload,
  LegendRegionPayload,
  StatusMessageSetter,
} from '../types'
import { useAppStore } from '../store/appStore'
import { requestGrading, requestSplitQuestions, deleteQuestion as deleteQuestionApi } from '../services/agentApi'

type SelectionSnapshot = {
  selection: SelectionBox | null
  buildRegionsPayload: () => RegionPayload[] | null
  buildLegendsPayload: () => LegendRegionPayload[] | null
  clearSelection?: () => void
}

type MaybeWrappedAgUiEvent = AgUiEvent | { type?: string; event?: AgUiEvent }

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
    sessionId: number | null,
    activeFile: any,
    snapshot: SelectionSnapshot | null,
  ) => Promise<void>
  handleOcrItemUpdate: (id: string, updater: (item: AggregatedOcrItem) => AggregatedOcrItem) => void
  handleOcrItemDelete: (id: string) => void
  handleAnswerChange: (id: string, value: string) => void
  handleSplitOcrItem: (target: AggregatedOcrItem, index: number, user: UserInfo | null) => Promise<void>
  handleSubmitGrading: (
    currentFile: any,
    agentDocumentId: number | null,
    user: UserInfo | null,
  ) => Promise<void>
  handleAgUiEvent: (incoming: MaybeWrappedAgUiEvent) => void
}

export const useOcrManager = (
  backendBaseUrl: string,
  onStatusMessage: StatusMessageSetter,
  onToast: (message: string, type: 'info' | 'success' | 'error') => void,
  agentDocumentId: number | null,
): UseOcrManagerReturn => {
  const { t } = useTranslation('common')
  const storeOcrItems = useAppStore((state) => state.ocrItems)
  const setStoreOcrItems = useAppStore((state) => state.setOcrItems)
  const currentUser = useAppStore((state) => state.user)
  const workroom = useAppStore((state) => state.workroom)

  const [isExtracting, setIsExtracting] = useState(false)
  const [isGrading, setIsGrading] = useState(false)
  const [splittingItemId, setSplittingItemId] = useState<string | null>(null)

  const ocrItemsRef = useRef<AggregatedOcrItem[]>([])
  const selectionSnapshotRef = useRef<SelectionSnapshot | null>(null)

  useEffect(() => {
    ocrItemsRef.current = storeOcrItems
  }, [storeOcrItems])

  const handleSelectionSnapshotChange = useCallback((snapshot: SelectionSnapshot) => {
    selectionSnapshotRef.current = snapshot
  }, [])

  const handleAddToEditor = useCallback(
    async (sessionId: number | null, activeFile: any, snapshot: SelectionSnapshot | null) => {
      if (!snapshot || !snapshot.selection || snapshot.selection.segments.length === 0) {
        onStatusMessage('selection_missing')
        return
      }
      const { selection } = snapshot

      // 根据页号选出对应的 sessionId（图片多页情况下每页可能来源不同）
      const uniqueSessionIds = Array.from(
        new Set(
          selection.segments
            .map((seg) => activeFile?.pageSessionIds?.[seg.page - 1] ?? activeFile?.sessionId ?? null)
            .filter((id): id is number => typeof id === 'number'),
        ),
      )

      if (uniqueSessionIds.length === 0) {
        onStatusMessage('session_missing')
        return
      }

      if (uniqueSessionIds.length > 1) {
        onStatusMessage('selection_cross_upload')
        return
      }

      const resolvedSessionId = uniqueSessionIds[0]

      const regions = snapshot.buildRegionsPayload()
      if (!regions || regions.length === 0) {
        onStatusMessage('selection_invalid')
        return
      }

      const legends = snapshot.buildLegendsPayload()

      const payload = {
        session_id: resolvedSessionId,
        regions,
        legends,
      }

      setIsExtracting(true)
      onStatusMessage('ocr_running')
      console.log('[ocr] request', payload)

      try {
        const [ocrResp, legendResp] = await Promise.all([
          fetch(`${backendBaseUrl}/api/ocr/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
          legends && legends.length > 0
            ? fetch(`${backendBaseUrl}/api/legend/extract`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: resolvedSessionId, legends }),
              })
            : Promise.resolve(null as any),
        ])

        if (!ocrResp.ok) throw new Error(await ocrResp.text())
        const data = (await ocrResp.json()) as { items: OcrResult[] }

        let legendImages: string[] = []
        if (legendResp && legendResp.ok) {
          const legendData = (await legendResp.json()) as { images: string[] }
          legendImages = legendData.images ?? []
        }

        if (!sessionId || !activeFile) {
          onStatusMessage('ocr_done')
          return
        }

        const now = Date.now()
        let enriched: AggregatedOcrItem[] = []
        if (selection.segments.length > 1) {
          const combinedText = data.items.map((item) => item.text).join('\n\n').trim()
          if (combinedText.length > 0) {
            const firstSegment = selection.segments[0]
            enriched = [
              {
                region_index: 0,
                text: combinedText,
                id: `${sessionId}-${now}`,
                sessionId,
                fileId: activeFile.fileId,
                fileName: activeFile.name,
                page: firstSegment?.page ?? 1,
                createdAt: now,
                legendImages,
                originalText: combinedText,
                answerText: '',
              },
            ]
          }
        } else {
          enriched = data.items.map((item, idx) => {
            const segment = selection.segments[idx] ?? selection.segments[selection.segments.length - 1]
            return {
              ...item,
              id: `${sessionId}-${now}-${idx}`,
              sessionId,
              fileId: activeFile.fileId,
              fileName: activeFile.name,
              page: segment?.page ?? (activeFile.previewPages.length ? idx + 1 : 1),
              createdAt: now + idx,
              legendImages,
              originalText: item.text,
              answerText: '',
            }
          })
        }

        setStoreOcrItems((prev) => [...prev, ...enriched])
        onStatusMessage('ocr_done')
        snapshot.clearSelection?.()
        selectionSnapshotRef.current = null
        console.log('[ocr] success items', data.items.length)
      } catch (err) {
        console.error('[ocr] failed', err)
        onStatusMessage('ocr_failed')
      } finally {
        setIsExtracting(false)
      }
    },
    [backendBaseUrl, onStatusMessage],
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

      // 如果没有绑定后端题目，或当前没有 agentDocumentId，则仅本地删除
      const questionId = target?.questionMeta?.questionId
      if (!target || !questionId || !agentDocumentId) {
        setStoreOcrItems((prev) => prev.filter((item) => item.id !== id))
        return
      }

      const tenantId = currentUser?.tenant_id
      if (!tenantId) {
        console.warn('[agent.delete_question] missing tenantId, fallback to local delete')
        setStoreOcrItems((prev) => prev.filter((item) => item.id !== id))
        return
      }

      try {
        await deleteQuestionApi(backendBaseUrl, {
          tenantId,
          // agentDocumentId 已由 useAgentSync 管理，与当前题卡对应
          documentId: agentDocumentId,
          questionId,
        })
      } catch (err) {
        console.error('[agent.delete_question] failed', err)
        // 若后端删除失败，则不移除前端题卡，避免与快照不一致
        return
      }

      setStoreOcrItems((prev) => prev.filter((item) => item.id !== id))
    },
    [agentDocumentId, backendBaseUrl, currentUser, setStoreOcrItems],
  )

  const handleAnswerChange = useCallback((id: string, value: string) => {
    setStoreOcrItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              answerText: value,
            }
          : item,
      ),
    )
  }, [setStoreOcrItems])

  const handleSplitOcrItem = useCallback(
    async (target: AggregatedOcrItem, _index: number, user: UserInfo | null) => {
      if (!user) return
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
          documentId: agentDocumentId ?? undefined,
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
              answerText: '',
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
    [agentDocumentId, backendBaseUrl, onStatusMessage, onToast, splittingItemId],
  )

  const handleSubmitGrading = useCallback(
    async (currentFile: any, agentDocumentId: number | null, user: UserInfo | null) => {
      if (!user) return
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
        const payload: GradeRunRequest = {
          tenantId: user.tenant_id,
          userId: user.id,
          workroomId: workroom?.id ?? 0,
          documentId: agentDocumentId ?? undefined,
          title: currentFile?.name ?? undefined,
          questions: ocrItemsRef.current.map((item, idx) => ({
            sequenceIndex: idx,
            content: item.text,
            userAnswer: item.answerText ?? '',
            legendImages: item.legendImages ?? [],
            page: item.page ?? null,
            fileName: item.fileName,
          })),
        }
        const resp = await requestGrading(backendBaseUrl, payload)
        const resultMap = new Map(resp.results.map((r) => [r.sequence_index, r]))
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
                predictedAnswer: result.predicted_answer ?? undefined,
                reasoning: result.reasoning ?? undefined,
                confidence: result.confidence ?? null,
                rawResponse: result.raw_response ?? undefined,
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
    [backendBaseUrl, onStatusMessage, workroom?.id],
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
          if (typeof questionId === 'number') {
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
            sessionId: baseItem?.sessionId ?? 0,
            fileId: baseItem?.fileId ?? 0,
            fileName: baseItem?.fileName ?? '生成题目',
            page: baseItem?.page ?? 1,
            createdAt,
            legendImages: event.payload.legendImages ?? [],
            answerText: '',
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
    [],
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
