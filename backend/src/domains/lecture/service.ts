import { createLogger } from "../../lib/logger"
import {
  loadAgentRuntimeModules,
  withAgentScope,
} from "../agent/service"
import { StudioService } from "../studio/service"
import { LectureEvents } from "./events"
import {
  extractRuntimeLectureBlocksFromMessages,
  extractProjectedLectureText,
  extractRuntimeReasoningPart,
  extractRuntimeTextDelta,
  extractRuntimeTextPart,
  isAssistantRuntimeMessage,
  runtimeEventPartID,
  runtimeEventPartKind,
  runtimeEventMessageID,
} from "./runtime-projection"
import { LectureRepository } from "./repository"
import type {
  LectureBlockRecord,
  LectureHighlightSpan,
  LectureRuntimeQuestion,
  LectureRuntimeQuestionOption,
  LectureSessionRecord,
  LectureSummaryHandback,
  LectureSourceBlock,
  LectureVisualizationPatch,
} from "./types"

const logger = createLogger({ domain: "lecture-service" })
const projectedLectureMessageIDs = new Set<string>()
const runtimeLectureDrafts = new Map<
  string,
  {
    messageID: string | null
    partID: string | null
    text: string
    startedAt: string
    assistantMessageIDs: Set<string>
    textPartIDs: Set<string>
    reasoningPartIDs: Set<string>
  }
>()
const runtimeLectureReasoningDrafts = new Map<
  string,
  {
    messageID: string | null
    partID: string | null
    text: string
    startedAt: string
  }
>()

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)))
}

function uniqueSpans(values: LectureHighlightSpan[]) {
  const seen = new Set<string>()
  const result: LectureHighlightSpan[] = []
  for (const item of values) {
    const sourceId = String(item?.sourceId ?? "").trim()
    const quote = String(item?.quote ?? "").trim()
    if (!sourceId || !quote) continue
    const key = `${sourceId}\u0000${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ sourceId, quote })
  }
  return result
}

function normalizeLooseText(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function containsChinese(value: string) {
  return /[\u4e00-\u9fff]/.test(value)
}

function looksLikeBareMathLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (trimmed.startsWith("$")) return false
  if (containsChinese(trimmed)) return false
  if (!/[0-9=\\_^]/.test(trimmed)) return false
  if (trimmed.length > 120) return false
  return true
}

function repairLectureMarkdownText(text: string) {
  if (!text.trim()) return text
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!looksLikeBareMathLine(trimmed)) return line
      return `$$${trimmed}$$`
    })
    .join("\n")
}

function inferHighlightSpansFromSourceBlocks(input: {
  text: string
  sourceBlocks: LectureSourceBlock[]
}) {
  const normalizedText = normalizeLooseText(input.text)
  const inferred: LectureHighlightSpan[] = []
  for (const block of input.sourceBlocks) {
    const quote = normalizeLooseText(block.text)
    if (!quote) continue
    if (quote.length < 4) continue
    if (!normalizedText.includes(quote)) continue
    inferred.push({
      sourceId: block.id,
      quote: block.text.trim(),
    })
  }
  return inferred
}

async function loadLectureSourceBlocks(session: LectureSessionRecord) {
  const detail = await StudioService.getQuestionCardDetail({
    userID: session.userID,
    workroomID: session.workroomID,
    cardID: session.cardID,
  })
  return buildSourceBlocks({
    stem: detail.content.stem,
    legendImages: detail.content.legendImages,
  })
}

export function extractLectureAgentSessionIDFromMessages(messages: any[], originMessageID?: string | null) {
  const orderedMessages = Array.isArray(messages) ? [...messages].reverse() : []
  const trimmedOriginMessageID = originMessageID?.trim() ?? ""
  const startIndex = trimmedOriginMessageID
    ? orderedMessages.findIndex((message) => String(message?.info?.id ?? "") === trimmedOriginMessageID)
    : -1
  const start = startIndex >= 0 ? startIndex : 0

  for (let index = start; index < orderedMessages.length; index++) {
    const message = orderedMessages[index]
    if (message?.info?.role !== "assistant") continue
    const parts = Array.isArray(message?.parts) ? message.parts : []
    for (const part of parts) {
      if (part?.type !== "tool" || part?.tool !== "task") continue
      if (String(part?.state?.input?.subagent_type ?? "") !== "lecture") continue
      const sessionID = String(part?.state?.metadata?.sessionId ?? "").trim()
      if (sessionID) return sessionID
    }
  }

  return null
}

function normalizeVisualizationPatches(values: LectureVisualizationPatch[]) {
  const result: LectureVisualizationPatch[] = []
  for (const item of values) {
    const targetId = String(item?.targetId ?? "").trim()
    if (!targetId) continue
    if (item.op === "remove_node") {
      result.push({ op: "remove_node", targetId })
      continue
    }
    if (item.op === "set_attr") {
      const name = String(item?.name ?? "").trim()
      if (!name) continue
      result.push({
        op: "set_attr",
        targetId,
        name,
        value: item.value == null ? null : String(item.value),
      })
      continue
    }
    if (item.op === "scene_state") {
      result.push({
        op: "scene_state",
        targetId,
        state: item.state && typeof item.state === "object" ? item.state : {},
      })
      continue
    }
    if (item.op === "set_html" || item.op === "append_child") {
      const html = String(item?.html ?? "")
      if (!html.trim()) continue
      result.push({ op: item.op, targetId, html })
      continue
    }
    if (item.op === "set_text") {
      result.push({ op: "set_text", targetId, text: String(item?.text ?? "") })
    }
  }
  return result
}

function containsForbiddenVisualizationMarkup(html: string) {
  const checks = [
    /<script[^>]*\ssrc\s*=/i,
    /<iframe\b/i,
    /<object\b/i,
    /<embed\b/i,
    /<link\b/i,
    /<meta\b/i,
    /\son\w+\s*=/i,
    /javascript\s*:/i,
    /window\s*\.\s*top/i,
    /window\s*\.\s*parent/i,
    /document\s*\.\s*cookie/i,
    /location\s*=/i,
  ]
  return checks.some((pattern) => pattern.test(html))
}

function isFullVisualizationDocument(html: string) {
  return /<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html)
}

function assertVisualizationHTMLSafe(html: string, context: string) {
  if (!html.trim()) return
  if (isFullVisualizationDocument(html)) {
    throw new Error(`INVALID_VISUALIZATION_HTML: full html documents are not allowed in ${context}; submit a fragment inside #lecture-visualization-root`)
  }
  if (containsForbiddenVisualizationMarkup(html)) {
    throw new Error(`INVALID_VISUALIZATION_HTML: forbidden markup in ${context}`)
  }
}

function ensureVisualizationRoot(html: string) {
  const rootMarkup = html.trim()
  if (!rootMarkup) return '<div id="lecture-visualization-root"></div>'
  if (/<html[\s>]/i.test(rootMarkup)) {
    throw new Error("INVALID_VISUALIZATION_HTML: full html document is not allowed")
  }
  return `<div id="lecture-visualization-root">${rootMarkup}</div>`
}

function extractVisualizationRootInnerHTML(wrappedHTML: string) {
  const match = wrappedHTML.match(
    /^<div\b[^>]*\bid=(?:"lecture-visualization-root"|'lecture-visualization-root')[^>]*>([\s\S]*)<\/div>\s*$/,
  )
  if (!match) throw new Error("VISUALIZATION_ROOT_SERIALIZATION_FAILED")
  return match[1] ?? ""
}

function escapeCssIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`)
}

interface HTMLRewriterElementLike {
  getAttribute(name: string): string | null
  setInnerContent(content: string, options?: { html?: boolean }): void
  removeAttribute(name: string): void
  setAttribute(name: string, value: string): void
  remove(): void
  append(content: string, options?: { html?: boolean }): void
}

interface HTMLRewriterLike {
  on(
    selector: string,
    handlers: {
      element(element: HTMLRewriterElementLike): void
    },
  ): HTMLRewriterLike
  transform(input: Response): { text(): Promise<string> }
}

async function applyVisualizationPatchToHTML(input: {
  wrappedHTML: string
  patch: LectureVisualizationPatch
}) {
  const selector = `#${escapeCssIdentifier(input.patch.targetId)}`
  let matched = false
  const HTMLRewriterCtor = (globalThis as typeof globalThis & { HTMLRewriter: new () => HTMLRewriterLike }).HTMLRewriter
  const htmlRewriter = new HTMLRewriterCtor().on(selector, {
    element(element: HTMLRewriterElementLike) {
      matched = true
      const op = input.patch.op
      if (op === "set_html") {
        assertVisualizationHTMLSafe(input.patch.html, "set_html")
        element.setInnerContent(input.patch.html, { html: true })
        return
      }
      if (op === "set_text") {
        element.setInnerContent(input.patch.text, { html: false })
        return
      }
      if (op === "set_attr") {
        const attrName = input.patch.name.trim().toLowerCase()
        if (!attrName || attrName.startsWith("on")) {
          throw new Error("forbidden_attribute")
        }
        if (element.getAttribute("id") === "lecture-visualization-root" && attrName === "id") {
          throw new Error("cannot_modify_root_id")
        }
        const value = input.patch.value == null ? null : String(input.patch.value)
        if (value != null && /javascript\s*:/i.test(value)) {
          throw new Error("forbidden_attribute_value")
        }
        if (value == null) element.removeAttribute(input.patch.name)
        else element.setAttribute(input.patch.name, value)
        return
      }
      if (op === "remove_node") {
        if (element.getAttribute("id") === "lecture-visualization-root") {
          throw new Error("cannot_remove_root")
        }
        element.remove()
        return
      }
      if (op === "append_child") {
        assertVisualizationHTMLSafe(input.patch.html, "append_child")
        element.append(input.patch.html, { html: true })
        return
      }
      if (op === "scene_state") {
        element.setAttribute("data-lecture-scene-state", JSON.stringify(input.patch.state ?? {}))
      }
    },
  })
  const transformed = await htmlRewriter.transform(new Response(input.wrappedHTML)).text()
  if (!matched) {
    throw new Error("target_not_found_or_outside_root")
  }
  return transformed
}

async function applyVisualizationPatchesToSnapshot(input: {
  snapshotHTML: string | null
  patches: LectureVisualizationPatch[]
}) {
  let wrappedHTML = ensureVisualizationRoot(input.snapshotHTML ?? "")
  const failed: Array<{ index: number; targetId: string; op: string; reason: string }> = []

  for (const [index, patch] of input.patches.entries()) {
    try {
      wrappedHTML = await applyVisualizationPatchToHTML({
        wrappedHTML,
        patch,
      })
    } catch (error) {
      failed.push({
        index,
        targetId: patch.targetId,
        op: patch.op,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    html: extractVisualizationRootInnerHTML(wrappedHTML),
    failed,
    allFailed: failed.length === input.patches.length,
  }
}

function normalizeQuestionText(raw: string): string {
  return raw
    .replace(/<\/(p|div|li|ul|ol)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, " ")
}

function parseMultipleChoiceQuestion(
  text: string,
): { stem: string; options: { label: string; text: string }[] } | null {
  const normalized = normalizeQuestionText(text)
  const lines = normalized.split(/\r?\n/).map((line) => line.trim())
  const options: { label: string; text: string }[] = []
  const stemLines: string[] = []
  let currentOption: { label: string; text: string } | null = null
  let parsingOptions = false

  const flushOption = () => {
    if (!currentOption) return
    currentOption.text = currentOption.text.trim()
    if (currentOption.text) options.push(currentOption)
    currentOption = null
  }

  for (const line of lines) {
    if (!line) {
      if (currentOption) currentOption.text += "\n"
      else stemLines.push("")
      continue
    }

    const match = line.match(/^([A-H])[.．、\s]+(.+)$/)
    if (match) {
      parsingOptions = true
      flushOption()
      currentOption = { label: match[1].toUpperCase(), text: match[2].trim() }
      continue
    }

    if (parsingOptions && currentOption) {
      currentOption.text = `${currentOption.text} ${line}`.trim()
    } else {
      stemLines.push(line)
    }
  }

  flushOption()
  if (options.length < 2) return null
  return {
    stem: stemLines.join("\n").trim(),
    options,
  }
}

function buildSourceBlocks(input: {
  stem: string
  legendImages?: string[]
}): LectureSourceBlock[] {
  const parsed = parseMultipleChoiceQuestion(input.stem)
  const blocks: LectureSourceBlock[] = [
    {
      id: "stem",
      kind: "stem",
      text: parsed?.stem?.trim() || input.stem.trim(),
      label: "题干",
    },
  ]

  for (const option of parsed?.options ?? []) {
    blocks.push({
      id: `option.${option.label}`,
      kind: "option",
      text: option.text,
      label: `选项 ${option.label}`,
    })
  }

  for (const [index] of (input.legendImages ?? []).entries()) {
    blocks.push({
      id: `legend.${index + 1}`,
      kind: "legend",
      text: `图例 ${index + 1}`,
      label: `图例 ${index + 1}`,
    })
  }
  return blocks
}

export function buildLectureTaskPrompt(input: {
  lectureSessionID: string
  questionNumber?: number | null
  stem: string
  sourceBlocks: LectureSourceBlock[]
}) {
  const blockLines = input.sourceBlocks
    .map((block) => `- ${block.id}: ${block.label ?? block.kind}${block.text ? ` => ${block.text}` : ""}`)
    .join("\n")
  return [
    "【角色与边界】",
    "- 你的角色是一对一辅导老师：先诊断学生卡点，再用最自然的方式引导，逐步撤掉脚手架，让学生自己说出关键关系。",
    "- 题目已经完整给出，只在 lecture container 内讲这道题。",
    "- 讲解推进遵循“先定位、再推导、再确认”的顺序，每次只推进一个关键认知点。",
    "- 需要学生参与时，直接使用原生 question tool；这是教学流程的一部分，不是额外工具。",
    "- 选项只通过 question tool 询问，不要把选项原文写进 lecture block。",
    "",
    "【教学节奏】",
    "- 先判断题目最自然的入口，再展开推导；每一步只讲一个新观察、新关系或新决策。",
    "- 课堂互动用 question tool 完成，结构化选项保持简短中性；`question.custom` 默认允许自由回答，只有要封闭题时才设为 `false`。",
    "- 学生回答后先回应他的想法，再继续主线，不要直接跳到最终答案。",
    "",
    "【可视化原则】",
    "- 过程、机制、动态变化、空间关系、参数影响等内容，优先用自包含的交互式 HTML canvas 动画；静态示意图和纯标签层再用 SVG。",
    "- 只选一种表达路径：canvas、text 或 none。首次可视化必须是完整可运行片段，后续更新才使用 `render-html-patch`。",
    "- `render-html` 只接收 `#lecture-visualization-root` 内部 fragment，不提交完整文档壳；可视化内容要适配讲解面板尺寸，不依赖固定全屏布局。",
    "- canvas 由 `LectureCanvasRuntime.mountCanvas(canvas, drawScene)` 承载，绘制函数只负责世界坐标内容；viewport 视为相机状态，在 draw 里处理 zoom / pan / DPR / 重绘。",
    "- SVG 需要稳定 `viewBox` 和响应式宽高，缩放和平移交给宿主，不要靠 CSS transform 放大整页。",
    "- 所有中文图形文字使用 CJK 字体栈，canvas 优先用 `LectureCanvasRuntime.setTextStyle(ctx, size, weight)` 或 `LectureCanvasRuntime.fontStack`。",
    "",
    "【写作与传输】",
    "- 公式、方程、比例、推导、指数、下标、单位换算一律写成 LaTeX，独立成行优先用 `$$...$$`。",
    "- 中文、TeX、长文本、HTML 和 patch 统一走 UTF-8 临时文件 + `--delete-after-read` 作为唯一主通道。",
    "- 在 PowerShell 里写临时文件时，必须用单引号 here-string `@'... '@`、`Set-Content -Encoding utf8`，或 `[System.IO.File]::WriteAllText(..., [System.Text.Encoding]::UTF8)`；不要把 LaTeX 放进双引号字符串，否则 `$...$` 会被变量展开吞掉。",
    "- 普通讲解正文直接正常输出，系统会原生流式投影到讲解容器；不要再用 lecture bridge 写 lecture 正文。",
    "- 渲染可视化时使用 `render-html --html-file <utf8-file> --delete-after-read`，增量更新时使用 `render-html-patch --patch-file <utf8-file> --delete-after-read`。",
    "- 正文讲解直接引用正在讲的原文，系统会从讲解正文中自动推断高亮；不要为了高亮再调用 `append-block`。",
    "- 不要传 `--session-id`；lecture bridge 会自动绑定当前 lecture container。",
    "",
    "【讲解输出】",
    "- 讲解内容写入讲解容器，引导问题用 question tool，后续根据学生回答继续推进。",
    "- 当你使用 question tool 生成可选项时，保持选项简短清晰，必要时可以附上简短说明，不要写长篇诊断。",
    "- 要学生自由回答时，利用 `question.custom` 的原生默认语义；只有要显式封闭时才设为 `false`。",
    '- 高亮 spans 使用 JSON 数组，形如 [{"sourceId":"stem","quote":"原文片段"}]。',
    "",
    "【题目上下文】",
    input.questionNumber ? `当前题号：第 ${input.questionNumber} 题` : "",
    "<current_question>",
    input.stem,
    "</current_question>",
    blockLines ? `可引用的原文块：\n${blockLines}` : "",
    "- 讲解时直接引用你正在讲的原文块，不要把高亮写成固定规则。",
  ]
    .filter(Boolean)
    .join("\n\n")
}

async function requireSession(userID: string, workroomID: string, lectureSessionID: string) {
  const session = await LectureRepository.getSessionByID(userID, workroomID, lectureSessionID)
  if (!session) {
    throw new Error(`LECTURE_SESSION_NOT_FOUND: ${lectureSessionID}`)
  }
  return session
}

function compareLectureBlocksByCreatedAt(left: LectureBlockRecord, right: LectureBlockRecord) {
  const leftTime = Date.parse(left.createdAt)
  const rightTime = Date.parse(right.createdAt)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  return left.id.localeCompare(right.id)
}

function mergeRuntimeLectureBlocks(input: {
  runtimeBlocks: LectureBlockRecord[]
  persistedBlocks: LectureBlockRecord[]
}) {
  if (input.runtimeBlocks.length === 0) return input.persistedBlocks
  return [
    ...input.runtimeBlocks,
    ...input.persistedBlocks.filter((block) => block.role !== "lecture"),
  ].sort(compareLectureBlocksByCreatedAt)
}

async function loadRuntimeLectureBlocks(session: LectureSessionRecord): Promise<LectureBlockRecord[]> {
  if (!session.lectureAgentSessionID) return []
  const { AppRuntime, Session, SessionID } = await loadAgentRuntimeModules()
  try {
    const messages = await withAgentScope(
      { userID: session.userID, workroomID: session.workroomID, syncUserSettings: false },
      async () =>
        AppRuntime.runPromise(
          Session.Service.use((svc: any) =>
            svc.messages({
              sessionID: SessionID.make(session.lectureAgentSessionID!),
              limit: 200,
            }),
          ),
        ),
    )
    return extractRuntimeLectureBlocksFromMessages({
      lectureSessionID: session.id,
      messages: Array.isArray(messages) ? messages : [],
      fallbackCreatedAt: session.createdAt,
    })
  } catch (error) {
    logger.warn("lecture runtime message sync failed", {
      lecture_session_id: session.id,
      lecture_agent_session_id: session.lectureAgentSessionID,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

async function buildSessionPayloadCore(session: LectureSessionRecord, blocks?: LectureBlockRecord[]) {
  const detail = await StudioService.getQuestionCardDetail({
    userID: session.userID,
    workroomID: session.workroomID,
    cardID: session.cardID,
  })
  const lectureAgentSessionID = await resolveLectureAgentSessionID(session)
  const pendingQuestion = await getPendingRuntimeQuestion({
    ...session,
    lectureAgentSessionID,
  })
  const pendingQuestionJSON = pendingQuestion
    ? JSON.stringify({
        id: pendingQuestion.requestID,
        session_id: pendingQuestion.sessionID,
        questions: pendingQuestion.questions,
      })
    : null
  let effectiveSession =
    pendingQuestion && session.status === "running"
      ? {
          ...session,
          lectureAgentSessionID,
          status: "paused_for_question" as const,
          questionPromptJSON: pendingQuestionJSON,
        }
      : {
          ...session,
          lectureAgentSessionID,
          questionPromptJSON: pendingQuestionJSON,
        }
  if (pendingQuestion && pendingQuestionJSON !== session.questionPromptJSON) {
    const touched =
      (await LectureRepository.updateSession(session.userID, session.workroomID, session.id, {
        status: "paused_for_question",
        lectureAgentSessionID,
        questionPromptJSON: pendingQuestionJSON,
      })) ?? null
    if (touched) {
      effectiveSession = {
        ...touched,
        status: "paused_for_question",
        lectureAgentSessionID: touched.lectureAgentSessionID ?? lectureAgentSessionID,
        questionPromptJSON: pendingQuestionJSON,
      }
    }
    await LectureEvents.publish(session.id, {
      type: "question_asked",
      session: effectiveSession,
      request: {
        id: pendingQuestion.requestID,
        session_id: pendingQuestion.sessionID,
        questions: pendingQuestion.questions,
      },
    })
  }
  return {
    session: effectiveSession,
    blocks: blocks ?? (await LectureRepository.listBlocks(session.userID, session.workroomID, session.id)),
    questionCard: detail,
    pendingQuestion,
    sourceBlocks: buildSourceBlocks({
      stem: detail.content.stem,
      legendImages: detail.content.legendImages,
    }),
  }
}

async function syncLectureProjection(session: LectureSessionRecord) {
  const lectureAgentSessionID = await resolveLectureAgentSessionID(session)
  let nextSession = session
  if (lectureAgentSessionID && lectureAgentSessionID !== session.lectureAgentSessionID) {
    nextSession =
      (await LectureRepository.updateSession(session.userID, session.workroomID, session.id, {
        lectureAgentSessionID,
      })) ?? nextSession
  }

  const persistedBlocks = await LectureRepository.listBlocks(session.userID, session.workroomID, session.id)
  const runtimeBlocks = await loadRuntimeLectureBlocks(nextSession)
  const blocks = mergeRuntimeLectureBlocks({
    runtimeBlocks,
    persistedBlocks,
  })
  const lastBlock = blocks.at(-1) ?? null
  if (runtimeBlocks.length > 0) {
    const shouldMarkRunning = nextSession.status === "idle"
    const shouldUpdateCursor = nextSession.resumeCursor !== blocks.length
    const shouldUpdateLastBlock = lastBlock?.id && nextSession.lastBlockID !== lastBlock.id
    if (shouldMarkRunning || shouldUpdateCursor || shouldUpdateLastBlock) {
      nextSession =
        (await LectureRepository.updateSession(session.userID, session.workroomID, session.id, {
          status: shouldMarkRunning ? "running" : nextSession.status,
          resumeCursor: blocks.length,
          lastBlockID: lastBlock?.id ?? nextSession.lastBlockID,
        })) ?? nextSession
    }
  }
  return { session: nextSession, blocks }
}

async function buildSessionPayload(session: LectureSessionRecord, blocks?: LectureBlockRecord[]) {
  const synced = await syncLectureProjection(session)
  return buildSessionPayloadCore(synced.session, blocks ?? synced.blocks)
}

async function buildLaunchPayload(session: LectureSessionRecord, blocks?: LectureBlockRecord[]) {
  const payload = await buildSessionPayload(session, blocks)
  return {
    ...payload,
    taskDescription: payload.questionCard.anchor.questionNumber
      ? `Lecture ${payload.questionCard.anchor.questionNumber}`
      : "Lecture session",
    taskPrompt: buildLectureTaskPrompt({
      lectureSessionID: session.id,
      questionNumber: payload.questionCard.anchor.questionNumber,
      stem: payload.questionCard.content.stem,
      sourceBlocks: payload.sourceBlocks,
    }),
  }
}

function mapRuntimeQuestion(request: any): LectureRuntimeQuestion | null {
  if (!request?.id || !request?.sessionID || !Array.isArray(request.questions)) return null
  return {
    requestID: String(request.id),
    sessionID: String(request.sessionID),
    questions: request.questions
      .map((item: any) => {
        const normalizedOptions: LectureRuntimeQuestionOption[] = Array.isArray(item?.options)
          ? item.options
              .map((option: any) => ({
                label: String(option?.label ?? "").trim(),
                description: String(option?.description ?? "").trim(),
              }))
              .filter(
                (option: LectureRuntimeQuestionOption): option is LectureRuntimeQuestionOption =>
                  Boolean(option.label && option.description),
              )
          : []
        const allowsCustom = item?.custom !== false
        return {
          question: String(item?.question ?? "").trim(),
          header: String(item?.header ?? "").trim(),
          options: normalizedOptions,
          multiple: item?.multiple === true ? true : undefined,
          custom: allowsCustom ? true : undefined,
        }
      })
      .filter((item: { question: string }) => item.question),
  }
}

async function getPendingRuntimeQuestion(session: LectureSessionRecord): Promise<LectureRuntimeQuestion | null> {
  if (!session.lectureAgentSessionID) return null
  const { AppRuntime, Question } = await loadAgentRuntimeModules()
  return withAgentScope({ userID: session.userID, workroomID: session.workroomID, syncUserSettings: false }, async () => {
    const requests = await AppRuntime.runPromise(Question.Service.use((svc: any) => svc.list()))
    const matched = Array.isArray(requests)
      ? requests.find((item: any) => String(item?.sessionID ?? "") === session.lectureAgentSessionID)
      : null
    return matched ? mapRuntimeQuestion(matched) : null
  })
}

async function resumeSessionLoop(input: {
  userID: string
  workroomID: string
  sessionID: string
}) {
  const { AppRuntime, SessionPrompt, SessionID } = await loadAgentRuntimeModules()
  return withAgentScope({ userID: input.userID, workroomID: input.workroomID, syncUserSettings: false }, async () => {
    await AppRuntime.runPromise(
      SessionPrompt.Service.use((svc: any) =>
        svc.loop({
          sessionID: SessionID.make(input.sessionID),
        }),
      ),
    )
  })
}

function buildReasoningDraftRecord(input: {
  lectureSessionID: string
  draft: {
    messageID: string | null
    partID: string | null
    text: string
    startedAt: string
  }
  status: "thinking" | "complete"
}) {
  const startedAtMs = Date.parse(input.draft.startedAt)
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0
  return {
    id: input.draft.partID ? `reasoning.${input.draft.partID}` : `reasoning.${input.draft.messageID ?? input.lectureSessionID}`,
    sessionID: input.lectureSessionID,
    text: input.draft.text,
    status: input.status,
    elapsedMs,
    createdAt: input.draft.startedAt,
  }
}

async function resolveLectureAgentSessionID(session: LectureSessionRecord) {
  if (session.lectureAgentSessionID) return session.lectureAgentSessionID
  if (!session.originAgentSessionID) return null
  const { AppRuntime, Session, SessionID } = await loadAgentRuntimeModules()
  let messages: any[] = []
  try {
    messages = await withAgentScope(
      { userID: session.userID, workroomID: session.workroomID, syncUserSettings: false },
      async () =>
        AppRuntime.runPromise(
          Session.Service.use((svc: any) => svc.messages({ sessionID: SessionID.make(session.originAgentSessionID!) })),
        ),
    )
  } catch {
    return null
  }
  const lectureAgentSessionID = extractLectureAgentSessionIDFromMessages(messages, session.originMessageID)
  if (!lectureAgentSessionID) return null
  const updated = await LectureRepository.updateSession(session.userID, session.workroomID, session.id, {
    lectureAgentSessionID,
  })
  return updated?.lectureAgentSessionID ?? lectureAgentSessionID
}

export const LectureService = {
  buildSourceBlocks,

  async projectRuntimeStreamEvent(input: {
    userID: string
    workroomID: string
    agentSessionID: string
    event: { type: string; properties: Record<string, unknown> }
  }) {
    const lectureSession = await this.resolveSessionByAgentSessionID({
      userID: input.userID,
      workroomID: input.workroomID,
      lectureAgentSessionID: input.agentSessionID,
    })
    if (!lectureSession) return null

    const messageID = runtimeEventMessageID(input.event)
    const draftKey = lectureSession.id
    const existingDraft = runtimeLectureDrafts.get(draftKey)
    const draft =
      existingDraft ??
      {
        messageID: null,
        partID: null,
        text: "",
        startedAt: new Date().toISOString(),
        assistantMessageIDs: new Set<string>(),
        textPartIDs: new Set<string>(),
        reasoningPartIDs: new Set<string>(),
      }

    if (
      (input.event.type === "message.started" || input.event.type === "message.updated") &&
      isAssistantRuntimeMessage(input.event)
    ) {
      if (messageID) draft.assistantMessageIDs.add(messageID)
      runtimeLectureDrafts.set(draftKey, draft)
      return null
    }

    const partKind = runtimeEventPartKind(input.event)
    const eventPartID = runtimeEventPartID(input.event)
    if (eventPartID && partKind === "text") draft.textPartIDs.add(eventPartID)
    if (eventPartID && partKind === "reasoning") draft.reasoningPartIDs.add(eventPartID)

    const reasoningPart = extractRuntimeReasoningPart(input.event)
    if (reasoningPart) {
      if (reasoningPart.messageID && draft.assistantMessageIDs.size > 0 && !draft.assistantMessageIDs.has(reasoningPart.messageID)) {
        return null
      }
      if (reasoningPart.partID) draft.reasoningPartIDs.add(reasoningPart.partID)
      runtimeLectureDrafts.set(draftKey, draft)
      const reasoningDraft = {
        messageID: reasoningPart.messageID,
        partID: reasoningPart.partID,
        text: reasoningPart.text,
        startedAt: runtimeLectureReasoningDrafts.get(draftKey)?.startedAt ?? new Date().toISOString(),
      }
      runtimeLectureReasoningDrafts.set(draftKey, reasoningDraft)
      await LectureEvents.publish(lectureSession.id, {
        type: "lecture.reasoning.streaming",
        session: lectureSession,
        reasoningDraft: buildReasoningDraftRecord({
          lectureSessionID: lectureSession.id,
          draft: reasoningDraft,
          status: "thinking",
        }),
      })
      return null
    }

    const textPart = extractRuntimeTextPart(input.event)
    if (textPart) {
      if (textPart.messageID && draft.assistantMessageIDs.size > 0 && !draft.assistantMessageIDs.has(textPart.messageID)) {
        return null
      }
      if (textPart.partID) draft.textPartIDs.add(textPart.partID)
      draft.messageID = textPart.messageID ?? draft.messageID
      draft.partID = textPart.partID ?? draft.partID
      draft.text = textPart.text
      runtimeLectureDrafts.set(draftKey, draft)
      await LectureEvents.publish(lectureSession.id, {
        type: "lecture.block.streaming",
        session: lectureSession,
        draftBlock: {
          id: draft.partID ? `draft.${draft.partID}` : `draft.${draft.messageID ?? lectureSession.id}`,
          sessionID: lectureSession.id,
          role: "lecture",
          text: draft.text,
          createdAt: draft.startedAt,
        },
      })
      return null
    }

    const textDelta = extractRuntimeTextDelta(input.event)
    if (textDelta) {
      if (textDelta.messageID && draft.assistantMessageIDs.size > 0 && !draft.assistantMessageIDs.has(textDelta.messageID)) {
        return null
      }
      if (textDelta.partID && draft.reasoningPartIDs.has(textDelta.partID)) {
        const reasoningDraft =
          runtimeLectureReasoningDrafts.get(draftKey) ??
          {
            messageID: textDelta.messageID,
            partID: textDelta.partID,
            text: "",
            startedAt: new Date().toISOString(),
          }
        reasoningDraft.messageID = textDelta.messageID ?? reasoningDraft.messageID
        reasoningDraft.partID = textDelta.partID ?? reasoningDraft.partID
        reasoningDraft.text += textDelta.text
        runtimeLectureReasoningDrafts.set(draftKey, reasoningDraft)
        runtimeLectureDrafts.set(draftKey, draft)
        await LectureEvents.publish(lectureSession.id, {
          type: "lecture.reasoning.streaming",
          session: lectureSession,
          reasoningDraft: buildReasoningDraftRecord({
            lectureSessionID: lectureSession.id,
            draft: reasoningDraft,
            status: "thinking",
          }),
        })
        return null
      }
      if (textDelta.partID && draft.textPartIDs.size > 0 && !draft.textPartIDs.has(textDelta.partID)) {
        return null
      }
      draft.messageID = textDelta.messageID ?? draft.messageID
      draft.partID = textDelta.partID ?? draft.partID
      draft.text += textDelta.text
      runtimeLectureDrafts.set(draftKey, draft)
      await LectureEvents.publish(lectureSession.id, {
        type: "lecture.block.streaming",
        session: lectureSession,
        draftBlock: {
          id: draft.partID ? `draft.${draft.partID}` : `draft.${draft.messageID ?? lectureSession.id}`,
          sessionID: lectureSession.id,
          role: "lecture",
          text: draft.text,
          createdAt: draft.startedAt,
        },
      })
      return null
    }

    const completedText = extractProjectedLectureText(input.event)
    const reasoningDraft = runtimeLectureReasoningDrafts.get(draftKey)
    if (input.event.type !== "message.completed" || (!completedText && !draft.text.trim() && !reasoningDraft?.text.trim())) return null
    if (messageID) {
      const dedupeKey = `${lectureSession.id}\u0000${messageID}`
      if (projectedLectureMessageIDs.has(dedupeKey)) return null
      projectedLectureMessageIDs.add(dedupeKey)
    }
    if (reasoningDraft?.text.trim()) {
      await LectureEvents.publish(lectureSession.id, {
        type: "lecture.reasoning.streaming",
        session: lectureSession,
        reasoningDraft: buildReasoningDraftRecord({
          lectureSessionID: lectureSession.id,
          draft: reasoningDraft,
          status: "complete",
        }),
      })
    }
    runtimeLectureReasoningDrafts.delete(draftKey)
    runtimeLectureDrafts.delete(draftKey)
    await LectureEvents.publish(lectureSession.id, {
      type: "lecture.block.streaming",
      session: lectureSession,
      draftBlock: null,
    })
    return null
  },

  async launchSession(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    cardID: string
    originAgentSessionID?: string | null
    originMessageID?: string | null
  }) {
    logger.info("lecture launch start", {
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID,
      card_id: input.cardID,
      origin_agent_session_id: input.originAgentSessionID ?? null,
    })
    const existing = await LectureRepository.findRecoverableSession(input)
    const session =
      existing ??
      (await LectureRepository.createSession({
        ...input,
        status: "idle",
      }))
    if (!session) {
      throw new Error("LECTURE_SESSION_CREATE_FAILED")
    }
    const payload = await buildLaunchPayload(session)
    return {
      ...payload,
      reusedExisting: Boolean(existing),
    }
  },

  async getSession(input: { userID: string; workroomID: string; lectureSessionID: string }) {
    const session = await requireSession(input.userID, input.workroomID, input.lectureSessionID)
    return buildSessionPayload(session)
  },

  async resolveSessionByAgentSessionID(input: {
    userID: string
    workroomID: string
    lectureAgentSessionID: string
  }) {
    const session = await LectureRepository.findSessionByLectureAgentSessionID(input)
    if (session) return session
    const { AppRuntime, Session, SessionID } = await loadAgentRuntimeModules()
    let childSession: any = null
    try {
      childSession = await withAgentScope(
        { userID: input.userID, workroomID: input.workroomID, syncUserSettings: false },
        async () =>
          AppRuntime.runPromise(Session.Service.use((svc: any) => svc.get(SessionID.make(input.lectureAgentSessionID)))),
      )
    } catch {
      return null
    }
    const parentSessionID = String(childSession?.parentID ?? "").trim()
    if (!parentSessionID) return null
    const matched = await LectureRepository.findMostRecentSessionByOriginAgentSessionID({
      userID: input.userID,
      workroomID: input.workroomID,
      originAgentSessionID: parentSessionID,
    })
    if (!matched) return null
    return LectureRepository.updateSession(input.userID, input.workroomID, matched.id, {
      lectureAgentSessionID: input.lectureAgentSessionID,
    })
  },

  async setVisualizationHTML(input: {
    userID: string
    workroomID: string
    lectureSessionID: string
    html: string | null
  }) {
    const session = await requireSession(input.userID, input.workroomID, input.lectureSessionID)
    const nextHTML = input.html?.trim() ? input.html : null
    if (nextHTML) {
      assertVisualizationHTMLSafe(nextHTML, "render-html")
    }
    const next = await LectureRepository.updateSession(input.userID, input.workroomID, session.id, {
      visualizationHTML: nextHTML,
    })
    if (!next) throw new Error("LECTURE_SESSION_UPDATE_FAILED")
    logger.info("snapshot_persisted", {
      lecture_session_id: session.id,
      mode: "snapshot",
      snapshot_version: next.updatedAt,
      html_size: nextHTML?.length ?? 0,
    })
    const payload = await buildSessionPayloadCore(next)
    await LectureEvents.publish(session.id, {
      type: "lecture.visualization.updated",
      session: payload.session,
      mode: "snapshot",
      snapshotVersion: payload.session.updatedAt,
    })
    return payload.session
  },

  async patchVisualizationHTML(input: {
    userID: string
    workroomID: string
    lectureSessionID: string
    patches: LectureVisualizationPatch[]
  }) {
    const session = await requireSession(input.userID, input.workroomID, input.lectureSessionID)
    const patches = normalizeVisualizationPatches(input.patches)
    logger.info("patch_received", {
      lecture_session_id: session.id,
      patch_count: patches.length,
    })
    if (!patches.length) {
      return session
    }
    const patchResult = await applyVisualizationPatchesToSnapshot({
      snapshotHTML: session.visualizationHTML,
      patches,
    })
    if (patchResult.failed.length > 0) {
      for (const item of patchResult.failed) {
        logger.warn("patch_applied", {
          lecture_session_id: session.id,
          ok: false,
          patch_index: item.index,
          target_id: item.targetId,
          op: item.op,
          reason: item.reason,
        })
      }
    }
    if (patchResult.allFailed) {
      logger.warn("patch_rebuild_fallback", {
        lecture_session_id: session.id,
        reason: "all_patches_failed",
      })
      const payload = await buildSessionPayloadCore(session)
      await LectureEvents.publish(session.id, {
        type: "lecture.visualization.updated",
        session: payload.session,
        mode: "snapshot",
        snapshotVersion: payload.session.updatedAt,
      })
      return payload.session
    }
    const touched = await LectureRepository.updateSession(input.userID, input.workroomID, session.id, {
      visualizationHTML: patchResult.html.trim() ? patchResult.html : null,
    })
    if (!touched) throw new Error("LECTURE_SESSION_UPDATE_FAILED")
    logger.info("snapshot_persisted", {
      lecture_session_id: session.id,
      mode: "patch",
      snapshot_version: touched.updatedAt,
      html_size: patchResult.html.length,
      failed_patch_count: patchResult.failed.length,
    })
    const payload = await buildSessionPayload(touched)
    await LectureEvents.publish(session.id, {
      type: "lecture.visualization.updated",
      session: payload.session,
      mode: "patch",
      patches,
      snapshotVersion: payload.session.updatedAt,
    })
    return payload.session
  },

  async appendBlock(input: {
    userID: string
    workroomID: string
    lectureSessionID: string
    role: LectureBlockRecord["role"]
    text: string
    highlightSpans?: LectureHighlightSpan[]
  }) {
    const session = await requireSession(input.userID, input.workroomID, input.lectureSessionID)
    const sourceBlocks = await loadLectureSourceBlocks(session)
    const repairedText = repairLectureMarkdownText(input.text.trim())
    const inferredHighlightSpans = inferHighlightSpansFromSourceBlocks({
      text: repairedText,
      sourceBlocks,
    })
    const nextHighlightSpans = uniqueSpans([...(input.highlightSpans ?? []), ...inferredHighlightSpans])
    const shouldAnnounceReady = !session.lastBlockID
    const block = await LectureRepository.createBlock({
      userID: input.userID,
      workroomID: input.workroomID,
      lectureSessionID: input.lectureSessionID,
      role: input.role,
      text: repairedText,
      highlightSpans: nextHighlightSpans,
      pauseAfter: false,
    })
    if (!block) throw new Error("LECTURE_BLOCK_CREATE_FAILED")
    const blocks = await LectureRepository.listBlocks(input.userID, input.workroomID, session.id)
    const nextSession = await LectureRepository.updateSession(input.userID, input.workroomID, session.id, {
      status: "running",
      activeHighlightSpans: block.highlightSpans.length > 0 ? block.highlightSpans : session.activeHighlightSpans,
      resumeCursor: blocks.length,
      lastBlockID: block.id,
    })
    if (!nextSession) throw new Error("LECTURE_SESSION_UPDATE_FAILED")
    const payload = await buildSessionPayloadCore(nextSession, blocks)
    if (shouldAnnounceReady) {
      await LectureEvents.publish(session.id, {
        type: "lecture.session.ready",
        session: payload.session,
        blocks,
      })
    }
    await LectureEvents.publish(session.id, {
      type: "lecture.block.appended",
      session: payload.session,
      block,
    })
    if (block.highlightSpans.length > 0) {
      await LectureEvents.publish(session.id, {
        type: "lecture.highlight.changed",
        session: payload.session,
        block,
      })
    }
    return block
  },

  async answerQuestion(input: {
    userID: string
    workroomID: string
    lectureSessionID: string
    text: string
    highlightSpans?: LectureHighlightSpan[]
  }) {
    await requireSession(input.userID, input.workroomID, input.lectureSessionID)
    const block = await this.appendBlock({
      userID: input.userID,
      workroomID: input.workroomID,
      lectureSessionID: input.lectureSessionID,
      role: "answer",
      text: input.text,
      highlightSpans: input.highlightSpans,
    })
    const session = await LectureRepository.updateSession(input.userID, input.workroomID, input.lectureSessionID, {
      status: "running",
    })
    if (!session) throw new Error("LECTURE_SESSION_UPDATE_FAILED")
    const payload = await buildSessionPayloadCore(session)
    await LectureEvents.publish(input.lectureSessionID, {
      type: "lecture.resumed",
      session: payload.session,
      block,
    })
    const blocks = await LectureRepository.listBlocks(input.userID, input.workroomID, input.lectureSessionID)
    return { session: payload.session, blocks, block }
  },

  async closeSession(input: { userID: string; workroomID: string; lectureSessionID: string }) {
    const session = await requireSession(input.userID, input.workroomID, input.lectureSessionID)
    const next = await LectureRepository.updateSession(input.userID, input.workroomID, session.id, {
      closedAt: new Date().toISOString(),
    })
    if (!next) throw new Error("LECTURE_SESSION_UPDATE_FAILED")
    return next
  },

  async completeSession(input: {
    userID: string
    workroomID: string
    lectureSessionID: string
    teachingSummary: string
    nextSuggestion?: string | null
  }) {
    const session = await requireSession(input.userID, input.workroomID, input.lectureSessionID)
    const blocks = await LectureRepository.listBlocks(input.userID, input.workroomID, input.lectureSessionID)
    const summary: LectureSummaryHandback = {
      lectureSessionId: session.id,
      cardID: session.cardID,
      completed: true,
      coveredSpans: uniqueSpans(blocks.flatMap((item) => item.highlightSpans)),
      studentQuestions: blocks.filter((item) => item.role === "student_question").map((item) => item.text),
      teachingSummary: input.teachingSummary.trim(),
      nextSuggestion: input.nextSuggestion?.trim() || null,
    }
    const next = await LectureRepository.updateSession(input.userID, input.workroomID, session.id, {
      status: "completed",
      summaryStatus: "completed",
      summary,
      completedAt: new Date().toISOString(),
    })
    if (!next) throw new Error("LECTURE_SESSION_UPDATE_FAILED")
    const payload = await buildSessionPayloadCore(next, blocks)
    await LectureEvents.publish(session.id, {
      type: "lecture.completed",
      session: payload.session,
    })
    return {
      session: payload.session,
      blocks,
      summary,
    }
  },

  async replyRuntimeQuestion(input: {
    userID: string
    workroomID: string
    lectureSessionID: string
    requestID: string
    answers: string[][]
    freeText?: Array<string | null>
  }) {
    const session = await requireSession(input.userID, input.workroomID, input.lectureSessionID)
    const lectureAgentSessionID = await resolveLectureAgentSessionID(session)
    if (!lectureAgentSessionID) {
      throw new Error("LECTURE_AGENT_SESSION_NOT_FOUND")
    }
    const { AppRuntime, Question, QuestionID } = await loadAgentRuntimeModules()
    const resumed =
      (await LectureRepository.updateSession(input.userID, input.workroomID, session.id, {
        status: "running",
        questionPromptJSON: session.questionPromptJSON ?? "null",
      })) ?? session
    const resumedPayload = await buildSessionPayloadCore(resumed)
    await LectureEvents.publish(session.id, {
      type: "question_replied",
      session: resumedPayload.session,
      requestId: input.requestID,
      freeText: input.freeText,
    })
    await LectureEvents.publish(session.id, {
      type: "lecture.resumed",
      session: resumedPayload.session,
    })
    await withAgentScope({ userID: input.userID, workroomID: input.workroomID, syncUserSettings: false }, async () => {
      await AppRuntime.runPromise(
        Question.Service.use((svc: any) =>
          svc.reply({
            requestID: QuestionID.make(input.requestID),
            answers: input.answers,
            freeText: input.freeText,
          }),
        ),
      )
    })
    void resumeSessionLoop({
      userID: input.userID,
      workroomID: input.workroomID,
      sessionID: lectureAgentSessionID,
    }).catch((error) => {
      logger.error("lecture agent loop after runtime question failed", {
        lecture_session_id: input.lectureSessionID,
        lecture_agent_session_id: lectureAgentSessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return resumedPayload
  },
}
