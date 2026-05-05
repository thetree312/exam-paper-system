export const TRANSLATION_SCOPES = ["word", "sentence"] as const

export type TranslationScope = (typeof TRANSLATION_SCOPES)[number]

export type TranslationSense = {
  pos: string
  meaning: string
  note?: string | null
}

export type TranslationWordPayload = {
  phonetic?: string | null
  translation?: string | null
  example?: string | null
  lemma?: string | null
  morphology?: string | null
  forms: string[]
  senses: TranslationSense[]
}

export type TranslationQuotaInfo = {
  limit: number | null
  remaining: number | null
  resetAt: string | null
}

export type TranslationLookupResponse = {
  translation?: string | null
  word?: TranslationWordPayload | null
  quota: TranslationQuotaInfo | null
}

export type MathTranslationResponse = {
  translated_text: string
  rendered_latex: string
  confidence: number
  notes: string
  meta: {
    model: string
    latencyMs: number
    usage?: Record<string, unknown> | null
  }
}
