import React, { useState, useCallback, useEffect, useRef, memo } from 'react'

/**
 * AnimatedHeartButton - Material Design 风格版
 * 遵循 Material 3 的图标比例与运动规范
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
    const [status, setStatus] = useState(isLikedInitial ? 1 : 0)
    const [isAnimating, setIsAnimating] = useState(false)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 当 isLikedInitial 改变时，只在没有动画进行时更新状态
    useEffect(() => {
      if (!isAnimating) {
        setStatus(isLikedInitial ? 1 : 0)
      }
    }, [isLikedInitial, isAnimating])

    const clearCurrentTimer = useCallback(() => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }, [])

    useEffect(() => {
      return () => clearCurrentTimer()
    }, [clearCurrentTimer])

    const handleClick = useCallback(async () => {
      if (isAnimating || isLoading) return

      clearCurrentTimer()
      setIsAnimating(true)

      if (status === 0) {
        // 从空心到满心
        setStatus(1)
        try {
          if (onLike) await onLike()
        } catch (e) {
          setStatus(0)
        }
        timerRef.current = setTimeout(() => {
          setIsAnimating(false)
        }, 500)
      } else if (status === 1) {
        // 从满心到破碎
        setStatus(2)
        try {
          if (onUnlike) await onUnlike()
          // onUnlike 成功，继续破碎动画，最后回到空心
          timerRef.current = setTimeout(() => {
            setStatus(0)
            setIsAnimating(false)
          }, 700)
        } catch (e) {
          // onUnlike 失败，回退到满心，但让破碎动画完整播放
          timerRef.current = setTimeout(() => {
            setStatus(1)
            setIsAnimating(false)
          }, 700)
        }
      }
    }, [status, isAnimating, isLoading, onLike, onUnlike, clearCurrentTimer])

    return (
      <>
        <button
          onClick={handleClick}
          disabled={isLoading}
          className={`relative focus:outline-none flex items-center justify-center ${
            isLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          }`}
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-label={status === 1 ? 'Remove from favorites' : 'Add to favorites'}
        >
          <div className="relative w-5 h-5 flex items-center justify-center pointer-events-none">
            {/* Status 0: Initial (Material Border Style) */}
            {status === 0 && (
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-slate-500">
                <path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z" />
              </svg>
            )}

            {/* Status 1: Liked (Material Filled Style) */}
            {status === 1 && (
              <div className={isAnimating ? 'animate-m-pop' : ''}>
                <svg viewBox="0 0 24 24" className="w-5 h-5 fill-rose-600">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
                {isAnimating && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    {[...Array(6)].map((_, i) => (
                      <div
                        key={i}
                        className="absolute w-1 h-1 bg-rose-500 rounded-full animate-m-particle"
                        style={{
                          '--angle': `${i * 60}deg`,
                          '--dist': '18px',
                        } as React.CSSProperties}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Status 2: Cracking (Material Style Heartbreak) */}
            {status === 2 && (
              <div className="relative w-5 h-5">
                <svg
                  viewBox="0 0 24 24"
                  className="absolute inset-0 w-5 h-5 fill-slate-400 animate-m-crack-left"
                  style={{
                    clipPath:
                      'polygon(0% 0%, 50% 0%, 40% 30%, 55% 50%, 40% 70%, 50% 100%, 0% 100%)',
                  }}
                >
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
                <svg
                  viewBox="0 0 24 24"
                  className="absolute inset-0 w-5 h-5 fill-slate-400 animate-m-crack-right"
                  style={{
                    clipPath:
                      'polygon(50% 0%, 100% 0%, 100% 100%, 50% 100%, 40% 70%, 55% 50%, 40% 30%)',
                  }}
                >
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
              </div>
            )}
          </div>

          <style>{`
            /* Material Standard Easing: cubic-bezier(0.2, 0, 0, 1) */
            /* Material Emphasized-Decelerate: cubic-bezier(0.05, 0.7, 0.1, 1.0) */

            @keyframes m-pop {
              0% { transform: scale(0.8); }
              60% { transform: scale(1.2); }
              100% { transform: scale(1); }
            }

            @keyframes m-particle {
              0% { transform: rotate(var(--angle)) translateY(0); opacity: 1; }
              100% { transform: rotate(var(--angle)) translateY(calc(-1 * var(--dist))); opacity: 0; }
            }

            @keyframes m-crack-left {
              0% { transform: translate(0, 0) rotate(0); opacity: 1; }
              100% { transform: translate(-6px, 10px) rotate(-15deg); opacity: 0; }
            }

            @keyframes m-crack-right {
              0% { transform: translate(0, 0) rotate(0); opacity: 1; }
              100% { transform: translate(6px, 10px) rotate(15deg); opacity: 0; }
            }

            .animate-m-pop { animation: m-pop 400ms cubic-bezier(0.05, 0.7, 0.1, 1.0) forwards; }
            .animate-m-particle { animation: m-particle 500ms cubic-bezier(0, 0, 0.2, 1) forwards; }
            .animate-m-crack-left { animation: m-crack-left 600ms cubic-bezier(0.4, 0, 1, 1) forwards; }
            .animate-m-crack-right { animation: m-crack-right 600ms cubic-bezier(0.4, 0, 1, 1) forwards; }
          `}</style>
        </button>
      </>
    )
  }
)

AnimatedHeartButton.displayName = 'AnimatedHeartButton'

export default AnimatedHeartButton
