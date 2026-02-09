import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FlashcardItem, FlashcardMasteryStats, UserInfo } from '../types'
import { MarkdownWithMath } from './MarkdownWithMath'
import { FlashcardApi } from '../services/flashcardApi'

interface FlashcardPanelProps {
  backendBaseUrl: string
  documentId: number | null
  documentTitle: string | null
  user: UserInfo | null
  onBack: () => void
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
  ensureDocument?: () => Promise<number | null>
  onDocumentResolved?: (documentId: number) => void
}

const MASTERY_COLORS: Record<string, string> = {
  new: 'bg-slate-100 text-slate-600 border-slate-200',
  struggling: 'bg-rose-50 text-rose-700 border-rose-200',
  reviewing: 'bg-amber-50 text-amber-700 border-amber-200',
  mastered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

export const FlashcardPanel: React.FC<FlashcardPanelProps> = ({
  backendBaseUrl,
  documentId,
  documentTitle,
  user,
  onBack,
  onToast,
  ensureDocument,
  onDocumentResolved,
}) => {
  const { t, i18n } = useTranslation('common')
  const preferredLanguage: 'zh' | 'en' = i18n.language?.toLowerCase().startsWith('en') ? 'en' : 'zh'
  const [items, setItems] = useState<FlashcardItem[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [stats, setStats] = useState<FlashcardMasteryStats | null>(null)
  const [mode, setMode] = useState<'all' | 'due'>('all')

  const tenantId = user?.tenant_id
  const userId = user?.id
  const docTitle = documentTitle ?? t('flashcard.document.untitled')
  const canOperate = Boolean(tenantId && userId)

  // ── 加载闪卡列表 ──────────────────────────────────

  const loadCards = useCallback(async (overrideMode?: 'all' | 'due', overrideDocumentId?: number) => {
    const targetDocumentId = overrideDocumentId ?? documentId
    if (!tenantId || !userId || !targetDocumentId) return
    setLoading(true)
    setError(null)
    try {
      let cards: FlashcardItem[]
      const effectiveMode = overrideMode ?? mode
      if (effectiveMode === 'due') {
        cards = await FlashcardApi.getDueFlashcards(backendBaseUrl, tenantId, userId, targetDocumentId)
      } else {
        cards = await FlashcardApi.listFlashcards(backendBaseUrl, tenantId, userId, targetDocumentId)
      }
      setItems(cards)
      setCurrentIndex(0)
      setRevealed(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('flashcard.messages.load_failed')
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [backendBaseUrl, tenantId, userId, documentId, mode, t])

  // ── 加载掌握统计 ──────────────────────────────────

  const loadStats = useCallback(async () => {
    if (!tenantId || !userId || !documentId) return
    try {
      const s = await FlashcardApi.getMasteryStats(backendBaseUrl, tenantId, userId, documentId)
      setStats(s)
    } catch {
      // 统计加载失败不阻塞主流程
    }
  }, [backendBaseUrl, tenantId, userId, documentId])

  // ── 生成闪卡 ──────────────────────────────────────

  const handleGenerate = useCallback(async (force = false) => {
    if (!tenantId || !userId) return

    setGenerating(true)
    setError(null)

    let targetDocId = documentId
    try {
      if (!targetDocId && ensureDocument) {
        const resolved = await ensureDocument()
        if (resolved) {
          targetDocId = resolved
          onDocumentResolved?.(resolved)
        }
      }
      if (!targetDocId) {
        setError(t('flashcard.messages.need_document'))
        return
      }

      const result = await FlashcardApi.generateFlashcards(
        backendBaseUrl, tenantId, userId, targetDocId, 40, force, preferredLanguage,
      )
      onToast?.(
        t('flashcard.toast.generated', { count: result.cardCount, mode: result.mode }),
        'success',
      )
      // 生成结束后默认回到“全部卡片”，并强制使用生成时的 documentId 刷新
      setMode('all')
      await loadCards('all', targetDocId)
      await loadStats()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('flashcard.messages.generate_failed')
      setError(msg)
      onToast?.(msg, 'error')
    } finally {
      setGenerating(false)
    }
  }, [
    backendBaseUrl,
    tenantId,
    userId,
    documentId,
    ensureDocument,
    onDocumentResolved,
    onToast,
    t,
    loadCards,
    loadStats,
    preferredLanguage,
  ])

  // ── 自评提交 ──────────────────────────────────────

  const handleReview = useCallback(async (score: number) => {
    const card = items[currentIndex]
    if (!card || !tenantId || !userId) return

    setReviewSubmitting(true)
    try {
      await FlashcardApi.submitReview(backendBaseUrl, tenantId, userId, card.cardId, score)
      // 更新本地状态
      const updated = [...items]
      const newMastery = score === 0 ? 'struggling' : score === 1 ? 'reviewing' : 'mastered'
      updated[currentIndex] = { ...card, masteryState: newMastery as FlashcardItem['masteryState'], lastScore: score }
      setItems(updated)
      // 自动翻到下一张
      if (currentIndex < items.length - 1) {
        setCurrentIndex(currentIndex + 1)
        setRevealed(false)
      } else {
        onToast?.(t('flashcard.toast.round_complete'), 'success')
        await loadStats()
      }
    } catch (err) {
      onToast?.(t('flashcard.toast.review_failed'), 'error')
    } finally {
      setReviewSubmitting(false)
    }
  }, [items, currentIndex, tenantId, userId, backendBaseUrl, onToast, t, loadStats])

  // ── Agent 升级 ────────────────────────────────────

  const handleEscalate = useCallback(async () => {
    const card = items[currentIndex]
    if (!card || !tenantId || !userId) return

    try {
      const result = await FlashcardApi.agentEscalate(backendBaseUrl, tenantId, userId, card.cardId)
      onToast?.(result.message, 'info')
    } catch (err) {
      onToast?.(t('flashcard.toast.escalate_failed'), 'error')
    }
  }, [items, currentIndex, tenantId, userId, backendBaseUrl, onToast, t])

  // ── 初始加载 ──────────────────────────────────────

  useEffect(() => {
    if (!tenantId || !userId || !documentId) {
      setItems([])
      setStats(null)
      setCurrentIndex(0)
      setRevealed(false)
      return
    }
    void loadCards()
    void loadStats()
  }, [tenantId, userId, documentId, loadCards, loadStats])

  // ── 导航 ──────────────────────────────────────────

  const goPrev = useCallback(() => {
    if (items.length === 0) return
    setCurrentIndex((p) => (p - 1 + items.length) % items.length)
    setRevealed(false)
  }, [items.length])

  const goNext = useCallback(() => {
    if (items.length === 0) return
    setCurrentIndex((p) => (p + 1) % items.length)
    setRevealed(false)
  }, [items.length])

  const currentItem = items.length > 0 ? items[currentIndex] : null

  // ── 渲染 ──────────────────────────────────────────

  return (
    <div className="h-full w-full rounded-xl bg-[radial-gradient(circle_at_top,_rgba(15,23,42,0.08),_transparent_60%)] backdrop-blur flex flex-col">
      {/* ── 顶栏 ── */}
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{t('flashcard.header.badge')}</div>
          <h2 className="text-xl font-semibold text-slate-900">{docTitle}</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-slate-200 overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => {
                if (mode !== 'all') {
                  setMode('all')
                  void loadCards('all')
                }
              }}
              className={`px-3 py-1.5 transition-colors ${
                mode === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-transparent text-slate-500 hover:bg-slate-50'
              }`}
            >
              {t('flashcard.mode.all')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (mode !== 'due') {
                  setMode('due')
                  void loadCards('due')
                }
              }}
              className={`px-3 py-1.5 transition-colors ${
                mode === 'due'
                  ? 'bg-slate-900 text-white'
                  : 'bg-transparent text-slate-500 hover:bg-slate-50'
              }`}
            >
              {t('flashcard.mode.due')}
            </button>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-1.5 rounded-full border border-slate-200 text-slate-600 hover:border-slate-300 text-sm"
          >
            {t('flashcard.header.back')}
          </button>
        </div>
      </div>

      {/* ── 掌握统计条 ── */}
      {stats && stats.total > 0 && (
        <div className="px-6 pb-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-slate-500">{t('flashcard.stats.total', { count: stats.total })}</span>
          <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
            {t('flashcard.stats.mastered', { count: stats.mastered })}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
            {t('flashcard.stats.reviewing', { count: stats.reviewing })}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
            {t('flashcard.stats.struggling', { count: stats.struggling })}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
            {t('flashcard.stats.new_cards', { count: stats.neverReviewed })}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-semibold">
            {t('flashcard.stats.due_today', { count: stats.dueToday })}
          </span>
        </div>
      )}

      {/* ── 主体区域 ── */}
      <div className="flex-1 px-6 py-4 overflow-y-auto">
        {/* 空态 / 加载 / 错误 */}
        {!documentId && !loading ? (
          <div className="flex flex-col items-center justify-center text-center gap-4 text-slate-500 text-sm py-20 border border-dashed border-slate-200 rounded-lg">
            <p>{t('flashcard.messages.need_document')}</p>
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={!canOperate || generating}
              className="px-5 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold shadow disabled:opacity-60"
            >
              {generating ? t('flashcard.buttons.generating') : t('flashcard.buttons.generate')}
            </button>
          </div>
        ) : loading ? (
          <div className="text-center text-slate-500 text-sm py-20">{generating ? t('flashcard.messages.generating_in_progress') : t('flashcard.states.loading')}</div>
        ) : !loading && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-4 text-slate-500 text-sm py-20 border border-dashed border-slate-200 rounded-lg">
            <p>{generating ? t('flashcard.messages.generating_in_progress') : error ?? t('flashcard.messages.no_items')}</p>
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={!canOperate || generating}
              className="px-5 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold shadow disabled:opacity-60"
            >
              {generating ? t('flashcard.buttons.generating') : t('flashcard.buttons.generate')}
            </button>
          </div>
        ) : error && items.length > 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-4 py-20">
            <p className="text-rose-500 text-sm">{error}</p>
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={!canOperate || generating}
              className="px-5 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold shadow disabled:opacity-60"
            >
              {generating ? t('flashcard.buttons.generating') : t('flashcard.buttons.generate')}
            </button>
          </div>
        ) : currentItem ? (
          <div className="h-full flex flex-col items-center justify-between gap-6">
            {/* 导航 */}
            <div className="flex items-center gap-4 text-sm text-slate-500">
              <button type="button" onClick={goPrev} className="p-2 rounded-full border border-slate-200 text-slate-600 hover:border-slate-400">
                <span className="material-symbols-outlined text-[18px]">chevron_left</span>
              </button>
              <span className="text-slate-700 font-semibold">{currentIndex + 1}/{items.length}</span>
              <button type="button" onClick={goNext} className="p-2 rounded-full border border-slate-200 text-slate-600 hover:border-slate-400">
                <span className="material-symbols-outlined text-[18px]">chevron_right</span>
              </button>
            </div>

            {/* 卡片 */}
            <div className="relative w-full max-w-3xl flex-1 flex items-center justify-center">
              <div className="absolute inset-0 scale-95 translate-y-6 blur-2xl bg-white/40 rounded-[32px]" />
              <div className="relative w-full bg-white border border-slate-200 rounded-[32px] shadow-2xl px-10 py-8 flex flex-col gap-5">
                {/* 卡头：知识点标签 + 掌握状态 */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <span className={`inline-block w-fit px-3 py-0.5 text-xs rounded-full border ${MASTERY_COLORS[currentItem.masteryState]}`}>
                      {t(`flashcard.mastery.${currentItem.masteryState}`)}
                    </span>
                    <h3 className="text-lg font-semibold text-slate-900">{currentItem.conceptTag}</h3>
                  </div>
                  {currentItem.confidence != null && (
                    <span className="text-[10px] text-slate-400">
                      {t('flashcard.card.confidence', { value: Math.round(currentItem.confidence * 100) })}
                    </span>
                  )}
                </div>

                {/* CUE（正面） */}
                <div className="min-h-[80px]">
                  <div className="text-xs uppercase tracking-[0.15em] text-slate-400 mb-2">{t('flashcard.card.cue_label')}</div>
                  <MarkdownWithMath className="text-base leading-relaxed" compact>
                    {currentItem.cue || t('flashcard.states.empty_front')}
                  </MarkdownWithMath>
                </div>

                {/* 翻面按钮 */}
                {!revealed && (
                  <button
                    type="button"
                    onClick={() => setRevealed(true)}
                    className="self-center px-6 py-2 rounded-full border border-slate-300 text-slate-600 hover:border-slate-500 text-sm font-medium transition-colors"
                  >
                    {t('flashcard.buttons.show_answer')}
                  </button>
                )}

                {/* ANSWER（背面） */}
                <div className={`transition-all duration-500 ${revealed ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none h-0 overflow-hidden'}`}>
                  <div className="bg-slate-900 text-white rounded-2xl px-6 py-4 shadow-inner">
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-300 mb-2">{t('flashcard.card.answer_label')}</div>
                    <MarkdownWithMath className="text-base leading-relaxed text-white" compact>
                      {currentItem.answer || t('flashcard.states.empty_answer')}
                    </MarkdownWithMath>
                  </div>

                  {/* 自评按钮组 */}
                  <div className="mt-4 flex items-center justify-center gap-3">
                    <button
                      type="button"
                      disabled={reviewSubmitting}
                      onClick={() => void handleReview(0)}
                      className="px-4 py-2 rounded-full bg-rose-500 text-white text-sm font-semibold shadow hover:bg-rose-600 disabled:opacity-60 transition-colors"
                    >
                      {t('flashcard.review.score_0')}
                    </button>
                    <button
                      type="button"
                      disabled={reviewSubmitting}
                      onClick={() => void handleReview(1)}
                      className="px-4 py-2 rounded-full bg-amber-500 text-white text-sm font-semibold shadow hover:bg-amber-600 disabled:opacity-60 transition-colors"
                    >
                      {t('flashcard.review.score_1')}
                    </button>
                    <button
                      type="button"
                      disabled={reviewSubmitting}
                      onClick={() => void handleReview(2)}
                      className="px-4 py-2 rounded-full bg-emerald-500 text-white text-sm font-semibold shadow hover:bg-emerald-600 disabled:opacity-60 transition-colors"
                    >
                      {t('flashcard.review.score_2')}
                    </button>
                  </div>

                  {/* Agent 升级入口 */}
                  <div className="mt-3 flex justify-center">
                    <button
                      type="button"
                      onClick={() => void handleEscalate()}
                      className="text-xs text-blue-600 hover:text-blue-800 underline underline-offset-2"
                    >
                      {t('flashcard.review.ask_agent')}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 底部操作 */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleGenerate(true)}
                disabled={generating}
                className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold shadow disabled:opacity-60"
              >
                {generating ? t('flashcard.buttons.generating') : t('flashcard.buttons.regenerate')}
              </button>
              <button
                type="button"
                onClick={() => void loadCards()}
                disabled={loading}
                className="px-4 py-2 rounded-full border border-slate-200 text-slate-600 text-sm hover:border-slate-400 disabled:opacity-60"
              >
                {t('flashcard.buttons.refresh')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
