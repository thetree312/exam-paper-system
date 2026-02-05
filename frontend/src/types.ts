export type AuthMode = 'login' | 'register'

export interface UserInfo {
  id: number
  tenant_id: number
  email: string
  display_name: string
  tenant_code?: string
}

export interface PageSelectionSegment {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface SelectionExclusion extends PageSelectionSegment {
  id: string
}

export interface SelectionLegend extends PageSelectionSegment {
  id: string
}

export interface SelectionBox {
  x: number
  y: number
  width: number
  height: number
  segments: PageSelectionSegment[]
  exclusions: SelectionExclusion[]
  legends?: SelectionLegend[]
}

export interface RegionPayload {
  page: number
  x: number
  y: number
  width: number
  height: number
  exclusions?: Omit<PageSelectionSegment, 'page'>[]
}

export interface OcrResult {
  region_index: number
  text: string
}

export type GradingJudgement = 'pending' | 'correct' | 'incorrect' | 'skipped' | 'uncertain' | 'error'

export interface QuestionVersionRecord {
  content: string
  legendImages: string[]
  studentAnswer?: string | null
  grading?: {
    judgement?: string | null
    predictedAnswer?: string | null
    reasoning?: string | null
    confidence?: number | null
  }
  capturedAt?: string
  page?: number | null
  origin?: {
    requestLabel?: string
    agentRunId?: string
  }
  solution?: QuestionSolutionPayload
}

export interface QuestionSolutionPayload {
  finalAnswer?: string
  analysis?: string
}

export interface AggregatedOcrItem extends OcrResult {
  id: string
  sessionId: number
  fileId: number
  fileName: string
  page: number
  createdAt: number
  legendImages?: string[]
  originalText?: string
  answerText?: string
  sourceType?: 'upload' | 'favorite'  // 新增：标识来源（上传或收藏）
  questionMeta?: {
    questionId?: number
    sequenceIndex?: number
    groupId?: number | null
  }
  versions?: QuestionVersionRecord[]
  activeVersionIndex?: number
  uiState?: {
    shinyUntil?: number
    variant?: 'replace' | 'insert'
  }
  noteSource?: NoteSourceMeta
  solution?: QuestionSolutionPayload | null
  grading?: {
    status: GradingJudgement
    predictedAnswer?: string
    reasoning?: string
    confidence?: number | null
    rawResponse?: string
    error?: string
  }
}

export interface LegendRegionPayload {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface LegendResponse {
  images: string[]
}

export type TabStatus = 'pending' | 'processing' | 'ready' | 'failed'

export interface SessionStatus {
  session_id: number
  file_id: number
  status: 'pending' | 'processing' | 'done' | 'failed'
  preview_url?: string | null
  preview_pages?: string[]
}

export interface UploadedFileTab {
  sessionId: number
  fileId: number
  name: string
  previewType: 'image' | 'pdf' | 'word' | null
  previewUrl: string | null
  previewPages: string[]
  pageSessionIds?: number[]
  pageFileIds?: number[]
  pageStatuses?: TabStatus[]
  status: TabStatus
  isPlaceholder?: boolean
}

export interface AgentQuestion {
  id: number
  sequenceIndex: number
  groupId?: number | null
  page?: number | null
  content: string
  legendImages: string[]
  studentAnswer?: string | null
  gradingJudgement?: string | null
  gradingPredictedAnswer?: string | null
  gradingReasoning?: string | null
  gradingConfidence?: number | null
}

export interface QuestionSyncPayload {
  tenantId: number
  userId: number
  documentId?: number | null
  sessionId?: number | null
  fileId?: number | null
  questionId?: number | null
  sequenceIndex: number
  page?: number | null
  content: string
  legendImages?: string[]
  title?: string | null
  studentAnswer?: string | null
  sourceType?: 'upload' | 'favorite'
}

export interface QuestionSyncResponse {
  document_id: number
  question: {
    id: number
    sequence_index: number
  }
}

export interface AgentSnapshotResponse {
  document_id: number
  title: string
  status: string
  questions: AgentQuestion[]
}

export interface AgentMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  token_usage?: number | null
  created_at: string
}

export type AgentRunContext = 'blank' | 'exam_editor' | 'code_editor' | 'other' | 'batch_question'

export interface AgentRunMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AgentNoteFocus {
  documentId?: number | null
  fileId?: number | null
  blockIndex?: number | null
  snippet?: string | null
  title?: string | null
}

export interface AgentRunRequest {
  tenantId: number
  userId: number
  uiContext?: AgentRunContext
  documentId?: number | null
  messages: AgentRunMessage[]
  noteFocus?: AgentNoteFocus | null
  /** 会话视图 ID，用于同一文档下区分不同编辑视图/标签的 Agent 会话 */
  viewId?: string | null
  /** 后端分配的 Agent 会话 ID，用于跨请求复用同一 LangGraph 线程 */
  sessionId?: number | null
}

export type TranslationScope = 'word' | 'sentence'

export interface TranslationWordSense {
  pos?: string | null
  meaning?: string | null
  note?: string | null
}

export interface TranslationWordPayload {
  phonetic?: string | null
  translation?: string | null
  example?: string | null
  lemma?: string | null
  morphology?: string | null
  forms?: string[]
  senses?: TranslationWordSense[]
}

export interface TranslationQuotaInfo {
  limit?: number | null
  remaining?: number | null
  reset_at?: string | null
}

export interface TranslationLookupResponse {
  translation?: string | null
  word?: TranslationWordPayload | null
  quota?: TranslationQuotaInfo | null
}

export interface TranslationLookupPayload {
  tenantId: number
  userId: number
  text: string
  scope: TranslationScope
}

export interface TranslationContext {
  backendBaseUrl: string
  tenantId: number
  userId: number
}

export interface AgentSendPayload {
  /** 发送到 Copilot 输入框的原始文本，例如 "@题目3" 或自然语言指令 */
  text: string
  /** 可选：关联的文档/笔记上下文，用于 DocumentReadTool */
  noteFocus?: AgentNoteFocus
  /** 可选：覆盖本轮对话的 uiContext，用于触发特定 LangGraph 分支（如 batch_question）。 */
  uiContextOverride?: AgentRunContext
  /** 可选：批量出题相关的元信息，由题卡侧传入。 */
  batchMeta?: {
    mode: 'batch_question'
    baseSequenceIndex?: number
    baseQuestionId?: number
    /** 当前卡片剩余可用题数上限（例如 5 - 已有题数）。 */
    maxCapacity?: number
  }
}

export interface AgentRunResponse {
  /** 后端返回的会话 ID，前端需在后续请求中继续携带 */
  sessionId?: number | null
  messages: AgentRunMessage[]
}

// ===== Agent 会话管理 =====

export interface AgentConversationMeta {
  /** 本地 UI 使用的 key，用于区分同一文档下多个会话视图 */
  key: string
  /** 后端会话 ID（agent_sessions.id），用于与 LangGraph 线程及历史记录关联 */
  sessionId: number | null
  /** 租户 + 用户 + 文档 + 视图上下文 */
  tenantId: number
  userId: number
  documentId: number | null
  viewId: string | null
  /** 会话标题，由后端元数据或首条用户消息生成 */
  title: string
  /** 最近一条消息摘要，便于在会话列表中预览 */
  lastMessagePreview?: string | null
  /** 累计消息数量 */
  messageCount?: number
  /** 会话状态与归档标记 */
  status?: string
  archived?: boolean
  /** 创建与更新时间戳（毫秒） */
  createdAt: number
  updatedAt: number
}

export interface AgentSessionListItem {
  id: number
  tenant_id: number
  user_id: number
  document_id: number
  view_id: string
  title?: string | null
  last_message_preview?: string | null
  message_count: number
  status: string
  archived: boolean
  created_at: string
  updated_at: string
}

export interface AgentSessionListResponseDto {
  sessions: AgentSessionListItem[]
}

export interface AgentHistoryMessageDto {
  id: number
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  created_at: string
}

export interface AgentSessionMessagesResponseDto {
  session_id: number
  messages: AgentHistoryMessageDto[]
}

export interface AgUiQuestionReplaceEvent {
  action: 'question.replace'
  target: {
    questionId?: number
    sequenceIndex?: number
    groupId?: number | null
  }
  payload: {
    mode: 'similar_overwrite'
    newContent: string
    legendImages: string[]
    versionCount?: number
    currentVersionIndex?: number
    versions?: QuestionVersionRecord[]
    solution?: QuestionSolutionPayload
    origin?: {
      requestLabel?: string
      agentRunId?: string
    }
    ui?: {
      shinyOverlay?: boolean
      answerModeReset?: boolean
      variantOfQuestionId?: number | null
    }
  }
}

export interface NoteSourceMeta {
  documentId?: number | null
  fileId?: number | null
  pages?: number[]
  blockRange?: [number | null, number | null] | null
  snippet?: string | null
  context?: string | null
  title?: string | null
  questionId?: number | null
  sequenceIndex?: number | null
}

export interface AgUiQuestionInsertEvent {
  action: 'question.insert'
  target: {
    questionId?: number
    sequenceIndex?: number
    groupId?: number | null
  }
  payload: {
    mode: 'from_content_no_overwrite'
    content: string
    legendImages: string[]
    versionCount?: number
    currentVersionIndex?: number
    versions?: QuestionVersionRecord[]
    solution?: QuestionSolutionPayload
    origin?: {
      requestLabel?: string
      agentRunId?: string
    }
    ui?: {
      shinyOverlay?: boolean
      answerModeReset?: boolean
    }
    noteSource?: NoteSourceMeta
  }
}

export interface NoteSourceMeta {
  documentId?: number | null
  fileId?: number | null
  pages?: number[]
  blockRange?: [number | null, number | null] | null
  snippet?: string | null
  context?: string | null
  title?: string | null
  questionId?: number | null
  sequenceIndex?: number | null
}

export type AgUiEvent =
  | AgUiQuestionReplaceEvent
  | AgUiQuestionInsertEvent
  | (Record<string, unknown> & { action: string })

export interface GradeQuestionPayload {
  sequenceIndex: number
  content: string
  userAnswer: string
  legendImages?: string[]
  page?: number | null
  fileName?: string
}

export interface GradeRunRequest {
  tenantId: number
  userId: number
  documentId?: number | null
  title?: string | null
  questions: GradeQuestionPayload[]
}

export interface GradeQuestionResult {
  sequence_index: number
  judgement: Exclude<GradingJudgement, 'pending'>
  predicted_answer?: string | null
  reasoning?: string | null
  confidence?: number | null
  raw_response?: string | null
  error?: string | null
}

export interface GradeRunResponse {
  results: GradeQuestionResult[]
}

export interface SplitQuestionsRequest {
  tenantId: number
  userId: number
  documentId?: number | null
  text: string
  maxQuestions?: number | null
}

export interface SplitQuestionItem {
  index: number
  text: string
}

export interface SplitQuestionsResponse {
  questions: SplitQuestionItem[]
}

export interface MindMapNodePayload {
  id: string
  label: string
  type?: string
  /**
   * parentId / side 用于支持 XMind 风格树形布局：
   * - parentId 为空时视为根候选；
   * - side 仅对紧贴根节点的一级节点有意义（left/right/center）。
   */
  parentId?: string | null
  side?: 'left' | 'right' | 'center' | null
  data?: {
    description?: string
    source?: string
    questionIds?: number[]
    sequenceIndexes?: number[]
    page?: number | null
    [key: string]: unknown
  }
}

export interface MindMapEdgePayload {
  id: string
  source: string
  target: string
  label?: string | null
  type?: string
}

export interface MindMapGraphResponse {
  nodes: MindMapNodePayload[]
  edges: MindMapEdgePayload[]
  /** 可选的根节点 id，用于树形布局。 */
  rootId?: string | null
  cached?: boolean
  hasQuestionRefs?: boolean
}

export type MindMapRequestMode = 'document' | 'file'

export type MindMapSourceType = 'exam_document' | 'uploaded_file'

export interface MindMapSourceRef {
  sourceType: MindMapSourceType
  sourceId: number
  kind?: string | null
}

export interface MindMapNavigateTarget {
  questionId?: number | null
  sequenceIndex?: number | null
  page?: number | null
  label?: string
  rawNode?: MindMapNodePayload
}

export interface MindMapFocusRequest {
  questionId?: number | null
  sequenceIndex?: number | null
  page?: number | null
  highlightDuration?: number
  token: number
}

export interface ExportQuestionPayload {
  index: number
  markdown: string
}

export interface ExportWordRequestPayload {
  title: string
  questions: ExportQuestionPayload[]
  templateKey?: string | null
}

export interface ExportTemplateInfo {
  key: string
  name: string
  description?: string | null
}

export interface ExportTemplatesResponse {
  templates: ExportTemplateInfo[]
}

// ===== 题型、科目、标签相关类型 =====

export interface QuestionType {
  id: number
  name: string
  created_at?: string
}

export interface Subject {
  id: number
  name: string
  created_at?: string
}

export interface Tag {
  id: number
  name: string
  created_at?: string
}

// ===== 题目相关类型 =====

export interface Question {
  id: number
  content: string
  legend_images: string[]
  page?: number | null
  document_id: number
  created_at: string
  updated_at: string
}

// ===== 收藏题目相关类型 =====

export interface QuestionFavorite {
  id: number
  question_id: number
  question: FavoriteQuestionDetail
  question_type?: QuestionType | null
  subject?: Subject | null
  tags: Tag[]
  created_at: string
}

export interface FavoriteQuestionDetail {
  id: number
  document_id: number
  sequence_index: number
  content: string
  legend_images: string[]
  page?: number | null
  created_at: string
  updated_at: string
}

export interface FavoritesListResponse {
  total: number
  page: number
  page_size: number
  items: QuestionFavorite[]
}

export interface FavoriteQuotaResponse {
  max_favorites: number
  current_count: number
  remaining: number
}

export interface FavoriteConfig {
  question_type_id?: number | null
  question_type_name?: string
  subject_id?: number | null
  subject_name?: string
  tag_ids: number[]
  new_tag_names: string[]
}

export interface AddFavoriteRequest {
  tenant_id: number
  user_id: number
  question_id: number
  question_type_id?: number | null
  subject_id?: number | null
  tag_ids?: number[] | null
}

export interface AddFavoriteResponse {
  id: number
  question_id: number
  question_type_id?: number | null
  subject_id?: number | null
  tags?: Tag[]
  created_at: string
}

export interface RemoveFavoriteResponse {
  success: boolean
}

export interface CheckFavoriteResponse {
  is_favorited: boolean
}
