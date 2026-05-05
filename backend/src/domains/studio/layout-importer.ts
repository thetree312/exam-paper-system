import { imageFileToDataUrl } from "../../lib/image-processing"
import type { DocumentRecord } from "../documents/service"
import type { DocumentLayoutBlock } from "../documents/pipeline/service"
import type { StudioLegendRegion, StudioSelectionRegion } from "./types"

export type ImportedQuestionCardDraft = {
  sequenceIndex: number
  page: number
  text: string
  originalText: string
  answerText: string
  canonicalAnswer: string
  legendImages: string[]
  sourceSelection: {
    regions: StudioSelectionRegion[]
    legends: StudioLegendRegion[]
  }
}

type QuestionAccumulator = {
  page: number
  parts: string[]
  legendImages: string[]
  regions: StudioSelectionRegion[]
  legends: StudioLegendRegion[]
}

const questionStartRe = /^\s*(\d{1,3})\s*[.．、:：]/
const answerHeaderRe = /^[\[【]?(第\s*)?(?<no>\d+)\s*(题)?\s*答案[】\]]?\s*$/
const answerValueRe = /^[\[【]?答案[】\]]?\s*[:：]?\s*(?<ans>.+)$/
const answerInlineRe =
  /^\s*(第\s*)?(?<no>\d+)\s*(题)?\s*[.．、:：）)]?\s*(?:(?:答案|Ans|ANS)\s*[:：]?)?\s*(?<rest>.*)$/

const figureLabels = new Set(["image", "figure", "chart", "table"])
const skipLabels = new Set(["header", "footer", "page_header", "page_footer", "pagenum", "page_number", "logo"])

function normalizeBlockText(input: string) {
  return input
    .replace(/<div[^>]*>/gi, "")
    .replace(/<\/div>/gi, "")
    .replace(/<span[^>]*>/gi, "")
    .replace(/<\/span>/gi, "")
    .trim()
}

function decodeHtmlEntities(input: string) {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
}

function looksLikeSectionHeader(text: string) {
  const stripped = text.trim()
  if (!stripped) return false
  if (/^[#\s]*[一二三四五六七八九十]+[、.．]/.test(stripped)) return true
  if (/^第[一二三四五六七八九十0-9ⅠⅡⅢIVVVI]+卷/.test(stripped)) return true
  const normalized = stripped.replace(/^#+/, "").trim()
  return ["选择题", "填空题", "解答题", "本大题", "本题共"].some((prefix) => normalized.startsWith(prefix))
}

function isExamNoticeLine(text: string) {
  const normalized = text.replace(/\s+/g, "")
  if (!normalized) return false
  if (/^\d{1,2}[.．、:：]/.test(normalized)) {
    return ["答题前", "选择题", "非选择题", "考试结束", "注意事项", "答题卡"].some((keyword) =>
      normalized.includes(keyword),
    )
  }
  return ["注意事项", "答题须知", "考生须知", "答题前", "考试结束后"].some((keyword) => normalized.includes(keyword))
}

function isQuestionSectionTitle(text: string) {
  if (!["选择题", "填空题", "解答题", "本题共"].some((keyword) => text.includes(keyword))) return false
  return /^[一二三四五六七八九十]+\s*[、.．]/.test(text)
}

function shouldSkipBlock(block: DocumentLayoutBlock) {
  const label = block.blockLabel.toLowerCase()
  if (!skipLabels.has(label) || !block.bboxNorm) return false
  return block.bboxNorm.y2 < 0.15 || block.bboxNorm.y1 > 0.85
}

function isExtremeTopOrBottom(block: DocumentLayoutBlock) {
  if (!block.bboxNorm) return false
  return block.bboxNorm.y2 < 0.08 || block.bboxNorm.y1 > 0.92
}

function toSelectionRegion(block: DocumentLayoutBlock): StudioSelectionRegion | null {
  if (!block.bboxNorm) return null
  return {
    page: block.pageNumber,
    x: block.bboxNorm.x1,
    y: block.bboxNorm.y1,
    width: Math.max(0, block.bboxNorm.x2 - block.bboxNorm.x1),
    height: Math.max(0, block.bboxNorm.y2 - block.bboxNorm.y1),
  }
}

function toLegendRegion(block: DocumentLayoutBlock): StudioLegendRegion | null {
  const region = toSelectionRegion(block)
  if (!region) return null
  return {
    page: region.page,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  }
}

async function blockLegendImage(block: DocumentLayoutBlock) {
  if (!block.cropAssetAbsolutePath) return null
  try {
    return await imageFileToDataUrl(block.cropAssetAbsolutePath)
  } catch {
    return null
  }
}

function firstQuestionNumber(text: string) {
  const match = questionStartRe.exec(text.trim())
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function mapAnswers(answerLines: string[]) {
  const answerMap = new Map<number, string>()
  let lastNo: number | null = null

  const addAnswer = (no: number, text: string) => {
    const value = text.trim()
    if (!value) return
    const previous = answerMap.get(no)
    answerMap.set(no, previous ? `${previous}\n${value}` : value)
  }

  for (const line of answerLines) {
    const stripped = line.trim()
    if (!stripped) continue

    const headerMatch = answerHeaderRe.exec(stripped)
    if (headerMatch?.groups?.no) {
      lastNo = Number(headerMatch.groups.no)
      continue
    }

    const valueMatch = answerValueRe.exec(stripped)
    if (valueMatch?.groups?.ans && lastNo !== null) {
      addAnswer(lastNo, valueMatch.groups.ans)
      continue
    }

    const inlineMatch = answerInlineRe.exec(stripped)
    if (inlineMatch?.groups?.no) {
      const parsed = Number(inlineMatch.groups.no)
      if (Number.isFinite(parsed)) {
        lastNo = parsed
        const rest = (inlineMatch.groups.rest ?? "").replace(/^[\[【]?答案[】\]]?\s*[:：]?\s*/, "").trim()
        addAnswer(parsed, rest)
      }
      continue
    }

    if (lastNo !== null) addAnswer(lastNo, stripped)
  }

  return answerMap
}

export async function importDocumentLayoutAsQuestionCards(document: DocumentRecord) {
  const questions: QuestionAccumulator[] = []
  let current: QuestionAccumulator | null = null
  const answerLines: string[] = []
  let hasStartedQuestions = false
  let inNoticeSection = true
  let inAnswerSection = false

  const flushCurrent = () => {
    if (!current) return
    const text = current.parts.join("\n").trim()
    if (!text) {
      current = null
      return
    }
    questions.push(current)
    hasStartedQuestions = true
    current = null
  }

  const pages = [...document.layoutPages].sort((left, right) => left.pageNumber - right.pageNumber)
  for (const page of pages) {
    const blocks = [...page.blocks].sort((left, right) => left.blockIndex - right.blockIndex)
    if (blocks.length === 0) continue

    const pageContainsAnswerKeyword = blocks.some((block) =>
      ["参考答案", "题答案", "【答案】", "答案】", "答案："].some((keyword) => block.content.includes(keyword)),
    )
    if (hasStartedQuestions && pageContainsAnswerKeyword && !inAnswerSection) {
      flushCurrent()
      inAnswerSection = true
    }

    for (const block of blocks) {
      if (shouldSkipBlock(block)) continue

      const label = block.blockLabel.toLowerCase()
      const rawContent = block.content ?? ""
      const content = normalizeBlockText(rawContent)

      if (content) {
        for (const line of content.split(/\r?\n/)) {
          const stripped = decodeHtmlEntities(line).trim()
          if (!stripped) {
            if (current) current.parts.push("")
            continue
          }

          if (isExamNoticeLine(stripped) && inNoticeSection && !inAnswerSection) {
            continue
          }

          const hitAnswerKeyword = ["参考答案", "答案解析", "【答案】", "题答案"].some((keyword) =>
            stripped.includes(keyword),
          )
          if (hitAnswerKeyword && !inAnswerSection) {
            flushCurrent()
            inAnswerSection = true
          }

          if (inNoticeSection && looksLikeSectionHeader(stripped)) {
            inNoticeSection = false
            continue
          }

          if (inNoticeSection && !inAnswerSection) continue
          if (inAnswerSection) {
            answerLines.push(stripped)
            continue
          }

          if (isQuestionSectionTitle(stripped)) {
            flushCurrent()
            continue
          }

          if (questionStartRe.test(stripped)) {
            flushCurrent()
            current = {
              page: page.pageNumber,
              parts: [stripped],
              legendImages: [],
              regions: [],
              legends: [],
            }
            const region = toSelectionRegion(block)
            if (region) current.regions.push(region)
            continue
          }

          if (current) {
            current.parts.push(stripped)
            const region = toSelectionRegion(block)
            if (region) current.regions.push(region)
          }
        }
      }

      const isHtmlTableBlock = label === "table" && /<table/i.test(rawContent)
      if (current && figureLabels.has(label) && !isExtremeTopOrBottom(block) && !isHtmlTableBlock) {
        const image = await blockLegendImage(block)
        if (image) {
          const placeholder = `[[GLM_FIG_${current.legendImages.length}]]`
          current.parts.push(placeholder)
          current.legendImages.push(image)
          const legendRegion = toLegendRegion(block)
          if (legendRegion) current.legends.push(legendRegion)
        }
      }
    }
  }

  flushCurrent()

  const answerMap = mapAnswers(answerLines)
  if (questions.length === 0) {
    const fallback = document.layoutPages
      .map((page) => page.markdown)
      .join("\n\n")
      .trim()
    if (!fallback) throw new Error("Document layout does not contain importable text")
    return [
      {
        sequenceIndex: 0,
        page: 1,
        text: fallback,
        originalText: fallback,
        answerText: "",
        canonicalAnswer: "",
        legendImages: [],
        sourceSelection: { regions: [], legends: [] },
      },
    ] satisfies ImportedQuestionCardDraft[]
  }

  return questions.map((question, index) => {
    const no = firstQuestionNumber(question.parts.find((part) => part.trim()) ?? "") ?? index + 1
    const text = question.parts.join("\n").trim()
    return {
      sequenceIndex: index,
      page: question.page,
      text,
      originalText: text,
      answerText: "",
      canonicalAnswer: answerMap.get(no) ?? "",
      legendImages: question.legendImages,
      sourceSelection: {
        regions: question.regions,
        legends: question.legends,
      },
    } satisfies ImportedQuestionCardDraft
  })
}
