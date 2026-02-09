import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FlashcardItem, UserInfo } from '../types'
import { MarkdownWithMath } from './MarkdownWithMath'
import { FlashcardApi } from '../services/flashcardApi'

interface FlashcardPanelProps {
  backendBaseUrl: string
  documentId: number | null
  documentTitle: string | null
  user: UserInfo | null
  onBack: () => void
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
  /** 当需要生成题目文档时触发，例如调用 GLM-OCR；返回生成后的 documentId */
  ensureDocument?: () => Promise<number | null>
  onDocumentResolved?: (documentId: number) => void
}

function getCardKey(item: FlashcardItem, index: number): string {
  return `${item.documentId || 'doc'}-${item.questionId ?? 'virtual'}-${index}`
}

type FlashcardSource = 'exam' | 'article'

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
  const { t } = useTranslation('common')
  const [items, setItems] = useState<FlashcardItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealedMap, setRevealedMap] = useState<Record<string, boolean>>({})
  const [activeSource, setActiveSource] = useState<FlashcardSource | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)

  const tenantId = user?.tenant_id
  const docTitle = documentTitle ?? t('flashcard.document.untitled')

  const disableFetchMessage = useMemo(() => {
    if (!user) return t('flashcard.messages.login_required')
    if (!documentId) return t('flashcard.messages.need_document')
    return null
  }, [user, documentId, t])

  const loadFlashcards = useCallback(
    async (options?: { skipEnsure?: boolean }) => {
      if (!tenantId) {
        setError(t('flashcard.messages.login_required'))
        return
      }

      setLoading(true)
      setError(null)

      let targetDocumentId = documentId
      try {
        if (!targetDocumentId && !options?.skipEnsure && ensureDocument) {
          const resolvedId = await ensureDocument()
          if (resolvedId) {
            targetDocumentId = resolvedId
            onDocumentResolved?.(resolvedId)
          }
        }

        if (!targetDocumentId) {
          setItems([])
          setActiveSource(null)
          setError(disableFetchMessage)
          return
        }

        let nextItems: FlashcardItem[] = []
        let source: FlashcardSource | null = null
        let lastError: Error | null = null

        try {
          const examItems = await FlashcardApi.fetchExamFlashcards(backendBaseUrl, tenantId, targetDocumentId)
          if (examItems.length > 0) {
            nextItems = examItems
            source = 'exam'
          }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(t('flashcard.messages.load_failed'))
        }

        if (source === null) {
          try {
            const articleItems = await FlashcardApi.fetchArticleFlashcards(
              backendBaseUrl,
              tenantId,
              targetDocumentId,
            )
            nextItems = articleItems
            source = 'article'
            lastError = null
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(t('flashcard.messages.load_failed'))
          }
        }

        if (lastError && (!nextItems || nextItems.length === 0)) {
          throw lastError
        }

        setItems(nextItems)
        setActiveSource(source)
        setRevealedMap({})
        if (nextItems.length === 0) {
          setError(t('flashcard.messages.no_items'))
        }
      } catch (err) {
        console.error('[flashcard-panel] fetch failed', err)
        const msg = err instanceof Error ? err.message : t('flashcard.messages.load_failed')
        setError(msg)
        if (onToast) {
          onToast(t('flashcard.toast.load_failed', { error: msg }), 'error')
        }
      } finally {
        setLoading(false)
      }
    }, [
      backendBaseUrl,
      documentId,
      disableFetchMessage,
      ensureDocument,
      onDocumentResolved,
      onToast,
      tenantId,
    ])

  useEffect(() => {
    if (!tenantId || !documentId) {
      setItems([])
      setRevealedMap({})
      setActiveSource(null)
      setCurrentIndex(0)
      return
    }
    void loadFlashcards()
  }, [tenantId, documentId, loadFlashcards])

  useEffect(() => {
    setCurrentIndex(0)
    setRevealedMap({})
  }, [items])

  const handleToggleReveal = useCallback((key: string) => {
    setRevealedMap((prev) => ({
      ...prev,
      [key]: !prev[key],
    }))
  }, [])

  const handleGenerate = useCallback(() => {
    void loadFlashcards()
  }, [loadFlashcards])

  const canGenerate = Boolean(tenantId)
  const hasDeck = items.length > 0
  const currentItem = hasDeck ? items[currentIndex] : null
  const currentKey = currentItem ? getCardKey(currentItem, currentIndex) : null
  const currentRevealed = currentKey ? revealedMap[currentKey] : false

  const goPrev = useCallback(() => {
    if (!hasDeck) return
    setCurrentIndex((prev) => (prev - 1 + items.length) % items.length)
  }, [hasDeck, items.length])

  const goNext = useCallback(() => {
    if (!hasDeck) return
    setCurrentIndex((prev) => (prev + 1) % items.length)
  }, [hasDeck, items.length])

  const revealCurrent = useCallback(() => {
    if (!currentKey) return
    setRevealedMap((prev) => ({
      ...prev,
      [currentKey]: !prev[currentKey],
    }))
  }, [currentKey])

  const renderAnswerBadge = (item: FlashcardItem) => {
    if (!item.backMarkdown) return null
    const status = item.answerStatus || 'default'
    const source = item.answerSource === 'ai' ? t('flashcard.badges.source_ai') : t('flashcard.badges.source_manual')
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
        {status === 'ai_draft' ? t('flashcard.badges.answer_ai_draft') : t('flashcard.badges.answer_standard')}
        <span className="text-[10px] text-emerald-500">{source}</span>
      </span>
    )
  }

  return (
    <div className="h-full w-full rounded-xl bg-[radial-gradient(circle_at_top,_rgba(15,23,42,0.08),_transparent_60%)] backdrop-blur flex flex-col">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{t('flashcard.header.badge')}</div>
          <h2 className="text-xl font-semibold text-slate-900">{docTitle}</h2>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 rounded-full border border-slate-200 text-slate-600 hover:border-slate-300"
        >
          {t('flashcard.header.back')}
        </button>
      </div>

      <div className="px-6 py-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="text-sm text-slate-500">
          {activeSource === 'article'
            ? t('flashcard.info.article')
            : activeSource === 'exam'
              ? t('flashcard.info.exam')
              : t('flashcard.info.default')}
        </div>
        {activeSource && (
          <span
            className={`px-3 py-1 text-xs rounded-full border ${
              activeSource === 'article'
                ? 'border-blue-200 bg-blue-50 text-blue-600'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
          >
            {t('flashcard.info.source_label', {
              source:
                activeSource === 'article'
                  ? t('flashcard.info.source_article')
                  : t('flashcard.info.source_exam'),
            })}
          </span>
        )}
      </div>

      <div className="flex-1 px-6 py-6">
        {disableFetchMessage && !documentId ? (
          <div className="flex flex-col items-center justify-center text-center gap-4 text-slate-500 text-sm py-20 border border-dashed border-slate-200 rounded-lg">
            <p>{disableFetchMessage}</p>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate || loading}
              className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold shadow disabled:opacity-60"
            >
              {loading ? t('flashcard.buttons.generating') : t('flashcard.buttons.generate')}
            </button>
          </div>
        ) : loading ? (
          <div className="text-center text-slate-500 text-sm py-20">{t('flashcard.states.loading')}</div>
        ) : error ? (
          <div className="text-center text-rose-500 text-sm py-20">{error}</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-4 text-slate-500 text-sm py-20 border border-dashed border-slate-200 rounded-lg">
            <p>{t('flashcard.messages.no_items')}</p>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate || loading}
              className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold shadow disabled:opacity-60"
            >
              {loading ? t('flashcard.buttons.generating') : t('flashcard.buttons.generate')}
            </button>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-between">
            <div className="flex items-center gap-4 text-sm text-slate-500">
              <button
                type="button"
                onClick={goPrev}
                className="p-2 rounded-full border border-slate-200 text-slate-600 hover:border-slate-400"
              >
                <span className="material-symbols-outlined text-[18px]">chevron_left</span>
              </button>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{t('flashcard.states.question_label')}</div>
              <span className="text-slate-700 font-semibold">
                {currentIndex + 1}/{items.length}
              </span>
              <button
                type="button"
                onClick={goNext}
                className="p-2 rounded-full border border-slate-200 text-slate-600 hover:border-slate-400"
              >
                <span className="material-symbols-outlined text-[18px]">chevron_right</span>
              </button>
            </div>

            {currentItem && (
              <div className="relative w-full max-w-3xl flex-1 flex items-center justify-center">
                <div className="absolute inset-0 scale-95 translate-y-6 blur-2xl bg-white/40 rounded-[32px]"></div>
                <div
                  className="relative w-full bg-white border border-slate-200 rounded-[32px] shadow-2xl px-10 py-10 flex flex-col gap-6 transition-transform duration-500"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.15em] text-slate-400">#{currentItem.sequenceIndex + 1}</div>
                      <h3 className="text-2xl font-semibold text-slate-900">{docTitle}</h3>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {renderAnswerBadge(currentItem)}
                      <button
                        type="button"
                        onClick={revealCurrent}
                        className={`text-sm px-4 py-1.5 rounded-full border transition-colors ${
                          currentRevealed
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-slate-200 text-slate-600 hover:border-slate-400'
                        }`}
                      >
                        {currentRevealed ? t('flashcard.buttons.hide_answer') : t('flashcard.buttons.show_answer')}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <MarkdownWithMath className="text-lg leading-relaxed" compact>
                      {currentItem.frontMarkdown || t('flashcard.states.empty_front')}
                    </MarkdownWithMath>
                    {currentItem.legendImages?.length ? (
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        {currentItem.legendImages.map((src, idx) => (
                          <div key={`${currentKey}-legend-${idx}`} className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
                            <img src={src} alt={`legend-${idx + 1}`} className="w-full h-32 object-contain" />
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className={`transition-all duration-500 ${currentRevealed ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none'}`}>
                    <div className="bg-slate-900 text-white rounded-2xl px-6 py-4 shadow-inner">
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-300 mb-2">
                        {t('flashcard.states.answer_label')}
                      </div>
                      {currentItem.backMarkdown ? (
                        <MarkdownWithMath className="text-base leading-relaxed text-white" compact>
                          {currentItem.backMarkdown}
                        </MarkdownWithMath>
                      ) : (
                        <p className="text-sm text-slate-200">{t('flashcard.states.empty_answer')}</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-8 flex items-center gap-3">
              <button
                type="button"
                onClick={handleGenerate}
                disabled={loading}
                className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold shadow disabled:opacity-60"
              >
                {loading ? t('flashcard.buttons.generating') : t('flashcard.buttons.refresh')}
              </button>
              <div className="text-xs text-slate-500">
                {activeSource === 'article'
                  ? t('flashcard.info.footer_article')
                  : t('flashcard.info.footer_exam')}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
