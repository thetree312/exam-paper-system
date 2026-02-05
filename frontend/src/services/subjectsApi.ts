import type { Subject } from '../types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

/**
 * 获取科目列表
 */
export async function getSubjects(
  baseUrl: string,
  tenantId: number,
): Promise<Subject[]> {
  const resp = await fetch(
    `${baseUrl}/api/subjects?tenant_id=${tenantId}`,
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `获取科目列表失败 (${resp.status})`)
  }

  const data = (await resp.json()) as { items: Subject[] }
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
  const body = {
    tenant_id: tenantId,
    name,
  }

  const resp = await fetch(`${baseUrl}/api/subjects`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `创建科目失败 (${resp.status})`)
  }

  return (await resp.json()) as Subject
}
