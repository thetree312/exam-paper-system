import type {
  TranslationLookupPayload,
  TranslationLookupResponse,
} from '../types'

export class TranslationApiError extends Error {
  status: number
  detail: unknown

  constructor(message: string, status: number, detail: unknown) {
    super(message)
    this.name = 'TranslationApiError'
    this.status = status
    this.detail = detail
  }
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

export async function lookupTranslation(
  baseUrl: string,
  payload: TranslationLookupPayload,
  signal?: AbortSignal,
): Promise<TranslationLookupResponse> {
  const body = {
    tenant_id: payload.tenantId,
    user_id: payload.userId,
    text: payload.text,
    scope: payload.scope,
  }

  const resp = await fetch(`${baseUrl}/api/translation/lookup`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal,
  })

  if (!resp.ok) {
    let detail: any = null
    try {
      detail = await resp.json()
    } catch {
      detail = await resp.text()
    }

    const normalizedDetail = typeof detail === 'string' ? detail : detail?.detail ?? detail
    const message =
      (typeof normalizedDetail === 'string' && normalizedDetail) ||
      normalizedDetail?.message ||
      '翻译服务不可用'

    throw new TranslationApiError(message, resp.status, normalizedDetail)
  }

  return (await resp.json()) as TranslationLookupResponse
}
