import type {
  AddFavoriteRequest,
  AddFavoriteResponse,
  CheckFavoriteResponse,
  FavoriteQuotaResponse,
  FavoritesListResponse,
  RemoveFavoriteResponse,
} from '../types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

/**
 * 收藏题目
 */
export async function addFavorite(
  baseUrl: string,
  tenantId: number,
  userId: number,
  questionId: number,
  questionTypeId?: number | null,
  subjectId?: number | null,
  tagIds?: number[] | null,
): Promise<AddFavoriteResponse> {
  const body: AddFavoriteRequest = {
    tenant_id: tenantId,
    user_id: userId,
    question_id: questionId,
    question_type_id: questionTypeId,
    subject_id: subjectId,
    tag_ids: tagIds,
  }

  const resp = await fetch(`${baseUrl}/api/questions/favorites`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `收藏失败 (${resp.status})`)
  }

  return (await resp.json()) as AddFavoriteResponse
}

/**
 * 取消收藏
 */
export async function removeFavorite(
  baseUrl: string,
  tenantId: number,
  userId: number,
  questionId: number,
): Promise<RemoveFavoriteResponse> {
  const resp = await fetch(
    `${baseUrl}/api/questions/favorites/${questionId}?tenant_id=${tenantId}&user_id=${userId}`,
    {
      method: 'DELETE',
    },
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `取消收藏失败 (${resp.status})`)
  }

  return (await resp.json()) as RemoveFavoriteResponse
}

/**
 * 获取收藏列表（分页）
 */
export async function getFavorites(
  baseUrl: string,
  tenantId: number,
  userId: number,
  page: number = 1,
  pageSize: number = 20,
): Promise<FavoritesListResponse> {
  const resp = await fetch(
    `${baseUrl}/api/questions/favorites?tenant_id=${tenantId}&user_id=${userId}&page=${page}&page_size=${pageSize}`,
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `获取收藏列表失败 (${resp.status})`)
  }

  return (await resp.json()) as FavoritesListResponse
}

/**
 * 检查题目是否已收藏
 */
export async function checkFavorite(
  baseUrl: string,
  tenantId: number,
  userId: number,
  questionId: number,
): Promise<CheckFavoriteResponse> {
  const resp = await fetch(
    `${baseUrl}/api/questions/favorites/${questionId}/check?tenant_id=${tenantId}&user_id=${userId}`,
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `检查收藏状态失败 (${resp.status})`)
  }

  return (await resp.json()) as CheckFavoriteResponse
}

/**
 * 获取收藏配额信息
 */
export async function getFavoriteQuota(
  baseUrl: string,
  tenantId: number,
  userId: number,
): Promise<FavoriteQuotaResponse> {
  const resp = await fetch(
    `${baseUrl}/api/questions/favorites/quota?tenant_id=${tenantId}&user_id=${userId}`,
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `获取配额信息失败 (${resp.status})`)
  }

  return (await resp.json()) as FavoriteQuotaResponse
}
