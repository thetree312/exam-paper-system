import { ModelSettingsResolver } from "../model-settings/resolver"

type QuestionModelCapability = "question_split" | "question_grading"

async function chatJson(input: {
  userID: string
  capability: QuestionModelCapability
  system: string
  user: string
  temperature?: number
  topP?: number
  timeoutMs?: number
  retries?: number
}) {
  const config = await ModelSettingsResolver.resolveCapability({
    userID: input.userID,
    capability: input.capability,
  })

  const timeoutMs = input.timeoutMs ?? 45_000
  const retries = Math.max(0, input.retries ?? 0)

  const runOnce = async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("Question LLM request timed out")), timeoutMs)
    try {
      return await fetch(`${config.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.modelID,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          temperature: input.temperature ?? 0.2,
          top_p: input.topP ?? 0.8,
          max_tokens: 800,
          response_format: {
            type: "json_object",
          },
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  const isTimeoutError = (error: unknown) => {
    if (error instanceof Error && /timed out/i.test(error.message)) return true
    if (error instanceof DOMException && error.name === "AbortError") return true
    return false
  }

  let response: Response | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      response = await runOnce()
      lastError = null
      break
    } catch (error) {
      lastError = error
      if (!isTimeoutError(error) || attempt >= retries) throw error
    }
  }

  if (!response) {
    throw (lastError instanceof Error ? lastError : new Error("Question LLM request failed"))
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Question LLM request failed (${response.status}): ${text || response.statusText}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string
      }
    }>
  }
  const content = payload.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error("Question LLM returned empty content")

  try {
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    const start = content.indexOf("{")
    const end = content.lastIndexOf("}")
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>
    }
    throw new Error(`Question LLM returned non-JSON content: ${content.slice(0, 300)}`)
  }
}

export const QuestionLlmService = {
  chatJson,
}
