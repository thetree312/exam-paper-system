import { useState, useCallback, useEffect, memo } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

/**
 * 收藏按钮（本地 Material Symbols 版本）
 */
const AnimatedHeartButton = memo(
  ({
    isLikedInitial = false,
    onLike,
    onUnlike,
    isLoading = false,
  }: {
    isLikedInitial?: boolean
    onLike?: () => Promise<void> | void
    onUnlike?: () => Promise<void> | void
    isLoading?: boolean
  }) => {
    const { t } = useTranslation('common')
    const [status, setStatus] = useState(isLikedInitial ? 1 : 0)

    useEffect(() => {
      setStatus(isLikedInitial ? 1 : 0)
    }, [isLikedInitial])

    const handleClick = useCallback(async () => {
      if (isLoading) return
      if (status === 0) {
        try {
          if (onLike) await onLike()
          setStatus(1)
        } catch (e) {
          setStatus(0)
        }
      } else {
        try {
          if (onUnlike) await onUnlike()
          setStatus(0)
        } catch (e) {
          setStatus(1)
        }
      }
    }, [status, isLoading, onLike, onUnlike])

    return (
      <button
        onClick={handleClick}
        disabled={isLoading}
        className={`relative focus:outline-none flex items-center justify-center ${
          isLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        }`}
        style={{ WebkitTapHighlightColor: 'transparent' }}
        aria-label={status === 1 ? t('favorite_button.aria.remove') : t('favorite_button.aria.add')}
      >
        <Icon
          name={status === 1 ? 'bookmark_added' : 'bookmark_add'}
          filled={status === 1}
          className={`text-[20px] ${status === 1 ? 'text-blue-600' : 'text-[var(--ui-text-primary)]'}`}
        />
      </button>
    )
  }
)

AnimatedHeartButton.displayName = 'AnimatedHeartButton'

export default AnimatedHeartButton


