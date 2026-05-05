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

const FIRST_GRADING_PROMPT = [
  "你是题卡批改系统。输出 JSON，字段：grading_record, knowledge_profile。",
  "grading_record 字段：is_correct, score, diagnosis, mistake_type, careless_points, conceptual_errors, fixed_previous_errors, remaining_weaknesses, new_mistakes, comparison_with_previous_attempt, next_action_suggestion。",
  "knowledge_profile 字段：knowledge_points, knowledge_system_path, common_traps, confusing_points, solution_strategies, prerequisite_knowledge, difficulty_estimate。",
  "不要输出 markdown。",
].join("\n")

const REPEAT_GRADING_PROMPT = [
  "你是题卡批改系统。输出 JSON，字段仅 grading_record。",
  "grading_record 字段：is_correct, score, diagnosis, mistake_type, careless_points, conceptual_errors, fixed_previous_errors, remaining_weaknesses, new_mistakes, comparison_with_previous_attempt, next_action_suggestion。",
  "comparison_with_previous_attempt 必须给出“相较上一次作答”的明确评估结论（进步/退步/持平 + 原因）。",
  "不要输出 markdown。",
].join("\n")

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
         (id, user_id, workroom_id, card_id, mastery_level, total_attempts, correct_attempts, consecutive_correct_count, last_attempt_at, last_review_at, unresolved_weaknesses_json, repeated_mistakes_json, progress_signal, progress_summary, updated_at, created_at)
         VALUES (@id, @user_id, @workroom_id, @card_id, 'unknown', 0, 0, 0, NULL, @last_review_at, '[]', '[]', NULL, NULL, @updated_at, @created_at)`,
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
    const fixedSet = new Set(fixed.map((item) => item.trim()).filter(Boolean))
    const detectedLabels = Array.from(
      new Set(
        [...remaining, ...newly, ...conceptual, ...careless, ...(mistakeType ? [mistakeType] : [])]
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    )
    for (const weakness of existingWeaknesses) {
      const key = String(weakness.weakness_key ?? "").trim()
      const label = String(weakness.label ?? "").trim()
      if (!key) continue
      if (!fixedSet.has(key) && !fixedSet.has(label)) continue
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
    for (const weaknessLabel of detectedLabels) {
      const existingWeakness = existingWeaknesses.find(
        (item) =>
          String(item.weakness_key ?? "").trim() === weaknessLabel ||
          String(item.label ?? "").trim() === weaknessLabel,
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
           SET label=@label,
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
        weakness_key: weaknessLabel,
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
        (id, user_id, workroom_id, card_id, mastery_level, total_attempts, correct_attempts, consecutive_correct_count, last_attempt_at, last_review_at, unresolved_weaknesses_json, repeated_mistakes_json, progress_signal, progress_summary, updated_at, created_at)
        VALUES
        (@id, @user_id, @workroom_id, @card_id, @mastery_level, @total_attempts, @correct_attempts, @consecutive_correct_count, @last_attempt_at, @last_review_at, @unresolved_weaknesses_json, @repeated_mistakes_json, @progress_signal, @progress_summary, @updated_at, @created_at)`,
      ).run({
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
         SET mastery_level=@mastery_level, total_attempts=@total_attempts, correct_attempts=@correct_attempts, consecutive_correct_count=@consecutive_correct_count, last_attempt_at=@last_attempt_at, last_review_at=@last_review_at, unresolved_weaknesses_json=@unresolved_weaknesses_json, repeated_mistakes_json=@repeated_mistakes_json, progress_signal=@progress_signal, progress_summary=@progress_summary, updated_at=@updated_at
         WHERE user_id=@user_id AND workroom_id=@workroom_id AND card_id=@card_id`,
      ).run({
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

    return this.getLearningDetail({
      userID: input.userID,
      workroomID: input.workroomID,
      problemCardID: input.problemCardID,
    })
  },

  async getLearningDetail(input: { userID: string; workroomID: string; problemCardID: string }) {
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

    const repeatedMistakesList = learningState
      ? parseJsonText(String(learningState.repeated_mistakes_json ?? "[]"), [])
      : []
    const unresolvedWeaknessList = learningState
      ? parseJsonText(String(learningState.unresolved_weaknesses_json ?? "[]"), [])
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

    return {
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
      weaknesses: weaknesses.map((weakness) => ({
        id: String(weakness.id),
        weakness_key: String(weakness.weakness_key),
        label: String(weakness.label),
        category: String(weakness.category),
        status: String(weakness.status),
        severity: String(weakness.severity),
        count: Number(weakness.count ?? 0),
        first_seen_at: String(weakness.first_seen_at),
        last_seen_at: String(weakness.last_seen_at),
        resolved_at: weakness.resolved_at == null ? null : String(weakness.resolved_at),
      })),
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
  },
}
