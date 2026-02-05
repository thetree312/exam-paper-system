import React, { useCallback, useEffect, useState, useRef } from 'react'
import { addFavorite, checkFavorite, removeFavorite } from '../services/favoritesApi'
import { FavoriteConfigDialog } from './FavoriteConfigDialog'
import AnimatedHeartButton from './AnimatedHeartButton'
import type { FavoriteConfig } from '../types'

interface FavoriteButtonProps {
  backendBaseUrl: string
  tenantId: number
  userId: number
  questionId: number | undefined
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
  isFromFavorite?: boolean
}

export const FavoriteButton: React.FC<FavoriteButtonProps> = ({
  backendBaseUrl,
  tenantId,
  userId,
  questionId,
  onToast,
  isFromFavorite = false,
}) => {
  const [isFavorited, setIsFavorited] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [showConfigDialog, setShowConfigDialog] = useState(false)
  
  // 用于管理 onLike 的 Promise resolve/reject
  const likePromiseRef = useRef<{
    resolve: () => void
    reject: (err: Error) => void
  } | null>(null)

  // 检查收藏状态
  useEffect(() => {
    if (!questionId) {
      setIsFavorited(false)
      return
    }

    // 如果来自收藏页，直接标记为已收藏，不需要异步检查
    if (isFromFavorite) {
      setIsFavorited(true)
      setIsChecking(false)
      return
    }

    let cancelled = false
    setIsChecking(true)

    checkFavorite(backendBaseUrl, tenantId, userId, questionId)
      .then((resp) => {
        if (!cancelled) {
          setIsFavorited(resp.is_favorited)
        }
      })
      .catch((err) => {
        console.error('[favorite] check failed', err)
        if (!cancelled) {
          setIsFavorited(false)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsChecking(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, tenantId, userId, questionId, isFromFavorite])



  const handleConfigConfirm = useCallback(
    async (config: FavoriteConfig) => {
      if (!questionId || isLoading) return

      setIsLoading(true)

      try {
        await addFavorite(
          backendBaseUrl,
          tenantId,
          userId,
          questionId,
          config.question_type_id,
          config.subject_id,
          config.tag_ids.length > 0 ? config.tag_ids : undefined,
        )
        setIsFavorited(true)
        onToast?.('已收藏', 'success')
        
        // 通知 onLike Promise 成功
        likePromiseRef.current?.resolve()
        likePromiseRef.current = null
      } catch (err) {
        console.error('[favorite] add failed', err)
        const errorMsg = err instanceof Error ? err.message : '操作失败'

        // 解析错误信息
        if (errorMsg.includes('402') || errorMsg.includes('配额') || errorMsg.includes('上限')) {
          onToast?.('收藏数量已达上限，请升级订阅', 'error')
          likePromiseRef.current?.reject(err as Error)
        } else if (errorMsg.includes('409') || errorMsg.includes('已收藏')) {
          onToast?.('该题目已收藏', 'info')
          setIsFavorited(true)
          likePromiseRef.current?.resolve()
        } else {
          onToast?.('收藏失败', 'error')
          likePromiseRef.current?.reject(err as Error)
        }
        likePromiseRef.current = null
      } finally {
        setIsLoading(false)
      }
    },
    [backendBaseUrl, tenantId, userId, questionId, isLoading, onToast],
  )

  const handleConfigClose = useCallback(() => {
    setShowConfigDialog(false)
    // 用户取消对话框，reject Promise
    likePromiseRef.current?.reject(new Error('用户取消'))
    likePromiseRef.current = null
  }, [])

  // 如果题目未保存（没有 questionId），不显示按钮
  if (!questionId) {
    return null
  }

  return (
    <>
      <AnimatedHeartButton
        isLikedInitial={isFavorited}
        isLoading={isLoading || isChecking}
        onLike={async () => {
          return new Promise<void>((resolve, reject) => {
            likePromiseRef.current = { resolve, reject }
            setShowConfigDialog(true)
          })
        }}
        onUnlike={async () => {
          if (!questionId) return
          setIsLoading(true)
          try {
            await removeFavorite(backendBaseUrl, tenantId, userId, questionId)
            setIsFavorited(false)
            onToast?.('已取消收藏', 'success')
          } catch (err) {
            console.error('[favorite] remove failed', err)
            onToast?.('取消收藏失败', 'error')
            // 不抛出错误，让动画完整播放，然后状态会自动回退
          } finally {
            setIsLoading(false)
          }
        }}
      />

      <FavoriteConfigDialog
        open={showConfigDialog}
        onClose={handleConfigClose}
        onConfirm={handleConfigConfirm}
        backendBaseUrl={backendBaseUrl}
        tenantId={tenantId}
        onToast={onToast}
      />
    </>
  )
}
