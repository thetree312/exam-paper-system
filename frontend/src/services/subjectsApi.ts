import type { Subject } from '../types'
import { apiJson, withJsonBody } from '../lib/api'

/**
 * 获取科目列表
 */
export async function getSubjects(
  baseUrl: string,
  tenantId: number,
): Promise<Subject[]> {
  const data = await apiJson<{ items: Subject[] }>(
    `${baseUrl}/api/taxonomies/subjects?tenant_id=${tenantId}`,
    {
      method: 'GET',
    },
  )
  return data.items
}

/**
 * 创建新科目（或获取已存在的）
 */
export async function createSubject(
  baseUrl: string,
  tenantId: number,
  name: string,
): Promise<Subject> {
  return apiJson<Subject>(`${baseUrl}/api/taxonomies/subjects`, {
    method: 'POST',
    ...withJsonBody({
      tenant_id: tenantId,
      name,
    }),
  })
}
