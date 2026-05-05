import { apiJson, withJsonBody } from '../lib/api'
import type { MathTranslationResponse } from '../types'

export async function translateMathInput(
  baseUrl: string,
  text: string,
  signal?: AbortSignal,
): Promise<MathTranslationResponse> {
  return apiJson<MathTranslationResponse>(`${baseUrl}/api/translation/math`, {
    method: 'POST',
    ...withJsonBody({ text }),
    signal,
  })
}
