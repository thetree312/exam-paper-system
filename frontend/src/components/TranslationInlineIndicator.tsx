import React from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import type { TranslationScope } from '../types'

export type InlineIndicatorStatus = 'idle' | 'loading' | 'error'

interface TranslationInlineIndicatorProps {
  active: boolean
  x: number
  y: number
  status: InlineIndicatorStatus
  scope: TranslationScope
  onRetry?: () => void
}

export const TranslationInlineIndicator: React.FC<TranslationInlineIndicatorProps> = ({
  active,
  x,
  y,
  status,
  scope,
  onRetry,
}) => {
  const { t } = useTranslation('common')
  if (!active || status === 'idle') return null

  const isError = status === 'error'

  const content = (
    <div
      className={`translation-inline-indicator translation-inline-indicator--${status}`}
      style={{ left: x, top: y }}
    >
      {isError ? (
        <button
          type="button"
          className="translation-inline-indicator__error-btn"
          onClick={onRetry}
          aria-label={t('translation.retry')}
        >
          <span className="material-symbols-outlined translation-inline-indicator__error-icon">error</span>
        </button>
      ) : (
        <span
          className="translation-inline-indicator__spinner"
          aria-label={scope === 'word' ? t('translation.loading_word') : t('translation.loading_sentence')}
        />
      )}
    </div>
  )

  return createPortal(content, document.body)
}
