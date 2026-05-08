import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FlashcardItem, FlashcardMasteryStats, UserInfo } from '../types'
import { MarkdownWithMath } from './MarkdownWithMath'
import { FlashcardApi } from '../services/flashcardApi'
import { fetchWorkroomArtifact, upsertWorkroomArtifact } from '../services/workroomApi'
import Icon from './Icon'


interface FlashcardPanelProps {
  backendBaseUrl: string
  workroomId: string | null | undefined
  documentId: string | null
  documentTitle: string | null
  user: UserInfo | null
  onBack: () => void
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
  ensureDocument?: () => Promise<string | null>
  onDocumentResolved?: (documentId: string) => void
}

const MASTERY_COLORS: Record<string, string> = {
  new: 'bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)] border-[var(--ui-border-default)]',
  struggling: 'bg-rose-50 text-rose-700 border-rose-200',
  reviewing: 'bg-amber-50 text-amber-700 border-amber-200',
  mastered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

export const FlashcardPanel: React.FC<FlashcardPanelProps> = ({
  backendBaseUrl,
  workroomId,
  documentId,
  documentTitle,
  user,
  onBack,
  onToast,
  ensureDocument,
  onDocumentResolved,
}) => {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<FlashcardItem[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [stats, setStats] = useState<FlashcardMasteryStats | null>(null)
  const [mode, setMode] = useState<'all' | 'due'>('all')
  const restoredStateKeyRef = React.useRef<string | null>(null)
  const restoredCardIdRef = React.useRef<string | null>(null)

  const userId = user?.id
  const docTitle = documentTitle ?? t('flashcard.document.untitled')
  const canOperate = Boolean(userId)
  const panelStateKey = userId && workroomId && documentId ? `${workroomId}:${documentId}:${userId}` : null

  // ── 加载闪卡列表 ──────────────────────────────────

  const loadCards = useCallback(async (overrideMode?: 'all' | 'due', overrideDocumentId?: string) => {
    const targetDocumentId = overrideDocumentId ?? documentId
    if (!userId || !targetDocumentId || !workroomId) return
    setLoading(true)
    setError(null)
    try {
      let cards: FlashcardItem[]
      const effectiveMode = overrideMode ?? mode
      if (effectiveMode === 'due') {
        cards = await FlashcardApi.getDueFlashcards(backendBaseUrl, workroomId, targetDocumentId)
      } else {
        cards = await FlashcardApi.listFlashcards(backendBaseUrl, workroomId, targetDocumentId)
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
  }, [backendBaseUrl, userId, documentId, mode, t, workroomId])

  // ── 加载掌握统计 ──────────────────────────────────

  const loadStats = useCallback(async () => {
    if (!userId || !documentId || !workroomId) return
    try {
      const s = await FlashcardApi.getMasteryStats(backendBaseUrl, workroomId, documentId)
      setStats(s)
    } catch {
      // 统计加载失败不阻塞主流程
    }
  }, [backendBaseUrl, userId, documentId, workroomId])

  // ── 生成闪卡 ──────────────────────────────────────

  const handleGenerate = useCallback(async (force = false) => {
    if (!userId || !workroomId) return

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
        backendBaseUrl, workroomId, targetDocId, 40, force,
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
  }, [backendBaseUrl, userId, documentId, ensureDocument, onDocumentResolved, onToast, t, loadCards, loadStats, workroomId])

  // ── 自评提交 ──────────────────────────────────────

  const handleReview = useCallback(async (score: number) => {
    const card = items[currentIndex]
    if (!card || !userId || !workroomId) return

    setReviewSubmitting(true)
    try {
      await FlashcardApi.submitReview(backendBaseUrl, workroomId, card.cardId, score)
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
  }, [items, currentIndex, userId, backendBaseUrl, onToast, t, loadStats, workroomId])

  // ── Agent 升级 ────────────────────────────────────

  const handleEscalate = useCallback(async () => {
    const card = items[currentIndex]
    if (!card || !userId || !workroomId) return

    try {
      const result = await FlashcardApi.agentEscalate(backendBaseUrl, workroomId, card.cardId)
      onToast?.(result.message, 'info')
    } catch (err) {
      onToast?.(t('flashcard.toast.escalate_failed'), 'error')
    }
  }, [items, currentIndex, userId, backendBaseUrl, onToast, t, workroomId])

  // ── 初始加载 ──────────────────────────────────────

  useEffect(() => {
    if (!userId || !documentId || !workroomId) {
      setItems([])
      setStats(null)
      setCurrentIndex(0)
      setRevealed(false)
      restoredStateKeyRef.current = null
      return
    }
    void loadCards()
    void loadStats()
  }, [userId, documentId, loadCards, loadStats, workroomId])

  useEffect(() => {
    if (!panelStateKey) {
      restoredStateKeyRef.current = null
      return
    }
    if (restoredStateKeyRef.current === panelStateKey) {
      return
    }

    let cancelled = false
    void fetchWorkroomArtifact(
      backendBaseUrl,
      workroomId!,
      user?.tenant_id ?? 0,
      userId!,
      'flashcard_panel',
      'current',
    )
      .then((artifact) => {
        if (cancelled || !artifact) return
        const payload = artifact.payload_json ?? {}
        if (String(payload.documentId ?? '') !== String(documentId)) return
        const artifactMode = payload.mode
        const artifactCurrentIndex = payload.currentIndex
        const artifactCurrentCardId = payload.currentCardId
        const artifactRevealed = payload.revealed

        if (artifactMode === 'all' || artifactMode === 'due') {
          setMode(artifactMode)
        }
        if (typeof artifactCurrentCardId === 'string' && artifactCurrentCardId.trim()) {
          restoredCardIdRef.current = artifactCurrentCardId
        }
        if (typeof artifactCurrentIndex === 'number' && artifactCurrentIndex >= 0) {
          setCurrentIndex(artifactCurrentIndex)
        }
        if (typeof artifactRevealed === 'boolean') {
          setRevealed(artifactRevealed)
        }
        restoredStateKeyRef.current = panelStateKey
      })
      .catch((err) => {
        console.error('[flashcard] failed to restore panel state', err)
      })

    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, documentId, panelStateKey, user?.tenant_id, userId, workroomId])

  useEffect(() => {
    if (!documentId || !userId || !workroomId || items.length === 0) return
    const safeIndex = Math.min(Math.max(currentIndex, 0), Math.max(items.length - 1, 0))
    const currentCard = items[safeIndex] ?? null
    const timer = window.setTimeout(() => {
      void upsertWorkroomArtifact(
        backendBaseUrl,
        workroomId,
        user?.tenant_id ?? 0,
        userId,
        'flashcard_panel',
        'current',
        {
          source_file_id: documentId,
          payload_json: {
            documentId,
            mode,
            currentIndex: safeIndex,
            currentCardId: currentCard?.cardId ?? null,
            revealed,
          },
        },
      ).catch((err) => {
        console.error('[flashcard] failed to persist panel state', err)
      })
    }, 220)

    return () => window.clearTimeout(timer)
  }, [backendBaseUrl, currentIndex, documentId, items, mode, revealed, user?.tenant_id, userId, workroomId])

  useEffect(() => {
    if (items.length === 0) {
      if (currentIndex !== 0) setCurrentIndex(0)
      if (revealed) setRevealed(false)
      return
    }
    if (restoredCardIdRef.current) {
      const restoredIndex = items.findIndex((item) => item.cardId === restoredCardIdRef.current)
      restoredCardIdRef.current = null
      if (restoredIndex >= 0 && restoredIndex !== currentIndex) {
        setCurrentIndex(restoredIndex)
        return
      }
    }
    if (currentIndex >= items.length) {
      setCurrentIndex(items.length - 1)
    }
  }, [currentIndex, items, revealed])

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
    <div className="flashcard-panel h-full w-full rounded-xl bg-[radial-gradient(circle_at_top,_rgba(15,23,42,0.08),_transparent_60%)] backdrop-blur flex flex-col">
      {/* ── 顶栏 ── */}
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--ui-text-primary)]">{t('flashcard.header.badge')}</div>
          <h2 className="text-xl font-semibold text-[var(--ui-text-primary)]">{docTitle}</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-[var(--ui-border-default)] overflow-hidden text-xs">
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
                  : 'bg-transparent text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]'
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
                  : 'bg-transparent text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]'
              }`}
            >
              {t('flashcard.mode.due')}
            </button>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-1.5 rounded-full border border-[var(--ui-border-default)] text-[var(--ui-text-primary)] hover:border-[var(--ui-border-strong)] text-sm"
          >
            {t('flashcard.header.back')}
          </button>
        </div>
      </div>

      {/* ── 掌握统计条 ── */}
      {stats && stats.total > 0 && (
        <div className="px-6 pb-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-[var(--ui-text-primary)]">{t('flashcard.stats.total', { count: stats.total })}</span>
          <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
            {t('flashcard.stats.mastered', { count: stats.mastered })}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
            {t('flashcard.stats.reviewing', { count: stats.reviewing })}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
            {t('flashcard.stats.struggling', { count: stats.struggling })}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)] border border-[var(--ui-border-default)]">
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
          <div className="flex flex-col items-center justify-center text-center gap-4 text-[var(--ui-text-primary)] text-sm py-20 border border-dashed border-[var(--ui-border-default)] rounded-lg">
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
          <div className="text-center text-[var(--ui-text-primary)] text-sm py-20">{generating ? t('flashcard.messages.generating_in_progress') : t('flashcard.states.loading')}</div>
        ) : !loading && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-4 text-[var(--ui-text-primary)] text-sm py-20 border border-dashed border-[var(--ui-border-default)] rounded-lg">
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
            <div className="flex items-center gap-4 text-sm text-[var(--ui-text-primary)]">
              <button type="button" onClick={goPrev} className="p-2 rounded-full border border-[var(--ui-border-default)] text-[var(--ui-text-primary)] hover:border-[var(--ui-border-strong)]">
                <Icon name={"chevron_left"} className="text-[18px]" />
              </button>
              <span className="text-[var(--ui-text-primary)] font-semibold">{currentIndex + 1}/{items.length}</span>
              <button type="button" onClick={goNext} className="p-2 rounded-full border border-[var(--ui-border-default)] text-[var(--ui-text-primary)] hover:border-[var(--ui-border-strong)]">
                <Icon name={"chevron_right"} className="text-[18px]" />
              </button>
            </div>

            {/* 卡片 */}
            <div className="relative w-full max-w-3xl flex-1 flex items-center justify-center">
              <div className="absolute inset-0 scale-95 translate-y-6 blur-2xl bg-[var(--ui-bg-panel)]/40 rounded-[32px]" />
              <div className="relative w-full bg-[var(--ui-bg-panel)] border border-[var(--ui-border-default)] rounded-[32px] shadow-2xl px-10 py-8 flex flex-col gap-5">
                {/* 卡头：知识点标签 + 掌握状态 */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <span className={`inline-block w-fit px-3 py-0.5 text-xs rounded-full border ${MASTERY_COLORS[currentItem.masteryState]}`}>
                      {t(`flashcard.mastery.${currentItem.masteryState}`)}
                    </span>
                    <h3 className="text-lg font-semibold text-[var(--ui-text-primary)]">{currentItem.conceptTag}</h3>
                  </div>
                  {currentItem.confidence != null && (
                    <span className="text-[10px] text-[var(--ui-text-primary)]">
                      {t('flashcard.card.confidence', { value: Math.round(currentItem.confidence * 100) })}
                    </span>
                  )}
                </div>

                {/* CUE（正面） */}
                <div className="min-h-[80px]">
                  <div className="text-xs uppercase tracking-[0.15em] text-[var(--ui-text-primary)] mb-2">{t('flashcard.card.cue_label')}</div>
                  <MarkdownWithMath className="text-base leading-relaxed" compact>
                    {currentItem.cue || t('flashcard.states.empty_front')}
                  </MarkdownWithMath>
                </div>

                {/* 翻面按钮 */}
                {!revealed && (
                  <button
                    type="button"
                    onClick={() => setRevealed(true)}
                    className="self-center px-6 py-2 rounded-full border border-[var(--ui-border-strong)] text-[var(--ui-text-primary)] hover:border-slate-500 text-sm font-medium transition-colors"
                  >
                    {t('flashcard.buttons.show_answer')}
                  </button>
                )}

                {/* ANSWER（背面） */}
                <div className={`transition-all duration-500 ${revealed ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none h-0 overflow-hidden'}`}>
                  <div className="bg-slate-900 text-white rounded-2xl px-6 py-4 shadow-inner">
                    <div className="text-xs uppercase tracking-[0.2em] text-[var(--ui-text-primary)] mb-2">{t('flashcard.card.answer_label')}</div>
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
                className="px-4 py-2 rounded-full border border-[var(--ui-border-default)] text-[var(--ui-text-primary)] text-sm hover:border-[var(--ui-border-strong)] disabled:opacity-60"
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


