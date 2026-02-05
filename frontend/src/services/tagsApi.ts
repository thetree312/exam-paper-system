import type { Tag } from '../types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

/**
 * 获取标签列表
 */
export async function getTags(
  baseUrl: string,
  tenantId: number,
): Promise<Tag[]> {
  const resp = await fetch(
    `${baseUrl}/api/tags?tenant_id=${tenantId}`,
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `获取标签列表失败 (${resp.status})`)
  }

  const data = (await resp.json()) as { items: Tag[] }
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
  const body = {
    tenant_id: tenantId,
    name,
  }

  const resp = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `创建标签失败 (${resp.status})`)
  }

  return (await resp.json()) as Tag
}
