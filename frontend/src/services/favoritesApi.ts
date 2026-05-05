import type {
  AddFavoriteResponse,
  CheckFavoriteResponse,
  FavoritesListResponse,
  RemoveFavoriteResponse,
} from '../types'
import { apiFetch, apiJson, withJsonBody } from '../lib/api'

/**
 * 收藏题目
 */
export async function addFavorite(
  baseUrl: string,
  _tenantId: number,
  _userId: string | number,
  questionId: number,
  questionTypeId?: number | string | null,
  subjectId?: number | string | null,
  tagIds?: Array<number | string> | null,
): Promise<AddFavoriteResponse> {
  return apiJson<AddFavoriteResponse>(`${baseUrl}/api/favorites`, {
    method: 'POST',
    ...withJsonBody({
      questionID: String(questionId),
      questionTypeID: questionTypeId != null ? String(questionTypeId) : null,
      subjectID: subjectId != null ? String(subjectId) : null,
      tagIDs: tagIds?.map((id) => String(id)),
    }),
  })
}

/**
 * 取消收藏
 */
export async function removeFavorite(
  baseUrl: string,
  _tenantId: number,
  _userId: string | number,
  questionId: number,
): Promise<RemoveFavoriteResponse> {
  const response = await apiFetch(`${baseUrl}/api/favorites/${questionId}`, {
    method: 'DELETE',
  })
  return (await response.json()) as RemoveFavoriteResponse
}

/**
 * 获取收藏列表（分页）
 */
export async function getFavorites(
  baseUrl: string,
  _tenantId: number,
  _userId: string | number,
  page: number = 1,
  pageSize: number = 20,
): Promise<FavoritesListResponse> {
  return apiJson<FavoritesListResponse>(`${baseUrl}/api/favorites?page=${page}&page_size=${pageSize}`, {
    method: 'GET',
  })
}

/**
 * 检查题目是否已收藏
 */
export async function checkFavorite(
  baseUrl: string,
  _tenantId: number,
  _userId: string | number,
  questionId: number,
): Promise<CheckFavoriteResponse> {
  return apiJson<CheckFavoriteResponse>(`${baseUrl}/api/favorites/${questionId}/check`, {
    method: 'GET',
  })
}

