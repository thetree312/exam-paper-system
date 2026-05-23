import { createID } from "../../lib/ids"
import { getLocalSqlite, parseJsonText } from "../../lib/local-sqlite"
import { QuestionLlmService } from "../questions/llm-service"

type EventType =
  | "enter_answer_mode"
  | "add_to_collection"
  | "add_to_studio"
  | "start_review"
  | "submit_answer"
  | "finish_review"
  | "remove_from_studio"

function nowIso() {
  return new Date().toISOString()
}

function toRootCause(mistakeType?: string | null) {
  const value = String(mistakeType ?? "").toLowerCase()
  if (value.includes("careless")) return "careless_mistake"
  if (value.includes("concept")) return "concept_gap"
  if (value.includes("calc")) return "calculation_error"
  if (value.includes("method")) return "method_gap"
  if (value.includes("misread")) return "misread_question"
  return "unknown"
}

type ProgressSignal =
  | "lucky_hit"
  | "breakthrough"
  | "stabilizing"
  | "partial_repair"
  | "stagnant"
  | "relapse"
  | "deeper_confusion"

type QuestionGenerationRecommendation = {
  strategy: "remedial" | "stabilize" | "advance"
  recommended_difficulty: "easy" | "medium" | "hard"
  recommended_question_types: string[]
  recommended_knowledge_points: string[]
  recommended_relation_type: "practice_generated" | "variant" | "explanation_followup"
  target_ability: string[]
  avoid_patterns: string[]
  prompt_hints: string[]
  reason_summary: string
  confidence: number
  based_on_attempt_id: string
  based_on_attempt_index: number
  updated_at: string
}

function computeMasterySnapshot(input: {
  totalAttempts: number
  correctAttempts: number
  consecutiveCorrectCount: number
  unresolvedWeaknesses: string[]
  repeatedMistakeCount: number
  duplicateRecentAnswer: boolean
  lastAttemptAt?: string | null
}) {
  if (input.totalAttempts <= 0) {
    return { masteryLevel: "unmastered", masteryScore: 0 }
  }
  const accuracy = input.correctAttempts / input.totalAttempts
  const unresolvedPenalty = Math.min(24, input.unresolvedWeaknesses.length * 5)
  const repeatPenalty = Math.min(15, input.repeatedMistakeCount * 4)
  const streakBonus = Math.min(8, input.consecutiveCorrectCount * 2)
  const samplePenalty = input.totalAttempts === 1 ? 30 : input.totalAttempts === 2 ? 16 : 0
  const duplicatePenalty = input.duplicateRecentAnswer ? 12 : 0
  const recencyPenalty = (() => {
    if (!input.lastAttemptAt) return 0
    const lastAt = new Date(input.lastAttemptAt).getTime()
    if (!Number.isFinite(lastAt)) return 0
    const days = (Date.now() - lastAt) / (24 * 60 * 60 * 1000)
    if (days >= 30) return 8
    if (days >= 14) return 4
    return 0
  })()
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(accuracy * 72 - unresolvedPenalty - repeatPenalty - recencyPenalty - samplePenalty - duplicatePenalty + streakBonus),
    ),
  )
  const cappedScore =
    input.totalAttempts < 3
      ? Math.min(score, 59)
      : input.unresolvedWeaknesses.length > 0
        ? Math.min(score, 79)
        : score
  if (cappedScore < 20) return { masteryLevel: "unmastered", masteryScore: cappedScore }
  if (cappedScore < 40) return { masteryLevel: "weak", masteryScore: cappedScore }
  if (cappedScore < 60) return { masteryLevel: "basic", masteryScore: cappedScore }
  if (cappedScore < 80) return { masteryLevel: "good", masteryScore: cappedScore }
  return { masteryLevel: "proficient", masteryScore: cappedScore }
}

function computeProgressSnapshot(input: {
  attemptIndex: number
  isCorrect: boolean | null
  comparisonWithPreviousAttempt: string | null
  fixedPreviousErrors: string[]
  remainingWeaknesses: string[]
  newMistakes: string[]
  previousAnswerText: string | null
  currentAnswerText: string
  previousJudgement: string | null
}) {
  const comparison = String(input.comparisonWithPreviousAttempt ?? "").trim()
  const duplicateRecentAnswer =
    Boolean(input.previousAnswerText) &&
    input.currentAnswerText.trim() !== "" &&
    input.currentAnswerText.trim() === String(input.previousAnswerText ?? "").trim()
  if (input.attemptIndex <= 1) {
    if (input.isCorrect === true) {
      return {
        signal: "lucky_hit" as ProgressSignal,
        summary: "首次作答命中，先记为有效起点，暂不视为稳定掌握。",
        duplicateRecentAnswer,
      }
    }
    return {
      signal: "stagnant" as ProgressSignal,
      summary: "首次作答已建立基线，后续需看是否能修复当前薄弱点。",
      duplicateRecentAnswer,
    }
  }
  if (duplicateRecentAnswer) {
    return {
      signal: "stagnant" as ProgressSignal,
      summary: "本次与上次答案重复，系统不将其视为新的掌握证据。",
      duplicateRecentAnswer,
    }
  }
  if (input.isCorrect === true && input.fixedPreviousErrors.length > 0) {
    return {
      signal: "breakthrough" as ProgressSignal,
      summary: comparison || "本次命中了关键修复点，说明你正在从旧错误中走出来。",
      duplicateRecentAnswer,
    }
  }
  if (
    input.isCorrect === true &&
    input.previousJudgement === "correct" &&
    input.remainingWeaknesses.length === 0 &&
    input.newMistakes.length === 0
  ) {
    return {
      signal: "stabilizing" as ProgressSignal,
      summary: comparison || "连续正确且没有新增薄弱点，表现开始稳定。",
      duplicateRecentAnswer,
    }
  }
  if (input.fixedPreviousErrors.length > 0 && input.isCorrect !== true) {
    return {
      signal: "partial_repair" as ProgressSignal,
      summary: comparison || "虽然还没完全做对，但你已经修掉了上次的一部分核心错误。",
      duplicateRecentAnswer,
    }
  }
  if (input.newMistakes.length > 0 && input.isCorrect !== true) {
    return {
      signal: "deeper_confusion" as ProgressSignal,
      summary: comparison || "本次出现了新的错误点，说明理解还不够稳定。",
      duplicateRecentAnswer,
    }
  }
  if (input.previousJudgement === "correct" && input.isCorrect !== true) {
    return {
      signal: "relapse" as ProgressSignal,
      summary: comparison || "旧问题出现回摆，需要重新巩固已经会过的部分。",
      duplicateRecentAnswer,
    }
  }
  return {
    signal: "stagnant" as ProgressSignal,
    summary: comparison || "本次暂未形成新的有效掌握证据，但学习轨迹已被记录。",
    duplicateRecentAnswer,
  }
}

function buildReviewHeatmap180d(submittedAtList: string[]) {
  const bucket = new Map<string, number>()
  for (const submittedAt of submittedAtList) {
    const key = String(submittedAt).slice(0, 10)
    if (!key) continue
    bucket.set(key, (bucket.get(key) ?? 0) + 1)
  }
  const result: Array<{ date: string; intensity: number }> = []
  const now = new Date()
  for (let i = 179; i >= 0; i -= 1) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    result.push({
      date,
      intensity: Math.min(4, bucket.get(date) ?? 0),
    })
  }
  return result
}

function appendUniqueTextArray(raw: string | null | undefined, value: string) {
  const next = value.trim()
  const existing = parseJsonText<string[]>(raw ?? "[]", []).filter(Boolean)
  if (!next) return existing
  return Array.from(new Set([...existing, next]))
}

function normalizeWeaknessKey(text: string) {
  const raw = text.trim()
  if (!raw) return ""
  const compact = raw
    .toLowerCase()
    .replace(/[，。、“”"'‘’（）()【】\[\]\s\-_,.:：;；!?！？]/g, "")
  if (!compact) return ""
  if ((compact.includes("固有频率") && compact.includes("决定")) || compact.includes("受迫振动频率")) {
    return "固有频率与受迫振动频率区分"
  }
  if (compact.includes("共振") && (compact.includes("条件") || compact.includes("发生"))) {
    return "共振条件理解"
  }
  if (compact.includes("多普勒") && compact.includes("频率")) {
    return "多普勒频率变化判断"
  }
  if ((compact.includes("概念") && compact.includes("错误")) || compact.includes("concept")) {
    return "概念理解错误"
  }
  return compact
}

function dedupeWeaknessLabels(labels: string[]) {
  const map = new Map<string, string>()
  for (const label of labels.map((item) => item.trim()).filter(Boolean)) {
    const key = normalizeWeaknessKey(label)
    if (!key) continue
    const existing = map.get(key)
    if (!existing || label.length > existing.length) {
      map.set(key, label)
    }
  }
  return map
}

function mapDifficultyFromMastery(masteryLevel: string, unresolvedWeaknessCount: number): "easy" | "medium" | "hard" {
  const level = masteryLevel.toLowerCase()
  if (level === "unmastered" || level === "weak") return "easy"
  if (level === "basic") return unresolvedWeaknessCount > 0 ? "easy" : "medium"
  if (level === "good") return unresolvedWeaknessCount > 0 ? "medium" : "hard"
  if (level === "proficient") return "hard"
  return "medium"
}

function buildGenerationRecommendation(input: {
  now: string
  attemptID: string
  attemptIndex: number
  masteryLevel: string
  progressSignal: ProgressSignal
  unresolvedWeaknesses: string[]
  repeatedMistakes: string[]
  knowledgePoints: string[]
  mistakeType?: string | null
}) {
  const unresolvedCount = input.unresolvedWeaknesses.length
  const strategy: QuestionGenerationRecommendation["strategy"] =
    input.progressSignal === "breakthrough" || input.progressSignal === "stabilizing"
      ? "advance"
      : input.progressSignal === "partial_repair" || input.progressSignal === "stagnant"
        ? "stabilize"
        : "remedial"
  const recommended_difficulty = mapDifficultyFromMastery(input.masteryLevel, unresolvedCount)
  const recommended_question_types =
    strategy === "remedial"
      ? ["选择题", "判断题"]
      : strategy === "stabilize"
        ? ["选择题", "填空题"]
        : ["填空题", "简答题"]
  const target_ability =
    strategy === "remedial"
      ? ["概念辨析", "基础审题"]
      : strategy === "stabilize"
        ? ["步骤稳定性", "易错点修复"]
        : ["变式迁移", "综合推理"]
  const avoid_patterns = Array.from(
    new Set([
      unresolvedCount > 0 ? "避免跨越当前薄弱点直接提难度" : "",
      input.repeatedMistakes.length > 0 ? "避免重复同构题干与选项排列" : "",
      input.progressSignal === "deeper_confusion" ? "避免多知识点混合新题" : "",
      input.progressSignal === "relapse" ? "避免直接升级题型复杂度" : "",
    ].filter(Boolean)),
  )
  const prompt_hints = Array.from(
    new Set([
      recommended_difficulty === "easy" ? "优先单知识点、短题干、低干扰选项" : "",
      recommended_difficulty === "medium" ? "保持单核心知识点，可加入一步变式" : "",
      recommended_difficulty === "hard" ? "允许跨表示转换与多步骤推理" : "",
      input.mistakeType ? `覆盖错因类型:${input.mistakeType}` : "",
    ].filter(Boolean)),
  )
  const recommended_knowledge_points = input.knowledgePoints.length > 0 ? input.knowledgePoints : input.unresolvedWeaknesses.slice(0, 3)
  const recommended_relation_type: QuestionGenerationRecommendation["recommended_relation_type"] =
    strategy === "advance" ? "variant" : "practice_generated"
  const reason_summary =
    strategy === "remedial"
      ? "当前薄弱点仍未收敛，建议先做低难度巩固题。"
      : strategy === "stabilize"
        ? "学习状态处于修复/稳定阶段，建议中低难度巩固变式。"
        : "近期表现稳定，可做更高难度迁移题。"
  const confidence = Number((0.55 + Math.min(0.35, input.attemptIndex * 0.05)).toFixed(2))
  return {
    strategy,
    recommended_difficulty,
    recommended_question_types,
    recommended_knowledge_points,
    recommended_relation_type,
    target_ability,
    avoid_patterns,
    prompt_hints,
    reason_summary,
    confidence,
    based_on_attempt_id: input.attemptID,
    based_on_attempt_index: input.attemptIndex,
    updated_at: input.now,
  } satisfies QuestionGenerationRecommendation
}

const FIRST_GRADING_PROMPT = [
  "你是题卡批改系统。输出 JSON，字段：grading_record, knowledge_profile。",
  "grading_record 字段：is_correct, score, diagnosis, mistake_type, careless_points, conceptual_errors, fixed_previous_errors, remaining_weaknesses, new_mistakes, comparison_with_previous_attempt, next_action_suggestion。",
  "knowledge_profile 字段：knowledge_points, knowledge_system_path, common_traps, confusing_points, solution_strategies, prerequisite_knowledge, difficulty_estimate。",
  "next_action_suggestion 不是复习建议，而是“下一道练习题如何生成”的约束说明。",
  "next_action_suggestion 必须优先保留原题题干中的核心主题锚点与题型结构，不得擅自替换原题中的并列核心概念。",
  "next_action_suggestion 禁止输出“复习某章节/某模块/某专题”这类泛化表述，必须直接说明下一题该保留什么主题、强化什么误区、控制什么难度与题型。",
  "next_action_suggestion 长度控制在 1 到 2 句，尽量短，不要写成长段教学解释。",
  "不要输出 markdown。",
].join("\n")

const REPEAT_GRADING_PROMPT = [
  "你是题卡批改系统。输出 JSON，字段仅 grading_record。",
  "grading_record 字段：is_correct, score, diagnosis, mistake_type, careless_points, conceptual_errors, fixed_previous_errors, remaining_weaknesses, new_mistakes, comparison_with_previous_attempt, next_action_suggestion。",
  "comparison_with_previous_attempt 必须给出“相较上一次作答”的明确评估结论（进步/退步/持平 + 原因）。",
  "next_action_suggestion 不是复习建议，而是“下一道练习题如何生成”的约束说明。",
  "next_action_suggestion 必须优先保留原题题干中的核心主题锚点与题型结构，不得擅自替换原题中的并列核心概念。",
  "next_action_suggestion 禁止输出“复习某章节/某模块/某专题”这类泛化表述，必须直接说明下一题该保留什么主题、强化什么误区、控制什么难度与题型。",
  "next_action_suggestion 长度控制在 1 到 2 句，尽量短，不要写成长段教学解释。",
  "不要输出 markdown。",
].join("\n")

const MONTHLY_COMPRESSION_PROMPT = [
  "你是学习档案压缩器。请把连续作答记录压缩为月度摘要。",
  "仅输出 JSON，字段：summary_text,key_weaknesses,progress_assessment,next_generation_strategy,risk_flags。",
  "summary_text 必须简洁，描述阶段性变化与结论。",
  "next_generation_strategy 应给出下一阶段出题建议。",
  "不要输出 markdown，不要输出额外解释。",
].join("\n")

const YEARLY_COMPRESSION_PROMPT = [
  "你是学习档案压缩器。请把多条月度摘要压缩为年度摘要。",
  "仅输出 JSON，字段：summary_text,yearly_trend,persistent_weaknesses,strategy_adjustments,next_year_focus。",
  "summary_text 需要概括全年学习轨迹，不要冗长。",
  "不要输出 markdown，不要输出额外解释。",
].join("\n")

type LearningSummaryRow = {
  id: string
  summary_level: "monthly" | "yearly"
  marker: string
  summary_period_json: string
  content_json: string
  source_count: number
  compressed_at: string
  compressed_by_model: string | null
  folded_in_summary_id: string | null
}

function normalizeSummaryLevel(value: string): "monthly" | "yearly" {
  return value === "yearly" ? "yearly" : "monthly"
}

async function maybeCompressLearningHistory(input: {
  userID: string
  workroomID: string
  problemCardID: string
  now: string
}) {
  const db = getLocalSqlite()
  const attempts = db
    .prepare(
      `SELECT attempt_index, answer_text, judgement, score_percent, reasoning, submitted_at
       FROM question_card_attempts
       WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id
       ORDER BY attempt_index ASC`,
    )
    .all({
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.problemCardID,
    }) as Array<Record<string, unknown>>
  const gradingByIndex = new Map<number, Record<string, unknown>>(
    (
      db
        .prepare(
          `SELECT attempt_index, diagnosis, mistake_type, remaining_weaknesses_json, new_mistakes_json, comparison_with_previous_attempt
           FROM question_card_grading_records
           WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`,
        )
        .all({
          user_id: input.userID,
          workroom_id: input.workroomID,
          card_id: input.problemCardID,
        }) as Array<Record<string, unknown>>
    ).map((row) => [Number(row.attempt_index), row]),
  )
  const summaries = db
    .prepare(
      `SELECT id, summary_level, marker, summary_period_json, content_json, source_count, compressed_at, compressed_by_model, folded_in_summary_id
       FROM question_card_learning_summaries
       WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id
       ORDER BY compressed_at ASC`,
    )
    .all({
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.problemCardID,
    }) as Array<LearningSummaryRow>

  const monthlySummaries = summaries.filter((item) => normalizeSummaryLevel(item.summary_level) === "monthly")
  const coveredAttemptMax = monthlySummaries.reduce((max, item) => {
    const period = parseJsonText<{ end_attempt_index?: number }>(item.summary_period_json, {})
    return Math.max(max, Number(period.end_attempt_index ?? 0))
  }, 0)
  const uncoveredAttempts = attempts.filter((item) => Number(item.attempt_index) > coveredAttemptMax)

  if (uncoveredAttempts.length >= 30) {
    const chunk = uncoveredAttempts.slice(0, 30)
    const startAttemptIndex = Number(chunk[0]?.attempt_index ?? 0)
    const endAttemptIndex = Number(chunk[chunk.length - 1]?.attempt_index ?? 0)
    const llmInput = chunk.map((item) => {
      const idx = Number(item.attempt_index)
      const grading = gradingByIndex.get(idx)
      return {
        attempt_index: idx,
        answer_text: String(item.answer_text ?? ""),
        judgement: String(item.judgement ?? "uncertain"),
        score_percent: Number(item.score_percent ?? 0),
        submitted_at: String(item.submitted_at ?? ""),
        diagnosis: grading ? String(grading.diagnosis ?? "") : null,
        mistake_type: grading ? (grading.mistake_type == null ? null : String(grading.mistake_type)) : null,
        remaining_weaknesses: grading ? parseJsonText(String(grading.remaining_weaknesses_json ?? "[]"), []) : [],
        new_mistakes: grading ? parseJsonText(String(grading.new_mistakes_json ?? "[]"), []) : [],
      }
    })
    const compressed = (await QuestionLlmService.chatJson({
      userID: input.userID,
      capability: "question_grading",
      system: MONTHLY_COMPRESSION_PROMPT,
      user: JSON.stringify({
        task: "monthly_learning_summary",
        card_id: input.problemCardID,
        attempt_range: { start_attempt_index: startAttemptIndex, end_attempt_index: endAttemptIndex },
        attempts: llmInput,
      }),
      temperature: 0.2,
      topP: 0.8,
      timeoutMs: 90_000,
      retries: 1,
    })) as Record<string, unknown>
    db.prepare(
      `INSERT INTO question_card_learning_summaries
       (id, user_id, workroom_id, card_id, summary_level, marker, summary_period_json, content_json, source_count, compressed_at, compressed_by_model, folded_in_summary_id, created_at, updated_at)
       VALUES
       (@id, @user_id, @workroom_id, @card_id, 'monthly', 'MONTHLY_COMPRESSED', @summary_period_json, @content_json, @source_count, @compressed_at, @compressed_by_model, NULL, @created_at, @updated_at)`,
    ).run({
      id: createID("learning_summary"),
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.problemCardID,
      summary_period_json: JSON.stringify({
        start_attempt_index: startAttemptIndex,
        end_attempt_index: endAttemptIndex,
      }),
      content_json: JSON.stringify({
        summary_text: String(compressed.summary_text ?? ""),
        key_weaknesses: Array.isArray(compressed.key_weaknesses) ? compressed.key_weaknesses : [],
        progress_assessment: compressed.progress_assessment ?? null,
        next_generation_strategy: compressed.next_generation_strategy ?? null,
        risk_flags: Array.isArray(compressed.risk_flags) ? compressed.risk_flags : [],
      }),
      source_count: chunk.length,
      compressed_at: input.now,
      compressed_by_model: null,
      created_at: input.now,
      updated_at: input.now,
    })
  }

  const latestMonthly = db
    .prepare(
      `SELECT id, summary_period_json, content_json, compressed_at
       FROM question_card_learning_summaries
       WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id AND summary_level='monthly' AND folded_in_summary_id IS NULL
       ORDER BY compressed_at ASC`,
    )
    .all({
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.problemCardID,
    }) as Array<{ id: string; summary_period_json: string; content_json: string; compressed_at: string }>

  if (latestMonthly.length >= 12) {
    const batch = latestMonthly.slice(0, 12)
    const firstPeriod = parseJsonText<{ start_attempt_index?: number }>(batch[0]!.summary_period_json, {})
    const lastPeriod = parseJsonText<{ end_attempt_index?: number }>(batch[batch.length - 1]!.summary_period_json, {})
    const compressed = (await QuestionLlmService.chatJson({
      userID: input.userID,
      capability: "question_grading",
      system: YEARLY_COMPRESSION_PROMPT,
      user: JSON.stringify({
        task: "yearly_learning_summary",
        card_id: input.problemCardID,
        monthly_summaries: batch.map((item) => ({
          id: item.id,
          period: parseJsonText(item.summary_period_json, {}),
          content: parseJsonText(item.content_json, {}),
          compressed_at: item.compressed_at,
        })),
      }),
      temperature: 0.2,
      topP: 0.8,
      timeoutMs: 90_000,
      retries: 1,
    })) as Record<string, unknown>
    const yearlyID = createID("learning_summary")
    db.prepare(
      `INSERT INTO question_card_learning_summaries
       (id, user_id, workroom_id, card_id, summary_level, marker, summary_period_json, content_json, source_count, compressed_at, compressed_by_model, folded_in_summary_id, created_at, updated_at)
       VALUES
       (@id, @user_id, @workroom_id, @card_id, 'yearly', 'YEARLY_COMPRESSED', @summary_period_json, @content_json, @source_count, @compressed_at, @compressed_by_model, NULL, @created_at, @updated_at)`,
    ).run({
      id: yearlyID,
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.problemCardID,
      summary_period_json: JSON.stringify({
        start_attempt_index: Number(firstPeriod.start_attempt_index ?? 0),
        end_attempt_index: Number(lastPeriod.end_attempt_index ?? 0),
      }),
      content_json: JSON.stringify({
        summary_text: String(compressed.summary_text ?? ""),
        yearly_trend: compressed.yearly_trend ?? null,
        persistent_weaknesses: Array.isArray(compressed.persistent_weaknesses) ? compressed.persistent_weaknesses : [],
        strategy_adjustments: compressed.strategy_adjustments ?? null,
        next_year_focus: compressed.next_year_focus ?? null,
      }),
      source_count: batch.length,
      compressed_at: input.now,
      compressed_by_model: null,
      created_at: input.now,
      updated_at: input.now,
    })
    for (const monthly of batch) {
      db.prepare(
        `UPDATE question_card_learning_summaries
         SET folded_in_summary_id=@folded_in_summary_id, updated_at=@updated_at
         WHERE id=@id`,
      ).run({
        id: monthly.id,
        folded_in_summary_id: yearlyID,
        updated_at: input.now,
      })
    }
  }
}

export const ProblemCardService = {
  async recordEvent(input: {
    userID: string
    workroomID: string
    problemCardID: string
    eventType: EventType
    payload?: Record<string, unknown>
  }) {
    const db = getLocalSqlite()
    db.prepare(
      `INSERT INTO question_card_study_events (id, user_id, workroom_id, card_id, event_type, payload_json, created_at)
       VALUES (@id, @user_id, @workroom_id, @card_id, @event_type, @payload_json, @created_at)`,
    ).run({
      id: createID("study_event"),
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.problemCardID,
      event_type: input.eventType,
      payload_json: JSON.stringify(input.payload ?? {}),
      created_at: nowIso(),
    })
  },

  async enterAnswerMode(input: { userID: string; workroomID: string; problemCardID: string }) {
    await this.recordEvent({
      ...input,
      eventType: "enter_answer_mode",
    })
    return this.getLearningDetail(input)
  },

  async addToStudio(input: { userID: string; workroomID: string; problemCardID: string }) {
    await this.recordEvent({
      ...input,
      eventType: "add_to_studio",
    })
    return { status: "ok" as const }
  },

  async finishReview(input: { userID: string; workroomID: string; problemCardID: string }) {
    await this.recordEvent({
      ...input,
      eventType: "finish_review",
    })
    const db = getLocalSqlite()
    const state = db
      .prepare(`SELECT * FROM question_card_learning_states WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Record<string, unknown> | null
    const now = nowIso()
    if (!state) {
      db.prepare(
        `INSERT INTO question_card_learning_states
         (id, user_id, workroom_id, card_id, mastery_level, total_attempts, correct_attempts, consecutive_correct_count, last_attempt_at, last_review_at, unresolved_weaknesses_json, repeated_mistakes_json, progress_signal, progress_summary, generation_recommendation_json, updated_at, created_at)
         VALUES (@id, @user_id, @workroom_id, @card_id, 'unknown', 0, 0, 0, NULL, @last_review_at, '[]', '[]', NULL, NULL, '{}', @updated_at, @created_at)`,
      ).run({
        id: createID("learning_state"),
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
        last_review_at: now,
        updated_at: now,
        created_at: now,
      })
    } else {
      db.prepare(
        `UPDATE question_card_learning_states
         SET last_review_at=@last_review_at, updated_at=@updated_at
         WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`,
      ).run({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
        last_review_at: now,
        updated_at: now,
      })
    }
    return this.getLearningDetail(input)
  },

  async submit(input: {
    userID: string
    workroomID: string
    problemCardID: string
    userAnswer: string
    inputSource: "option" | "text" | "mixed"
  }) {
    const db = getLocalSqlite()
    const card = db
      .prepare(`SELECT * FROM studio_question_cards WHERE user_id=@user_id AND workroom_id=@workroom_id AND id=@id`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        id: input.problemCardID,
      }) as Record<string, unknown> | null
    if (!card) throw new Error(`ProblemCard not found: ${input.problemCardID}`)
    const attemptCountRow = db
      .prepare(`SELECT COUNT(*) as count FROM question_card_attempts WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as { count: number }
    const attemptIndex = Number(attemptCountRow.count) + 1
    const attemptID = createID("question_card_attempt")
    const now = nowIso()

    db.prepare(
      `INSERT INTO question_card_attempts
      (id, user_id, workroom_id, card_id, studio_document_id, sequence_index, source_document_id, answer_text, attempt_index, judgement, predicted_answer, score_numerator, score_denominator, score_percent, grading_mode, reference_evidence_status, reasoning, submitted_at, created_at, updated_at)
      VALUES
      (@id, @user_id, @workroom_id, @card_id, @studio_document_id, @sequence_index, @source_document_id, @answer_text, @attempt_index, 'uncertain', NULL, 0, 1, 0, 'llm_freeform', @reference_evidence_status, NULL, @submitted_at, @created_at, @updated_at)`,
    ).run({
      id: attemptID,
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.problemCardID,
      studio_document_id: String(card.studio_document_id),
      sequence_index: Number(card.sequence_index),
      source_document_id: (card.source_document_id as string | null) ?? null,
      answer_text: input.userAnswer.trim(),
      attempt_index: attemptIndex,
      reference_evidence_status: parseJsonText<{ status?: string }>(String(card.answer_evidence_json ?? "{}"), {}).status ?? "missing",
      submitted_at: now,
      created_at: now,
      updated_at: now,
    })

    await this.recordEvent({
      userID: input.userID,
      workroomID: input.workroomID,
      problemCardID: input.problemCardID,
      eventType: "submit_answer",
      payload: {
        input_source: input.inputSource,
        attempt_index: attemptIndex,
      },
    })

    const latestGrading = db
      .prepare(`SELECT * FROM question_card_grading_records WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY created_at DESC LIMIT 1`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Record<string, unknown> | null
    const existingProfile = db
      .prepare(`SELECT * FROM question_card_knowledge_profiles WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY created_at ASC LIMIT 1`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Record<string, unknown> | null
    const weaknesses = db
      .prepare(`SELECT * FROM question_card_weaknesses WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>
    const attempts = db
      .prepare(`SELECT * FROM question_card_attempts WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY submitted_at DESC`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>

    const historySummary = {
      total_attempts: attempts.length,
      correct_attempts: attempts.filter((item) => String(item.judgement) === "correct").length,
      last_correct_at: attempts.find((item) => String(item.judgement) === "correct")?.submitted_at ?? null,
      repeated_mistake_types: Array.from(new Set(weaknesses.map((item) => String(item.category)).filter(Boolean))),
      unresolved_weaknesses: weaknesses.filter((item) => String(item.status) !== "resolved").map((item) => String(item.label)),
    }

    const requestPayload = existingProfile
      ? {
          task: "repeat_grading",
          problem: {
            question_text: String(card.text),
            options: [],
            reference_answer: String(card.canonical_answer ?? ""),
          },
          knowledge_profile: {
            knowledge_points: parseJsonText(String(existingProfile.knowledge_points_json ?? "[]"), []),
            knowledge_system_path: parseJsonText(String(existingProfile.knowledge_system_path_json ?? "[]"), []),
            common_traps: parseJsonText(String(existingProfile.common_traps_json ?? "[]"), []),
            confusing_points: parseJsonText(String(existingProfile.confusing_points_json ?? "[]"), []),
            solution_strategies: parseJsonText(String(existingProfile.solution_strategies_json ?? "[]"), []),
          },
          current_attempt: {
            attempt_index: attemptIndex,
            user_answer: input.userAnswer,
          },
          previous_grading_record: latestGrading
            ? {
                attempt_index: Number(latestGrading.attempt_index),
                diagnosis: String(latestGrading.diagnosis ?? ""),
                mistake_type: String(latestGrading.mistake_type ?? ""),
                remaining_weaknesses: parseJsonText(String(latestGrading.remaining_weaknesses_json ?? "[]"), []),
                next_action_suggestion: String(latestGrading.next_action_suggestion ?? ""),
              }
            : null,
          history_summary: historySummary,
          requirements: {
            compare_with_previous_attempt: true,
            detect_fixed_errors: true,
            detect_remaining_weaknesses: true,
            do_not_regenerate_knowledge_profile: true,
            next_action_suggestion_is_generation_instruction: true,
            preserve_original_topic_anchor: true,
            forbid_chapter_level_advice: true,
            keep_next_action_suggestion_brief: true,
          },
        }
      : {
          task: "first_grading_with_problem_enrichment",
          source: {
            document_id: String(card.source_document_id ?? ""),
            document_title: String(card.studio_document_id),
            page: Number(card.page),
            question_region: parseJsonText(String(card.source_selection_json ?? "{}"), {}),
          },
          problem: {
            question_text: String(card.text),
            options: [],
            reference_answer: String(card.canonical_answer ?? ""),
          },
          attempt: {
            attempt_index: attemptIndex,
            user_answer: input.userAnswer,
          },
          requirements: {
            grade_answer: true,
            generate_knowledge_profile: true,
            diagnose_mistake: true,
            next_action_suggestion_is_generation_instruction: true,
            preserve_original_topic_anchor: true,
            forbid_chapter_level_advice: true,
            keep_next_action_suggestion_brief: true,
          },
        }

    const llm = await QuestionLlmService.chatJson({
      userID: input.userID,
      capability: "question_grading",
      system: existingProfile ? REPEAT_GRADING_PROMPT : FIRST_GRADING_PROMPT,
      user: JSON.stringify(requestPayload),
      temperature: 0.2,
      topP: 0.8,
      timeoutMs: 90_000,
      retries: 1,
    })

    const grading = (llm.grading_record ?? llm) as Record<string, unknown>
    const isCorrect = typeof grading.is_correct === "boolean" ? grading.is_correct : null
    const score = grading.score === null || grading.score === undefined ? null : Number(grading.score)
    const diagnosis = String(grading.diagnosis ?? "")
    const mistakeType = grading.mistake_type == null ? null : String(grading.mistake_type)
    const careless = Array.isArray(grading.careless_points) ? grading.careless_points.map((item) => String(item)) : []
    const conceptual = Array.isArray(grading.conceptual_errors) ? grading.conceptual_errors.map((item) => String(item)) : []
    const fixed = Array.isArray(grading.fixed_previous_errors) ? grading.fixed_previous_errors.map((item) => String(item)) : []
    const remaining = Array.isArray(grading.remaining_weaknesses) ? grading.remaining_weaknesses.map((item) => String(item)) : []
    const newly = Array.isArray(grading.new_mistakes) ? grading.new_mistakes.map((item) => String(item)) : []
    const comparisonWithPreviousAttempt =
      grading.comparison_with_previous_attempt == null ? null : String(grading.comparison_with_previous_attempt).trim() || null
    const suggestion = grading.next_action_suggestion == null ? null : String(grading.next_action_suggestion)

    const gradingID = createID("grading_record")
    db.prepare(
      `INSERT INTO question_card_grading_records
      (id, user_id, workroom_id, card_id, attempt_id, attempt_index, is_correct, score, diagnosis, mistake_type, careless_points_json, conceptual_errors_json, fixed_previous_errors_json, remaining_weaknesses_json, new_mistakes_json, comparison_with_previous_attempt, next_action_suggestion, used_context_summary_json, llm_output_json, created_at, updated_at)
      VALUES
      (@id, @user_id, @workroom_id, @card_id, @attempt_id, @attempt_index, @is_correct, @score, @diagnosis, @mistake_type, @careless_points_json, @conceptual_errors_json, @fixed_previous_errors_json, @remaining_weaknesses_json, @new_mistakes_json, @comparison_with_previous_attempt, @next_action_suggestion, @used_context_summary_json, @llm_output_json, @created_at, @updated_at)`,
    ).run({
      id: gradingID,
      user_id: input.userID,
      workroom_id: input.workroomID,
      card_id: input.problemCardID,
      attempt_id: attemptID,
      attempt_index: attemptIndex,
      is_correct: isCorrect === null ? null : isCorrect ? 1 : 0,
      score,
      diagnosis,
      mistake_type: mistakeType,
      careless_points_json: JSON.stringify(careless),
      conceptual_errors_json: JSON.stringify(conceptual),
      fixed_previous_errors_json: JSON.stringify(fixed),
      remaining_weaknesses_json: JSON.stringify(remaining),
      new_mistakes_json: JSON.stringify(newly),
      comparison_with_previous_attempt: comparisonWithPreviousAttempt,
      next_action_suggestion: suggestion,
      used_context_summary_json: JSON.stringify(historySummary),
      llm_output_json: JSON.stringify(llm),
      created_at: now,
      updated_at: now,
    })

    db.prepare(
      `UPDATE question_card_attempts
       SET judgement=@judgement, predicted_answer=@predicted_answer, score_percent=@score_percent, reasoning=@reasoning, updated_at=@updated_at
       WHERE id=@id`,
    ).run({
      id: attemptID,
      judgement: isCorrect === null ? "uncertain" : isCorrect ? "correct" : "incorrect",
      predicted_answer: null,
      score_percent: score ?? (isCorrect === null ? 0 : isCorrect ? 100 : 0),
      reasoning: diagnosis,
      updated_at: now,
    })

    if (!existingProfile && llm.knowledge_profile && typeof llm.knowledge_profile === "object") {
      const profile = llm.knowledge_profile as Record<string, unknown>
      db.prepare(
        `INSERT INTO question_card_knowledge_profiles
        (id, user_id, workroom_id, card_id, knowledge_points_json, knowledge_system_path_json, common_traps_json, confusing_points_json, solution_strategies_json, prerequisite_knowledge_json, difficulty_estimate, generated_by_diagnosis_id, first_generated_at, version, created_at, updated_at)
        VALUES
        (@id, @user_id, @workroom_id, @card_id, @knowledge_points_json, @knowledge_system_path_json, @common_traps_json, @confusing_points_json, @solution_strategies_json, @prerequisite_knowledge_json, @difficulty_estimate, @generated_by_diagnosis_id, @first_generated_at, 1, @created_at, @updated_at)`,
      ).run({
        id: createID("knowledge_profile"),
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
        knowledge_points_json: JSON.stringify(Array.isArray(profile.knowledge_points) ? profile.knowledge_points : []),
        knowledge_system_path_json: JSON.stringify(Array.isArray(profile.knowledge_system_path) ? profile.knowledge_system_path : []),
        common_traps_json: JSON.stringify(Array.isArray(profile.common_traps) ? profile.common_traps : []),
        confusing_points_json: JSON.stringify(Array.isArray(profile.confusing_points) ? profile.confusing_points : []),
        solution_strategies_json: JSON.stringify(Array.isArray(profile.solution_strategies) ? profile.solution_strategies : []),
        prerequisite_knowledge_json: JSON.stringify(Array.isArray(profile.prerequisite_knowledge) ? profile.prerequisite_knowledge : []),
        difficulty_estimate: profile.difficulty_estimate == null ? null : String(profile.difficulty_estimate),
        generated_by_diagnosis_id: gradingID,
        first_generated_at: now,
        created_at: now,
        updated_at: now,
      })
    }
    const existingWeaknesses = db
      .prepare(`SELECT * FROM question_card_weaknesses WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>
    const fixedSet = new Set(fixed.map((item) => normalizeWeaknessKey(item)).filter(Boolean))
    const detectedByKey = dedupeWeaknessLabels([
      ...remaining,
      ...newly,
      ...conceptual,
      ...careless,
      ...(mistakeType ? [mistakeType] : []),
    ])
    for (const weakness of existingWeaknesses) {
      const key = normalizeWeaknessKey(String(weakness.weakness_key ?? "").trim())
      const label = String(weakness.label ?? "").trim()
      if (!key) continue
      if (!fixedSet.has(key) && !fixedSet.has(normalizeWeaknessKey(label))) continue
      db.prepare(
        `UPDATE question_card_weaknesses
         SET status='resolved',
             resolved_at=@resolved_at,
             updated_at=@updated_at,
             evidence_diagnosis_ids_json=@evidence_diagnosis_ids_json
         WHERE id=@id`,
      ).run({
        id: String(weakness.id),
        resolved_at: now,
        updated_at: now,
        evidence_diagnosis_ids_json: JSON.stringify(appendUniqueTextArray(String(weakness.evidence_diagnosis_ids_json ?? "[]"), gradingID)),
      })
    }
    for (const [normalizedWeaknessKey, weaknessLabel] of detectedByKey.entries()) {
      const existingWeakness = existingWeaknesses.find(
        (item) =>
          normalizeWeaknessKey(String(item.weakness_key ?? "").trim()) === normalizedWeaknessKey ||
          normalizeWeaknessKey(String(item.label ?? "").trim()) === normalizedWeaknessKey,
      )
      const nextStatus =
        existingWeakness && String(existingWeakness.status) === "resolved"
          ? "relapsed"
          : isCorrect === true
            ? "improving"
            : "open"
      if (existingWeakness) {
        db.prepare(
          `UPDATE question_card_weaknesses
           SET weakness_key=@weakness_key,
               label=@label,
               category=@category,
               status=@status,
               count=@count,
               last_seen_at=@last_seen_at,
               resolved_at=@resolved_at,
               evidence_attempt_ids_json=@evidence_attempt_ids_json,
               evidence_diagnosis_ids_json=@evidence_diagnosis_ids_json,
               updated_at=@updated_at
           WHERE id=@id`,
        ).run({
          id: String(existingWeakness.id),
          label: weaknessLabel,
          weakness_key: normalizedWeaknessKey,
          category: toRootCause(mistakeType),
          status: nextStatus,
          count: Number(existingWeakness.count ?? 0) + 1,
          last_seen_at: now,
          resolved_at: null,
          evidence_attempt_ids_json: JSON.stringify(appendUniqueTextArray(String(existingWeakness.evidence_attempt_ids_json ?? "[]"), attemptID)),
          evidence_diagnosis_ids_json: JSON.stringify(appendUniqueTextArray(String(existingWeakness.evidence_diagnosis_ids_json ?? "[]"), gradingID)),
          updated_at: now,
        })
        continue
      }
      db.prepare(
        `INSERT INTO question_card_weaknesses
        (id, user_id, workroom_id, card_id, weakness_key, label, category, status, severity, count, first_seen_at, last_seen_at, resolved_at, evidence_attempt_ids_json, evidence_diagnosis_ids_json, created_at, updated_at)
        VALUES
        (@id, @user_id, @workroom_id, @card_id, @weakness_key, @label, @category, @status, 'medium', 1, @first_seen_at, @last_seen_at, @resolved_at, @evidence_attempt_ids_json, @evidence_diagnosis_ids_json, @created_at, @updated_at)`,
      ).run({
        id: createID("question_card_weakness"),
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
        weakness_key: normalizedWeaknessKey,
        label: weaknessLabel,
        category: toRootCause(mistakeType),
        status: nextStatus,
        first_seen_at: now,
        last_seen_at: now,
        resolved_at: null,
        evidence_attempt_ids_json: JSON.stringify([attemptID]),
        evidence_diagnosis_ids_json: JSON.stringify([gradingID]),
        created_at: now,
        updated_at: now,
      })
    }

    const attemptsAfter = db
      .prepare(`SELECT * FROM question_card_attempts WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY submitted_at DESC`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>
    const correctAttempts = attemptsAfter.filter((item) => String(item.judgement) === "correct").length
    let consecutive = 0
    for (const item of attemptsAfter) {
      if (String(item.judgement) === "correct") consecutive += 1
      else break
    }
    const unresolvedWeaknesses = db
      .prepare(`SELECT label FROM question_card_weaknesses WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id AND status!='resolved'`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<{ label: string }>
    const repeatedMistakes = db
      .prepare(`SELECT category FROM question_card_weaknesses WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id AND count>=2`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<{ category: string }>
    const previousAttempt = attemptsAfter[1] ?? null
    const progress = computeProgressSnapshot({
      attemptIndex,
      isCorrect,
      comparisonWithPreviousAttempt,
      fixedPreviousErrors: fixed,
      remainingWeaknesses: remaining,
      newMistakes: newly,
      previousAnswerText: previousAttempt ? String(previousAttempt.answer_text ?? "") : null,
      currentAnswerText: input.userAnswer,
      previousJudgement: previousAttempt ? String(previousAttempt.judgement ?? "") : null,
    })
    const mastery = computeMasterySnapshot({
      totalAttempts: attemptsAfter.length,
      correctAttempts,
      consecutiveCorrectCount: consecutive,
      unresolvedWeaknesses: unresolvedWeaknesses.map((item) => item.label),
      repeatedMistakeCount: Array.from(new Set(repeatedMistakes.map((item) => item.category))).length,
      duplicateRecentAnswer: progress.duplicateRecentAnswer,
      lastAttemptAt: (attemptsAfter[0]?.submitted_at as string | undefined) ?? null,
    })
    const stateExisting = db
      .prepare(`SELECT id FROM question_card_learning_states WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as { id: string } | null
    if (!stateExisting) {
      db.prepare(
        `INSERT INTO question_card_learning_states
        (id, user_id, workroom_id, card_id, mastery_level, total_attempts, correct_attempts, consecutive_correct_count, last_attempt_at, last_review_at, unresolved_weaknesses_json, repeated_mistakes_json, progress_signal, progress_summary, generation_recommendation_json, updated_at, created_at)
        VALUES
        (@id, @user_id, @workroom_id, @card_id, @mastery_level, @total_attempts, @correct_attempts, @consecutive_correct_count, @last_attempt_at, @last_review_at, @unresolved_weaknesses_json, @repeated_mistakes_json, @progress_signal, @progress_summary, @generation_recommendation_json, @updated_at, @created_at)`,
      ).run({
        ...(() => {
          const recommendation = buildGenerationRecommendation({
            now,
            attemptID,
            attemptIndex,
            masteryLevel: mastery.masteryLevel,
            progressSignal: progress.signal,
            unresolvedWeaknesses: unresolvedWeaknesses.map((item) => item.label),
            repeatedMistakes: Array.from(new Set(repeatedMistakes.map((item) => item.category))),
            knowledgePoints: Array.isArray((llm as any)?.knowledge_profile?.knowledge_points)
              ? ((llm as any).knowledge_profile.knowledge_points as unknown[]).map((item) => String(item).trim()).filter(Boolean)
              : [],
            mistakeType,
          })
          return { generation_recommendation_json: JSON.stringify(recommendation) }
        })(),
        id: createID("learning_state"),
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
        mastery_level: mastery.masteryLevel,
        total_attempts: attemptsAfter.length,
        correct_attempts: correctAttempts,
        consecutive_correct_count: consecutive,
        last_attempt_at: attemptsAfter[0]?.submitted_at ?? null,
        last_review_at: now,
        unresolved_weaknesses_json: JSON.stringify(unresolvedWeaknesses.map((item) => item.label)),
        repeated_mistakes_json: JSON.stringify(Array.from(new Set(repeatedMistakes.map((item) => item.category)))),
        progress_signal: progress.signal,
        progress_summary: progress.summary,
        updated_at: now,
        created_at: now,
      })
    } else {
      db.prepare(
        `UPDATE question_card_learning_states
         SET mastery_level=@mastery_level, total_attempts=@total_attempts, correct_attempts=@correct_attempts, consecutive_correct_count=@consecutive_correct_count, last_attempt_at=@last_attempt_at, last_review_at=@last_review_at, unresolved_weaknesses_json=@unresolved_weaknesses_json, repeated_mistakes_json=@repeated_mistakes_json, progress_signal=@progress_signal, progress_summary=@progress_summary, generation_recommendation_json=@generation_recommendation_json, updated_at=@updated_at
         WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`,
      ).run({
        ...(() => {
          const recommendation = buildGenerationRecommendation({
            now,
            attemptID,
            attemptIndex,
            masteryLevel: mastery.masteryLevel,
            progressSignal: progress.signal,
            unresolvedWeaknesses: unresolvedWeaknesses.map((item) => item.label),
            repeatedMistakes: Array.from(new Set(repeatedMistakes.map((item) => item.category))),
            knowledgePoints: Array.isArray((llm as any)?.knowledge_profile?.knowledge_points)
              ? ((llm as any).knowledge_profile.knowledge_points as unknown[]).map((item) => String(item).trim()).filter(Boolean)
              : [],
            mistakeType,
          })
          return { generation_recommendation_json: JSON.stringify(recommendation) }
        })(),
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
        mastery_level: mastery.masteryLevel,
        total_attempts: attemptsAfter.length,
        correct_attempts: correctAttempts,
        consecutive_correct_count: consecutive,
        last_attempt_at: attemptsAfter[0]?.submitted_at ?? null,
        last_review_at: now,
        unresolved_weaknesses_json: JSON.stringify(unresolvedWeaknesses.map((item) => item.label)),
        repeated_mistakes_json: JSON.stringify(Array.from(new Set(repeatedMistakes.map((item) => item.category)))),
        progress_signal: progress.signal,
        progress_summary: progress.summary,
        updated_at: now,
      })
    }

    try {
      await maybeCompressLearningHistory({
        userID: input.userID,
        workroomID: input.workroomID,
        problemCardID: input.problemCardID,
        now,
      })
    } catch {
      // Keep grading flow successful even if compression fails; retry can happen on next submit.
    }

    return this.getLearningDetail({
      userID: input.userID,
      workroomID: input.workroomID,
      problemCardID: input.problemCardID,
    })
  },

  async getLearningDetail(input: { userID: string; workroomID: string; problemCardID: string; full?: boolean }) {
    const db = getLocalSqlite()
    const card = db
      .prepare(`SELECT * FROM studio_question_cards WHERE user_id=@user_id AND workroom_id=@workroom_id AND id=@id`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        id: input.problemCardID,
      }) as Record<string, unknown> | null
    if (!card) throw new Error(`ProblemCard not found: ${input.problemCardID}`)
    const studioDocument = db
      .prepare(`SELECT * FROM studio_documents WHERE user_id=@user_id AND workroom_id=@workroom_id AND id=@id`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        id: String(card.studio_document_id),
      }) as Record<string, unknown> | null
    const knowledgeProfile = db
      .prepare(`SELECT * FROM question_card_knowledge_profiles WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY created_at ASC LIMIT 1`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Record<string, unknown> | null
    const learningState = db
      .prepare(`SELECT * FROM question_card_learning_states WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Record<string, unknown> | null
    const latestGrading = db
      .prepare(`SELECT * FROM question_card_grading_records WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY created_at DESC LIMIT 1`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Record<string, unknown> | null
    const attempts = db
      .prepare(`SELECT * FROM question_card_attempts WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY submitted_at DESC`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>
    const gradingRecords = db
      .prepare(`SELECT * FROM question_card_grading_records WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY created_at DESC`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>
    const weaknesses = db
      .prepare(`SELECT * FROM question_card_weaknesses WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY updated_at DESC`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>
    const events = db
      .prepare(`SELECT * FROM question_card_study_events WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id ORDER BY created_at DESC`)
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>
    const gradingCount = db
      .prepare(`SELECT COUNT(*) as count FROM question_card_grading_records WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as { count: number }
    const reviewCount = db
      .prepare(`SELECT COUNT(*) as count FROM question_card_study_events WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id AND event_type IN ('submit_answer','finish_review')`)
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as { count: number }
    const reviewHeatmap180d = buildReviewHeatmap180d(attempts.map((item) => String(item.submitted_at)))
    const summaries = db
      .prepare(
        `SELECT summary_level, marker, summary_period_json, content_json, source_count, compressed_at, folded_in_summary_id
         FROM question_card_learning_summaries
         WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id
         ORDER BY compressed_at DESC`,
      )
      .all({
        user_id: input.userID,
        workroom_id: input.workroomID,
        card_id: input.problemCardID,
      }) as Array<Record<string, unknown>>

    const repeatedMistakesList = learningState
      ? parseJsonText(String(learningState.repeated_mistakes_json ?? "[]"), [])
      : []
    const unresolvedWeaknessList = learningState
      ? Array.from(dedupeWeaknessLabels(parseJsonText(String(learningState.unresolved_weaknesses_json ?? "[]"), [])).values())
      : []
    const duplicateRecentAnswer =
      attempts.length >= 2 &&
      String(attempts[0]?.answer_text ?? "").trim() !== "" &&
      String(attempts[0]?.answer_text ?? "").trim() === String(attempts[1]?.answer_text ?? "").trim()
    const masteryFromState = computeMasterySnapshot({
      totalAttempts: Number(learningState?.total_attempts ?? 0),
      correctAttempts: Number(learningState?.correct_attempts ?? 0),
      consecutiveCorrectCount: Number(learningState?.consecutive_correct_count ?? 0),
      unresolvedWeaknesses: unresolvedWeaknessList,
      repeatedMistakeCount: Array.isArray(repeatedMistakesList) ? repeatedMistakesList.length : 0,
      duplicateRecentAnswer,
      lastAttemptAt: (learningState?.last_attempt_at as string | undefined) ?? null,
    })

    const base = {
      problemCard: {
        id: String(card.id),
        source_document_id: String(card.source_document_id ?? ""),
        source_document_title: String(studioDocument?.title ?? card.studio_document_id),
        source_page: Number(card.page),
        source_region: parseJsonText(String(card.source_selection_json ?? "{}"), {}),
        question_text: String(card.text),
        options: [],
        reference_answer_ref: parseJsonText(String(card.answer_evidence_json ?? "{}"), {}),
        created_at: String(card.created_at),
        updated_at: String(card.updated_at),
      },
      knowledgeProfile: knowledgeProfile
        ? {
            problem_card_id: String(knowledgeProfile.card_id),
            knowledge_points: parseJsonText(String(knowledgeProfile.knowledge_points_json ?? "[]"), []),
            knowledge_system_path: parseJsonText(String(knowledgeProfile.knowledge_system_path_json ?? "[]"), []),
            common_traps: parseJsonText(String(knowledgeProfile.common_traps_json ?? "[]"), []),
            confusing_points: parseJsonText(String(knowledgeProfile.confusing_points_json ?? "[]"), []),
            solution_strategies: parseJsonText(String(knowledgeProfile.solution_strategies_json ?? "[]"), []),
            prerequisite_knowledge: parseJsonText(String(knowledgeProfile.prerequisite_knowledge_json ?? "[]"), []),
            difficulty_estimate: knowledgeProfile.difficulty_estimate ?? null,
            generated_by_grading_record_id: knowledgeProfile.generated_by_diagnosis_id ?? null,
            first_generated_at: String(knowledgeProfile.first_generated_at),
            version: Number(knowledgeProfile.version ?? 1),
          }
        : null,
      learningState: learningState
        ? {
            problem_card_id: String(learningState.card_id),
            mastery_level: String(learningState.mastery_level || masteryFromState.masteryLevel),
            mastery_score: masteryFromState.masteryScore,
            total_attempts: Number(learningState.total_attempts ?? 0),
            correct_attempts: Number(learningState.correct_attempts ?? 0),
            consecutive_correct_count: Number(learningState.consecutive_correct_count ?? 0),
            last_attempt_at: learningState.last_attempt_at ?? null,
            last_review_at: learningState.last_review_at ?? null,
            unresolved_weaknesses: unresolvedWeaknessList,
            repeated_mistakes: repeatedMistakesList,
            progress_signal: learningState.progress_signal == null ? null : String(learningState.progress_signal),
            progress_summary: learningState.progress_summary == null ? null : String(learningState.progress_summary),
            generation_recommendation: parseJsonText(String(learningState.generation_recommendation_json ?? "{}"), {}),
            updated_at: String(learningState.updated_at),
          }
        : null,
      gradingRecords: gradingRecords.map((record) => ({
        id: String(record.id),
        attempt_id: String(record.attempt_id),
        attempt_index: Number(record.attempt_index),
        is_correct: record.is_correct === null ? null : Number(record.is_correct) === 1,
        score: record.score === null ? null : Number(record.score),
        diagnosis: String(record.diagnosis ?? ""),
        mistake_type: record.mistake_type == null ? null : String(record.mistake_type),
        careless_points: parseJsonText(String(record.careless_points_json ?? "[]"), []),
        conceptual_errors: parseJsonText(String(record.conceptual_errors_json ?? "[]"), []),
        fixed_previous_errors: parseJsonText(String(record.fixed_previous_errors_json ?? "[]"), []),
        remaining_weaknesses: parseJsonText(String(record.remaining_weaknesses_json ?? "[]"), []),
        new_mistakes: parseJsonText(String(record.new_mistakes_json ?? "[]"), []),
        comparison_with_previous_attempt:
          record.comparison_with_previous_attempt == null ? null : String(record.comparison_with_previous_attempt),
        next_action_suggestion: record.next_action_suggestion == null ? null : String(record.next_action_suggestion),
        used_context_summary: parseJsonText(String(record.used_context_summary_json ?? "{}"), {}),
        created_at: String(record.created_at),
      })),
      latestGradingRecord: latestGrading
        ? {
            id: String(latestGrading.id),
            attempt_id: String(latestGrading.attempt_id),
            attempt_index: Number(latestGrading.attempt_index),
            is_correct: latestGrading.is_correct === null ? null : Number(latestGrading.is_correct) === 1,
            score: latestGrading.score === null ? null : Number(latestGrading.score),
            diagnosis: String(latestGrading.diagnosis ?? ""),
            mistake_type: latestGrading.mistake_type ?? null,
            careless_points: parseJsonText(String(latestGrading.careless_points_json ?? "[]"), []),
            conceptual_errors: parseJsonText(String(latestGrading.conceptual_errors_json ?? "[]"), []),
            fixed_previous_errors: parseJsonText(String(latestGrading.fixed_previous_errors_json ?? "[]"), []),
            remaining_weaknesses: parseJsonText(String(latestGrading.remaining_weaknesses_json ?? "[]"), []),
            new_mistakes: parseJsonText(String(latestGrading.new_mistakes_json ?? "[]"), []),
            comparison_with_previous_attempt:
              latestGrading.comparison_with_previous_attempt == null
                ? null
                : String(latestGrading.comparison_with_previous_attempt),
            next_action_suggestion: latestGrading.next_action_suggestion ?? null,
            used_context_summary: parseJsonText(String(latestGrading.used_context_summary_json ?? "{}"), {}),
            created_at: String(latestGrading.created_at),
          }
        : null,
      attempts: attempts.map((attempt) => ({
        id: String(attempt.id),
        attempt_index: Number(attempt.attempt_index ?? 1),
        user_answer: String(attempt.answer_text ?? ""),
        judgement: String(attempt.judgement ?? "uncertain"),
        predicted_answer: attempt.predicted_answer == null ? null : String(attempt.predicted_answer),
        score_percent: Number(attempt.score_percent ?? 0),
        reasoning: attempt.reasoning == null ? null : String(attempt.reasoning),
        submitted_at: String(attempt.submitted_at),
      })),
      weaknesses: (() => {
        const merged = new Map<string, {
          id: string
          weakness_key: string
          label: string
          category: string
          status: string
          severity: string
          count: number
          first_seen_at: string
          last_seen_at: string
          resolved_at: string | null
        }>()
        for (const weakness of weaknesses) {
          const label = String(weakness.label ?? "")
          const storedKey = String(weakness.weakness_key ?? "")
          const canonicalKey = normalizeWeaknessKey(storedKey || label)
          if (!canonicalKey) continue
          const current = {
            id: String(weakness.id),
            weakness_key: canonicalKey,
            label,
            category: String(weakness.category),
            status: String(weakness.status),
            severity: String(weakness.severity),
            count: Number(weakness.count ?? 0),
            first_seen_at: String(weakness.first_seen_at),
            last_seen_at: String(weakness.last_seen_at),
            resolved_at: weakness.resolved_at == null ? null : String(weakness.resolved_at),
          }
          const existing = merged.get(canonicalKey)
          if (!existing) {
            merged.set(canonicalKey, current)
            continue
          }
          existing.count += current.count
          if (current.label.length > existing.label.length) existing.label = current.label
          if (current.last_seen_at > existing.last_seen_at) existing.last_seen_at = current.last_seen_at
          if (current.first_seen_at < existing.first_seen_at) existing.first_seen_at = current.first_seen_at
          if (!existing.resolved_at && current.resolved_at) existing.resolved_at = current.resolved_at
        }
        return Array.from(merged.values()).sort((a, b) => b.count - a.count || b.last_seen_at.localeCompare(a.last_seen_at))
      })(),
      reviewHeatmap180d,
      attemptStats: {
        total_attempts: attempts.length,
      },
      reviewStats: {
        review_count: Number(reviewCount.count ?? 0),
        grading_count: Number(gradingCount.count ?? 0),
      },
      timelineEvents: events.map((item) => ({
        id: String(item.id),
        event_type: String(item.event_type),
        payload: parseJsonText(String(item.payload_json ?? "{}"), {}),
        created_at: String(item.created_at),
      })),
    }
    const compact = {
      problemCard: base.problemCard,
      knowledgeProfile: base.knowledgeProfile,
      currentState: base.learningState,
      latestGradingRecord: base.latestGradingRecord,
      raw_recent_attempts: base.attempts.slice(0, 5),
      weaknesses: base.weaknesses,
      summaries: {
        monthly_summaries: summaries
          .filter((item) => String(item.summary_level) === "monthly")
          .map((item) => ({
            summary_level: "monthly",
            marker: String(item.marker ?? "MONTHLY_COMPRESSED"),
            summary_period: parseJsonText(String(item.summary_period_json ?? "{}"), {}),
            content: parseJsonText(String(item.content_json ?? "{}"), {}),
            source_count: Number(item.source_count ?? 0),
            compressed_at: String(item.compressed_at ?? ""),
            folded_in_summary_id: item.folded_in_summary_id == null ? null : String(item.folded_in_summary_id),
          })),
        yearly_summaries: summaries
          .filter((item) => String(item.summary_level) === "yearly")
          .map((item) => ({
            summary_level: "yearly",
            marker: String(item.marker ?? "YEARLY_COMPRESSED"),
            summary_period: parseJsonText(String(item.summary_period_json ?? "{}"), {}),
            content: parseJsonText(String(item.content_json ?? "{}"), {}),
            source_count: Number(item.source_count ?? 0),
            compressed_at: String(item.compressed_at ?? ""),
          })),
      },
      attemptStats: base.attemptStats,
      reviewStats: base.reviewStats,
    }
    return input.full ? base : compact
  },
}
