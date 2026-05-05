import { AuthService } from "../auth/service"
import { ModelSettingsResolver } from "../model-settings/resolver"
import { TranslationQuotaExceededError, TranslationQuotaService } from "./quota-service"
import type {
  MathTranslationResponse,
  TranslationLookupResponse,
  TranslationQuotaInfo,
  TranslationScope,
  TranslationSense,
  TranslationWordPayload,
} from "./types"

type TranslationModelResult = {
  translation?: string | null
  phonetic?: string | null
  wordTranslation?: string | null
  example?: string | null
  lemma?: string | null
  morphology?: string | null
  forms?: string[]
  senses?: TranslationSense[]
}

class TranslationServiceError extends Error {}
class TranslationQuotaError extends Error {
  constructor(
    message: string,
    public readonly quota: TranslationQuotaInfo,
  ) {
    super(message)
  }
}

function normalizeString(value: unknown) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeStringList(input: unknown) {
  if (Array.isArray(input)) {
    return Array.from(new Set(input.map(normalizeString).filter((item): item is string => Boolean(item))))
  }
  if (typeof input === "string") {
    return Array.from(
      new Set(
        input
          .split(/[;,/、\s]+/)
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    )
  }
  return []
}

function normalizeSenses(input: unknown): TranslationSense[] {
  if (!Array.isArray(input)) return []
  const normalized: TranslationSense[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const meaning = normalizeString(record.meaning)
    if (!meaning) continue
    normalized.push({
      pos: normalizeString(record.pos) ?? "",
      meaning,
      note: normalizeString(record.note),
    })
  }
  return normalized
}

function parseWordPayload(content: string): TranslationModelResult {
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "")
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new TranslationServiceError(`Word translation payload is not valid JSON: ${(error as Error).message}`)
  }

  if (!parsed || typeof parsed !== "object") {
    throw new TranslationServiceError("Word translation payload must be an object")
  }

  const record = parsed as Record<string, unknown>
  return {
    phonetic: normalizeString(record.phonetic),
    wordTranslation: normalizeString(record.trans ?? record.translation),
    example: normalizeString(record.example),
    lemma: normalizeString(record.lemma),
    morphology: normalizeString(record.morphology),
    forms: normalizeStringList(record.forms),
    senses: normalizeSenses(record.senses),
  }
}

function buildPrompts(text: string, scope: TranslationScope) {
  const cleaned = text.trim()
  if (!cleaned) throw new Error("Translation text is required")

  if (scope === "word") {
    return {
      system:
        "你是一个严格的英汉词典助手。必须只输出 JSON 对象，不允许 Markdown、解释、前后缀或代码块。输出字段必须是 phonetic, trans, example, lemma, morphology, forms, senses。",
      user: [
        "请解析下列英文单词，按 JSON 输出：",
        '{',
        '  "phonetic": "英式音标，格式 /.../，没有则为 null",',
        '  "trans": "核心中文释义，没有则为 null",',
        '  "example": "英文例句，必须包含目标词的原形或当前词形，没有则为 null",',
        '  "lemma": "词根或原形，没有则为 null",',
        '  "morphology": "词形变化说明，没有则为 null",',
        '  "forms": ["相关词形"],',
        '  "senses": [{"pos": "词性缩写", "meaning": "中文释义", "note": "可选补充说明"}]',
        '}',
        cleaned,
      ].join("\n"),
    }
  }

  return {
    system: "你是一个精准的英译中翻译助手，只返回译文，禁止输出解释、标题或前后缀。",
    user: `请将以下英文内容翻译成自然流畅的中文，仅输出译文：\n${cleaned}`,
  }
}

function buildMathPrompt(text: string) {
  const cleaned = text.trim()
  if (!cleaned) throw new Error("Math translation text is required")
  return [
    "将输入转成可渲染 LaTeX，并输出严格 JSON。",
    '仅输出: {"translated_text":string,"rendered_latex":string,"confidence":number,"notes":string}',
    "整段翻译，勿只改局部；rendered_latex 不含 $/$$ 且不保留中文数学词。",
    "保留原意，不擅自补题；若不确定则降 confidence 并在 notes 说明。",
    `当前输入：${cleaned}`,
  ].join("\n")
}

function buildChatCompletionsUrl(baseURL: string) {
  const normalized = baseURL.trim().replace(/\/+$/, "")
  const withoutSuffix = normalized.replace(/\/chat\/completions$/i, "")
  return `${withoutSuffix}/chat/completions`
}

async function resolveTranslationModel(input: {
  userID: string
  scope: TranslationScope
}) {
  const capability = input.scope === "word" ? "translation_word" : "translation_sentence"
  return ModelSettingsResolver.resolveCapability({
    userID: input.userID,
    capability,
  })
}

async function callModel(input: { userID: string; text: string; scope: TranslationScope }) {
  const model = await resolveTranslationModel({
    userID: input.userID,
    scope: input.scope,
  })
  const prompts = buildPrompts(input.text, input.scope)
  const payload: Record<string, unknown> = {
    model: model.modelID,
    messages: [
      { role: "system", content: prompts.system },
      { role: "user", content: prompts.user },
    ],
    temperature: 0.2,
    top_p: 0.85,
  }
  if (input.scope === "word") {
    payload.response_format = { type: "json_object" }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("Translation request timed out")), 45_000)
  let response: Response
  try {
    response = await fetch(`${model.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${model.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new TranslationServiceError(`Translation provider error (${response.status}): ${text || response.statusText}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string
      }
    }>
  }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new TranslationServiceError(`Translation provider returned empty content for model ${model.modelID}`)

  if (input.scope === "word") return parseWordPayload(content)
  return { translation: content } satisfies TranslationModelResult
}

type MathModelResult = {
  translated_text: string
  rendered_latex: string
  confidence: number
  notes: string
  model: string
  latencyMs: number
  usage?: Record<string, unknown> | null
}

function parseMathPayload(content: string, fallbackInput: string) {
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "")
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const translatedText = normalizeString(parsed.translated_text) ?? fallbackInput
    const renderedLatex = normalizeString(parsed.rendered_latex) ?? translatedText
    return {
      translated_text: translatedText,
      rendered_latex: renderedLatex,
      confidence: Number(parsed.confidence ?? 0),
      notes: normalizeString(parsed.notes) ?? "",
    }
  } catch {
    return {
      translated_text: fallbackInput,
      rendered_latex: fallbackInput,
      confidence: 0,
      notes: "non-json response",
    }
  }
}

async function callMathModel(input: { userID: string; text: string }): Promise<MathModelResult> {
  const model = await ModelSettingsResolver.resolveCapability({
    userID: input.userID,
    capability: "translation_math",
  })
  const payload: Record<string, unknown> = {
    model: model.modelID,
    temperature: 0.2,
    top_p: 0.85,
    max_tokens: 256,
    enable_thinking: false,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "你输出严格 JSON，不要额外解释。" },
      { role: "user", content: buildMathPrompt(input.text) },
    ],
  }

  const controller = new AbortController()
  const startedAt = Date.now()
  const timeout = setTimeout(() => controller.abort(new Error("Math translation request timed out")), 45_000)
  let response: Response
  try {
    response = await fetch(buildChatCompletionsUrl(model.baseURL), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${model.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  const latencyMs = Date.now() - startedAt
  const raw = await response.text()
  if (!response.ok) {
    throw new TranslationServiceError(`Math translation provider error (${response.status}): ${raw || response.statusText}`)
  }

  let parsedResponse: { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, unknown> | null; model?: string } = {}
  try {
    parsedResponse = JSON.parse(raw)
  } catch {
    throw new TranslationServiceError("Math translation provider returned invalid JSON response")
  }

  const content = parsedResponse.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new TranslationServiceError(`Math translation provider returned empty content for model ${model.modelID}`)
  }
  return {
    ...parseMathPayload(content, input.text.trim()),
    model: parsedResponse.model ?? model.modelID,
    latencyMs,
    usage: parsedResponse.usage ?? null,
  }
}

function buildQuotaInfo(input: TranslationQuotaInfo | null) {
  return input
}

function buildWordPayload(result: TranslationModelResult): TranslationWordPayload {
  return {
    phonetic: result.phonetic ?? null,
    translation: result.wordTranslation ?? null,
    example: result.example ?? null,
    lemma: result.lemma ?? null,
    morphology: result.morphology ?? null,
    forms: result.forms ?? [],
    senses: result.senses ?? [],
  }
}

export const TranslationDomainService = {
  async lookup(input: { userID: string; text: string; scope: TranslationScope }): Promise<TranslationLookupResponse> {
    const user = await AuthService.getUserByID(input.userID)
    let quota: TranslationQuotaInfo | null = null

    if (!(user.subscription.plan === "pro" && user.subscription.status === "active")) {
      try {
        const status = TranslationQuotaService.consume(input.userID)
        quota = {
          limit: status.limit,
          remaining: status.remaining,
          resetAt: status.resetAt,
        }
      } catch (error) {
        if (error instanceof TranslationQuotaExceededError) {
          throw new TranslationQuotaError("免费版每小时仅支持 20 次翻译，请稍后再试或升级订阅", {
            limit: error.status.limit,
            remaining: error.status.remaining,
            resetAt: error.status.resetAt,
          })
        }
        throw error
      }
    }

    const result = await callModel(input)
    return {
      translation: result.translation ?? null,
      word: input.scope === "word" ? buildWordPayload(result) : null,
      quota: buildQuotaInfo(quota),
    }
  },

  async translateMath(input: { userID: string; text: string }): Promise<MathTranslationResponse> {
    const result = await callMathModel(input)
    return {
      translated_text: result.translated_text,
      rendered_latex: result.rendered_latex,
      confidence: Number.isFinite(result.confidence) ? Math.max(0, Math.min(1, result.confidence)) : 0,
      notes: result.notes,
      meta: {
        model: result.model,
        latencyMs: result.latencyMs,
        usage: result.usage ?? null,
      },
    }
  },
}

export { TranslationQuotaError }
