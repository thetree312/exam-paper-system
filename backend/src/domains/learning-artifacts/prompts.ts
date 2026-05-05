const EXAM_CARD_EXAMPLE = [
  "示例输入 (试卷题目):",
  "题目 1: 已知复数 (1+5i)^1 的虚部是多少？",
  "标准答案: 因为 z^1 = z，所以虚部仍为 5。",
  "",
  "示例输出(JSON):",
  "[",
  '  {"concept_tag":"复数的虚部定义","cue":"复数 a + bi 的“虚部”指什么?","answer":"1. 只看 i 前的实系数; 2. 虚部 = b; 3. 若 b = 0 则该复数是实数","question_number":1,"confidence":0.92}',
  '  {"concept_tag":"指数为 1 的幂运算","cue":"当 z 取 1 次方时, 它的虚部会发生变化吗?","answer":"1. 任意数 z 都有 z^1 = z; 2. 因此虚部保持不变; 3. 只要指数为 1, 结果与原数一致","question_number":1,"confidence":0.88}',
  "]",
].join("\n")

const DOC_CARD_EXAMPLE = [
  "示例输入 (长文档摘要):",
  "章节 1 摘要: DNA 的双螺旋结构由互补碱基配对稳定, 复制遵循半保留机制...",
  "",
  "示例输出(JSON):",
  "[",
  '  {"concept_tag":"DNA 半保留复制机制","cue":"为什么说 DNA 复制是“半保留”的?","answer":"1. 复制时以旧链为模板; 2. 每条子链都含一条旧链+一条新链; 3. 该机制保证遗传信息稳定","confidence":0.9}',
  '  {"concept_tag":"互补碱基配对的作用","cue":"互补碱基配对如何保证双螺旋结构稳定?","answer":"1. A-T 和 G-C 配对提供氢键; 2. 配对规则使两条链长度一致; 3. 防止复制时产生大量错误","confidence":0.86}',
  "]",
].join("\n")

export function buildFlashcardLongOutlineSystemPrompt() {
  return [
    "你是一名教研助手，负责将长篇教材/讲义/笔记压缩为章节级知识纲要。",
    "输出严格为 JSON 数组，每个元素包含 chunk_id、summary，可选 page_start/page_end 与 concepts。",
    "不要输出解释、不要 Markdown 代码块。",
  ].join("\n")
}

export function buildFlashcardLongOutlineUserPrompt(input: {
  title: string
  chunkIndex: number
  chunkCount: number
  maxCards: number
  chunkContent: string
}) {
  return [
    `文档标题: ${input.title}`,
    `分块编号: ${input.chunkIndex}/${input.chunkCount}`,
    `目标: 后续将基于摘要生成不超过 ${input.maxCards} 张知识点闪卡。`,
    "要求摘要保留概念、公式、判断条件、易错点，避免冗长。",
    input.chunkContent,
  ].join("\n\n")
}

export function buildFlashcardGenerationSystemPrompt(input: {
  maxCards: number
  sourceType: "exam" | "long_doc"
}) {
  const contextHint = input.sourceType === "exam" ? "以下是试卷中的题目及答案" : "以下是文档章节摘要"
  const extraField = input.sourceType === "exam" ? '  question_number (整数，对应原题序号，无法对应则 null),\n' : ""
  const exampleBlock = input.sourceType === "exam" ? EXAM_CARD_EXAMPLE : DOC_CARD_EXAMPLE

  return [
    "你是一名教研专家，负责从学习材料中提取细粒度知识点，生成用于间隔重复复习的闪卡。",
    "严禁照搬题干或原文，请先抽象出知识点，再用主动召回问题引导学习者回忆。",
    "输出严格为 JSON 数组，每个元素包含：",
    '  concept_tag (知识点主题标签),',
    "  cue (15~40字疑问句，禁止直接粘贴题干原句),",
    "  answer (2~4条要点，聚焦推理/公式/结论),",
    extraField + "  confidence (0~1 浮点数)。",
    "质量规则：",
    "1. 一张卡只考一个概念/公式/方法。",
    "2. answer 需要关键条件/步骤/结论，禁止空泛。",
    `3. 最多输出 ${input.maxCards} 张卡片，知识点不足可少于该数量。`,
    "",
    `${contextHint}。请严格参考示例结构与写作风格：`,
    exampleBlock,
  ].join("\n")
}

export function buildMindmapOutlineSystemPrompt(input: {
  title: string
  mode: "knowledge_structure" | "exam_review"
  sourceType: string
  sourceId: string
}) {
  const modeLabel = input.mode === "knowledge_structure" ? "knowledge structure map" : "exam/review map"
  return [
    `You are preparing a high-quality ${modeLabel}.`,
    "Do not output the final mindmap yet.",
    "Return JSON only. No prose, no markdown, no comments.",
    "Use exactly this shape:",
    JSON.stringify(
      {
        title: input.title,
        mode: input.mode,
        documentSummary: "high-level synthesis of the document",
        topics: [
          {
            topic: "top-level topic",
            summary: "why this topic matters",
            subtopics: [{ topic: "refined subtopic", summary: "what this subtopic covers", evidenceHints: ["page 2"] }],
          },
        ],
      },
      null,
      2,
    ),
    "Rules:",
    "1. Topics must be semantic topics, not page labels.",
    "2. Prefer 4 to 8 top-level topics when source supports it.",
    "3. If mode is exam_review, bias toward tested themes and traps.",
    "4. If mode is knowledge_structure, bias toward concepts and hierarchy.",
    "5. Do not output ids or database fields.",
    `6. Source metadata: source_type=${input.sourceType}, source_id=${input.sourceId}`,
  ].join("\n")
}

export function buildMindmapExpandSystemPrompt(input: {
  title: string
  mode: "knowledge_structure" | "exam_review"
  sourceType: string
  sourceId: string
}) {
  const modeInstruction =
    input.mode === "knowledge_structure"
      ? "Focus on concepts, principles, and hierarchy."
      : "Focus on exam themes, methods, and common traps."
  return [
    "You are an expert at expanding a compact outline into a high-quality semantic mindmap.",
    "Return JSON only. No prose, no markdown, no comments.",
    "Use this shape exactly:",
    JSON.stringify(
      {
        title: input.title,
        nodes: [{ id: "root", label: "root node" }, { id: "topic-1", label: "topic", parentID: "root" }],
        edges: [{ id: "edge-1", from: "root", to: "topic-1" }],
      },
      null,
      2,
    ),
    "Rules:",
    `1. ${modeInstruction}`,
    "2. All top-level topics must connect from root.",
    "3. No isolated nodes.",
    "4. Keep semantic consistency with provided outline.",
    `5. Source metadata: source_type=${input.sourceType}, source_id=${input.sourceId}`,
  ].join("\n")
}
