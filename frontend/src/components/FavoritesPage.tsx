import React, { useCallback, useEffect, useState } from 'react'
import { getFavorites, getFavoriteQuota, removeFavorite } from '../services/favoritesApi'
import { MarkdownWithMath } from './MarkdownWithMath'
import AnimatedHeartButton from './AnimatedHeartButton'
import type { FavoriteQuotaResponse, QuestionFavorite, UserInfo } from '../types'

interface FavoritesPageProps {
  backendBaseUrl: string
  user: UserInfo
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
  onBack?: () => void
  onAddToEditor?: (questionId: number) => void
}

/**
 * 检测题目内容是否应该禁用 LaTeX
 * 规则：如果内容中有大量 $...$ 且内部只是数字/逗号/空格，说明是货币符号，应禁用 LaTeX
 */
function shouldDisableMath(content: string): boolean {
  if (!content) return false

  // 出现经典 LaTeX 控制字符时优先认为是数学题
  if (/[\\{}^_]/.test(content)) {
    return false
  }

  const dollarPairs = content.match(/\$([^\$]+?)\$/g) || []
  const hasSuspiciousPair = dollarPairs.some((match) => {
    const inner = match.slice(1, -1).trim()
    const tooManySpaces = inner.split(/\s+/).length > 3
    const tooLongWithoutCommands = inner.length > 50 && !inner.includes('\\')
    return tooManySpaces || tooLongWithoutCommands
  })

  const lonelyDollarRegex = /\$(?=\s?\d+)/g
  let lonelyMatch: RegExpExecArray | null
  let hasLonelyDollar = false
  while (!hasLonelyDollar && (lonelyMatch = lonelyDollarRegex.exec(content))) {
    const startIndex = lonelyMatch.index
    const searchWindow = content.slice(startIndex + 1, startIndex + 21)
    if (!searchWindow.includes('$')) {
      hasLonelyDollar = true
    }
  }

  const shouldDisable = hasSuspiciousPair || hasLonelyDollar

  console.log('[FavoritesPage] shouldDisableMath:', {
    totalPairs: dollarPairs.length,
    hasSuspiciousPair,
    hasLonelyDollar,
    shouldDisable,
    samples: dollarPairs.slice(0, 5),
  })

  return shouldDisable
}

export const FavoritesPage: React.FC<FavoritesPageProps> = ({
  backendBaseUrl,
  user,
  onToast,
  onBack,
  onAddToEditor,
}) => {
  const [favorites, setFavorites] = useState<QuestionFavorite[]>([])
  const [quota, setQuota] = useState<FavoriteQuotaResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [pageSize] = useState(20)
  const [searchQuery, setSearchQuery] = useState('')
  const [removingId, setRemovingId] = useState<number | null>(null)

  const loadFavorites = useCallback(
    async (page: number) => {
      setIsLoading(true)
      try {
        const [favoritesResp, quotaResp] = await Promise.all([
          getFavorites(backendBaseUrl, user.tenant_id, user.id, page, pageSize),
          getFavoriteQuota(backendBaseUrl, user.tenant_id, user.id),
        ])

        setFavorites(favoritesResp.items)
        setTotalPages(Math.ceil(favoritesResp.total / pageSize))
        setQuota(quotaResp)
      } catch (err) {
        console.error('[favorites] load failed', err)
        onToast?.('加载收藏列表失败', 'error')
      } finally {
        setIsLoading(false)
      }
    },
    [backendBaseUrl, user.tenant_id, user.id, pageSize, onToast],
  )

  useEffect(() => {
    loadFavorites(currentPage)
  }, [currentPage, loadFavorites])

  const handleRemoveFavorite = useCallback(
    async (questionId: number) => {
      if (removingId) return

      setRemovingId(questionId)
      try {
        await removeFavorite(backendBaseUrl, user.tenant_id, user.id, questionId)
        onToast?.('已取消收藏', 'success')
        
        // 重新加载当前页
        await loadFavorites(currentPage)
      } catch (err) {
        console.error('[favorites] remove failed', err)
        onToast?.('取消收藏失败', 'error')
      } finally {
        setRemovingId(null)
      }
    },
    [backendBaseUrl, user.tenant_id, user.id, currentPage, loadFavorites, onToast, removingId],
  )

  const handlePageChange = useCallback((page: number) => {
    if (page < 1 || page > totalPages) return
    setCurrentPage(page)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [totalPages])

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    } catch {
      return dateStr
    }
  }

  const filteredFavorites = searchQuery.trim()
    ? favorites.filter((fav) =>
        fav.question.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        fav.question_id.toString().includes(searchQuery),
      )
    : favorites

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Main Content */}
      <main className="flex-1 w-full overflow-y-auto">
        <div className="max-w-[960px] mx-auto px-6 py-12">
          {/* Title Section */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-16">
            <div>
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-3 tracking-tight">收藏题库</h1>
              <p className="text-base text-slate-500 font-light max-w-lg">
                管理您的个人精选题目。您可以在此复习、整理或导出为试卷。
              </p>
            </div>
            {quota && (
              <div className="flex flex-col items-start md:items-end gap-1">
                <div className="text-[13px] font-medium text-slate-500 uppercase tracking-wider">Storage Usage</div>
                <div className="text-2xl font-mono font-medium text-slate-900">
                  {quota.current_count}{' '}
                  <span className="text-slate-300 text-lg">/</span>{' '}
                  <span className="text-slate-400 text-lg">
                    {quota.max_favorites === -1 ? '∞' : quota.max_favorites}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Search and Filter */}
          <div className="mb-14 relative z-10">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1 group">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-black transition-colors">
                  search
                </span>
                <input
                  className="w-full pl-12 pr-4 py-4 bg-white border border-slate-200 rounded-xl text-[15px] placeholder-slate-400 text-slate-900 focus:outline-none focus:border-black focus:ring-1 focus:ring-black shadow-sm transition-all"
                  placeholder="搜索题目关键词、ID..."
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="h-full px-5 py-3 flex items-center gap-2 bg-white border border-slate-200 rounded-xl hover:border-slate-300 hover:bg-slate-50 text-slate-900 text-[14px] font-medium transition-all shadow-sm"
                  onClick={() => loadFavorites(currentPage)}
                >
                  <span className="material-symbols-outlined text-[20px]">refresh</span>
                  <span>刷新</span>
                </button>
              </div>
            </div>
          </div>

          {/* Loading State */}
          {isLoading && (
            <div className="flex items-center justify-center py-20">
              <span className="material-symbols-outlined text-[32px] animate-spin text-slate-400">progress_activity</span>
            </div>
          )}

          {/* Empty State */}
          {!isLoading && filteredFavorites.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <span className="material-symbols-outlined text-[64px] text-slate-300 mb-4">star_border</span>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">暂无收藏题目</h3>
              <p className="text-slate-500 mb-6">
                {searchQuery ? '没有找到匹配的题目' : '开始收藏您喜欢的题目吧'}
              </p>
              {onBack && (
                <button
                  onClick={onBack}
                  className="px-6 py-3 bg-slate-900 text-white rounded-xl hover:bg-slate-800 transition-colors text-sm font-medium"
                >
                  返回题库
                </button>
              )}
            </div>
          )}

          {/* Question Cards */}
          {!isLoading && filteredFavorites.length > 0 && (
            <div className="space-y-6">
              {filteredFavorites.map((favorite, cardIndex) => {
                // 日志：打印每个题卡的信息
                console.log(`[FavoritesPage] Rendering card ${cardIndex}:`, {
                  favorite_id: favorite.id,
                  question_id: favorite.question_id,
                  content_length: favorite.question.content.length,
                  has_legend_images: (favorite.question.legend_images?.length ?? 0) > 0,
                  page: favorite.question.page,
                  sequence_index: favorite.question.sequence_index,
                })

                return (
                  <article
                    key={favorite.id}
                    className="question-card relative p-8 rounded-2xl border border-slate-100 bg-white hover:border-slate-200 hover:shadow-card group transition-all"
                  >
                    <div className="flex justify-between items-start mb-5">
                      <div className="flex items-center gap-3">
                        <span className="text-[12px] font-mono font-medium text-slate-400 bg-slate-50 border border-slate-100 px-2 py-0.5 rounded">
                          Q-{favorite.question_id}
                        </span>
                        <div className="w-1 h-1 rounded-full bg-slate-300"></div>
                        <div className="flex gap-2">
                          {favorite.question.page && (
                            <>
                              <span className="text-[13px] text-slate-600">第 {favorite.question.page} 页</span>
                              <span className="text-[13px] text-slate-400">/</span>
                            </>
                          )}
                          <span className="text-[13px] text-slate-600">序号 {favorite.question.sequence_index + 1}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {onAddToEditor && (
                          <button
                            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-blue-50 text-blue-600 hover:text-blue-700 transition-colors"
                            title="添加到编辑区"
                            onClick={() => onAddToEditor(favorite.question_id)}
                          >
                            <span className="material-symbols-outlined text-[20px]">forms_add_on</span>
                          </button>
                        )}
                        <AnimatedHeartButton
                          isLikedInitial={true}
                          isLoading={removingId === favorite.question_id}
                          onLike={async () => {
                            // 收藏页已是喜欢状态，不需要处理
                          }}
                          onUnlike={async () => {
                            await handleRemoveFavorite(favorite.question_id)
                          }}
                        />
                      </div>
                    </div>

                    <div className="text-[16px] leading-8 text-slate-900 font-normal md:pr-12">
                      {(() => {
                        const disableMath = shouldDisableMath(favorite.question.content)
                        console.log(`[FavoritesPage] Card ${favorite.id} rendering with disableMath=${disableMath}`)
                        return (
                          <MarkdownWithMath disableMath={disableMath}>
                            {favorite.question.content}
                          </MarkdownWithMath>
                        )
                      })()}
                    </div>

                    {favorite.question.legend_images && favorite.question.legend_images.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {favorite.question.legend_images.map((img, idx) => (
                          <img
                            key={idx}
                            src={img}
                            alt={`图例 ${idx + 1}`}
                            className="max-w-[200px] max-h-[150px] rounded-lg border border-slate-200"
                          />
                        ))}
                      </div>
                    )}

                    {/* 元数据显示：题型、科目、标签 */}
                    {(favorite.question_type || favorite.subject || (favorite.tags && favorite.tags.length > 0)) && (
                      <div className="mt-4 flex flex-wrap gap-3 items-center">
                        {favorite.question_type && (
                          <span className="inline-flex items-center gap-1 px-3 py-1 bg-blue-50 border border-blue-200 rounded-full text-sm text-blue-700">
                            <span className="material-symbols-outlined text-[16px]">category</span>
                            {favorite.question_type.name}
                          </span>
                        )}
                        {favorite.subject && (
                          <span className="inline-flex items-center gap-1 px-3 py-1 bg-purple-50 border border-purple-200 rounded-full text-sm text-purple-700">
                            <span className="material-symbols-outlined text-[16px]">school</span>
                            {favorite.subject.name}
                          </span>
                        )}
                        {favorite.tags && favorite.tags.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {favorite.tags.map((tag) => (
                              <span
                                key={tag.id}
                                className="inline-flex items-center gap-1 px-3 py-1 bg-amber-50 border border-amber-200 rounded-full text-sm text-amber-700"
                              >
                                <span className="material-symbols-outlined text-[16px]">label</span>
                                {tag.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="mt-6 flex items-center justify-between pt-4 border-t border-dashed border-slate-100">
                      <span className="text-[11px] text-slate-400 font-mono tracking-wide uppercase">
                        Added {formatDate(favorite.created_at)}
                      </span>
                    </div>
                  </article>
                )
              })}
            </div>
          )}

          {/* Pagination */}
          {!isLoading && filteredFavorites.length > 0 && totalPages > 1 && (
            <div className="mt-20 flex justify-center items-center gap-4">
              <button
                className="w-10 h-10 flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-50 hover:text-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage <= 1}
              >
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <div className="flex items-center gap-2 text-[14px] font-medium text-slate-500">
                <span className="text-black">{currentPage}</span>
                <span className="text-slate-300">/</span>
                <span>{totalPages}</span>
              </div>
              <button
                className="w-10 h-10 flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-50 hover:text-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages}
              >
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </div>
          )}
        </div>
      </main>

      <style>{`
        .question-card {
          transition: all 0.2s ease;
        }
      `}</style>
    </div>
  )
}
