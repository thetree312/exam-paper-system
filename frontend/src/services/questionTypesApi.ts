import type { QuestionType } from '../types'
import { apiJson, withJsonBody } from '../lib/api'

/**
 * 获取题型列表
 */
export async function getQuestionTypes(
  baseUrl: string,
  tenantId: number,
): Promise<QuestionType[]> {
  const data = await apiJson<{ items: QuestionType[] }>(
    `${baseUrl}/api/taxonomies/question-types?tenant_id=${tenantId}`,
    {
      method: 'GET',
    },
  )
  return data.items
}

/**
 * 创建新题型（或获取已存在的）
 */
export async function createQuestionType(
  baseUrl: string,
  tenantId: number,
  name: string,
): Promise<QuestionType> {
  return apiJson<QuestionType>(`${baseUrl}/api/taxonomies/question-types`, {
    method: 'POST',
    ...withJsonBody({
      tenant_id: tenantId,
      name,
    }),
  })
}
