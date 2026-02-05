import type { QuestionType } from '../types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

/**
 * 获取题型列表
 */
export async function getQuestionTypes(
  baseUrl: string,
  tenantId: number,
): Promise<QuestionType[]> {
  const resp = await fetch(
    `${baseUrl}/api/question-types?tenant_id=${tenantId}`,
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `获取题型列表失败 (${resp.status})`)
  }

  const data = (await resp.json()) as { items: QuestionType[] }
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
  const body = {
    tenant_id: tenantId,
    name,
  }

  const resp = await fetch(`${baseUrl}/api/question-types`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `创建题型失败 (${resp.status})`)
  }

  return (await resp.json()) as QuestionType
}
