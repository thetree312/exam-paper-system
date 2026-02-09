export const OPTION_REGEX = /^([A-J])[\.:、．\)\]]+\s*(.*)$/i

const READING_QUESTION_REGEX = /^(\d{1,3})[\s\.:、．\)\]]+(.+)$/
const MATCHING_PARAGRAPH_REGEX = /^([A-Z])[\)\.:：]\s*(.*)$/
const MATCHING_STATEMENT_REGEX = /^(\d{1,3})[\)\.:：]\s*(.*)$/

const SECTION_BREAK_KEYWORDS = [
  '选择答案',
  '填空题',
  '解答题',
  '本大题共',
  'choose answer',
  'fill in the blank',
  'fill-in-the-blank',
  'short answer',
  'questions',
]

const HARD_CUT_MARKERS = [
  '## ',
  '三、填空题',
  '本大题共',
  '选择答案',
  '### ',
  'fill in the blanks',
  'choose answer',
]

export interface ReadingOption {
  label: string
  text: string
}

export interface ReadingQuestion {
  id: string
  stem: string
  options: ReadingOption[]
}

export interface ReadingParseResult {
  passage: string
  questions: ReadingQuestion[]
}

export interface ParagraphMatchingParagraph {
  id: string
  text: string
}

export interface ParagraphMatchingStatement {
  id: string
  text: string
}

export interface ParagraphMatchingParseResult {
  instructions: string
  paragraphs: ParagraphMatchingParagraph[]
  statements: ParagraphMatchingStatement[]
}

export function normalizeQuestionText(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/<\/(p|div|li|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/<[^>]+>/g, ' ')
}

function preprocessHorizontalOptions(source: string): string {
  if (!source) return ''
  let result = ''
  let inMath = false
  const len = source.length

  for (let i = 0; i < len; i += 1) {
    const ch = source[i]

    if (ch === '$') {
      inMath = !inMath
      result += ch
      continue
    }

    // 仅在数学环境之外，对连续的「空格/Tab」做横排选项识别；
    // 不再吞掉原始的換行符，避免破坏 Markdown 表格、段落结构。
    if (!inMath && (ch === ' ' || ch === '\t')) {
      let j = i
      while (j < len && (source[j] === ' ' || source[j] === '\t')) {
        j += 1
      }

      if (j < len) {
        const letter = source[j]
        if (/[A-Ja-j]/.test(letter)) {
          let k = j + 1
          // 注意：这里刻意不把顿号“、”算作选项标点，避免将“点 A、B”之类几何点误判为横排选项
          while (k < len && /[\s\.:．\)\]）]/.test(source[k])) {
            k += 1
          }
          if (k > j + 1) {
            result += `\n${letter.toUpperCase()}. `
            i = k - 1
            continue
          }
        }
      }
    }

    result += ch
  }

  return result
}

export function parseMultipleChoiceQuestion(
  text: string,
): { stem: string; options: { label: string; text: string }[] } | null {
  const normalized = normalizeQuestionText(text)

  const preprocessed = preprocessHorizontalOptions(normalized)

  const lines = preprocessed.split(/\r?\n/).map((line) => line.trim())
  const options: { label: string; text: string }[] = []
  const stemLines: string[] = []
  let currentOption: { label: string; text: string } | null = null
  let parsingOptions = false

  const isSectionBreakLine = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed) return false

    if (trimmed === '选择答案') return true
    if (/^#{1,6}\s+/.test(trimmed)) return true
    if (/^[一二三四五六七八九十]+、/.test(trimmed)) return true
    if (trimmed.includes('填空题') || trimmed.includes('解答题')) return true
    if (trimmed.includes('本大题共')) return true

    return false
  }

  for (const line of lines) {
    if (!line) {
      if (currentOption) {
        currentOption.text += '\n'
      } else {
        stemLines.push('')
      }
      continue
    }

    if (isSectionBreakLine(line)) {
      if (parsingOptions) {
        break
      }
      // 段落标题（例如“选择答案”、“三、填空题”）在题干中通常无需重复展示，直接跳过
      continue
    }

    const match = line.match(OPTION_REGEX)

    if (match) {
      parsingOptions = true
      if (currentOption) {
        currentOption.text = currentOption.text.trim()
        options.push(currentOption)
      }
      currentOption = {
        label: match[1].toUpperCase(),
        text: match[2].trim(),
      }
    } else if (parsingOptions && currentOption) {
      currentOption.text = `${currentOption.text} ${line}`.trim()
    } else {
      stemLines.push(line)
    }
  }

  if (currentOption) {
    currentOption.text = currentOption.text.trim()
    options.push(currentOption)
  }

  const hasImagePlaceholders = preprocessed.includes('[[GLM_FIG_')

  const cleanedOptions: { label: string; text: string }[] = options.map((opt) => {
    let text = opt.text

    const hardCutMarkers = ['## ', '三、填空题', '本大题共', '选择答案']
    for (const marker of hardCutMarkers) {
      const idx = text.indexOf(marker)
      if (idx >= 0) {
        text = text.slice(0, idx)
      }
    }

    text = text.trim()

    return {
      label: opt.label,
      text,
    }
  })

  if (cleanedOptions.length < 2) {
    if (cleanedOptions.length === 1) {
      try {
        console.debug('[mcq.parse]', {
          stage: 'single-option',
          preview: preprocessed.slice(0, 400),
          options: cleanedOptions,
        })
      } catch {
        // ignore
      }
    }
    return null
  }

  const result = {
    stem: stemLines.join('\n').trim(),
    options: cleanedOptions,
  }

  try {
    console.debug('[mcq.parse]', {
      stage: 'ok',
      preview: preprocessed.slice(0, 400),
      options: result.options,
    })
  } catch {
    // ignore
  }

  return result
}

export function parseReadingComprehension(raw: string): ReadingParseResult | null {
  const normalized = normalizeQuestionText(raw)
  if (!normalized) return null
  const lines = normalized.split(/\r?\n/)

  const passageLines: string[] = []
  const questions: { id: string; stemLines: string[]; options: ReadingOption[] }[] = []

  let inQuestions = false
  let currentQuestion: { id: string; stemLines: string[]; options: ReadingOption[] } | null = null
  let currentOption: ReadingOption | null = null
  let parsingOptions = false

  const flushOption = () => {
    if (currentOption) {
      currentOption.text = currentOption.text.trim()
      if (currentOption.text) {
        currentQuestion?.options.push(currentOption)
      }
    }
    currentOption = null
  }

  const flushQuestion = () => {
    if (!currentQuestion) return
    flushOption()
    if (currentQuestion.options.length >= 2) {
      questions.push(currentQuestion)
    }
    currentQuestion = null
    parsingOptions = false
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (!inQuestions) {
        passageLines.push('')
      } else if (currentOption) {
        currentOption.text += '\n'
      } else if (currentQuestion) {
        currentQuestion.stemLines.push('')
      }
      continue
    }

    const qMatch = line.match(READING_QUESTION_REGEX)
    if (!inQuestions) {
      if (qMatch) {
        inQuestions = true
        currentQuestion = {
          id: qMatch[1],
          stemLines: [qMatch[2].trim()],
          options: [],
        }
      } else {
        passageLines.push(line)
      }
      continue
    }

    if (qMatch) {
      flushQuestion()
      currentQuestion = {
        id: qMatch[1],
        stemLines: [qMatch[2].trim()],
        options: [],
      }
      continue
    }

    const optMatch = line.match(OPTION_REGEX)
    if (optMatch && currentQuestion) {
      parsingOptions = true
      flushOption()
      currentOption = {
        label: optMatch[1].toUpperCase(),
        text: optMatch[2].trim(),
      }
      continue
    }

    if (parsingOptions && currentOption) {
      currentOption.text = `${currentOption.text} ${line}`.trim()
    } else if (currentQuestion) {
      currentQuestion.stemLines.push(line)
    }
  }

  flushQuestion()

  const passage = passageLines.join('\n').trim()
  if (!passage || !questions.length) {
    return null
  }

  return {
    passage,
    questions: questions.map((q) => ({
      id: q.id,
      stem: q.stemLines.join(' ').replace(/\s+/g, ' ').trim(),
      options: q.options,
    })),
  }
}

export function parseReadingAnswerMap(raw: string): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const result: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          result[String(key)] = value.trim().toUpperCase()
        }
      }
      if (Object.keys(result).length) {
        return result
      }
    }
  } catch {
    // ignore
  }

  const fallback: Record<string, string> = {}
  raw
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((segment) => {
      const match = segment.match(/^(\d{1,3})\s*[:=\-]?\s*([A-J])$/i)
      if (match) {
        fallback[match[1]] = match[2].toUpperCase()
      }
    })
  return fallback
}

export function parseParagraphMatching(raw: string): ParagraphMatchingParseResult | null {
  const normalized = normalizeQuestionText(raw)
  if (!normalized) return null
  const lines = normalized.split(/\r?\n/)

  const instructions: string[] = []
  const paragraphs: { id: string; lines: string[] }[] = []
  const statements: { id: string; lines: string[] }[] = []

  let mode: 'instructions' | 'paragraphs' | 'statements' = 'instructions'
  let currentParagraph: { id: string; lines: string[] } | null = null
  let currentStatement: { id: string; lines: string[] } | null = null

  const flushParagraph = () => {
    if (currentParagraph) {
      const text = currentParagraph.lines.join(' ').replace(/\s+/g, ' ').trim()
      if (text) {
        paragraphs.push({ id: currentParagraph.id, text })
      }
    }
    currentParagraph = null
  }

  const flushStatement = () => {
    if (currentStatement) {
      const text = currentStatement.lines.join(' ').replace(/\s+/g, ' ').trim()
      if (text) {
        statements.push({ id: currentStatement.id, text })
      }
    }
    currentStatement = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const paragraphMatch = line.match(MATCHING_PARAGRAPH_REGEX)
    const statementMatch = line.match(MATCHING_STATEMENT_REGEX)

    if (paragraphMatch && mode !== 'statements') {
      mode = 'paragraphs'
      flushParagraph()
      currentParagraph = {
        id: paragraphMatch[1],
        lines: [],
      }
      if (paragraphMatch[2]?.trim()) {
        currentParagraph.lines.push(paragraphMatch[2].trim())
      }
      continue
    }

    if (statementMatch) {
      if (mode !== 'statements') {
        mode = 'statements'
        flushParagraph()
      }
      flushStatement()
      currentStatement = {
        id: statementMatch[1],
        lines: [],
      }
      if (statementMatch[2]?.trim()) {
        currentStatement.lines.push(statementMatch[2].trim())
      }
      continue
    }

    if (mode === 'paragraphs' && currentParagraph) {
      currentParagraph.lines.push(line)
      continue
    }

    if (mode === 'statements' && currentStatement) {
      currentStatement.lines.push(line)
      continue
    }

    instructions.push(line)
  }

  flushParagraph()
  flushStatement()

  if (!paragraphs.length || !statements.length) {
    return null
  }

  return {
    instructions: instructions.join('\n').trim(),
    paragraphs,
    statements,
  }
}

export function parseMatchingAnswerMap(raw: string): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const result: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          result[String(key)] = value.trim().toUpperCase()
        }
      }
      if (Object.keys(result).length) {
        return result
      }
    }
  } catch {
    // ignore
  }
  const fallback: Record<string, string> = {}
  raw
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((segment) => {
      const match = segment.match(/^(\d{1,3})\s*[:=\-]?\s*([A-Z])$/i)
      if (match) {
        fallback[match[1]] = match[2].toUpperCase()
      }
    })
  return fallback
}

export function serializeAnswerMap(map: Record<string, string>): string {
  const keys = Object.keys(map)
  if (!keys.length) return ''
  return JSON.stringify(map)
}

export function stripChoiceBlockFromEditedText(text: string): string {
  if (!text) return ''
  const lines = text.split(/\r?\n/)
  const kept: string[] = []

  const ensureTableSpacing = (content: string[]): string => {
    const result: string[] = []
    let inTableBlock = false

    for (const line of content) {
      const trimmed = line.trim()
      const isTableLine = trimmed.startsWith('|') && trimmed.endsWith('|')

      if (isTableLine) {
        if (!inTableBlock) {
          if (result.length > 0 && result[result.length - 1].trim() !== '') {
            result.push('')
          }
          inTableBlock = true
        }
        result.push(line)
        continue
      }

      if (inTableBlock) {
        if (trimmed !== '' && result.length > 0 && result[result.length - 1].trim() !== '') {
          result.push('')
        }
        inTableBlock = false
      }

      result.push(line)
    }

    return result.join('\n')
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      kept.push(line)
      continue
    }
    const match = trimmed.match(OPTION_REGEX)
    if (match) {
      continue
    }
    kept.push(line)
  }
  return ensureTableSpacing(kept)
}