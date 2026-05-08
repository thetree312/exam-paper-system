import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { QuestionEditor } from '../QuestionEditor'

import { useAgentSync } from '../hooks/useAgentSync'
import { listStudioQuestionCards } from '../services/studioApi'

import { MarkdownWithMath } from './MarkdownWithMath'

import { FavoriteButton } from './FavoriteButton'

import type { AgentSendPayload, AggregatedOcrItem, GradingJudgement, QuestionVersionRecord, UserInfo } from '../types'

import { parseMultipleChoiceQuestion, parseParagraphMatching, parseReadingComprehension, stripChoiceBlockFromEditedText } from './questionRenderers/utils'

import { ReadingQuestionRenderer } from './questionRenderers/ReadingQuestionRenderer'

import { ParagraphMatchingRenderer } from './questionRenderers/ParagraphMatchingRenderer'

import { parseFillBlankQuestion } from './questionRenderers/fillBlank/parser'

import { FillBlankRenderer } from './questionRenderers/fillBlank/FillBlankRenderer'

import { McqAnswerRenderer } from './questionRenderers/McqAnswerRenderer'
import { RichMathComposer } from './math/RichMathComposer'
import Icon from './Icon'
import { createPlainTextMathDocument, ensureMathContentDocument, mathContentToPromptText, type MathContentDocument } from '../lib/mathContent'
import { fetchModelSettings } from '../services/modelSettingsApi'




type OcrItemUpdater = (prev: AggregatedOcrItem) => AggregatedOcrItem



type ParsedQuestionResult = {

  matching: ReturnType<typeof parseParagraphMatching> | null

  reading: ReturnType<typeof parseReadingComprehension> | null

  mcq: ReturnType<typeof parseMultipleChoiceQuestion> | null

  fillBlank: ReturnType<typeof parseFillBlankQuestion> | null

}



const questionParseCache = new Map<string, ParsedQuestionResult>()



function getParsedQuestion(mcqSourceText: string, enabled: boolean): ParsedQuestionResult {

  if (!enabled) {

    return { matching: null, reading: null, mcq: null, fillBlank: null }

  }



  const key = mcqSourceText

  const cached = questionParseCache.get(key)

  if (cached) return cached



  const matching = parseParagraphMatching(mcqSourceText)

  const reading = !matching ? parseReadingComprehension(mcqSourceText) : null

  const mcq =

    !matching && !reading ? parseMultipleChoiceQuestion(mcqSourceText) : null

  const fillBlank = !matching && !reading && !mcq ? parseFillBlankQuestion(mcqSourceText) : null



  const result: ParsedQuestionResult = { matching, reading, mcq, fillBlank }

  questionParseCache.set(key, result)

  return result

}



interface AgentWorkspacePanelProps {

  backendBaseUrl: string

  user: UserInfo

  items: AggregatedOcrItem[]

  documentTitle?: string | null
  
  studioDocumentId?: string | number | null
  sourceDocumentId?: string | number | null
  workroomId?: string | number | null

  onUpdateItem: (id: string, updater: OcrItemUpdater) => void

  onDeleteItem: (id: string) => void

  onSendToAgent?: (payload: AgentSendPayload) => void

  onAnswerChange?: (id: string, value: MathContentDocument) => void

  onSubmitGrading?: () => void

  isGrading?: boolean

  answerMode?: boolean

  onSplitItem?: (item: AggregatedOcrItem, index: number) => void

  splittingItemId?: string | null

  onToast?: (message: string, type: 'info' | 'success' | 'error') => void

  modelSettingsRevision?: number

}



export const AgentWorkspacePanel: React.FC<AgentWorkspacePanelProps> = React.memo(({

  backendBaseUrl,

  user,

  items,

  documentTitle,
  
  studioDocumentId = null,
  sourceDocumentId = null,
  workroomId = null,

  onUpdateItem,

  onDeleteItem,

  onSendToAgent,

  onAnswerChange,

  onSubmitGrading,

  isGrading = false,

  answerMode = false,

  onSplitItem,

  splittingItemId = null,

  onToast,

  modelSettingsRevision = 0,

}) => {
  const { t } = useTranslation('common')
  const [mathInputEnabled, setMathInputEnabled] = useState(false)

  const {

    isReady,

    studioDocumentId: syncedStudioDocumentId,
    sourceDocumentId: syncedSourceDocumentId,

    isSyncing,

    lastSavedAt,

    error,

    syncImmediate,

    syncDebounced,

    flushPending,

  } = useAgentSync({

    backendBaseUrl,

    tenantId: user?.tenant_id,

    userId: user?.id,

    workroomId,

    initialStudioDocumentId: studioDocumentId,
    initialSourceDocumentId: sourceDocumentId,

  })

  useEffect(() => {
    let cancelled = false
    void fetchModelSettings(backendBaseUrl)
      .then((settings) => {
        if (cancelled) return
        setMathInputEnabled(Boolean(settings.experimentalFeatures.mathInput.enabled))
      })
      .catch(() => {
        if (cancelled) return
        setMathInputEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, modelSettingsRevision])



  useEffect(() => {

    return () => {

      flushPending().catch(() => {

        // ignore flush errors on unmount

      })

    }

  }, [flushPending])



  const [versionMap, setVersionMap] = useState<Record<number, QuestionVersionRecord[]>>({})

  const snapshotDocRef = useRef<string | number | null>(null)

  const localVersionMap = useMemo(() => {
    const mapping: Record<number, QuestionVersionRecord[]> = {}
    for (const item of items) {
      const sequenceIndex = item.questionMeta?.sequenceIndex
      if (typeof sequenceIndex !== 'number') continue
      if (Array.isArray(item.versions) && item.versions.length > 0) {
        mapping[sequenceIndex] = item.versions.slice(0, 4)
      }
    }
    return mapping
  }, [items])



  useEffect(() => {
    setVersionMap((prev) => ({ ...prev, ...localVersionMap }))
  }, [localVersionMap])

  useEffect(() => {
    const needsSnapshotHydration = items.some((item) => {
      const sequenceIndex = item.questionMeta?.sequenceIndex
      if (typeof sequenceIndex !== 'number') return false
      const missingVersions = !Array.isArray(item.versions) || item.versions.length === 0
      const missingQuestionId =
        typeof item.questionMeta?.questionId !== 'string' &&
        typeof item.questionMeta?.questionId !== 'number'
      return missingVersions || missingQuestionId
    })

    if (!syncedStudioDocumentId || !isReady || !needsSnapshotHydration) {

      snapshotDocRef.current = null

      if (!syncedStudioDocumentId || !isReady) {
        setVersionMap(localVersionMap)
      }

      return

    }

    if (snapshotDocRef.current === syncedStudioDocumentId) {

      return

    }

    snapshotDocRef.current = syncedStudioDocumentId

    setVersionMap(localVersionMap)



    let cancelled = false

    ;(async () => {

      const cards = await listStudioQuestionCards(backendBaseUrl, {
        workroomID: String(workroomId),
        studioDocumentID: String(syncedStudioDocumentId),
      })

      if (cancelled) return
      const cardBySequence = new Map(cards.map((card) => [card.sequenceIndex, card]))
      const mapping: Record<number, QuestionVersionRecord[]> = {}

      if (!cancelled) {

        setVersionMap((prev) => ({ ...mapping, ...prev }))
        for (const item of items) {
          const sequenceIndex = item.questionMeta?.sequenceIndex
          if (typeof sequenceIndex !== 'number') continue
          const studioCard = cardBySequence.get(sequenceIndex)
          const snapshotQuestionId = studioCard?.projectedQuestionID ?? null
          if (!snapshotQuestionId) continue
          const currentQuestionId = item.questionMeta?.questionId
          if (
            (typeof currentQuestionId === 'string' || typeof currentQuestionId === 'number') &&
            currentQuestionId === snapshotQuestionId
          ) continue
          onUpdateItem(item.id, (prev) => ({
            ...prev,
            questionMeta: {
              questionId: snapshotQuestionId,
              sequenceIndex: prev.questionMeta?.sequenceIndex ?? sequenceIndex,
              groupId:
                prev.questionMeta?.groupId ??
                prev.questionMeta?.sequenceIndex ??
                sequenceIndex,
            },
          }))
        }

      }

    })()



    return () => {

      cancelled = true

    }

  }, [backendBaseUrl, isReady, items, localVersionMap, onUpdateItem, syncedStudioDocumentId, workroomId])



  const statusText = useMemo(() => {

    if (isSyncing) return t('editor_workspace.syncing')

    if (lastSavedAt) {

      const time = new Date(lastSavedAt).toLocaleTimeString()

      return t('editor_workspace.saved_at', { time })

    }

    return syncedStudioDocumentId ? t('editor_workspace.synced') : t('editor_workspace.not_synced')

  }, [syncedStudioDocumentId, isSyncing, lastSavedAt, t])



  const [versionAnswerMap, setVersionAnswerMap] = useState<Record<string, string>>({})



  // 按题卡分组：同一 groupId 归为一张卡片

  const cards = useMemo(

    () => {

      type CardItem = { item: AggregatedOcrItem; index: number }

      type Card = { groupKey: string; groupId: string | number | null; items: CardItem[] }



      const result: Card[] = []

      const map = new Map<string, Card>()



      items.forEach((item, index) => {

        const meta = item.questionMeta

        const rawGroupId = (meta?.groupId ?? null) as string | number | null

        // 有 groupId 的题使用 groupId 分组；否则退化为每题一组，保持旧行为

        const key = rawGroupId != null ? `g-${String(rawGroupId)}` : `i-${index}`

        let card = map.get(key)

        if (!card) {

          card = { groupKey: key, groupId: rawGroupId, items: [] }

          map.set(key, card)

          result.push(card)

        }

        card.items.push({ item, index })

      })



      return result

    },

    [items],

  )



  // 每个题卡当前展示的页索引

  const [activePageByGroup, setActivePageByGroup] = useState<Record<string, number>>({})



  // 有 shiny 的插入题，自动将该卡片切到对应页；否则默认展示第 0 页

  useEffect(() => {

    setActivePageByGroup((prev) => {

      const now = Date.now()

      const next: Record<string, number> = { ...prev }



      for (const card of cards) {

        if (!card.items.length) continue

        const shinyIndex = card.items.findIndex(({ item }) =>

          item.uiState?.shinyUntil && item.uiState.shinyUntil > now,

        )



        if (shinyIndex >= 0) {

          next[card.groupKey] = shinyIndex

        } else {

          const current = next[card.groupKey]

          next[card.groupKey] =

            typeof current === 'number' && current >= 0 && current < card.items.length

              ? current

              : 0

        }

      }



      return next

    })

  }, [cards])



  const resolveSequenceIndex = useCallback(

    (item: AggregatedOcrItem, index: number): number => {

      const meta = item.questionMeta

      if (meta && typeof meta.sequenceIndex === 'number') {

        return meta.sequenceIndex

      }



      const existingSeqs = items

        .map((q) => q.questionMeta?.sequenceIndex)

        .filter((v): v is number => typeof v === 'number')



      const maxSeq = existingSeqs.length ? Math.max(...existingSeqs) : -1



      let unsyncedRank = 0

      for (let i = 0; i <= index; i += 1) {

        const candidate = items[i]

        if (!candidate) continue

        const m = candidate.questionMeta

        if (!m || (typeof m.questionId !== 'number' && typeof m.sequenceIndex !== 'number')) {

          unsyncedRank += 1

        }

      }



      return maxSeq + unsyncedRank

    },

    [items],

  )



  const handleEditorChange = useCallback(

    (item: AggregatedOcrItem, index: number, nextValue: string) => {

      onUpdateItem(item.id, (prev) => ({

        ...prev,

        text: nextValue,

      }))

      syncDebounced({
        studioDocumentId: item.documentContext?.studioDocumentID ?? syncedStudioDocumentId ?? undefined,
        sourceDocumentId:
          item.documentContext?.sourceDocumentID ?? syncedSourceDocumentId ?? sourceDocumentId ?? undefined,

        sessionId: item.sessionId,

        fileId: item.fileId,

        sequenceIndex: resolveSequenceIndex(item, index),

        page: item.page,

        content: nextValue,

        legendImages: item.legendImages ?? [],
        canonicalAnswer: item.canonicalAnswer ?? null,

        title: documentTitle ?? item.fileName ?? '未命名试卷',

        sourceType: item.sourceType,

      })

    },

    [documentTitle, onUpdateItem, resolveSequenceIndex, sourceDocumentId, syncedSourceDocumentId, syncedStudioDocumentId, syncDebounced],

  )



  // 自动同步新识别出来但尚未手动保存的题目，避免用户每题都点一次“手动保存”

  const autoSyncCursorRef = useRef<number>(0)



  useEffect(() => {

    if (!isReady || !items.length || isSyncing) return



    const cursor = autoSyncCursorRef.current

    let nextCursor = cursor



    // 只针对新识别且尚未持久化的题目做一次性同步

    ;(async () => {

      for (let index = 0; index < items.length; index += 1) {

        const item = items[index]

        // 已经有 questionId 的题目（例如由 Agent 工具直接写入数据库的类似题），不再走自动同步，

        // 避免重复创建题目或篡改其分组信息。

        if (item.questionMeta?.questionId != null) continue

        if (item.createdAt <= cursor) continue

        nextCursor = Math.max(nextCursor, item.createdAt)

        try {

          const resp = await syncImmediate({
            studioDocumentId: item.documentContext?.studioDocumentID ?? syncedStudioDocumentId ?? undefined,
            sourceDocumentId:
              item.documentContext?.sourceDocumentID ?? syncedSourceDocumentId ?? sourceDocumentId ?? undefined,

            sessionId: item.sessionId,

            fileId: item.fileId,

            sequenceIndex: resolveSequenceIndex(item, index),

            page: item.page,

            content: item.text,

            legendImages: item.legendImages ?? [],
            canonicalAnswer: item.canonicalAnswer ?? null,

            title: documentTitle ?? item.fileName ?? '未命名试卷',

            sourceType: item.sourceType,

          })

          onUpdateItem(item.id, (prev) => ({

            ...prev,

            questionMeta: {

              questionId: resp.question.id,

              sequenceIndex: resp.question.sequence_index,

              // 若已有分组（例如来自 AG-UI 事件的类似题），保留原有 groupId；

              // 否则将本题 id 作为默认分组 id。

              groupId: prev.questionMeta?.groupId ?? resp.question.sequence_index,

            },

            documentContext: {
              studioDocumentID: String(resp.studio_document_id),
              sourceDocumentID:
                resp.source_document_id != null ? String(resp.source_document_id) : prev.documentContext?.sourceDocumentID ?? null,
            },

          }))

        } catch {

          // 错误状态由 hook 内部 error 处理，这里不中断后续条目

        }

      }



      if (nextCursor > cursor) {

        autoSyncCursorRef.current = nextCursor

      }

    })()

  }, [documentTitle, isReady, isSyncing, items, resolveSequenceIndex, sourceDocumentId, syncedSourceDocumentId, syncedStudioDocumentId, syncImmediate, onUpdateItem])



  const handleManualSave = useCallback(async () => {

    if (!items.length || isSyncing) return



    // 如果还没有创建文档，则对当前所有题目做一次完整同步

    if (!syncedStudioDocumentId) {

      for (let index = 0; index < items.length; index += 1) {

        const item = items[index]

        try {

          const resp = await syncImmediate({
            studioDocumentId: item.documentContext?.studioDocumentID ?? syncedStudioDocumentId ?? undefined,
            sourceDocumentId:
              item.documentContext?.sourceDocumentID ?? syncedSourceDocumentId ?? sourceDocumentId ?? undefined,

            sessionId: item.sessionId,

            fileId: item.fileId,

            sequenceIndex: resolveSequenceIndex(item, index),

            page: item.page,

            content: item.text,

            legendImages: item.legendImages ?? [],
            canonicalAnswer: item.canonicalAnswer ?? null,

            title: documentTitle ?? item.fileName ?? '未命名试卷',

            sourceType: item.sourceType,

          })

          onUpdateItem(item.id, (prev) => ({

            ...prev,

            questionMeta: {

              questionId: resp.question.id,

              sequenceIndex: resp.question.sequence_index,

              // 与自动同步保持一致：已有 groupId 则保留，否则用自身 id 初始化分组

              groupId: prev.questionMeta?.groupId ?? resp.question.sequence_index,

            },

            documentContext: {
              studioDocumentID: String(resp.studio_document_id),
              sourceDocumentID:
                resp.source_document_id != null ? String(resp.source_document_id) : prev.documentContext?.sourceDocumentID ?? null,
            },

          }))

        } catch {

          // 错误状态由 hook 内部 error 处理

          break

        }

      }

    } else {

      // 已有文档时，仅刷新当前待同步的改动

      await flushPending().catch(() => {

        /* error 已在 hook 中处理 */

      })

    }

  }, [documentTitle, flushPending, isSyncing, items, resolveSequenceIndex, sourceDocumentId, syncedSourceDocumentId, syncedStudioDocumentId, syncImmediate, onUpdateItem])



  const handleAnswerChangeInternal = useCallback(

    (item: AggregatedOcrItem, index: number, value: MathContentDocument) => {
      const promptText = mathContentToPromptText(value)
      const previousAnswerText = item.answerText ?? mathContentToPromptText(item.answerContent)
      if (promptText === previousAnswerText) {
        return
      }
      onAnswerChange?.(item.id, value)

      // 同步学生作答到后端题目快照，便于侧边栏 Agent 感知当前作答状态

      syncDebounced({
        studioDocumentId: item.documentContext?.studioDocumentID ?? syncedStudioDocumentId ?? undefined,
        sourceDocumentId:
          item.documentContext?.sourceDocumentID ?? syncedSourceDocumentId ?? sourceDocumentId ?? undefined,

        sessionId: item.sessionId,

        fileId: item.fileId,

        sequenceIndex: resolveSequenceIndex(item, index),

        page: item.page,

        content: item.text,

        legendImages: item.legendImages ?? [],
        canonicalAnswer: item.canonicalAnswer ?? null,

        title: documentTitle ?? item.fileName ?? '未命名试卷',

        studentAnswer: promptText || null,

        sourceType: item.sourceType,

      })

    },

    [documentTitle, onAnswerChange, resolveSequenceIndex, sourceDocumentId, syncedSourceDocumentId, syncedStudioDocumentId, syncDebounced],

  )



  if (!items.length) {

    return (

      <div className="text-[var(--ui-text-primary)] text-sm border border-dashed border-[var(--ui-border-default)] rounded-lg p-4 text-center">

        {t('editor_workspace.no_content')}

      </div>

    )

  }



  const statusMeta: Record<

    GradingJudgement,

    { label: string; classes: string; badge: string; icon: string }

  > = {

    pending: { label: t('editor_workspace.grading_status.pending'), classes: 'border-amber-200 bg-amber-50', badge: 'bg-amber-100 text-amber-700 border border-amber-200', icon: 'schedule' },

    correct: { label: t('editor_workspace.grading_status.correct'), classes: 'border-emerald-200 bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700 border border-emerald-200', icon: 'task_alt' },

    incorrect: { label: t('editor_workspace.grading_status.incorrect'), classes: 'border-rose-200 bg-rose-50', badge: 'bg-rose-100 text-rose-700 border border-rose-200', icon: 'close' },

    skipped: { label: t('editor_workspace.grading_status.skipped'), classes: 'border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)]', badge: 'bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)] border border-[var(--ui-border-default)]', icon: 'hourglass_empty' },

    uncertain: { label: t('editor_workspace.grading_status.uncertain'), classes: 'border-indigo-200 bg-indigo-50', badge: 'bg-indigo-100 text-indigo-700 border border-indigo-200', icon: 'help' },

    error: { label: t('editor_workspace.grading_status.error'), classes: 'border-orange-200 bg-orange-50', badge: 'bg-orange-100 text-orange-700 border border-orange-200', icon: 'warning' },

  }



  return (

    <div className="agent-workspace-panel space-y-4">

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--ui-text-primary)]">

        <div className="flex items-center gap-2">

          <span className="font-medium text-[var(--ui-text-primary)]">{t('editor_workspace.sync_status')}</span>

          {statusText}

        </div>

        <div className="flex items-center gap-2">

          {error && <span className="text-red-500">{error}</span>}

          <button

            type="button"

            className="px-3 py-1 rounded-md border border-[var(--ui-border-default)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)] disabled:opacity-50"

            onClick={handleManualSave}

            disabled={isSyncing}

          >

            {t('editor_workspace.manual_save')}

          </button>

          {onSubmitGrading && (

            <button

              type="button"

              className="px-3 py-1 rounded-md bg-slate-900 text-white hover:bg-black disabled:opacity-50"

              onClick={onSubmitGrading}

              disabled={isGrading || !items.length}

            >

              {isGrading ? t('editor_workspace.grading_in_progress') : t('editor_workspace.submit_grading')}

            </button>

          )}

        </div>

      </div>

      {cards.map((card) => {

        if (!card.items.length) return null



        const totalPages = card.items.length

        const storedPageIndex = activePageByGroup[card.groupKey] ?? 0

        const activePageIndex = Math.min(

          Math.max(storedPageIndex, 0),

          Math.max(totalPages - 1, 0),

        )

        const { item, index } = card.items[activePageIndex]

        const resolvedSequenceIndex =

          item.questionMeta?.sequenceIndex ?? index ?? item.region_index ?? 0

        const storedVersions =

          (item.versions && item.versions.length > 0

            ? item.versions

            : versionMap[resolvedSequenceIndex]) ?? []

        const versionHistory = storedVersions.slice(0, 4)

        const versionRecords: QuestionVersionRecord[] = [

          {

            content: item.text,

            legendImages: item.legendImages ?? [],

            studentAnswer: item.answerText,
            canonicalAnswer: item.canonicalAnswer ?? null,

            grading: item.grading

              ? {

                  judgement: item.grading.status,

                  predictedAnswer: item.grading.predictedAnswer,

                  reasoning: item.grading.reasoning,

                  confidence: item.grading.confidence ?? null,

                }

              : undefined,

          },

          ...versionHistory,

        ]

        const totalVersions = versionRecords.length

        const activeVersionIndex = Math.min(

          item.activeVersionIndex ?? 0,

          Math.max(versionRecords.length - 1, 0),

        )

        const viewingVersion = versionRecords[activeVersionIndex] ?? versionRecords[0]

        const isCurrentVersion = activeVersionIndex === 0

        const viewingContent = viewingVersion?.content ?? item.text

        const viewingLegendImages = viewingVersion?.legendImages ?? []

        const versionAnswerKey = `${resolvedSequenceIndex}:${activeVersionIndex}`

        const renderedAnswerValue =
          answerMode && activeVersionIndex > 0
            ? versionAnswerMap[versionAnswerKey] ?? ''
            : item.answerText ?? mathContentToPromptText(item.answerContent)

        const mcqSourceText = viewingContent

        const { matching, reading, mcq, fillBlank } = getParsedQuestion(mcqSourceText, answerMode)

        const renderedAnswerContent =
          activeVersionIndex > 0
            ? ensureMathContentDocument(renderedAnswerValue)
            : fillBlank
              ? ensureMathContentDocument(item.answerContent)
              : ensureMathContentDocument(item.answerContent, item.answerText ?? '')

        const showChoices = Boolean(answerMode && !matching && !reading && mcq && mcq.options.length >= 2)

        const isSplitting = splittingItemId === item.id



        const handleVersionAnswerChange = (value: MathContentDocument) => {

          if (activeVersionIndex === 0) {

            handleAnswerChangeInternal(item, index, value)

          } else {

            const key = `${resolvedSequenceIndex}:${activeVersionIndex}`

            setVersionAnswerMap((prev) => ({

              ...prev,

              [key]: mathContentToPromptText(value),

            }))

          }

        }

        const handleVersionFillBlankChange = (rawValue: string) => {
          if (activeVersionIndex === 0 && rawValue === (item.answerText ?? '')) {
            return
          }
          if (activeVersionIndex === 0) {
            onUpdateItem(item.id, (prev) => ({
              ...prev,
              answerText: rawValue,
              // 填空题 answerText 使用 JSON 字符串，answerContent 仅做同值镜像，避免回流缺省成空
              answerContent: createPlainTextMathDocument(rawValue),
            }))
            syncDebounced({
              studioDocumentId: item.documentContext?.studioDocumentID ?? syncedStudioDocumentId ?? undefined,
              sourceDocumentId:
                item.documentContext?.sourceDocumentID ?? syncedSourceDocumentId ?? sourceDocumentId ?? undefined,
              sessionId: item.sessionId,
              fileId: item.fileId,
              sequenceIndex: resolveSequenceIndex(item, index),
              page: item.page,
              content: item.text,
              legendImages: item.legendImages ?? [],
              canonicalAnswer: item.canonicalAnswer ?? null,
              title: documentTitle ?? item.fileName ?? '未命名试卷',
              studentAnswer: rawValue || null,
              sourceType: item.sourceType,
            })
            return
          }
          const key = `${resolvedSequenceIndex}:${activeVersionIndex}`
          setVersionAnswerMap((prev) => ({
            ...prev,
            [key]: rawValue,
          }))
        }

        const handleVersionChange = (nextIndex: number) => {

          if (nextIndex < 0 || nextIndex >= totalVersions) return

          onUpdateItem(item.id, (prev) => ({

            ...prev,

            activeVersionIndex: nextIndex,

          }))

        }



        const historicalGrading = !isCurrentVersion ? viewingVersion?.grading : undefined

        const gradingForDisplay = isCurrentVersion

          ? item.grading

          : historicalGrading

            ? {

                status: (historicalGrading.judgement ?? 'uncertain') as GradingJudgement,

                predictedAnswer: historicalGrading.predictedAnswer ?? undefined,

                reasoning: historicalGrading.reasoning ?? undefined,

                confidence: historicalGrading.confidence ?? null,

              }

            : undefined

        const displayGrading = answerMode ? gradingForDisplay : undefined

        const shouldDecorateWithGrading =

          Boolean(answerMode && item.grading?.status && item.grading.status !== 'pending')

        const cardDecorationClass = shouldDecorateWithGrading

          ? statusMeta[item.grading!.status].classes

          : 'border-transparent hover:border-[var(--ui-border-default)] hover:bg-[var(--ui-bg-panel-muted)]'



        // 题干展示一律基于当前可编辑文本 item.text，通过粗略移除选项行来得到 stem，保证编辑能反映到答题模式

        let answerModeStem: string | null = null

        if (answerMode && showChoices) {

          const stripped = stripChoiceBlockFromEditedText(viewingContent).trim()

          if (stripped) {

            answerModeStem = stripped

          } else if (mcq && mcq.stem.trim()) {

            // 如果用户把文本改得无法识别，则回退到原始解析出的题干

            answerModeStem = mcq.stem.trim()

          } else {

            answerModeStem = viewingContent

          }

        }



        const isShiny = Boolean(

          item.uiState?.shinyUntil && item.uiState.shinyUntil > Date.now(),

        )



        const handlePageChange = (nextPage: number) => {

          if (nextPage < 0 || nextPage >= totalPages) return

          setActivePageByGroup((prev) => ({

            ...prev,

            [card.groupKey]: nextPage,

          }))

        }



        return (

        <article

          key={card.groupKey}

          className={`group relative rounded-xl border transition-all p-4 -mx-4 question-card ${cardDecorationClass} ${

            isShiny ? 'question-card-shiny' : ''

          }`}

        >

          <div className="absolute left-[-24px] top-4 text-[var(--ui-text-primary)] group-hover:text-[var(--ui-text-primary)] opacity-0 group-hover:opacity-100 transition-opacity">

            <Icon name={"drag_indicator"} />

          </div>

          <header className="flex flex-col gap-2 mb-2">

            <div className="flex items-start justify-between gap-3">

              <div className="flex items-center gap-2">

                <span className="text-[var(--ui-text-primary)] text-sm font-medium">{t('editor_workspace.question_label', { index: index + 1 })}</span>

                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)] text-xs">
                  <Icon name="description" className="text-[14px]" />
                  {t('editor_workspace.page_label', { page: item.page ?? '-' })}
                </span>

                {item.noteSource && (

                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] border border-amber-200">
                    <Icon name="stylus_note" className="text-[14px]" />
                    {item.noteSource.title ? `${t('editor_workspace.source_label')}${item.noteSource.title}` : `${t('editor_workspace.source_label')}${t('editor_workspace.source_note')}`}
                  </span>

                )}

              </div>

              <div className="flex flex-wrap items-center gap-2 text-[var(--ui-text-primary)]">

                {totalPages > 1 && (

                  <div className="flex items-center gap-1 text-xs text-[var(--ui-text-primary)] mr-1.5">

                    <button

                      type="button"

                      className="px-2 py-1 rounded-full border border-[var(--ui-border-default)] hover:bg-[var(--ui-bg-panel-muted)] disabled:opacity-40"

                      onClick={() => handlePageChange(activePageIndex - 1)}

                      disabled={activePageIndex <= 0}

                    >

                      {t('editor_workspace.prev_question')}

                    </button>

                    <span className="font-medium text-[var(--ui-text-primary)]">

                      {t('editor_workspace.question_card', { current: activePageIndex + 1, total: totalPages })}

                    </span>

                    <button

                      type="button"

                      className="px-2 py-1 rounded-full border border-[var(--ui-border-default)] hover:bg-[var(--ui-bg-panel-muted)] disabled:opacity-40"

                      onClick={() => handlePageChange(activePageIndex + 1)}

                      disabled={activePageIndex >= totalPages - 1}

                    >

                      {t('editor_workspace.next_question')}

                    </button>

                  </div>

                )}

                {totalVersions > 1 && (

                  <div className="flex items-center gap-2 text-xs text-[var(--ui-text-primary)]">

                    <button

                      type="button"

                      className="px-2 py-1 rounded-full border border-[var(--ui-border-default)] hover:bg-[var(--ui-bg-panel-muted)] disabled:opacity-40"

                      onClick={() => handleVersionChange(activeVersionIndex - 1)}

                      disabled={activeVersionIndex <= 0}

                    >

                      {t('editor_workspace.version_new')}

                    </button>

                    <span className="font-medium text-[var(--ui-text-primary)]">

                      {t('editor_workspace.version_label', { current: activeVersionIndex + 1, total: totalVersions })}

                    </span>

                    <button

                      type="button"

                      className="px-2 py-1 rounded-full border border-[var(--ui-border-default)] hover:bg-[var(--ui-bg-panel-muted)] disabled:opacity-40"

                      onClick={() => handleVersionChange(activeVersionIndex + 1)}

                      disabled={activeVersionIndex >= totalVersions - 1}

                    >

                      {t('editor_workspace.version_old')}

                    </button>

                  </div>

                )}

                <div className="flex items-center gap-1.5">

                  <FavoriteButton

                    backendBaseUrl={backendBaseUrl}

                    tenantId={user.tenant_id}

                    userId={user.id}

                    questionId={item.questionMeta?.questionId}

                    onToast={onToast}

                    isFromFavorite={item.sourceType === 'favorite'}

                  />

                  <button

                    type="button"

                    className="size-8 rounded-full hover:bg-[var(--ui-bg-panel-muted)] inline-flex items-center justify-center transition"

                    title={t('editor_workspace.button_delete')}

                    onClick={() => onDeleteItem(item.id)}

                    disabled={isSplitting}

                  >

                    <Icon name={"delete"} className="text-[18px]" />

                  </button>

                  {onSplitItem && (

                    <button

                      type="button"

                      className={`size-8 rounded-full inline-flex items-center justify-center transition ${

                        isSplitting ? 'bg-[var(--ui-bg-panel-muted)] cursor-default' : 'hover:bg-[var(--ui-bg-panel-muted)]'

                      }`}

                      title={isSplitting ? t('editor_workspace.button_split_in_progress') : t('editor_workspace.button_split')}

                      onClick={() => !isSplitting && onSplitItem(item, index)}

                      disabled={isSplitting}

                    >

                      {isSplitting ? (

                        <Icon name={"progress_activity"} className="text-[18px] animate-spin" />

                      ) : (

                        <Icon name={"splitscreen_add"} className="text-[18px]" />

                      )}

                    </button>

                  )}

                  <button

                    type="button"

                    className="size-8 rounded-full hover:bg-[var(--ui-bg-panel-muted)] inline-flex items-center justify-center transition"

                    title={t('editor_workspace.button_send_to_copilot')}

                    onClick={() =>

                      onSendToAgent?.({

                        text: `@题目${index + 1}`,

                        noteFocus: item.noteSource

                          ? {

                              documentId: item.noteSource.documentId ?? undefined,

                              fileId: item.noteSource.fileId ?? undefined,

                              blockIndex:

                                item.noteSource.blockRange?.[0] ??

                                item.noteSource.sequenceIndex ??

                                undefined,

                              snippet: item.noteSource.snippet ?? undefined,

                              title: item.noteSource.title ?? undefined,

                            }

                          : undefined,

                      })

                    }

                    disabled={isSplitting}

                  >

                    <Icon name={"chat_paste_go"} className="text-[18px]" />

                  </button>

                  <button

                    type="button"

                    className="size-8 rounded-full hover:bg-[var(--ui-bg-panel-muted)] inline-flex items-center justify-center transition"

                    title={t('editor_workspace.button_copy')}

                    onClick={() => navigator.clipboard.writeText(item.text)}

                    disabled={isSplitting}

                  >

                    <Icon name={"content_copy"} className="text-[18px]" />

                  </button>

                </div>

              </div>

            </div>

            {!isCurrentVersion && (

              <div className="text-[11px] text-[var(--ui-text-primary)] bg-[var(--ui-bg-panel-muted)] border border-[var(--ui-border-default)] rounded-md px-2 py-1 inline-flex items-center gap-1">

                <Icon name={"history"} className="text-[14px]" />

                {t('question_editor.viewing_history')}

              </div>

            )}

            {answerMode && item.grading?.status && (

              <div

                className={`inline-flex items-center gap-2 text-xs font-medium px-2 py-1 rounded-full ${

                  statusMeta[item.grading.status].badge

                }`}

              >

                <Icon name={statusMeta[item.grading.status].icon} className="text-[16px]" />

                {statusMeta[item.grading.status].label}

                {item.grading?.confidence != null && (

                  <span className="text-[10px] opacity-80">

                    置信度 {(item.grading.confidence * 100).toFixed(0)}%

                  </span>

                )}

              </div>

            )}

          </header>

          {/* 题干区域：

              - 普通模式下使用 QuestionEditor；

              - 在答题模式且识别为填空题时，直接用 FillBlankRenderer 在题干位置就地编辑；

              - 在答题模式且为选择题、阅读理解或匹配题时，隐藏该编辑器，改为下方用专用渲染器。 */}

          <div className={answerMode && (showChoices || Boolean(reading) || Boolean(matching)) ? 'hidden' : ''}>

            {isCurrentVersion ? (

              answerMode && fillBlank ? (

                <FillBlankRenderer

                  parsed={fillBlank}

                  value={renderedAnswerValue}

                  onChange={handleVersionFillBlankChange}

                  disabled={isSplitting}

                  legendImages={viewingLegendImages}

                  mathInputEnabled={mathInputEnabled}

                  backendBaseUrl={backendBaseUrl}

                  userId={user.id}

                />

              ) : (

                <QuestionEditor

                  value={item.text}

                  onChange={

                    answerMode || isSplitting ? undefined : (value) => handleEditorChange(item, index, value)

                  }

                  title={item.fileName}

                  legendImages={item.legendImages}

                  readOnly={answerMode || isSplitting}

                  translationContext={{

                    backendBaseUrl,

                    tenantId: user.tenant_id,

                    userId: user.id,

                  }}

                />

              )

            ) : (

              <div className="rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)] p-4 text-sm text-[var(--ui-text-primary)]">

                <MarkdownWithMath>{viewingContent}</MarkdownWithMath>

              </div>

            )}

          </div>

          {answerMode && (

            <div className="mt-3 space-y-3">

              {matching ? (

                <ParagraphMatchingRenderer

                  data={matching}

                  value={renderedAnswerValue}

                  onChange={(value) => handleVersionAnswerChange(ensureMathContentDocument(value))}

                  disabled={isSplitting}

                />

              ) : reading ? (

                <ReadingQuestionRenderer

                  data={reading}

                  value={renderedAnswerValue}

                  onChange={(value) => handleVersionAnswerChange(ensureMathContentDocument(value))}

                  legendImages={viewingLegendImages}

                  disabled={isSplitting}

                />

              ) : showChoices && mcq ? (

                <McqAnswerRenderer

                  stem={answerModeStem}

                  options={mcq.options}

                  legendImages={viewingLegendImages}

                  value={renderedAnswerValue}

                  onChange={(value) => handleVersionAnswerChange(ensureMathContentDocument(value))}

                  disabled={isSplitting}

                />

              ) : fillBlank ? (

                null

              ) : (

                <label className="block text-xs font-medium text-[var(--ui-text-primary)]">

                  我的答案

                  <textarea
                    className="sr-only"
                    value={mathContentToPromptText(renderedAnswerContent)}
                    onChange={(e) => handleVersionAnswerChange(ensureMathContentDocument(e.target.value))}
                    disabled={isSplitting}
                    aria-label="我的答案"
                  />

                  <div className="mt-1 rounded-lg border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] p-2">
                    <RichMathComposer
                      value={renderedAnswerContent}
                      onChange={handleVersionAnswerChange}
                      disabled={isSplitting}
                      placeholder="输入答案，可直接写数理化表达，系统会原位自动转写"
                      mathInputEnabled={mathInputEnabled}
                      backendBaseUrl={backendBaseUrl}
                      userId={user.id}
                    />
                  </div>

                </label>

              )}

            </div>

          )}

          {answerMode && displayGrading?.reasoning && (

            <div className="mt-3 rounded-lg border border-[var(--ui-border-default)] bg-[var(--ui-bg-elevated)] p-3">

              <div className="text-xs font-semibold text-[var(--ui-text-primary)] mb-1">AI 解析</div>

              <MarkdownWithMath>{displayGrading.reasoning}</MarkdownWithMath>

            </div>

          )}

          {answerMode && displayGrading?.error && (

            <div className="mt-2 text-sm text-orange-600">批改失败：{displayGrading.error}</div>

          )}

        </article>

      )})}

    </div>

  )

}, (prev, next) => {

  return (

    prev.items.length === next.items.length &&

    prev.items.every((item, idx) => {

      const nextItem = next.items[idx]
      const prevQuestionId = item.questionMeta?.questionId
      const nextQuestionId = nextItem?.questionMeta?.questionId

      return (

        item.id === nextItem?.id &&

        item.text === nextItem?.text &&

        item.answerText === nextItem?.answerText &&

        item.uiState?.shinyUntil === nextItem?.uiState?.shinyUntil &&
        item.uiState?.variant === nextItem?.uiState?.variant &&

        prevQuestionId === nextQuestionId &&

        item.activeVersionIndex === nextItem?.activeVersionIndex &&

        item.grading?.status === nextItem?.grading?.status

      )

    }) &&

    prev.answerMode === next.answerMode &&

    prev.isGrading === next.isGrading &&

    prev.splittingItemId === next.splittingItemId

  )

})





