import { ModelSettingsResolver } from "../model-settings/resolver"

type LearningArtifactCapability =
  | "flashcard_generation"
  | "flashcard_long_outline"
  | "mindmap_outline_generation"
  | "mindmap_generation"

function extractJson(content: string) {
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "")
  const objectStart = trimmed.indexOf("{")
  const objectEnd = trimmed.lastIndexOf("}")
  const arrayStart = trimmed.indexOf("[")
  const arrayEnd = trimmed.lastIndexOf("]")

  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart && (arrayStart < objectStart || objectStart === -1)) {
    return trimmed.slice(arrayStart, arrayEnd + 1)
  }
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1)
  }
  return trimmed
}

export const LearningArtifactsLlmService = {
  async chatJson(input: {
    userID: string
    capability: LearningArtifactCapability
    system: string
    user: string
    temperature?: number
    topP?: number
    maxTokens?: number
  }) {
    const config = await ModelSettingsResolver.resolveCapability({
      userID: input.userID,
      capability: input.capability,
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("Learning artifact LLM request timed out")), 240_000)
    let response: Response
    try {
      response = await fetch(`${config.baseURL}/chat/completions`, {
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
          max_tokens: input.maxTokens ?? 4000,
          response_format: {
            type: "json_object",
          },
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Learning artifact LLM request failed (${response.status}): ${text || response.statusText}`)
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string
        }
      }>
    }
    const content = payload.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error("Learning artifact LLM returned empty content")

    return JSON.parse(extractJson(content)) as Record<string, unknown>
  },
}
