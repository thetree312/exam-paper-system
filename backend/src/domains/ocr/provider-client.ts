import { imageFileToDataUrl } from "../../lib/image-processing"
import { ModelSettingsResolver, type ResolvedModelExecution } from "../model-settings/resolver"

type NativeOcrPayload = {
  layout_details?: Array<Array<Record<string, unknown>>>
  data_info?: {
    pages?: Array<Record<string, unknown>>
  }
  md_results?: string
  code?: number
  message?: string
}

function resolveChatCompletionsEndpoint(baseURL: string) {
  return /\/chat\/completions\/?$/i.test(baseURL) ? baseURL : `${baseURL.replace(/\/+$/, "")}/chat/completions`
}

function resolveZhipuLayoutEndpoint(baseURL: string) {
  const normalized = baseURL.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "")
  return /\/layout_parsing$/i.test(normalized) ? normalized : `${normalized}/layout_parsing`
}

function extractTextFromOpenAiContent(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content)) {
    const joined = content
      .map((item) => {
        if (!item || typeof item !== "object") return ""
        const part = item as Record<string, unknown>
        if (typeof part.text === "string") return part.text.trim()
        if (part.type === "output_text" && typeof part.text === "string") return part.text.trim()
        return ""
      })
      .filter(Boolean)
      .join("\n")
      .trim()
    if (joined) return joined
  }
  throw new Error("OCR provider returned empty content")
}

function stripCodeFence(text: string) {
  return text.trim().replace(/^```[a-zA-Z0-9_-]*\s*/i, "").replace(/\s*```$/i, "").trim()
}

function normalizeOpenAiSelectionText(providerID: string, text: string) {
  const trimmed = stripCodeFence(text)
  if (providerID === "alibaba-cn") {
    try {
      const parsed = JSON.parse(trimmed) as Array<Record<string, unknown>>
      if (Array.isArray(parsed)) {
        const merged = parsed
          .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
          .filter(Boolean)
          .join("\n")
          .trim()
        if (merged) return merged
      }
    } catch {
      return trimmed
    }
  }
  return trimmed
}

function normalizeOpenAiLayoutText(text: string) {
  return stripCodeFence(text)
}

function normalizeNativeText(payload: NativeOcrPayload) {
  const markdown = String(payload.md_results ?? "").trim()
  if (markdown) return markdown
  const layoutDetails = Array.isArray(payload.layout_details) ? payload.layout_details : []
  const text = layoutDetails
    .flatMap((page) => (Array.isArray(page) ? page : []))
    .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).content ?? "").trim() : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
  if (text) return text
  throw new Error("OCR provider returned empty native content")
}

async function callZhipuNativeOcr(config: ResolvedModelExecution, imagePath: string): Promise<NativeOcrPayload> {
  const response = await fetch(resolveZhipuLayoutEndpoint(config.baseURL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.modelID,
      file: await imageFileToDataUrl(imagePath),
      need_layout_visualization: false,
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Zhipu OCR request failed (${response.status}): ${text}`)
  }

  const payload = JSON.parse(text) as NativeOcrPayload
  if (payload.code !== undefined && ![0, 200].includes(payload.code)) {
    throw new Error(`Zhipu OCR request failed: ${text}`)
  }
  return payload
}

async function callOpenAiCompatibleOcr(input: {
  config: ResolvedModelExecution
  imagePath: string
  prompt: string
  providerID: string
  alibabaTask?: "document_parsing" | "advanced_recognition"
}) {
  const imageUrl = await imageFileToDataUrl(input.imagePath)
  const extraBody =
    input.providerID === "alibaba-cn" && input.alibabaTask
      ? {
          ocr_options: {
            task: input.alibabaTask,
          },
        }
      : {}

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  const response = await fetch(resolveChatCompletionsEndpoint(input.config.baseURL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.config.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: input.config.modelID,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
              },
            },
            {
              type: "text",
              text: input.prompt,
            },
          ],
        },
      ],
      temperature: 0,
      ...extraBody,
    }),
  }).finally(() => {
    clearTimeout(timeout)
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`OpenAI-compatible OCR request failed (${response.status}): ${text}`)
  }

  const payload = JSON.parse(text) as {
    choices?: Array<{
      message?: {
        content?: unknown
      }
    }>
  }

  const content = payload.choices?.[0]?.message?.content
  return extractTextFromOpenAiContent(content)
}

function toSyntheticLayout(markdown: string): NativeOcrPayload {
  return {
    md_results: markdown,
    data_info: {
      pages: [{}],
    },
    layout_details: [
      [
        {
          label: "text",
          content: markdown,
        },
      ],
    ],
  }
}

function isOpenAiCompatibleOcrProvider(providerID: string) {
  return (
    providerID === "alibaba-cn" ||
    providerID === "siliconflow" ||
    providerID === "siliconflow-cn" ||
    providerID === "modelscope"
  )
}

const SELECTION_OCR_PROMPT = [
  "你是一个只做 OCR 的引擎，必须逐字逐行抄写图片中的全部内容（题号、题干、选项、公式等），严格保持顺序，不得省略。",
  "优先使用标准 LaTeX 表示所有数学符号（例如 \\sqrt{}、\\frac{}、\\cdot、\\complement_{U}、\\pi），",
  "如果确实无法确定对应的 LaTeX，可以暂时保留原 Unicode 字符，但仍然禁止添加 HTML 标签、Markdown、自然语言解释或总结。",
  "【重要】关于美元符号的处理：",
  "- 数学公式中的美元符号：用 $...$ 包裹行内公式（例如 $E=mc^2$），用 $$...$$ 包裹块级公式。",
  "- 英文文本中的美元符号（货币）：保持原样，不要用任何符号包裹（例如 $160、$50、$1000）。",
  "- 区分方法：如果 $ 后面紧跟数字且没有数学运算符，就是货币符号，直接抄写；如果包含数学符号或 LaTeX 命令，就用 $...$ 包裹。",
  "若识别的内容中出现表格，必须使用标准 Markdown 表格语法（第一行为表头，使用 '|' 与 '---' 分隔）逐列逐行抄写该表格，保持原有结构与顺序。",
  "对于选择题选项，尽量保持版式：若原图为一行横排或两列排版，请在输出时也合并为相同行/同列（例如 A. B. C. D. 横向，或两列两行）；只有当某个选项内容本身很长或换行时，再使用纵向分行。",
  "不要概括，不要解释，只输出识别到的原始内容。",
].join("")

export const OcrProviderClient = {
  async recognizeSelection(input: { userID: string; imagePath: string }) {
    const config = await ModelSettingsResolver.resolveCapability({
      userID: input.userID,
      capability: "studio_selection_ocr",
    })

    if (config.providerID === "zhipu") {
      const payload = await callZhipuNativeOcr(config, input.imagePath)
      return {
        providerID: config.providerID,
        payload,
        text: normalizeNativeText(payload),
      }
    }

    if (isOpenAiCompatibleOcrProvider(config.providerID)) {
      const text = await callOpenAiCompatibleOcr({
        config,
        imagePath: input.imagePath,
        providerID: config.providerID,
        alibabaTask: config.providerID === "alibaba-cn" ? "advanced_recognition" : undefined,
        prompt: SELECTION_OCR_PROMPT,
      })
      const normalizedText = normalizeOpenAiSelectionText(config.providerID, text)
      return {
        providerID: config.providerID,
        payload: toSyntheticLayout(normalizedText),
        text: normalizedText,
      }
    }

    throw new Error(`Unsupported OCR provider: ${config.providerID}`)
  },

  async recognizeDocumentLayout(input: { userID: string; imagePath: string }) {
    const config = await ModelSettingsResolver.resolveCapability({
      userID: input.userID,
      capability: "document_layout_ocr",
    })

    if (config.providerID === "zhipu") {
      const payload = await callZhipuNativeOcr(config, input.imagePath)
      if (!payload.layout_details || payload.layout_details.length === 0) {
        throw new Error(`Zhipu OCR returned no layout_details for ${input.imagePath}`)
      }
      return {
        providerID: config.providerID,
        payload,
        text: normalizeNativeText(payload),
      }
    }

    if (isOpenAiCompatibleOcrProvider(config.providerID)) {
      const markdown = await callOpenAiCompatibleOcr({
        config,
        imagePath: input.imagePath,
        providerID: config.providerID,
        alibabaTask: config.providerID === "alibaba-cn" ? "document_parsing" : undefined,
        prompt:
          "请把这页文档按阅读顺序转成 Markdown。保留标题、列表、表格和公式；只输出 Markdown 正文，不要解释，不要代码块围栏。",
      })
      const normalizedMarkdown = normalizeOpenAiLayoutText(markdown)
      const payload = toSyntheticLayout(normalizedMarkdown)
      return {
        providerID: config.providerID,
        payload,
        text: normalizedMarkdown,
      }
    }

    throw new Error(`Unsupported OCR provider: ${config.providerID}`)
  },
}
