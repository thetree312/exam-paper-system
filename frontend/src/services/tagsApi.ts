import type { Tag } from '../types'
import { apiJson, withJsonBody } from '../lib/api'

/**
 * 获取标签列表
 */
export async function getTags(
  baseUrl: string,
  tenantId: number,
): Promise<Tag[]> {
  const data = await apiJson<{ items: Tag[] }>(
    `${baseUrl}/api/taxonomies/tags?tenant_id=${tenantId}`,
    {
      method: 'GET',
    },
  )
  return data.items
}

/**
 * 创建新标签（或获取已存在的）
 */
export async function createTag(
  baseUrl: string,
  tenantId: number,
  name: string,
): Promise<Tag> {
  return apiJson<Tag>(`${baseUrl}/api/taxonomies/tags`, {
    method: 'POST',
    ...withJsonBody({
      tenant_id: tenantId,
      name,
    }),
  })
}
