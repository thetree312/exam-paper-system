import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { QuestionEditor } from '../QuestionEditor'

import { useAgentSync } from '../hooks/useAgentSync'

import { MarkdownWithMath } from './MarkdownWithMath'

import { FavoriteButton } from './FavoriteButton'

import type {

  AgentSendPayload,

  AggregatedOcrItem,

  GradingJudgement,

  QuestionVersionRecord,

  TranslationContext,

  UserInfo,

} from '../types'

import {

  normalizeQuestionText,

  OPTION_REGEX,

  parseMultipleChoiceQuestion,

  parseParagraphMatching,

  parseReadingComprehension,

  parseReadingAnswerMap,

  stripChoiceBlockFromEditedText,

} from './questionRenderers/utils'

import { ReadingQuestionRenderer } from './questionRenderers/ReadingQuestionRenderer'

import { ParagraphMatchingRenderer } from './questionRenderers/ParagraphMatchingRenderer'

import { parseFillBlankQuestion } from './questionRenderers/fillBlank/parser'

import { FillBlankRenderer } from './questionRenderers/fillBlank/FillBlankRenderer'

import { McqAnswerRenderer } from './questionRenderers/McqAnswerRenderer'



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

  initialDocumentId?: number | null
  workroomId?: number | null

  onUpdateItem: (id: string, updater: OcrItemUpdater) => void

  onDeleteItem: (id: string) => void

  onDocumentChange?: (documentId: number | null) => void

  onSendToAgent?: (payload: AgentSendPayload) => void

  onAnswerChange?: (id: string, value: string) => void

  onSubmitGrading?: () => void

  isGrading?: boolean

  answerMode?: boolean

  onSplitItem?: (item: AggregatedOcrItem, index: number) => void

  splittingItemId?: string | null

  onToast?: (message: string, type: 'info' | 'success' | 'error') => void

}



export const AgentWorkspacePanel: React.FC<AgentWorkspacePanelProps> = React.memo(({

  backendBaseUrl,

  user,

  items,

  documentTitle,

  initialDocumentId = null,
  workroomId = null,

  onUpdateItem,

  onDeleteItem,

  onDocumentChange,

  onSendToAgent,

  onAnswerChange,

  onSubmitGrading,

  isGrading = false,

  answerMode = false,

  onSplitItem,

  splittingItemId = null,

  onToast,

}) => {
  const { t } = useTranslation('common')

  const {

    isReady,

    documentId,

    isSyncing,

    lastSavedAt,

    error,

    syncImmediate,

    syncDebounced,

    flushPending,

    loadSnapshot,

  } = useAgentSync({

    backendBaseUrl,

    tenantId: user?.tenant_id,

    userId: user?.id,

    workroomId,

    initialDocumentId,

  })



  useEffect(() => {

    if (onDocumentChange) {

      onDocumentChange(documentId ?? null)

    }

  }, [documentId, onDocumentChange])



  useEffect(() => {

    return () => {

      flushPending().catch(() => {

        // ignore flush errors on unmount

      })

    }

  }, [flushPending])



  const [versionMap, setVersionMap] = useState<Record<number, QuestionVersionRecord[]>>({})

  const snapshotDocRef = useRef<number | null>(null)



  useEffect(() => {

    if (!documentId || !isReady) {

      snapshotDocRef.current = null

      setVersionMap({})

      return

    }

    if (snapshotDocRef.current === documentId) {

      return

    }

    snapshotDocRef.current = documentId

    setVersionMap({})



    let cancelled = false

    ;(async () => {

      const resp = await loadSnapshot(documentId)

      if (!resp || cancelled) return

      const mapping: Record<number, QuestionVersionRecord[]> = {}

      for (const q of resp.questions) {

        if (typeof q.sequenceIndex !== 'number') continue

        if (Array.isArray(q.versions) && q.versions.length) {

          mapping[q.sequenceIndex] = q.versions.slice(0, 4)

        } else {

          mapping[q.sequenceIndex] = []

        }

      }

      if (!cancelled) {

        setVersionMap(mapping)

      }

    })()



    return () => {

      cancelled = true

    }

  }, [documentId, isReady, loadSnapshot])



  const statusText = useMemo(() => {

    if (isSyncing) return t('editor_workspace.syncing')

    if (lastSavedAt) {

      const time = new Date(lastSavedAt).toLocaleTimeString()

      return t('editor_workspace.saved_at', { time })

    }

    return documentId ? t('editor_workspace.synced') : t('editor_workspace.not_synced')

  }, [documentId, isSyncing, lastSavedAt])



  const [versionAnswerMap, setVersionAnswerMap] = useState<Record<string, string>>({})



  // 按题卡分组：同一 groupId 归为一张卡片

  const cards = useMemo(

    () => {

      type CardItem = { item: AggregatedOcrItem; index: number }

      type Card = { groupKey: string; groupId: number | null; items: CardItem[] }



      const result: Card[] = []

      const map = new Map<string, Card>()



      items.forEach((item, index) => {

        const meta = item.questionMeta

        const rawGroupId = (meta?.groupId ?? null) as number | null

        // 有 groupId 的题使用 groupId 分组；否则退化为每题一组，保持旧行为

        const key = rawGroupId != null ? `g-${rawGroupId}` : `i-${index}`

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

        documentId: documentId ?? undefined,

        sessionId: item.sessionId,

        fileId: item.fileId,

        sequenceIndex: resolveSequenceIndex(item, index),

        page: item.page,

        content: nextValue,

        legendImages: item.legendImages ?? [],

        title: documentTitle ?? item.fileName ?? '未命名试卷',

        sourceType: item.sourceType,

      })

    },

    [documentId, documentTitle, onUpdateItem, resolveSequenceIndex, syncDebounced],

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

        if (item.questionMeta?.questionId) continue

        if (item.createdAt <= cursor) continue

        nextCursor = Math.max(nextCursor, item.createdAt)

        try {

          const resp = await syncImmediate({

            documentId: documentId ?? undefined,

            sessionId: item.sessionId,

            fileId: item.fileId,

            sequenceIndex: resolveSequenceIndex(item, index),

            page: item.page,

            content: item.text,

            legendImages: item.legendImages ?? [],

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

              groupId: prev.questionMeta?.groupId ?? resp.question.id,

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

  }, [documentId, documentTitle, isReady, isSyncing, items, resolveSequenceIndex, syncImmediate, onUpdateItem])



  const handleManualSave = useCallback(async () => {

    if (!items.length || isSyncing) return



    // 如果还没有创建文档，则对当前所有题目做一次完整同步

    if (!documentId) {

      for (let index = 0; index < items.length; index += 1) {

        const item = items[index]

        try {

          const resp = await syncImmediate({

            documentId: documentId ?? undefined,

            sessionId: item.sessionId,

            fileId: item.fileId,

            sequenceIndex: resolveSequenceIndex(item, index),

            page: item.page,

            content: item.text,

            legendImages: item.legendImages ?? [],

            title: documentTitle ?? item.fileName ?? '未命名试卷',

            sourceType: item.sourceType,

          })

          onUpdateItem(item.id, (prev) => ({

            ...prev,

            questionMeta: {

              questionId: resp.question.id,

              sequenceIndex: resp.question.sequence_index,

              // 与自动同步保持一致：已有 groupId 则保留，否则用自身 id 初始化分组

              groupId: prev.questionMeta?.groupId ?? resp.question.id,

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

  }, [documentId, documentTitle, flushPending, isSyncing, items, resolveSequenceIndex, syncImmediate, onUpdateItem])



  const handleAnswerChangeInternal = useCallback(

    (item: AggregatedOcrItem, index: number, value: string) => {

      onAnswerChange?.(item.id, value)

      // 同步学生作答到后端题目快照，便于侧边栏 Agent 感知当前作答状态

      syncDebounced({

        documentId: documentId ?? undefined,

        sessionId: item.sessionId,

        fileId: item.fileId,

        sequenceIndex: resolveSequenceIndex(item, index),

        page: item.page,

        content: item.text,

        legendImages: item.legendImages ?? [],

        title: documentTitle ?? item.fileName ?? '未命名试卷',

        studentAnswer: value || null,

        sourceType: item.sourceType,

      })

    },

    [documentId, documentTitle, onAnswerChange, resolveSequenceIndex, syncDebounced],

  )



  if (!items.length) {

    return (

      <div className="text-slate-400 text-sm border border-dashed border-slate-200 rounded-lg p-4 text-center">

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

    skipped: { label: t('editor_workspace.grading_status.skipped'), classes: 'border-slate-200 bg-slate-50', badge: 'bg-slate-100 text-slate-600 border border-slate-200', icon: 'hourglass_empty' },

    uncertain: { label: t('editor_workspace.grading_status.uncertain'), classes: 'border-indigo-200 bg-indigo-50', badge: 'bg-indigo-100 text-indigo-700 border border-indigo-200', icon: 'help' },

    error: { label: t('editor_workspace.grading_status.error'), classes: 'border-orange-200 bg-orange-50', badge: 'bg-orange-100 text-orange-700 border border-orange-200', icon: 'warning' },

  }



  return (

    <div className="space-y-4">

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">

        <div className="flex items-center gap-2">

          <span className="font-medium text-slate-600">{t('editor_workspace.sync_status')}</span>

          {statusText}

        </div>

        <div className="flex items-center gap-2">

          {error && <span className="text-red-500">{error}</span>}

          <button

            type="button"

            className="px-3 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"

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

      {cards.map((card, cardIndex) => {

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

            : item.answerText ?? ''



        const mcqSourceText = viewingContent



        const { matching, reading, mcq, fillBlank } = getParsedQuestion(mcqSourceText, answerMode)

        const showChoices = Boolean(answerMode && !matching && !reading && mcq && mcq.options.length >= 2)

        const selectedOption = showChoices ? renderedAnswerValue.trim().toUpperCase() : null

        const isSplitting = splittingItemId === item.id



        const handleVersionAnswerChange = (value: string) => {

          if (activeVersionIndex === 0) {

            handleAnswerChangeInternal(item, index, value)

          } else {

            const key = `${resolvedSequenceIndex}:${activeVersionIndex}`

            setVersionAnswerMap((prev) => ({

              ...prev,

              [key]: value,

            }))

          }

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

          : 'border-transparent hover:border-slate-200 hover:bg-slate-50'



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

          <div className="absolute left-[-24px] top-4 text-slate-300 group-hover:text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity">

            <span className="material-symbols-outlined">drag_indicator</span>

          </div>

          <header className="flex flex-col gap-2 mb-2">

            <div className="flex items-start justify-between gap-3">

              <div className="flex items-center gap-2">

                <span className="text-slate-500 text-sm font-medium">{t('editor_workspace.question_label', { index: index + 1 })}</span>

                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">

                  <span className="material-symbols-outlined text-[14px]">description</span>

                  {t('editor_workspace.page_label', { page: item.page ?? '-' })}

                </span>

                {item.noteSource && (

                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] border border-amber-200">

                    <span className="material-symbols-outlined text-[14px]">stylus_note</span>

                    {item.noteSource.title ? `${t('editor_workspace.source_label')}${item.noteSource.title}` : `${t('editor_workspace.source_label')}${t('editor_workspace.source_note')}`}

                  </span>

                )}

              </div>

              <div className="flex flex-wrap items-center gap-2 text-slate-400">

                {totalPages > 1 && (

                  <div className="flex items-center gap-1 text-xs text-slate-500 mr-1.5">

                    <button

                      type="button"

                      className="px-2 py-1 rounded-full border border-slate-200 hover:bg-slate-50 disabled:opacity-40"

                      onClick={() => handlePageChange(activePageIndex - 1)}

                      disabled={activePageIndex <= 0}

                    >

                      {t('editor_workspace.prev_question')}

                    </button>

                    <span className="font-medium text-slate-600">

                      {t('editor_workspace.question_card', { current: activePageIndex + 1, total: totalPages })}

                    </span>

                    <button

                      type="button"

                      className="px-2 py-1 rounded-full border border-slate-200 hover:bg-slate-50 disabled:opacity-40"

                      onClick={() => handlePageChange(activePageIndex + 1)}

                      disabled={activePageIndex >= totalPages - 1}

                    >

                      {t('editor_workspace.next_question')}

                    </button>

                  </div>

                )}

                {totalVersions > 1 && (

                  <div className="flex items-center gap-2 text-xs text-slate-500">

                    <button

                      type="button"

                      className="px-2 py-1 rounded-full border border-slate-200 hover:bg-slate-50 disabled:opacity-40"

                      onClick={() => handleVersionChange(activeVersionIndex - 1)}

                      disabled={activeVersionIndex <= 0}

                    >

                      {t('editor_workspace.version_new')}

                    </button>

                    <span className="font-medium text-slate-600">

                      {t('editor_workspace.version_label', { current: activeVersionIndex + 1, total: totalVersions })}

                    </span>

                    <button

                      type="button"

                      className="px-2 py-1 rounded-full border border-slate-200 hover:bg-slate-50 disabled:opacity-40"

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

                    className="size-8 rounded-full hover:bg-slate-100 inline-flex items-center justify-center transition"

                    title={t('editor_workspace.button_delete')}

                    onClick={() => onDeleteItem(item.id)}

                    disabled={isSplitting}

                  >

                    <span className="material-symbols-outlined text-[18px]">delete</span>

                  </button>

                  {onSplitItem && (

                    <button

                      type="button"

                      className={`size-8 rounded-full inline-flex items-center justify-center transition ${

                        isSplitting ? 'bg-slate-100 cursor-default' : 'hover:bg-slate-100'

                      }`}

                      title={isSplitting ? t('editor_workspace.button_split_in_progress') : t('editor_workspace.button_split')}

                      onClick={() => !isSplitting && onSplitItem(item, index)}

                      disabled={isSplitting}

                    >

                      {isSplitting ? (

                        <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>

                      ) : (

                        <span className="material-symbols-outlined text-[18px]">splitscreen_add</span>

                      )}

                    </button>

                  )}

                  <button

                    type="button"

                    className="size-8 rounded-full hover:bg-slate-100 inline-flex items-center justify-center transition"

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

                    <span className="material-symbols-outlined text-[18px]">chat_paste_go</span>

                  </button>

                  <button

                    type="button"

                    className="size-8 rounded-full hover:bg-slate-100 inline-flex items-center justify-center transition"

                    title={t('editor_workspace.button_copy')}

                    onClick={() => navigator.clipboard.writeText(item.text)}

                    disabled={isSplitting}

                  >

                    <span className="material-symbols-outlined text-[18px]">content_copy</span>

                  </button>

                </div>

              </div>

            </div>

            {!isCurrentVersion && (

              <div className="text-[11px] text-slate-500 bg-slate-100 border border-slate-200 rounded-md px-2 py-1 inline-flex items-center gap-1">

                <span className="material-symbols-outlined text-[14px]">history</span>

                {t('question_editor.viewing_history')}

              </div>

            )}

            {answerMode && item.grading?.status && (

              <div

                className={`inline-flex items-center gap-2 text-xs font-medium px-2 py-1 rounded-full ${

                  statusMeta[item.grading.status].badge

                }`}

              >

                <span className="material-symbols-outlined text-[16px]">

                  {statusMeta[item.grading.status].icon}

                </span>

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

                  onChange={handleVersionAnswerChange}

                  disabled={isSplitting}

                  legendImages={viewingLegendImages}

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

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">

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

                  onChange={handleVersionAnswerChange}

                  disabled={isSplitting}

                />

              ) : reading ? (

                <ReadingQuestionRenderer

                  data={reading}

                  value={renderedAnswerValue}

                  onChange={handleVersionAnswerChange}

                  legendImages={viewingLegendImages}

                  disabled={isSplitting}

                />

              ) : showChoices && mcq ? (

                <McqAnswerRenderer

                  stem={answerModeStem}

                  options={mcq.options}

                  legendImages={viewingLegendImages}

                  value={renderedAnswerValue}

                  onChange={handleVersionAnswerChange}

                  disabled={isSplitting}

                />

              ) : fillBlank ? (

                null

              ) : (

                <label className="block text-xs font-medium text-slate-500">

                  我的答案

                  <textarea

                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"

                    placeholder="请输入你的答案或解题过程"

                    value={renderedAnswerValue}

                    onChange={(e) => handleVersionAnswerChange(e.target.value)}

                    disabled={isSplitting}

                    rows={renderedAnswerValue && renderedAnswerValue.length > 60 ? 4 : 2}

                  />

                </label>

              )}

            </div>

          )}

          {answerMode && displayGrading?.reasoning && (

            <div className="mt-3 rounded-lg border border-slate-200 bg-white/70 p-3">

              <div className="text-xs font-semibold text-slate-500 mb-1">AI 解析</div>

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

      return (

        item.id === nextItem?.id &&

        item.text === nextItem?.text &&

        item.answerText === nextItem?.answerText &&

        item.activeVersionIndex === nextItem?.activeVersionIndex &&

        item.grading?.status === nextItem?.grading?.status

      )

    }) &&

    prev.answerMode === next.answerMode &&

    prev.isGrading === next.isGrading &&

    prev.splittingItemId === next.splittingItemId

  )

})



