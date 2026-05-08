import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getFavorites, removeFavorite } from '../services/favoritesApi'
import {
  addProblemCardToStudio,
  getProblemCardLearningDetail,
  type ProblemCardLearningDetailDto,
} from '../services/problemCardsApi'
import { FlashcardApi } from '../services/flashcardApi'
import { MarkdownWithMath } from './MarkdownWithMath'
import AnimatedHeartButton from './AnimatedHeartButton'
import type { QuestionFavorite, UserInfo } from '../types'
import Icon from './Icon'

interface FavoritesPageProps {
  backendBaseUrl: string
  user: UserInfo
  workroomID?: string
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
  onBack?: () => void
  onAddToEditor?: (questionId: number) => void
}

function formatDateTime(value?: string | null) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function heatColor(intensity: number) {
  if (intensity <= 0) return 'bg-[var(--ui-bg-panel-muted)]'
  if (intensity === 1) return 'bg-emerald-100'
  if (intensity === 2) return 'bg-emerald-200'
  if (intensity === 3) return 'bg-emerald-400'
  return 'bg-emerald-600'
}

function buildHeatmapWeeks(data: Array<{ date: string; intensity: number }>) {
  const byDate = new Map(data.map((item) => [item.date, item.intensity]))
  const days: Array<{ date: string; intensity: number; weekday: number }> = []
  const start = new Date(Date.now() - 179 * 24 * 60 * 60 * 1000)
  for (let i = 0; i < 180; i += 1) {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000)
    const key = d.toISOString().slice(0, 10)
    days.push({ date: key, intensity: byDate.get(key) ?? 0, weekday: d.getDay() })
  }
  const weeks: Array<Array<{ date: string; intensity: number } | null>> = []
  let week: Array<{ date: string; intensity: number } | null> = new Array(7).fill(null)
  for (const day of days) {
    week[day.weekday] = { date: day.date, intensity: day.intensity }
    if (day.weekday === 6) {
      weeks.push(week)
      week = new Array(7).fill(null)
    }
  }
  if (week.some((item) => item !== null)) weeks.push(week)
  return weeks
}

function masteryLevelText(level: string) {
  if (level === 'proficient') return '熟练'
  if (level === 'good') return '良好'
  if (level === 'basic') return '一般'
  if (level === 'weak') return '薄弱'
  return '未掌握'
}

function masteryLevelTone(level: string) {
  if (level === 'proficient') {
    return {
      ring: 'border-emerald-500',
      text: 'text-emerald-600',
      pill: 'bg-emerald-50 text-emerald-700',
    }
  }
  if (level === 'good') {
    return {
      ring: 'border-[var(--ui-accent)]',
      text: 'text-[var(--ui-text-primary)]',
      pill: 'bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)]',
    }
  }
  if (level === 'basic') {
    return {
      ring: 'border-amber-500',
      text: 'text-amber-600',
      pill: 'bg-amber-50 text-amber-700',
    }
  }
  if (level === 'weak') {
    return {
      ring: 'border-rose-500',
      text: 'text-rose-600',
      pill: 'bg-rose-50 text-rose-700',
    }
  }
  return {
    ring: 'border-[var(--ui-border-strong)]',
    text: 'text-[var(--ui-text-primary)]',
    pill: 'bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)]',
  }
}

function masteryLevelIcon(level: string) {
  if (level === 'proficient') return '/icons/mastery/light/proficient.png'
  if (level === 'good') return '/icons/mastery/light/good.png'
  if (level === 'basic') return '/icons/mastery/light/basic.png'
  if (level === 'weak') return '/icons/mastery/light/weak.png'
  return '/icons/mastery/light/unmastered.png'
}

function masteryPercent(detail: ProblemCardLearningDetailDto | null) {
  if (!detail?.learningState) return 0
  return Math.max(0, Math.min(100, Math.round(detail.learningState.mastery_score ?? 0)))
}

function formatDurationMinutes(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `${minutes} 分钟`
}

function normalizeFavoriteMarkdown(input: string) {
  if (!input) return input
  // OCR/存储链路中常见 \$...\$，这里恢复为可渲染数学分隔符
  return input.replace(/\\\$/g, '$').replace(/\\\\/g, '\\')
}

function normalizeLegendSrc(src: string) {
  if (!src) return src
  const trimmed = src.trim()
  if (trimmed.startsWith('data:image/')) return trimmed
  // 兼容本地数据中的“裸 base64”图片字符串，避免被当成 URL 路径触发 431
  if (/^[A-Za-z0-9+/_=-]+$/.test(trimmed) && trimmed.length > 200) {
    return `data:image/png;base64,${trimmed}`
  }
  if (/^https?:\/\//i.test(src)) return src
  if (src.startsWith('/')) return src
  return `/${trimmed}`
}

function renderContentWithInlineFigures(
  content: string,
  legendImages: string[] | undefined,
  keyPrefix: string,
  compact = false,
) {
  const source = normalizeFavoriteMarkdown(content)
  const FIG_RE = /\[\[GLM_FIG_(\d+)\]\]/g
  const nodes: React.ReactNode[] = []
  const usedLegendIndex = new Set<number>()
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FIG_RE.exec(source)) !== null) {
    const start = match.index
    const full = match[0]
    if (start > lastIndex) {
      const textPart = source.slice(lastIndex, start)
      if (textPart.trim()) {
        nodes.push(
          <MarkdownWithMath key={`${keyPrefix}-text-${start}`} compact={compact}>
            {textPart}
          </MarkdownWithMath>,
        )
      }
    }
    const idx = Number(match[1])
    const rawSrc = Number.isFinite(idx) ? legendImages?.[idx] : undefined
    const resolvedSrc = rawSrc ? normalizeLegendSrc(rawSrc) : ''
    if (resolvedSrc) {
      usedLegendIndex.add(idx)
      nodes.push(
        <img
          key={`${keyPrefix}-fig-${idx}-${start}`}
          src={resolvedSrc}
          alt={`题目图例 ${idx + 1}`}
          className="my-2 max-w-full h-auto rounded border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] object-contain"
        />,
      )
    }
    lastIndex = start + full.length
  }
  if (lastIndex < source.length) {
    const tail = source.slice(lastIndex)
    if (tail.trim()) {
      nodes.push(
        <MarkdownWithMath key={`${keyPrefix}-text-tail`} compact={compact}>
          {tail}
        </MarkdownWithMath>,
      )
    }
  }
  if (nodes.length === 0) {
    const fallback = (
      <MarkdownWithMath compact={compact}>
        {source}
      </MarkdownWithMath>
    )
    if (!legendImages?.length) return fallback
    return (
      <>
        {fallback}
        {legendImages.map((src, idx) => {
          const resolvedSrc = normalizeLegendSrc(src)
          if (!resolvedSrc) return null
          return (
            <img
              key={`${keyPrefix}-fig-fallback-${idx}`}
              src={resolvedSrc}
              alt={`题目图例 ${idx + 1}`}
              className="my-2 max-w-full h-auto rounded border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] object-contain"
            />
          )
        })}
      </>
    )
  }
  if (legendImages?.length) {
    legendImages.forEach((src, idx) => {
      if (usedLegendIndex.has(idx)) return
      const resolvedSrc = normalizeLegendSrc(src)
      if (!resolvedSrc) return
      nodes.push(
        <img
          key={`${keyPrefix}-fig-unused-${idx}`}
          src={resolvedSrc}
          alt={`题目图例 ${idx + 1}`}
          className="my-2 max-w-full h-auto rounded border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] object-contain"
        />,
      )
    })
  }
  return <>{nodes}</>
}

export const FavoritesPage: React.FC<FavoritesPageProps> = ({
  backendBaseUrl,
  user,
  workroomID,
  onToast,
  onBack,
  onAddToEditor,
}) => {
  const { t } = useTranslation('common')
  const [favorites, setFavorites] = useState<QuestionFavorite[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProblemCardLearningDetailDto | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [isMasteryModalOpen, setIsMasteryModalOpen] = useState(false)

  const loadFavorites = useCallback(async () => {
    setIsLoading(true)
    try {
      const favoritesResp = await getFavorites(backendBaseUrl, user.tenant_id, user.id, 1, 100)
      setFavorites(favoritesResp.items)
    } catch (err) {
      console.error('[favorites] load failed', err)
      onToast?.(t('favorites.toast.load_failed'), 'error')
    } finally {
      setIsLoading(false)
    }
  }, [backendBaseUrl, onToast, t, user.id, user.tenant_id])

  useEffect(() => {
    void loadFavorites()
  }, [loadFavorites])

  useEffect(() => {
    if (!selectedID || !workroomID) {
      setDetail(null)
      setIsMasteryModalOpen(false)
      return
    }
    setDetailLoading(true)
    void getProblemCardLearningDetail(backendBaseUrl, { workroomID, problemCardID: selectedID })
      .then((result) => setDetail(result))
      .catch((err) => {
        console.error('[favorites] detail failed', err)
        setDetail(null)
      })
      .finally(() => setDetailLoading(false))
  }, [backendBaseUrl, selectedID, workroomID])

  const handleRemoveFavorite = useCallback(
    async (questionId: number) => {
      try {
        await removeFavorite(backendBaseUrl, user.tenant_id, user.id, questionId)
        onToast?.(t('favorites.toast.removed'), 'success')
        await loadFavorites()
      } catch (err) {
        console.error('[favorites] remove failed', err)
        onToast?.(t('favorites.toast.remove_failed'), 'error')
      }
    },
    [backendBaseUrl, loadFavorites, onToast, t, user.id, user.tenant_id],
  )

  const filteredFavorites = useMemo(() => {
    if (!searchQuery.trim()) return favorites
    const q = searchQuery.toLowerCase()
    return favorites.filter((fav) => fav.question.content.toLowerCase().includes(q) || String(fav.question_id).includes(q))
  }, [favorites, searchQuery])

  const selectedFavorite = useMemo(
    () => favorites.find((item) => item.studio_question_card_id === selectedID) ?? null,
    [favorites, selectedID],
  )

  const handleOpenSelected = useCallback(() => {
    if (!selectedFavorite || !onAddToEditor) return
    onAddToEditor(selectedFavorite.question_id)
  }, [onAddToEditor, selectedFavorite])

  const handleAddToReviewPlan = useCallback(async () => {
    if (!selectedFavorite || !workroomID) return
    const problemCardID = selectedFavorite.studio_question_card_id
    if (problemCardID) {
      await addProblemCardToStudio(backendBaseUrl, {
        workroomID,
        problemCardID,
      })
    }
    const studioDocumentID =
      String((selectedFavorite.question as any).studio_document_id ?? selectedFavorite.question.document_id ?? '').trim()
    if (!studioDocumentID) {
      onToast?.('缺少题卡文档 ID，无法加入复习计划', 'error')
      return
    }
    try {
      const result = await FlashcardApi.generateFlashcards(backendBaseUrl, workroomID, studioDocumentID, 20, false)
      onToast?.(`已加入复习计划，生成 ${result.cardCount} 张闪卡`, 'success')
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : '加入复习计划失败', 'error')
    }
  }, [backendBaseUrl, onToast, selectedFavorite, workroomID])

  const handleUnfavoriteSelected = useCallback(async () => {
    if (!selectedFavorite) return
    await handleRemoveFavorite(selectedFavorite.question_id)
    setSelectedID(null)
  }, [handleRemoveFavorite, selectedFavorite])

  const attemptTimeline = useMemo(() => {
    if (!detail) return []
    const sortedEvents = [...detail.timelineEvents].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )
    return detail.attempts.slice(0, 5).map((attempt) => {
      const grading = detail.gradingRecords.find((item) => item.attempt_id === attempt.id) ?? null
      const currentTs = new Date(attempt.submitted_at).getTime()
      const nearestEnterEvent = sortedEvents
        .filter((event) => event.event_type === 'enter_answer_mode' && new Date(event.created_at).getTime() <= currentTs)
        .at(-1)
      const durationSeconds = nearestEnterEvent
        ? Math.max(0, Math.floor((currentTs - new Date(nearestEnterEvent.created_at).getTime()) / 1000))
        : null
      const previousAttempt = detail.attempts.find((item) => item.attempt_index === attempt.attempt_index - 1) ?? null
      const previousCorrect = previousAttempt?.judgement === 'correct' ? 1 : 0
      const currentCorrect = attempt.judgement === 'correct' ? 1 : 0
      const masteryDelta = previousAttempt ? (currentCorrect - previousCorrect) * 10 : null
      const attemptType = attempt.attempt_index === 1 ? '首次作答' : '复习'
      const comparisonText =
        grading?.comparison_with_previous_attempt?.trim() ||
        (attempt.attempt_index === 1 ? '首次作答，无上次对比' : '暂无对比评估')
      return {
        id: attempt.id,
        time: attempt.submitted_at,
        attemptIndex: attempt.attempt_index,
        judgement: attempt.judgement,
        attemptType,
        durationText: formatDurationMinutes(durationSeconds),
        masteryDelta,
        comparisonText,
        resultText:
          attempt.judgement === 'correct'
            ? '正确'
            : attempt.judgement === 'incorrect'
              ? '错误'
              : attempt.judgement === 'skipped'
                ? '未作答'
                : '待确认',
      }
    })
  }, [detail])

  const diagnosisSummary = useMemo(() => {
    if (!detail) return []
    return detail.gradingRecords.slice(0, 6).map((record) => ({
      id: record.id,
      date: record.created_at.slice(5, 10),
      label: record.mistake_type || '诊断记录',
      conclusion: record.diagnosis,
      relatedAttempts: record.used_context_summary.total_attempts,
    }))
  }, [detail])

  const weaknessTracks = useMemo(() => {
    if (!detail) return []
    return detail.weaknesses.slice(0, 6).map((weakness) => ({
      id: weakness.id,
      label: weakness.label,
      firstSeenAt: weakness.first_seen_at,
      lastSeenAt: weakness.last_seen_at,
      resolvedAt: weakness.resolved_at,
      status: weakness.status,
      count: weakness.count,
    }))
  }, [detail])

  const masteryTone = masteryLevelTone(detail?.learningState?.mastery_level ?? 'unmastered')
  const masteryIconSrc = masteryLevelIcon(detail?.learningState?.mastery_level ?? 'unmastered')

  return (
    <div className="favorites-page h-full bg-[var(--ui-bg-panel-muted)] p-6 overflow-y-auto relative">
      <div className="mx-auto w-full max-w-[1500px] relative">
      <main
        className="min-w-0 transition-[margin-right] duration-300"
        style={{ marginRight: selectedID ? 500 : 0 }}
      >
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--ui-text-primary)]">我的收藏</h1>
            <p className="text-sm text-[var(--ui-text-primary)] mt-1">管理你收藏的题卡、题组与闪卡，集中回顾，巩固所学。</p>
          </div>
          {onBack && (
            <button type="button" className="text-sm text-[var(--ui-text-primary)]" onClick={onBack}>
              返回
            </button>
          )}
        </div>
        <input
          className="w-full mb-4 rounded-lg border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] px-3 py-2 text-sm"
          placeholder={t('favorites.search_placeholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {isLoading ? (
          <div className="py-10 text-center text-[var(--ui-text-primary)]">加载中...</div>
        ) : filteredFavorites.length === 0 ? (
          <div className="py-10 text-center text-[var(--ui-text-primary)]">暂无收藏</div>
        ) : (
          <div className="space-y-3">
            {filteredFavorites.map((fav) => {
              const cardID = fav.studio_question_card_id ?? null
              const isActive = cardID != null && cardID === selectedID
              return (
                <article
                  key={fav.id}
                  className={`w-full text-left bg-[var(--ui-bg-panel)] border rounded-xl p-4 transition ${isActive ? 'border-emerald-500 shadow-sm' : 'border-[var(--ui-border-default)]'}`}
                >
                  <div
                    className="flex items-start justify-between gap-3 cursor-pointer"
                    onClick={() => {
                      if (!cardID) return
                      setSelectedID((prev) => (prev === cardID ? null : cardID))
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (!cardID) return
                        setSelectedID((prev) => (prev === cardID ? null : cardID))
                      }
                    }}
                  >
                    <div className="min-w-0">
                      {fav.question.knowledge_title ? (
                        <div className="text-base font-semibold text-[var(--ui-text-primary)]">
                          <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                            {fav.question.knowledge_title}
                          </MarkdownWithMath>
                        </div>
                      ) : null}
                      <div className="mt-2 text-xs text-[var(--ui-text-primary)]">
                        {renderContentWithInlineFigures(
                          fav.question.content,
                          fav.question.legend_images,
                          `fav-${fav.id}`,
                          true,
                        )}
                      </div>
                      <div className="text-xs text-[var(--ui-text-primary)] mt-2">{formatDateTime(fav.created_at)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {onAddToEditor && (
                        <button
                          type="button"
                          className="text-[var(--ui-text-primary)]"
                          onClick={(e) => {
                            e.stopPropagation()
                            onAddToEditor(fav.question_id)
                          }}
                        >
                          <Icon name="forms_add_on" className="text-[18px]" />
                        </button>
                      )}
                      <AnimatedHeartButton
                        isLikedInitial
                        onLike={async () => {}}
                        onUnlike={async () => {
                          await handleRemoveFavorite(fav.question_id)
                        }}
                      />
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
      </main>
      <aside
        className={`fixed right-0 top-0 z-40 h-screen w-[480px] overflow-y-auto border-l border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] transition-transform duration-300 ${
          selectedID ? 'translate-x-0' : 'translate-x-[calc(100%+2rem)]'
        }`}
      >
        {selectedID && (
          <>
            <div className="flex items-center justify-between mb-2 sticky top-0 bg-[var(--ui-bg-panel)] z-10 px-8 pt-6">
              <div className="text-sm text-[var(--ui-text-primary)]">题卡</div>
              <button type="button" onClick={() => setSelectedID(null)}>
                <Icon name="close" className="text-[var(--ui-text-primary)]" />
              </button>
            </div>
            <div className="px-8 pb-6">
            {detailLoading ? (
              <div className="text-[var(--ui-text-primary)]">详情加载中...</div>
            ) : !detail ? (
              <>
                <div className="flex items-start justify-between">
                  <div className="text-[20px] font-semibold text-[var(--ui-text-primary)] leading-tight">暂无题卡详情</div>
                  <Icon name="star" className="text-[var(--ui-text-primary)]" />
                </div>
                <div className="mt-2 text-xs text-[var(--ui-text-primary)]">来源：-　　标签：-</div>
                <div className="mt-3 text-[16px] font-semibold text-[var(--ui-text-primary)]">内容预览</div>
                <div className="mt-2 rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)] p-3 text-[14px] leading-7 text-[var(--ui-text-primary)]">
                  暂无内容
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between">
                  <div className="text-[20px] font-semibold text-[var(--ui-text-primary)] leading-tight">
                    {selectedFavorite?.question?.knowledge_title ? (
                      <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                        {selectedFavorite.question.knowledge_title}
                      </MarkdownWithMath>
                    ) : null}
                  </div>
                  <Icon name="star" className="text-[var(--ui-text-primary)]" />
                </div>
                <div className="mt-2 text-xs text-[var(--ui-text-primary)]">
                  来源：{detail.problemCard.source_document_title || '-'}　　标签：
                  {detail.weaknesses.slice(0, 3).map((w) => w.label).join('、') || detail.knowledgeProfile?.knowledge_points.slice(0, 3).join('、') || '-'}
                </div>

                <div className="mt-3 text-[16px] font-semibold text-[var(--ui-text-primary)]">内容预览</div>
                <div className="mt-2 rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)] p-3 text-[14px] leading-7 text-[var(--ui-text-primary)]">
                  {renderContentWithInlineFigures(
                    detail.problemCard.question_text,
                    selectedFavorite?.question?.legend_images,
                    `drawer-${detail.problemCard.id}`,
                    false,
                  )}
                </div>

                <div className="mt-3 text-[16px] font-semibold text-[var(--ui-text-primary)]">掌握度</div>
                <button
                  type="button"
                  className="mt-2 w-full rounded-xl border border-[var(--ui-border-default)] p-3 flex items-center gap-3 text-left hover:border-[var(--ui-border-strong)] transition"
                  onClick={() => setIsMasteryModalOpen(true)}
                >
                  <div className={`h-14 w-14 rounded-full border-[5px] ${masteryTone.ring} flex items-center justify-center text-[14px] font-bold text-[var(--ui-text-primary)]`}>
                    {masteryPercent(detail)}%
                  </div>
                  <div className="flex-1">
                    <div className={`text-[20px] font-semibold leading-tight ${masteryTone.text}`}>
                      {masteryLevelText(detail.learningState?.mastery_level ?? 'unknown')}
                    </div>
                    <div className="text-xs text-[var(--ui-text-primary)] mt-1">
                      {detail.learningState?.progress_summary?.trim() ||
                        `连续正确 ${detail.learningState?.consecutive_correct_count ?? 0} 次`}
                    </div>
                  </div>
                  <Icon name="chevron_right" className="text-[var(--ui-text-primary)] text-[18px]" />
                </button>

                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[16px] font-semibold text-[var(--ui-text-primary)]">复习热力图</span>
                    <span className="text-sm text-[var(--ui-text-primary)]">过去 180 天</span>
                  </div>
                  {detail.reviewHeatmap180d.some((item) => item.intensity > 0) ? (
                    <div className="flex gap-1">
                      {buildHeatmapWeeks(detail.reviewHeatmap180d).map((week, weekIdx) => (
                        <div key={weekIdx} className="grid grid-rows-7 gap-1">
                          {week.map((day, dayIdx) => (
                            <div
                              key={`${weekIdx}-${dayIdx}`}
                              className={`h-1.5 w-1.5 rounded-[2px] ${day ? heatColor(day.intensity) : 'bg-transparent'}`}
                              title={day ? `${day.date}: ${day.intensity}` : ''}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-[var(--ui-text-primary)]">暂无复习记录</div>
                  )}
                </div>

                <div className="mt-3 space-y-1.5 text-[13px] text-[var(--ui-text-primary)]">
                  <div className="flex justify-between"><span>收藏时间</span><span>{formatDateTime(selectedFavorite?.created_at)}</span></div>
                  <div className="flex justify-between"><span>最近复习</span><span>{formatDateTime(detail.learningState?.last_review_at)}</span></div>
                  <div className="flex justify-between"><span>累计作答次数</span><span>{detail.attemptStats.total_attempts} 次</span></div>
                  <div className="flex justify-between"><span>累计批改次数</span><span>{detail.reviewStats.grading_count} 次</span></div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button type="button" onClick={handleOpenSelected} className="rounded-lg bg-[var(--ui-btn-solid-bg)] text-white py-2 text-sm hover:bg-[var(--ui-btn-solid-hover)]">打开</button>
                  <button type="button" onClick={() => void handleAddToReviewPlan()} className="rounded-lg border border-[var(--ui-border-strong)] py-2 text-sm">加入复习计划</button>
                  <button type="button" onClick={() => void handleUnfavoriteSelected()} className="rounded-lg border border-[var(--ui-border-strong)] py-2 text-sm">取消收藏</button>
                </div>
              </>
            )}
            </div>
          </>
        )}
      </aside>
      </div>
      {selectedID && detail && isMasteryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
          <button
            type="button"
            className="absolute inset-0 bg-black/25"
            onClick={() => setIsMasteryModalOpen(false)}
          />
          <div className="relative w-full max-w-[800px] rounded-[18px] border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] shadow-2xl">
            <div className="flex items-start justify-between px-6 py-5 border-b border-[var(--ui-border-default)]">
              <div>
                <div className="text-[22px] font-semibold text-[var(--ui-text-primary)]">掌握度详情</div>
                <div className="mt-1 text-[13px] text-[var(--ui-text-primary)]">
                  记录你的作答历史、错因分析与薄弱点修复轨迹
                </div>
              </div>
              <button type="button" onClick={() => setIsMasteryModalOpen(false)}>
                <Icon name="close" className="text-[var(--ui-text-primary)]" />
              </button>
            </div>
            <div className="px-6 py-4 max-h-[76vh] overflow-y-auto space-y-4">
              <div className="relative">
                <div className="flex flex-wrap gap-2 pr-24">
                  <div className="rounded-full bg-[var(--ui-bg-panel-muted)] px-3 py-1.5 text-xs text-[var(--ui-text-primary)]">
                    {detail.attemptStats.total_attempts} 次作答
                  </div>
                  <div className="rounded-full bg-[var(--ui-bg-panel-muted)] px-3 py-1.5 text-xs text-[var(--ui-text-primary)]">
                    {detail.weaknesses.length} 类错因
                  </div>
                  <div className="rounded-full bg-[var(--ui-bg-panel-muted)] px-3 py-1.5 text-xs text-[var(--ui-text-primary)]">
                    已修复 {detail.weaknesses.filter((item) => item.status === 'resolved').length} 项
                  </div>
                  <div className={`rounded-full px-3 py-1.5 text-xs ${masteryTone.pill}`}>
                    当前掌握度 {masteryPercent(detail)}%
                  </div>
                </div>
                <div className="pointer-events-none absolute right-0 top-0">
                  <img src={masteryIconSrc} alt="掌握度等级图标" className="h-20 w-auto object-contain" />
                </div>
              </div>

              <section className="bg-[var(--ui-bg-panel)]">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ui-btn-solid-bg)] text-xs font-semibold text-white">1</div>
                  <div className="text-[16px] font-semibold text-[var(--ui-text-primary)]">作答时间线</div>
                  <div className="ml-2 rounded-full bg-[var(--ui-bg-panel-muted)] px-2 py-0.5 text-[11px] text-[var(--ui-text-primary)]">{detail.attemptStats.total_attempts}次作答</div>
                  <div className={`rounded-full px-2 py-0.5 text-[11px] ${masteryTone.pill}`}>当前掌握度 {masteryPercent(detail)}%</div>
                </div>
                <div className="mt-3 pl-4">
                  {attemptTimeline.length === 0 ? (
                    <div className="text-sm text-[var(--ui-text-primary)]">暂无作答记录</div>
                  ) : (
                    <div className="relative space-y-2">
                      <span className="absolute left-0 top-2 bottom-2 w-px bg-[var(--ui-border-default)]" />
                      {attemptTimeline.map((item) => (
                        <div key={item.id} className="relative pl-4">
                          <span className="absolute -left-[5px] top-5 h-2.5 w-2.5 rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-bg-panel)]" />
                          <div className="rounded-xl border border-[var(--ui-border-default)] px-3 py-2.5">
                            <div className="grid grid-cols-[1.2fr_0.75fr_0.65fr_0.8fr_0.65fr] items-center gap-2 text-[12px]">
                              <div className="text-[var(--ui-text-primary)]">{formatDateTime(item.time)}</div>
                              <div>
                                <span className="rounded-full bg-[var(--ui-bg-panel-muted)] px-2 py-0.5 text-[11px] text-[var(--ui-text-primary)]">{item.attemptType}</span>
                              </div>
                              <div className="text-[var(--ui-text-primary)]">{item.durationText}</div>
                              <div className={item.masteryDelta == null ? 'text-[var(--ui-text-primary)]' : item.masteryDelta >= 0 ? 'text-emerald-600' : 'text-rose-500'}>
                                掌握度 {item.masteryDelta == null ? '—' : `${item.masteryDelta > 0 ? '+' : ''}${item.masteryDelta}%`}
                              </div>
                              <div className={item.judgement === 'correct' ? 'text-emerald-600' : item.judgement === 'incorrect' ? 'text-rose-500' : 'text-[var(--ui-text-primary)]'}>
                                结果：{item.resultText}
                              </div>
                            </div>
                            <div className="mt-1.5 text-[12px] text-[var(--ui-text-primary)] whitespace-normal break-words">
                              <span className="text-[var(--ui-text-primary)]">较上次效果：</span>
                              <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                                {item.comparisonText}
                              </MarkdownWithMath>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="bg-[var(--ui-bg-panel)] border-t border-[var(--ui-border-default)] pt-3.5">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ui-btn-solid-bg)] text-xs font-semibold text-white">2</div>
                  <div className="text-[16px] font-semibold text-[var(--ui-text-primary)]">错因记录</div>
                  <div className="ml-2 rounded-full bg-[var(--ui-bg-panel-muted)] px-2 py-0.5 text-[11px] text-[var(--ui-text-primary)]">{detail.weaknesses.length}类高频错因</div>
                </div>
                <div className="mt-3 pl-4">
                  {diagnosisSummary.length === 0 ? (
                    <div className="text-sm text-[var(--ui-text-primary)]">暂无诊断记录</div>
                  ) : (
                    <div className="relative space-y-2">
                      <span className="absolute left-0 top-2 bottom-2 w-px bg-[var(--ui-border-default)]" />
                      {diagnosisSummary.map((item) => (
                        <div key={item.id} className="relative pl-4">
                          <span className="absolute -left-[5px] top-5 h-2.5 w-2.5 rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-bg-panel)]" />
                          <div className="rounded-xl border border-[var(--ui-border-default)] px-3 py-2.5">
                            <div className="flex items-center gap-2 text-[12px]">
                              <div className="text-[var(--ui-text-primary)]">{item.date}</div>
                              <div className="font-medium text-[var(--ui-text-primary)]">{item.label}</div>
                              <div className="text-[11px] text-[var(--ui-text-primary)]">关联作答：{String(item.relatedAttempts ?? '-')}</div>
                            </div>
                            <div className="mt-1.5 text-[12px] text-[var(--ui-text-primary)] whitespace-normal break-words">
                              <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                                {item.conclusion || '-'}
                              </MarkdownWithMath>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="bg-[var(--ui-bg-panel)] border-t border-[var(--ui-border-default)] pt-3.5">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ui-btn-solid-bg)] text-xs font-semibold text-white">3</div>
                  <div className="text-[16px] font-semibold text-[var(--ui-text-primary)]">薄弱点修复轨迹</div>
                  <div className="ml-2 rounded-full bg-[var(--ui-bg-panel-muted)] px-2 py-0.5 text-[11px] text-[var(--ui-text-primary)]">已修复 {detail.weaknesses.filter((item) => item.status === 'resolved').length} 个</div>
                </div>
                <div className="mt-3 pl-4">
                  {weaknessTracks.length === 0 ? (
                    <div className="text-sm text-[var(--ui-text-primary)]">暂无薄弱点记录</div>
                  ) : (
                    <div className="relative space-y-2">
                      <span className="absolute left-0 top-2 bottom-2 w-px bg-[var(--ui-border-default)]" />
                      {weaknessTracks.map((item) => (
                        <div key={item.id} className="relative pl-4">
                          <span className="absolute -left-[5px] top-5 h-2.5 w-2.5 rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-bg-panel)]" />
                          <div className="rounded-xl border border-[var(--ui-border-default)] px-3 py-2.5">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-[12px] font-medium text-[var(--ui-text-primary)]">
                                  <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                                    {item.label}
                                  </MarkdownWithMath>
                                </div>
                                <div className="mt-1 text-[11px] text-[var(--ui-text-primary)]">
                                  首次发现 {formatDateTime(item.firstSeenAt)} · 最近出现 {formatDateTime(item.lastSeenAt)}
                                </div>
                              </div>
                              <div className="rounded-full bg-[var(--ui-bg-panel)] px-2.5 py-1 text-[11px] text-[var(--ui-text-primary)]">
                                {item.status}
                              </div>
                            </div>
                            <div className="mt-1 text-[11px] text-[var(--ui-text-primary)]">
                              出现 {item.count} 次{item.resolvedAt ? ` · 修复于 ${formatDateTime(item.resolvedAt)}` : ''}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {detail.knowledgeProfile && (
                <section className="bg-[var(--ui-bg-panel)] border-t border-[var(--ui-border-default)] pt-3.5">
                  <div className="text-[16px] font-semibold text-[var(--ui-text-primary)]">题卡知识画像</div>
                  <div className="mt-3 grid gap-2 text-[13px] text-[var(--ui-text-primary)]">
                    <div>
                      <span>知识点：</span>
                      <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                        {detail.knowledgeProfile.knowledge_points.join('、') || '-'}
                      </MarkdownWithMath>
                    </div>
                    <div>
                      <span>易错点：</span>
                      <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                        {detail.knowledgeProfile.common_traps.join('、') || '-'}
                      </MarkdownWithMath>
                    </div>
                    <div>
                      <span>混淆点：</span>
                      <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                        {detail.knowledgeProfile.confusing_points.join('、') || '-'}
                      </MarkdownWithMath>
                    </div>
                    <div>
                      <span>解题思路：</span>
                      <MarkdownWithMath compact transformMarkdown={normalizeFavoriteMarkdown}>
                        {detail.knowledgeProfile.solution_strategies.join('、') || '-'}
                      </MarkdownWithMath>
                    </div>
                  </div>
                </section>
              )}
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-[var(--ui-border-default)]">
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleOpenSelected}
                  className="rounded-xl bg-[var(--ui-btn-solid-bg)] px-4 py-2 text-sm text-white hover:bg-[var(--ui-btn-solid-hover)]"
                >
                  审题记录
                </button>
                <button
                  type="button"
                  onClick={() => void handleAddToReviewPlan()}
                  className="rounded-xl border border-[var(--ui-border-strong)] px-4 py-2 text-sm text-[var(--ui-text-primary)]"
                >
                  加入专项复习
                </button>
              </div>
              <button
                type="button"
                onClick={() => setIsMasteryModalOpen(false)}
                className="rounded-xl border border-[var(--ui-border-strong)] px-4 py-2 text-sm text-[var(--ui-text-primary)]"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


