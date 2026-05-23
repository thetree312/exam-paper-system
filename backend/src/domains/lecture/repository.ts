import { createID } from "../../lib/ids"
import { getLocalSqlite, parseJsonText } from "../../lib/local-sqlite"
import type {
  LectureBlockRecord,
  LectureHighlightSpan,
  LectureSessionRecord,
  LectureSessionStatus,
  LectureSummaryHandback,
  LectureSummaryStatus,
} from "./types"

function parseHighlightSpans(raw: string): LectureHighlightSpan[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => ({
        sourceId: String(item?.sourceId ?? "").trim(),
        quote: String(item?.quote ?? "").trim(),
      }))
      .filter((item): item is LectureHighlightSpan => Boolean(item.sourceId && item.quote))
  } catch {
    return []
  }
}

function mapLectureSession(row: Record<string, unknown>): LectureSessionRecord {
  return {
    id: String(row.id),
    userID: String(row.user_id),
    workroomID: String(row.workroom_id),
    studioDocumentID: String(row.studio_document_id),
    cardID: String(row.card_id),
    originAgentSessionID: row.origin_agent_session_id == null ? null : String(row.origin_agent_session_id),
    lectureAgentSessionID: row.lecture_agent_session_id == null ? null : String(row.lecture_agent_session_id),
    originMessageID: row.origin_message_id == null ? null : String(row.origin_message_id),
    status: String(row.status) as LectureSessionStatus,
    resumeCursor: Number(row.resume_cursor ?? 0),
    projectedChildMessageCount: Number(row.projected_child_message_count ?? 0),
    lastBlockID: row.last_block_id == null ? null : String(row.last_block_id),
    activeHighlightSpans: parseHighlightSpans(String(row.active_highlight_targets_json ?? "[]")),
    visualizationHTML: row.visualization_html == null ? null : String(row.visualization_html),
    questionPromptJSON: row.question_prompt_json == null ? null : String(row.question_prompt_json),
    summaryStatus: String(row.summary_status ?? "pending") as LectureSummaryStatus,
    summary: parseJsonText<LectureSummaryHandback | null>(String(row.summary_json ?? "null"), null),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapLectureBlock(row: Record<string, unknown>): LectureBlockRecord {
  return {
    id: String(row.id),
    sessionID: String(row.session_id),
    role: String(row.role) as LectureBlockRecord["role"],
    text: String(row.text ?? ""),
    highlightSpans: parseHighlightSpans(String(row.highlight_targets_json ?? "[]")),
    pauseAfter: Number(row.pause_after ?? 0) === 1,
    createdAt: String(row.created_at),
  }
}

export const LectureRepository = {
  async createSession(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    cardID: string
    originAgentSessionID?: string | null
      originMessageID?: string | null
      status: LectureSessionStatus
  }) {
    const db = getLocalSqlite()
    const now = new Date().toISOString()
    const id = createID("lecture_session")
    db.prepare(
      `INSERT INTO lecture_sessions
        (id, user_id, workroom_id, studio_document_id, card_id, origin_agent_session_id, lecture_agent_session_id, origin_message_id, status, resume_cursor, projected_child_message_count, last_block_id, active_highlight_targets_json, visualization_html, summary_status, summary_json, closed_at, completed_at, archived_at, created_at, updated_at)
       VALUES
        (@id, @user_id, @workroom_id, @studio_document_id, @card_id, @origin_agent_session_id, NULL, @origin_message_id, @status, 0, 0, NULL, '[]', NULL, 'pending', 'null', NULL, NULL, NULL, @created_at, @updated_at)`,
    ).run({
      id,
      user_id: input.userID,
      workroom_id: input.workroomID,
      studio_document_id: input.studioDocumentID,
      card_id: input.cardID,
      origin_agent_session_id: input.originAgentSessionID ?? null,
      origin_message_id: input.originMessageID ?? null,
      status: input.status,
      created_at: now,
      updated_at: now,
    })
    return this.getSessionByID(input.userID, input.workroomID, id)
  },

  async getSessionByID(userID: string, workroomID: string, lectureSessionID: string) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT * FROM lecture_sessions
         WHERE id = @id AND user_id = @user_id AND workroom_id = @workroom_id
         LIMIT 1`,
      )
      .get({
        id: lectureSessionID,
        user_id: userID,
        workroom_id: workroomID,
      }) as Record<string, unknown> | null
    return row ? mapLectureSession(row) : null
  },

  async findSessionByLectureAgentSessionID(input: {
    userID: string
    workroomID: string
    lectureAgentSessionID: string
  }) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT *
           FROM lecture_sessions
          WHERE user_id = @user_id
            AND workroom_id = @workroom_id
            AND lecture_agent_session_id = @lecture_agent_session_id
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        lecture_agent_session_id: input.lectureAgentSessionID,
      }) as Record<string, unknown> | null
    return row ? mapLectureSession(row) : null
  },

  async findSessionByOriginAgentSessionAndIDSuffix(input: {
    userID: string
    workroomID: string
    originAgentSessionID: string
    lectureSessionIDSuffix: string
  }) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT *
           FROM lecture_sessions
          WHERE user_id = @user_id
            AND workroom_id = @workroom_id
            AND origin_agent_session_id = @origin_agent_session_id
            AND id LIKE @id_suffix
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        origin_agent_session_id: input.originAgentSessionID,
        id_suffix: `%${input.lectureSessionIDSuffix}`,
      }) as Record<string, unknown> | null
    return row ? mapLectureSession(row) : null
  },

  async findMostRecentSessionByOriginAgentSessionID(input: {
    userID: string
    workroomID: string
    originAgentSessionID: string
  }) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT *
           FROM lecture_sessions
          WHERE user_id = @user_id
            AND workroom_id = @workroom_id
            AND origin_agent_session_id = @origin_agent_session_id
            AND status IN ('idle', 'running', 'paused_for_question', 'answering')
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        origin_agent_session_id: input.originAgentSessionID,
      }) as Record<string, unknown> | null
    return row ? mapLectureSession(row) : null
  },

  async findRecoverableSession(input: {
    userID: string
    workroomID: string
    studioDocumentID: string
    cardID: string
    originAgentSessionID?: string | null
    originMessageID?: string | null
  }) {
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `SELECT * FROM lecture_sessions
         WHERE user_id = @user_id
           AND workroom_id = @workroom_id
           AND studio_document_id = @studio_document_id
           AND card_id = @card_id
           AND COALESCE(origin_agent_session_id, '') = COALESCE(@origin_agent_session_id, '')
           AND COALESCE(origin_message_id, '') = COALESCE(@origin_message_id, '')
           AND status IN ('idle', 'running', 'paused_for_question', 'answering')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get({
        user_id: input.userID,
        workroom_id: input.workroomID,
        studio_document_id: input.studioDocumentID,
        card_id: input.cardID,
        origin_agent_session_id: input.originAgentSessionID ?? null,
        origin_message_id: input.originMessageID ?? null,
      }) as Record<string, unknown> | null
    return row ? mapLectureSession(row) : null
  },

  async updateSession(
    userID: string,
    workroomID: string,
    lectureSessionID: string,
    patch: Partial<{
      status: LectureSessionStatus
      resumeCursor: number
      projectedChildMessageCount: number
      lastBlockID: string | null
      activeHighlightSpans: LectureHighlightSpan[]
      visualizationHTML: string | null
      questionPromptJSON: string | null
      summaryStatus: LectureSummaryStatus
      summary: LectureSummaryHandback | null
      lectureAgentSessionID: string | null
      closedAt: string | null
      completedAt: string | null
      archivedAt: string | null
    }>,
  ) {
    const current = await this.getSessionByID(userID, workroomID, lectureSessionID)
    if (!current) return null
    const next: LectureSessionRecord = {
      ...current,
      status: patch.status ?? current.status,
      resumeCursor: patch.resumeCursor ?? current.resumeCursor,
      projectedChildMessageCount:
        patch.projectedChildMessageCount === undefined
          ? current.projectedChildMessageCount
          : patch.projectedChildMessageCount,
      lastBlockID: patch.lastBlockID === undefined ? current.lastBlockID : patch.lastBlockID,
      activeHighlightSpans:
        patch.activeHighlightSpans === undefined ? current.activeHighlightSpans : patch.activeHighlightSpans,
      visualizationHTML: patch.visualizationHTML === undefined ? current.visualizationHTML : patch.visualizationHTML,
      questionPromptJSON:
        patch.questionPromptJSON === undefined ? current.questionPromptJSON : patch.questionPromptJSON,
      summaryStatus: patch.summaryStatus ?? current.summaryStatus,
      summary: patch.summary === undefined ? current.summary : patch.summary,
      lectureAgentSessionID:
        patch.lectureAgentSessionID === undefined ? current.lectureAgentSessionID : patch.lectureAgentSessionID,
      closedAt: patch.closedAt === undefined ? current.closedAt : patch.closedAt,
      completedAt: patch.completedAt === undefined ? current.completedAt : patch.completedAt,
      archivedAt: patch.archivedAt === undefined ? current.archivedAt : patch.archivedAt,
      updatedAt: new Date().toISOString(),
    }
    const db = getLocalSqlite()
    db.prepare(
      `UPDATE lecture_sessions
          SET status = @status,
              resume_cursor = @resume_cursor,
              projected_child_message_count = @projected_child_message_count,
              last_block_id = @last_block_id,
              active_highlight_targets_json = @active_highlight_targets_json,
              visualization_html = @visualization_html,
              question_prompt_json = @question_prompt_json,
              summary_status = @summary_status,
              summary_json = @summary_json,
              lecture_agent_session_id = @lecture_agent_session_id,
              closed_at = @closed_at,
              completed_at = @completed_at,
              archived_at = @archived_at,
              updated_at = @updated_at
        WHERE id = @id AND user_id = @user_id AND workroom_id = @workroom_id`,
    ).run({
      id: lectureSessionID,
      user_id: userID,
      workroom_id: workroomID,
      status: next.status,
      resume_cursor: next.resumeCursor,
      projected_child_message_count: next.projectedChildMessageCount,
      last_block_id: next.lastBlockID,
      active_highlight_targets_json: JSON.stringify(next.activeHighlightSpans),
      visualization_html: next.visualizationHTML,
      question_prompt_json: next.questionPromptJSON,
      summary_status: next.summaryStatus,
      summary_json: JSON.stringify(next.summary ?? null),
      lecture_agent_session_id: next.lectureAgentSessionID,
      closed_at: next.closedAt,
      completed_at: next.completedAt,
      archived_at: next.archivedAt,
      updated_at: next.updatedAt,
    })
    return next
  },

  async listBlocks(userID: string, workroomID: string, lectureSessionID: string) {
    const db = getLocalSqlite()
    const rows = db
      .prepare(
        `SELECT b.*
           FROM lecture_blocks b
           JOIN lecture_sessions s ON s.id = b.session_id
          WHERE b.session_id = @session_id
            AND s.user_id = @user_id
            AND s.workroom_id = @workroom_id
          ORDER BY b.created_at ASC, b.id ASC`,
      )
      .all({
        session_id: lectureSessionID,
        user_id: userID,
        workroom_id: workroomID,
      }) as Array<Record<string, unknown>>
    return rows.map(mapLectureBlock)
  },

  async createBlock(input: {
    userID: string
    workroomID: string
    lectureSessionID: string
    role: LectureBlockRecord["role"]
    text: string
    highlightSpans: LectureHighlightSpan[]
    pauseAfter: boolean
  }) {
    const db = getLocalSqlite()
    const now = new Date().toISOString()
    const id = createID("lecture_block")
    db.prepare(
      `INSERT INTO lecture_blocks
        (id, session_id, role, text, highlight_targets_json, pause_after, created_at)
       VALUES
        (@id, @session_id, @role, @text, @highlight_targets_json, @pause_after, @created_at)`,
    ).run({
      id,
      session_id: input.lectureSessionID,
      role: input.role,
      text: input.text,
      highlight_targets_json: JSON.stringify(input.highlightSpans),
      pause_after: input.pauseAfter ? 1 : 0,
      created_at: now,
    })
    const blocks = await this.listBlocks(input.userID, input.workroomID, input.lectureSessionID)
    return blocks.find((item) => item.id === id) ?? null
  },
}
