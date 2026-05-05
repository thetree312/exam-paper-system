import { QuestionLlmService } from "./llm-service"

export type SplitQuestionItem = {
  index: number
  text: string
}

const SPLIT_SYSTEM_PROMPT =
  "你是一个试卷整理助手，负责将一段可能包含多道题目的中文文本拆分成可以独立编辑的题目块。" +
  "题目可能是选择题、填空题、解答题等，你需要根据题号、结构和语义判断题目边界。" +
  '输出必须是一个 JSON 对象，形如：{"questions":[{"index":1,"text":"..."}, ...]}。' +
  "只输出 JSON，不要包含任何额外解释、注释或 Markdown。" +
  "每个 text 字段应包含该题目的完整题干，可以保留题号和选项。" +
  "不要把不同题目合并为一题，也不要把同一题拆得过细。"

export const QuestionSplitService = {
  async split(input: { userID: string; workroomID: string; text: string; maxQuestions: number }) {
    const text = input.text.trim()
    if (!text) throw new Error("text is required")

    const response = await QuestionLlmService.chatJson({
      userID: input.userID,
      capability: "question_split",
      system: SPLIT_SYSTEM_PROMPT,
      user: [
        "下面是一段可能包含多道试题的文本，请按“单道题”的粒度拆分：",
        "",
        "【原始文本】",
        text,
        "",
        "【任务要求】",
        "1. 仔细识别题号（如：1.、2、（1）、一、二、三等）和题干结构，推断题目边界。",
        "2. 每道题的 text 中应包含完整题干以及紧随其后的与本题紧密相关的内容（包括选项）。",
        "3. 如果无法明显拆出多题，则只输出一条 questions，text 为原文或适度清理后的完整文本。",
        `4. 最多返回 ${input.maxQuestions} 道题，多余的忽略。`,
        '5. 严格输出 {"questions":[{"index":number,"text":string}]}。',
      ].join("\n"),
      temperature: 0.1,
      topP: 0.8,
    })

    const rawItems = Array.isArray(response.questions) ? response.questions : []
    const items: SplitQuestionItem[] = rawItems
      .map((item, index) => {
        if (!item || typeof item !== "object") return null
        const record = item as Record<string, unknown>
        const textValue = String(record.text ?? "").trim()
        if (!textValue) return null
        const rawIndex = Number(record.index)
        return {
          index: Number.isInteger(rawIndex) && rawIndex > 0 ? rawIndex : index + 1,
          text: textValue,
        }
      })
      .filter((item): item is SplitQuestionItem => Boolean(item))
      .slice(0, input.maxQuestions)

    if (items.length === 0) {
      throw new Error("Question split returned no valid questions")
    }
    return items
  },
}
