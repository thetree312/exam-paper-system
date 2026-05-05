import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentChat } from '../hooks/useAgentChat'
import { useConversation } from '../hooks'
import type {
  AgentAssistantBlock,
  AgentAssistantToolBlock,
  AgentCitationAnchor,
  AgentInputFile,
  AgentRunContext,
  AgentSendPayload,
  AgUiEvent,
  UserInfo,
} from '../types'
import { InlineCitationMarkdown } from './InlineCitationMarkdown'
import { MarkdownWithMath } from './MarkdownWithMath'
import Lottie from 'lottie-react'
import workingCatAnimation from '../assets/animations/workingCat.json'
import noInternetAnimation from '../assets/animations/noInternet.json'
import { AgentConversationHistory } from './AgentConversationHistory'
import { MetalInputBox } from './MetalInputBox'
import { McpSettingsDialog } from './McpSettingsDialog'
import { SkillSettingsDialog } from './SkillSettingsDialog'
import { fetchModelSettings, fetchModelSettingsCatalog } from '../services/modelSettingsApi'
import { updateAgentSession } from '../services/agentApi'
import { deriveAssistantBlocks } from '../lib/agentFacts'
import { ensureMathContentDocument, mathContentToPromptText } from '../lib/mathContent'
import Icon from './Icon'
import {
  resolveModelIconKey,
  resolveProviderIconKey,
  type ModelSelectOption,
} from '../lib/modelBranding'


interface AgentChatPanelProps {
  backendBaseUrl: string
  user: UserInfo
  workroomId: string | number
  documentId?: string | number | null
  /** 会话视图 ID，用于区分同一文档下不同编辑视图/标签 */
  viewId?: string | null
  isOpen: boolean
  onClose: () => void
  width?: number
  onResize?: (width: number) => void
  appendToken?: { id: number; payload: AgentSendPayload } | null
  onAgUiEvent?: (event: AgUiEvent) => void
  onAppendTokenConsumed?: (id: number) => void
  onDocumentResolved?: (documentId: string | number) => void
  preferredSessionId?: string | null
  onSessionResolved?: (sessionId: string | null) => void
  onCitationClick?: (citation: AgentCitationAnchor) => void
  modelSettingsRevision?: number
}

type GreetingInfo = {
  title: string
  subtitle: string
  animation: object
}

function normalizeAiMarkdown(raw: string): string {
  if (!raw) return ''

  let text = raw

  // 长期约定：
  // - 后端 Solver 在需要书写数学公式时，应优先使用 $...$（行内）或 $$...$$（块级）包裹 LaTeX，
  //   由 remark-math + KaTeX 直接渲染；
  // - 下面的逻辑仅作为“旧消息兼容层”，把历史上使用中括号包裹的 LaTeX 公式块，
  //   稳定地转换为 $$...$$，以免破坏已有对话记录。

  // 兼容形如：
  // [ \vec{v}_{\text{视风}} = (3 - 0, 3 - 2) = (3, 1) ]
  // 的单行块公式（同一行内既有 '[' 又有 ']'，且中间至少包含一个 '\\'）。
  text = text.replace(/\[(?=[^\n]*\\)([^\]]+)\]/g, (_match, inner) => {
    const content = String(inner || '').trim()
    if (!content) return ''
    return `\n$$\n${content}\n$$\n`
  })

  // 兼容形如：
  // [\n
  //   \\vec{v}_{\\text{视风}} = ...\\Rightarrow ...\\
  // ]
  // 的多行块公式：左中括号与右中括号各占一行，中间是包含 LaTeX 命令的若干行。
  text = text.replace(/^\[\s*\n([\s\S]*?\\[\s\S]*?)\n\]\s*$/gm, (_match, inner) => {
    const content = String(inner || '').trim()
    if (!content) return ''
    return `\n$$\n${content}\n$$\n`
  })

  // 处理未显式包裹但整体看起来是 LaTeX 公式块的段落：
  // - 段落中包含至少一个 LaTeX 命令（如 \\vec, \\sqrt 等）；
  // - 段落本身尚未包含 $...$/$$...$$；
  // - 不是标题/列表/表格/代码块等结构化行；
  // - 段落中不包含明显的中文句号等长文本叙述（尽量只作用于“纯公式段落”）。
  const paragraphs = text.split(/\n{2,}/)
  const normalizedParagraphs = paragraphs.map((para) => {
    const trimmed = para.trim()
    if (!trimmed) return para

    // 已经显式使用 $ 或 $$ 的段落保持不变
    if (/\$\$[\s\S]*\$\$/.test(trimmed) || /(^|[^$])\$[^$]+\$([^$]|$)/.test(trimmed)) {
      return para
    }

    // 不含任何 LaTeX 命令，则不处理
    if (!/\\[a-zA-Z]+/.test(trimmed)) {
      return para
    }

    const lines = para.split('\n')
    const isStructured = lines.some((line) => {
      const t = line.trim()
      if (!t) return false
      return (
        t.startsWith('#') || // 标题
        t.startsWith('- ') ||
        t.startsWith('* ') ||
        /^\d+[\.)]/.test(t) || // 有序列表
        t.startsWith('|') || // 表格
        t.startsWith('```') // 代码块
      )
    })
    if (isStructured) {
      return para
    }

    // 包含明显中文句号/问号/感叹号，视为正文段落，避免误伤
    if (/[。？！]/.test(para)) {
      return para
    }

    const content = trimmed
    return `\n$$\n${content}\n$$\n`
  })

  text = normalizedParagraphs.join('\n\n')

  return text
}

function stringifyToolValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && value.length === 0) return ''
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
    return ''
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolStatusMeta(status: AgentAssistantToolBlock['status']) {
  switch (status) {
    case 'success':
      return {
        icon: '✓',
        label: '成功',
        tone: 'text-emerald-600',
        useSymbol: true,
      }
    case 'fail':
      return {
        icon: '✖',
        label: '失败',
        tone: 'text-rose-600',
        useSymbol: true,
      }
    case 'running':
      return {
        icon: 'progress_activity',
        label: '',
        tone: 'text-amber-600',
        useSymbol: false,
      }
    default:
      return {
        icon: 'schedule',
        label: '',
        tone: 'text-slate-500',
        useSymbol: false,
      }
  }
}

function isMcpToolName(toolName: string) {
  const normalized = toolName.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.includes('mcp')) return true

  const builtinToolNames = new Set([
    'bash',
    'shell',
    'command',
    'shell_command',
    'edit',
    'write',
    'apply_patch',
    'multiedit',
    'read',
    'grep',
    'glob',
    'list',
    'webfetch',
    'websearch',
    'codesearch',
    'task',
    'skill',
    'plan_enter',
    'plan_exit',
    'todowrite',
    'subtask',
    'agent',
    'question',
    'permission',
  ])

  // MCP 工具在 opencode 中通常是 `${server}_${tool}` 形式，例如 `chrome-devtools_new_page`
  return normalized.includes('_') && !builtinToolNames.has(normalized)
}

function toolKindIcon(block: AgentAssistantToolBlock) {
  const normalizedToolName = block.toolName.trim().toLowerCase()
  if (normalizedToolName === 'skill') return 'tool_skill'
  if (isMcpToolName(block.toolName)) return 'tool_mcp'

  switch (block.displayKind) {
    case 'command':
      return 'tool_shell'
    case 'file_edit':
      return 'tool_file_edit'
    case 'search_read':
      return 'manage_search'
    case 'web':
      return 'language'
    case 'task_stage':
      return 'checklist'
    case 'interaction':
      return 'contact_support'
    default:
      return 'deployed_code'
  }
}

function shortenPathLike(value: string) {
  const normalized = value.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 3) return normalized
  return `.../${parts.slice(-3).join('/')}`
}

function toolTitle(block: AgentAssistantToolBlock) {
  const input = block.input ?? {}
  const metadata = block.metadata ?? {}
  const candidates = [
    typeof metadata.raw === 'string' ? metadata.raw : '',
    typeof metadata.title === 'string' ? metadata.title : '',
    typeof input.command === 'string' ? input.command : '',
    typeof input.description === 'string' ? input.description : '',
    typeof input.filePath === 'string' ? input.filePath : '',
    typeof input.path === 'string' ? input.path : '',
    typeof input.pattern === 'string' ? input.pattern : '',
    typeof input.url === 'string' ? input.url : '',
    typeof input.query === 'string' ? input.query : '',
    typeof metadata.relativePath === 'string' ? metadata.relativePath : '',
    typeof metadata.filepath === 'string' ? metadata.filepath : '',
    Array.isArray(metadata.files) && typeof metadata.files[0]?.relativePath === 'string'
      ? String(metadata.files[0].relativePath)
      : '',
  ]

  for (const candidate of candidates) {
    const text = typeof candidate === 'string' ? candidate.trim() : ''
    if (text) return text
  }

  return block.toolName
}

const ToolEvidenceBlock: React.FC<{ block: AgentAssistantToolBlock }> = ({ block }) => {
  const status = toolStatusMeta(block.status)
  const inputText = stringifyToolValue(block.input)
  const outputText = stringifyToolValue(block.output)
  const errorText = typeof block.error === 'string' ? block.error.trim() : ''
  const collapsedTitle = block.displayKind === 'file_edit' ? shortenPathLike(toolTitle(block)) : toolTitle(block)
  const diffText =
    block.displayKind === 'file_edit' && block.metadata && typeof block.metadata.diff === 'string'
      ? block.metadata.diff
      : ''
  const fileDiffMeta =
    block.displayKind === 'file_edit' &&
    block.metadata &&
    block.metadata.filediff &&
    typeof block.metadata.filediff === 'object'
      ? (block.metadata.filediff as Record<string, any>)
      : null
  const fileEntries =
    block.displayKind === 'file_edit' && Array.isArray(block.metadata?.files)
      ? (block.metadata?.files as Array<Record<string, any>>)
      : []
  const searchPreview =
    block.displayKind === 'search_read'
      ? stringifyToolValue(block.metadata?.loaded ?? block.metadata?.count ?? block.output)
      : ''
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const wasRunningRef = useRef(block.status === 'running' || block.status === 'pending')
  const isRunning = block.status === 'running' || block.status === 'pending'
  const shouldExpand = manualExpanded ?? isRunning

  useEffect(() => {
    if (isRunning) {
      setManualExpanded(null)
    } else if (wasRunningRef.current) {
      setManualExpanded(false)
    }
    wasRunningRef.current = isRunning
  }, [isRunning])

  const detailSummary = (() => {
    if (block.displayKind === 'file_edit' && fileEntries.length > 0) {
      const add = fileEntries.reduce((sum, file) => sum + (typeof file.additions === 'number' ? file.additions : 0), 0)
      const del = fileEntries.reduce((sum, file) => sum + (typeof file.deletions === 'number' ? file.deletions : 0), 0)
      return `${fileEntries.length} 个文件 · +${add} / -${del}`
    }
    if (block.displayKind === 'file_edit' && fileDiffMeta?.patch) {
      const add = typeof fileDiffMeta.additions === 'number' ? fileDiffMeta.additions : 0
      const del = typeof fileDiffMeta.deletions === 'number' ? fileDiffMeta.deletions : 0
      return `+${add} / -${del}`
    }
    if (block.displayKind === 'file_edit' && diffText) {
      const add = diffText.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
      const del = diffText.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length
      return `+${add} / -${del}`
    }
    if (block.displayKind === 'search_read' && typeof block.metadata?.count === 'number') {
      return `${block.metadata.count} 条结果`
    }
    if (errorText) return null
    if (outputText) return null
    if (inputText) return null
    return null
  })()

  const renderDiff = (diff: string, fileLabel: string, stats?: { additions?: number; deletions?: number }) => {
    const lines = diff.split('\n').slice(0, 80)
    const additions =
      typeof stats?.additions === 'number'
        ? stats.additions
        : lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
    const deletions =
      typeof stats?.deletions === 'number'
        ? stats.deletions
        : lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
    return (
      <div className="rounded-[12px] border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-3 py-2 text-[12px] text-slate-500 border-b border-slate-200">
          <span className="truncate">{fileLabel}</span>
          <span className="shrink-0">{additions} additions / {deletions} deletions</span>
        </div>
        <pre className="max-h-80 overflow-auto px-3 py-2 text-[12px] leading-6 bg-slate-50 text-slate-700">
          {lines.map((line, index) => (
            <div
              key={`${index}-${line}`}
              className={
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'bg-emerald-50 text-emerald-700'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'bg-rose-50 text-rose-700'
                    : 'text-slate-600'
              }
            >
              {line || ' '}
            </div>
          ))}
        </pre>
      </div>
    )
  }

  const renderFileEditBlock = () => {
    if (fileEntries.length > 0) {
      return (
        <div className="space-y-3">
          {fileEntries.map((file, index) => {
            const label = shortenPathLike(String(file.relativePath ?? file.filePath ?? toolTitle(block)))
            const patch = typeof file.patch === 'string' ? file.patch : ''
            if (patch) {
              return (
                <div key={`${label}-${index}`}>
                  {renderDiff(patch, label, {
                    additions: typeof file.additions === 'number' ? file.additions : undefined,
                    deletions: typeof file.deletions === 'number' ? file.deletions : undefined,
                  })}
                </div>
              )
            }
            return (
              <div key={`${label}-${index}`} className="rounded-[12px] border border-slate-200 bg-white px-3 py-2">
                <div className="text-[12px] text-slate-500">{label}</div>
              </div>
            )
          })}
        </div>
      )
    }

    if (fileDiffMeta?.patch && typeof fileDiffMeta.patch === 'string') {
      return renderDiff(
        fileDiffMeta.patch,
        shortenPathLike(String(block.metadata?.relativePath ?? fileDiffMeta.file ?? toolTitle(block))),
        {
          additions: typeof fileDiffMeta.additions === 'number' ? fileDiffMeta.additions : undefined,
          deletions: typeof fileDiffMeta.deletions === 'number' ? fileDiffMeta.deletions : undefined,
        },
      )
    }

    if (diffText) {
      return renderDiff(diffText, shortenPathLike(toolTitle(block)))
    }

    const fileLabel = shortenPathLike(String(block.metadata?.relativePath ?? block.metadata?.filepath ?? toolTitle(block)))
    return (
      <div className="rounded-[12px] border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-slate-700">{fileLabel}</div>
            <div className="text-[12px] text-slate-400">
              {block.metadata?.exists === false ? '新建文件' : '写入文件'}
            </div>
          </div>
          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${status.tone}`}>
            {status.useSymbol ? (
              <span className="text-[16px] leading-none">{status.icon}</span>
            ) : (
              <Icon name={status.icon} className={`text-[14px] leading-none ${block.status === 'running' ? 'animate-spin' : ''}`} />
            )}
          </span>
        </div>
        {(outputText || inputText) && (
          <div className="px-3 py-2">
            <pre className="whitespace-pre-wrap text-[12px] leading-6 text-slate-700 font-mono">{outputText || inputText}</pre>
          </div>
        )}
      </div>
    )
  }

  const renderCommandBlock = () => {
    const lines: string[] = []
    const pushUnique = (value: unknown) => {
      if (typeof value !== 'string') return
      const trimmed = value.trim()
      if (!trimmed) return
      if (lines.includes(trimmed)) return
      lines.push(trimmed)
    }

    pushUnique(block.metadata?.raw)
    pushUnique(block.metadata?.title)
    pushUnique(block.input?.command)
    pushUnique(block.input?.description)
    pushUnique(block.input?.filePath)
    pushUnique(block.input?.path)
    pushUnique(block.input?.pattern)
    pushUnique(block.input?.url)
    pushUnique(block.input?.query)
    if (outputText) {
      pushUnique(outputText)
    } else if (inputText) {
      pushUnique(inputText)
    }

    const content = lines.join('\n\n').trim()
    if (!content) return null

    return (
      <div className="rounded-[12px] border border-slate-200 bg-slate-50 px-3 py-2">
        <pre className="whitespace-pre-wrap text-[12px] leading-6 text-slate-700 font-mono">{content}</pre>
      </div>
    )
  }

  return (
    <div className="max-w-[820px]">
      <button
        type="button"
        onClick={() => setManualExpanded((prev) => (prev == null ? !shouldExpand : !prev))}
        className="flex w-full items-center justify-between gap-3 py-1 text-left"
        aria-expanded={shouldExpand}
      >
        <div className="inline-flex min-w-0 items-center gap-2 text-[13px] text-slate-500">
          <Icon name={"chevron_right"} className={`text-[16px] leading-none transition-transform ${shouldExpand ? 'rotate-90' : ''}`} />
          <Icon name={toolKindIcon(block)} className="text-[16px] leading-none" />
          <span className={`font-medium text-slate-600 ${isRunning ? 'tool-running-shiny-text' : ''}`}>{collapsedTitle}</span>
          {detailSummary ? <span className="truncate text-[12px] text-slate-400">· {detailSummary}</span> : null}
        </div>
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${status.tone}`}>
          {status.useSymbol ? (
            <span className="text-[16px] leading-none">{status.icon}</span>
          ) : (
            <Icon name={status.icon} className={`text-[14px] leading-none ${block.status === 'running' ? 'animate-spin' : ''}`} />
          )}
        </span>
      </button>

      {shouldExpand && (
        <div className="ml-6 mt-1 border-l border-slate-200 pl-4 space-y-3">
          {block.displayKind === 'command' && renderCommandBlock()}

          {block.displayKind === 'file_edit' && renderFileEditBlock()}

          {block.displayKind === 'search_read' && searchPreview && (
            <div className="rounded-[12px] border border-slate-200 bg-slate-50 px-3 py-2">
              <pre className="whitespace-pre-wrap text-[12px] leading-6 text-slate-700 font-mono">{searchPreview}</pre>
            </div>
          )}

          {block.displayKind === 'web' && (inputText || outputText) && (
            <div className="rounded-[12px] border border-slate-200 bg-slate-50 px-3 py-2">
              <pre className="whitespace-pre-wrap text-[12px] leading-6 text-slate-700 font-mono">{outputText || inputText}</pre>
            </div>
          )}

          {block.displayKind === 'task_stage' && (
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-[12px] text-slate-600">{block.toolName}</span>
              {Object.entries(block.input ?? {}).slice(0, 3).map(([key, value]) => (
                <span key={key} className="inline-flex rounded-full bg-slate-50 px-2.5 py-1 text-[12px] text-slate-500">
                  {key}: {String(value)}
                </span>
              ))}
            </div>
          )}

          {block.displayKind === 'generic' && (inputText || outputText) && (
            <div className="rounded-[12px] border border-slate-200 bg-slate-50 px-3 py-2">
              <pre className="whitespace-pre-wrap text-[12px] leading-6 text-slate-700 font-mono">{outputText || inputText}</pre>
            </div>
          )}

          {errorText && (
            <div className="rounded-[12px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] leading-6 text-rose-700 font-mono">
              {errorText}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const AssistantNaturalFlow: React.FC<{
  msg: any
  onCitationClick?: (citation: AgentCitationAnchor) => void
}> = React.memo(({ msg, onCitationClick }) => {
  const blocks = useMemo(() => {
    if (Array.isArray(msg.parts)) {
      return deriveAssistantBlocks(msg.parts) ?? []
    }
    return Array.isArray(msg.assistantBlocks) ? (msg.assistantBlocks as AgentAssistantBlock[]) : []
  }, [msg.parts, msg.assistantBlocks])
  const visibleBlocks = blocks.filter((block) => {
    if (block.type === 'text' || block.type === 'commentary' || block.type === 'final_answer') {
      return String(block.text || '').trim().length > 0
    }
    return block.type === 'tool'
  })
  const fallbackContent =
    typeof msg.content === 'string'
      ? msg.content
      : mathContentToPromptText(ensureMathContentDocument(msg.content))

  return (
    <div className="min-w-0">
      <div className="min-w-0">
        <div className="space-y-3">
          {visibleBlocks.map((block, index) => {
            if (block.type === 'tool') {
              return <ToolEvidenceBlock key={block.id ?? `tool-${index}`} block={block} />
            }
            return (
              <div key={block.id ?? `text-${index}`} className="prose prose-slate max-w-none text-[15px] leading-relaxed">
                <InlineCitationMarkdown
                  content={normalizeAiMarkdown(block.text)}
                  citations={Array.isArray(msg.citations) ? msg.citations : []}
                  onCitationClick={onCitationClick}
                />
              </div>
            )
          })}

          {visibleBlocks.length === 0 && fallbackContent.trim() && (
            <div className="prose prose-slate max-w-none text-[15px] leading-relaxed">
              <InlineCitationMarkdown
                content={normalizeAiMarkdown(fallbackContent)}
                citations={Array.isArray(msg.citations) ? msg.citations : []}
                onCitationClick={onCitationClick}
              />
            </div>
          )}

          {msg.isStreaming && visibleBlocks.length === 0 && !fallbackContent.trim() && (
            <div className="flex items-center gap-1.5 text-slate-400" aria-label="thinking animation">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '120ms' }} />
              <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '240ms' }} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}, (prev, next) => (
  prev.msg?.id === next.msg?.id
  && prev.msg?.content === next.msg?.content
  && prev.msg?.parts === next.msg?.parts
  && prev.msg?.assistantBlocks === next.msg?.assistantBlocks
  && prev.msg?.isStreaming === next.msg?.isStreaming
  && prev.msg?.citations === next.msg?.citations
  && prev.msg?.citationStatus === next.msg?.citationStatus
))

export const AgentChatPanel: React.FC<AgentChatPanelProps> = ({
  backendBaseUrl,
  user,
  workroomId,
  documentId,
  viewId,
  isOpen,
  onClose: _onClose,
  width = 480,
  onResize,
  appendToken,
  onAgUiEvent: _onAgUiEvent,
  onAppendTokenConsumed,
  onDocumentResolved,
  preferredSessionId,
  onSessionResolved,
  onCitationClick,
  modelSettingsRevision = 0,
}) => {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [inputFiles, setInputFiles] = useState<AgentInputFile[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [candidateModelOptions, setCandidateModelOptions] = useState<ModelSelectOption[]>([])
  const [isSkillSettingsOpen, setIsSkillSettingsOpen] = useState(false)
  const [isMcpSettingsOpen, setIsMcpSettingsOpen] = useState(false)
  const [inputHeight, setInputHeight] = useState(34)
  const [mathInputEnabled, setMathInputEnabled] = useState(false)
  const [hitlFormValues, setHitlFormValues] = useState<Record<string, any>>({})
  const [isSubmittingHitlForm, setIsSubmittingHitlForm] = useState(false)
  const [hitlAnchorIndex, setHitlAnchorIndex] = useState<number | null>(null)
  // 当前 useAgentChat 状态所“绑定”的会话 key，用于避免在切换会话过程中
  // 将上一会话的消息和 sessionId 写入到新激活的会话元信息中。
  const [boundConversationKey, setBoundConversationKey] = useState<string | null>(null)
  const persistedSessionModelRef = useRef<string>('')

  const effectiveUiContext: AgentRunContext = appendToken?.payload.uiContextOverride ?? 'exam_editor'

  const {
    conversations,
    activeConversationKey,
    activeConversation,
    activeConversationMessages,
    conversationResetSignal,
    handleCreateConversation,
    handleSelectConversation,
    handleDeleteConversation,
    handleConversationMessagesChange,
    handleRenameConversation,
    upsertConversation,
  } = useConversation(backendBaseUrl, {
    tenantId: user?.tenant_id,
    userId: user?.id,
    workroomId,
    documentId: documentId ?? null,
    viewId: viewId ?? null,
    preferredSessionId: preferredSessionId ?? null,
  })
  const modelConversationKeyRef = useRef<string | null>(null)
  const modelOptions = useMemo(() => {
    const base = [...candidateModelOptions]
    const selected = activeConversation?.selectedModel
    if (!selected?.providerID || !selected?.modelID) return base
    const existed = base.some(
      (item) => item.providerID === selected.providerID && item.modelID === selected.modelID,
    )
    if (existed) return base
    return [
      {
        optionID: `${selected.providerID}::${selected.modelID}`,
        modelID: selected.modelID,
        label: selected.modelID,
        providerID: selected.providerID,
        providerIconKey: resolveProviderIconKey(selected.providerID),
        modelIconKey: resolveModelIconKey(selected.modelID),
      },
      ...base,
    ]
  }, [activeConversation?.selectedModel, candidateModelOptions])

  const {
    messages,
    isLoading,
    error,
    sendMessage,
    resumeWithPayload,
    cancelCurrentRun,
    resetChat,
    sessionId,
    setSessionId,
    setMessagesFromHistory,
    pendingInteraction,
  } = useAgentChat({
    backendBaseUrl,
    tenantId: user?.tenant_id,
    userId: user?.id,
    workroomId,
    uiContext: effectiveUiContext,
    documentId,
    viewId,
    noteFocus: appendToken?.payload.noteFocus,
    onDocumentResolved,
  })
  const deferredMessages = useDeferredValue(messages)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false

    void Promise.all([
      fetchModelSettings(backendBaseUrl),
      fetchModelSettingsCatalog(backendBaseUrl),
    ])
      .then(([settings, catalog]) => {
        if (cancelled) return
        setMathInputEnabled(Boolean(settings.experimentalFeatures.mathInput.enabled))
        const providerByID = new Map(catalog.providers.map((item) => [item.providerID, item]))
        const accountByID = new Map(settings.providerAccounts.map((item) => [item.accountID, item]))
        const seen = new Set<string>()
        const options: ModelSelectOption[] = []
        for (const binding of settings.capabilityBindings) {
          if (binding.capability !== 'agent_chat' || !binding.enabled) continue
          const account = accountByID.get(binding.accountID)
          if (!account) continue
          const providerID = String(account.providerID || '').trim()
          const modelID = String(binding.modelID || '').trim()
          if (!providerID || !modelID) continue
          const optionID = `${providerID}::${modelID}`
          if (seen.has(optionID)) continue
          seen.add(optionID)
          const providerMeta = providerByID.get(providerID)
          const modelMeta = providerMeta?.models.find((item) => item.modelID === modelID)
          options.push({
            optionID,
            modelID,
            label: modelMeta?.label || modelID,
            providerID,
            providerIconKey: resolveProviderIconKey(providerID, providerMeta?.iconKey),
            modelIconKey: resolveModelIconKey(modelID, modelMeta?.iconKey),
          })
        }
        setCandidateModelOptions(options)
      })
      .catch(() => {
        if (cancelled) return
        setCandidateModelOptions([])
      })

    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, isOpen, modelSettingsRevision])

  useEffect(() => {
    if (!activeConversationKey) return
    const conversationChanged = modelConversationKeyRef.current !== activeConversationKey
    modelConversationKeyRef.current = activeConversationKey
    const preferred = activeConversation?.selectedModel
      ? modelOptions.find(
          (item) =>
            item.providerID === activeConversation.selectedModel?.providerID &&
            item.modelID === activeConversation.selectedModel?.modelID,
        )
      : undefined

    setSelectedModel((prev) => {
      if (preferred) return preferred.optionID || preferred.modelID
      if (!conversationChanged && prev && modelOptions.some((item) => (item.optionID || item.modelID) === prev)) {
        return prev
      }
      return modelOptions[0]?.optionID || modelOptions[0]?.modelID || ''
    })
  }, [activeConversation?.selectedModel, activeConversationKey, modelOptions])

  useEffect(() => {
    onSessionResolved?.(sessionId ?? null)
  }, [onSessionResolved, sessionId])

  useEffect(() => {
    if (!activeConversation?.sessionId || !activeConversation.selectedModel?.providerID || !activeConversation.selectedModel?.modelID) {
      return
    }
    const signature = `${activeConversation.sessionId}::${activeConversation.selectedModel.providerID}::${activeConversation.selectedModel.modelID}`
    if (persistedSessionModelRef.current === signature) return
    persistedSessionModelRef.current = signature
    void updateAgentSession(backendBaseUrl, activeConversation.sessionId, {
      workroomId,
      selectedModel: {
        providerID: activeConversation.selectedModel.providerID,
        modelID: activeConversation.selectedModel.modelID,
      },
    }).catch((error) => {
      console.warn('[agent conversations] persist selected model failed', error)
    })
  }, [activeConversation?.selectedModel?.modelID, activeConversation?.selectedModel?.providerID, activeConversation?.sessionId, backendBaseUrl, workroomId])

  // 会话重置信号变化时（新建/切换会话），根据当前会话元信息和存量消息灌入 useAgentChat。
  // 仅在 conversationResetSignal 变化时运行一次，避免与 messages -> store 同步形成更新环。
  useEffect(() => {
    if (!conversationResetSignal) return
    if (!activeConversationKey || !activeConversation) return

    const isSameConversation = boundConversationKey === activeConversationKey

    // 在真正灌入消息之前，先将 useAgentChat 绑定到当前激活会话 key，
    // 后续 messages -> store 的同步只会作用于这个已绑定会话，
    // 避免在“激活 key 已变、更但消息仍是旧会话”的中间态下发生串写。
    setBoundConversationKey(activeConversationKey)

    ;(setSessionId as (id: string | null) => void)(activeConversation.sessionId ?? null)

    // 新建会话首轮发送后，session_id 解析和会话列表刷新可能再次触发 reset signal。
    // 这时如果还是同一个会话 key，就不能再用历史消息回灌，否则会把当前流式中的
    // optimistic messages 覆盖成服务端尚未完全落盘的空历史。
    if (isSameConversation) {
      return
    }

    if (Array.isArray(activeConversationMessages)) {
      setMessagesFromHistory(activeConversationMessages as any)
    } else {
      setMessagesFromHistory([] as any)
    }
  }, [conversationResetSignal])

  // 将当前 messages 同步回会话 store，便于下次切换/恢复。
  // 流式输出期间做轻度节流，避免每个 token 都触发全局状态更新导致页面抖动。
  const syncTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (!activeConversationKey) return
    if (boundConversationKey !== activeConversationKey) return

    if (syncTimerRef.current != null) {
      window.clearTimeout(syncTimerRef.current)
      syncTimerRef.current = null
    }

    const hasStreamingAssistant = messages.some((msg) => msg.role === 'assistant' && Boolean(msg.isStreaming))
    const delay = hasStreamingAssistant ? 220 : 0
    syncTimerRef.current = window.setTimeout(() => {
      handleConversationMessagesChange(activeConversationKey, messages as any, sessionId ?? null)
      syncTimerRef.current = null
    }, delay)

    return () => {
      if (syncTimerRef.current != null) {
        window.clearTimeout(syncTimerRef.current)
        syncTimerRef.current = null
      }
    }
  }, [activeConversationKey, boundConversationKey, handleConversationMessagesChange, messages, sessionId])

  const canSend = useMemo(() => !!input.trim() && !isLoading, [input, isLoading])
  const hasMessages = deferredMessages.length > 0
  const sendButtonSize = useMemo(() => Math.max(Math.min(inputHeight - 8, 30), 22), [inputHeight])

  // 处理来自编辑区的“发送到 Copilot”指令，将题目文本附加到输入框
  const lastAppendIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (!appendToken || appendToken.id === lastAppendIdRef.current) return
    lastAppendIdRef.current = appendToken.id
    setInput((prev) => {
      const text = appendToken.payload.text ?? ''
      if (!text.trim()) return prev
      return prev ? `${prev}\n\n${text}` : text
    })
    onAppendTokenConsumed?.(appendToken.id)
  }, [appendToken, onAppendTokenConsumed])

  useEffect(() => {
    if (pendingInteraction && hitlAnchorIndex == null) {
      for (let idx = deferredMessages.length - 1; idx >= 0; idx -= 1) {
        if (deferredMessages[idx]?.role === 'assistant') {
          setHitlAnchorIndex(idx)
          break
        }
      }
    }
    if (!pendingInteraction && hitlAnchorIndex != null) {
      setHitlAnchorIndex(null)
    }
  }, [pendingInteraction, hitlAnchorIndex, deferredMessages])

  useEffect(() => {
    if (!pendingInteraction) {
      setHitlFormValues({})
      setIsSubmittingHitlForm(false)
      return
    }
    if (pendingInteraction.kind === 'permission') {
      setHitlFormValues({
        reply: 'once',
        message: '',
      })
      setIsSubmittingHitlForm(false)
      return
    }
    const nextValues: Record<string, any> = {}
    pendingInteraction.request.questions.forEach((question, index) => {
      nextValues[`q${index}`] = question.multiple ? '' : (question.options[0]?.label ?? '')
    })
    setHitlFormValues(nextValues)
    setIsSubmittingHitlForm(false)
  }, [pendingInteraction?.requestId])

  const handleSend = useCallback(
    async (evt?: React.FormEvent) => {
      evt?.preventDefault()
      if (!canSend) return
      const content = input.trim()
      const filesForSend = inputFiles
      setInput('')
      setInputFiles([])
      setInputHeight(34)
      try {
        const selectedOption = modelOptions.find((item) => (item.optionID || item.modelID) === selectedModel)
        await sendMessage(
          ensureMathContentDocument(content),
          selectedOption?.providerID && selectedOption?.modelID
            ? {
                providerID: selectedOption.providerID,
                modelID: selectedOption.modelID,
              }
            : null,
          filesForSend.length > 0 ? filesForSend : undefined,
        )
      } catch {
        // error state is handled in hook
      }
    },
    [canSend, input, inputFiles, modelOptions, selectedModel, sendMessage],
  )

  const handleUploadAgentFiles = useCallback((files: AgentInputFile[]) => {
    setInputFiles((prev) => {
      const merged = [...prev]
      for (const file of files) {
        const exists = merged.some((item) => item.name === file.name && item.content === file.content)
        if (!exists) merged.push(file)
      }
      return merged
    })
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const native = e.nativeEvent as KeyboardEvent | undefined
      if (native?.isComposing || native?.keyCode === 229) {
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleStopGenerating = useCallback(() => {
    void cancelCurrentRun?.().catch((error) => {
      console.error('[agent-cancel] failed', error)
    })
  }, [cancelCurrentRun])

  const handleSelectedModelChange = useCallback(
    (optionID: string) => {
      setSelectedModel(optionID)
      const selectedOption = modelOptions.find((item) => (item.optionID || item.modelID) === optionID)
      if (!selectedOption?.providerID || !selectedOption.modelID || !activeConversationKey) return
      const selectedModelPayload = {
        providerID: selectedOption.providerID,
        modelID: selectedOption.modelID,
      }
      upsertConversation(activeConversationKey, (prev) => ({
        ...prev,
        selectedModel: selectedModelPayload,
      }))

      if (!activeConversation?.sessionId) return
      void updateAgentSession(backendBaseUrl, activeConversation.sessionId, {
        workroomId,
        selectedModel: selectedModelPayload,
      }).catch((error) => {
        console.warn('[agent conversations] persist selected model failed', error)
      })
    },
    [activeConversation?.sessionId, activeConversationKey, backendBaseUrl, modelOptions, upsertConversation, workroomId],
  )

  const handleHitlFieldChange = useCallback(
    (fieldId: string, value: any) => {
      setHitlFormValues((prev) => ({ ...prev, [fieldId]: value }))
    },
    [],
  )

  const handleHitlSubmit = useCallback(
    async (evt?: React.FormEvent) => {
      evt?.preventDefault()
      if (!pendingInteraction || !resumeWithPayload) return
      setIsSubmittingHitlForm(true)
      try {
        if (pendingInteraction.kind === 'permission') {
          const payload = {
            reply:
              typeof hitlFormValues.reply === 'string' && ['once', 'always', 'reject'].includes(hitlFormValues.reply)
                ? hitlFormValues.reply
                : 'once',
            message: typeof hitlFormValues.message === 'string' ? hitlFormValues.message.trim() : '',
          }
          console.info('[agent-hitl] native permission reply submit', {
            requestId: pendingInteraction.requestId,
            reply: payload.reply,
          })
          await resumeWithPayload(payload)
        } else {
          const answers = pendingInteraction.request.questions.map((question, index) => {
            const value = hitlFormValues[`q${index}`]
            if (question.multiple) {
              if (typeof value !== 'string') return []
              return value
                .split(/\r?\n|,/)
                .map((item) => item.trim())
                .filter(Boolean)
            }
            if (typeof value === 'string' && value.trim()) return [value.trim()]
            return []
          })
          console.info('[agent-hitl] native question reply submit', {
            requestId: pendingInteraction.requestId,
            answersCount: answers.length,
          })
          await resumeWithPayload({ answers })
        }
      } catch (err) {
        console.error('[agent-hitl] resume submit failed', err)
        throw err
      } finally {
        setIsSubmittingHitlForm(false)
      }
    },
    [hitlFormValues, pendingInteraction, resumeWithPayload],
  )

  const handleHitlCancel = useCallback(() => {
    setHitlFormValues({})
    setIsSubmittingHitlForm(false)
  }, [])

  const defaultAnimation = workingCatAnimation

  const greeting = useMemo<GreetingInfo>(() => {
    const hour = new Date().getHours()
    const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)]

    if (hour < 6) {
      return {
        title: t('agent_chat.greeting_night_title'),
        subtitle: pick([
          t('agent_chat.greeting_night_1'),
          t('agent_chat.greeting_night_2'),
          t('agent_chat.greeting_night_3'),
        ]),
        animation: workingCatAnimation,
      }
    }
    if (hour < 12) {
      return {
        title: t('agent_chat.greeting_morning_title'),
        subtitle: pick([
          t('agent_chat.greeting_morning_1'),
          t('agent_chat.greeting_morning_2'),
          t('agent_chat.greeting_morning_3'),
        ]),
        animation: workingCatAnimation,
      }
    }
    if (hour < 18) {
      return {
        title: t('agent_chat.greeting_afternoon_title'),
        subtitle: pick([
          '冷笑话：电脑为什么会累？因为它一直在“处理器”。',
          t('agent_chat.greeting_afternoon_2'),
          t('agent_chat.greeting_afternoon_3'),
        ]),
        animation: noInternetAnimation,
      }
    }
    return {
      title: t('agent_chat.greeting_evening_title'),
      subtitle: pick([
        t('agent_chat.greeting_evening_1'),
        t('agent_chat.greeting_evening_2'),
        t('agent_chat.greeting_evening_3'),
      ]),
      animation: workingCatAnimation,
    }
  }, [t])

  const drawerRef = useRef<HTMLElement | null>(null)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)

  const handleStartNewConversation = useCallback(() => {
    if (activeConversationKey) {
      handleConversationMessagesChange(activeConversationKey, messages as any, sessionId ?? null)
    }
    setBoundConversationKey(null)
    resetChat()
    handleCreateConversation(documentId ?? null)
  }, [
    activeConversationKey,
    documentId,
    handleConversationMessagesChange,
    handleCreateConversation,
    messages,
    resetChat,
    sessionId,
  ])

  const AssistantMessage = useMemo(
    () => React.memo(({ msg }: { msg: any }) => <AssistantNaturalFlow msg={msg} onCitationClick={onCitationClick} />),
    [onCitationClick],
  )

  const UserMessage: React.FC<{ msg: any }> = useMemo(
    () =>
      React.memo(({ msg }: { msg: any }) => {
        const [copied, setCopied] = useState(false)
        const textContent =
          typeof msg.content === 'string'
            ? msg.content
            : mathContentToPromptText(ensureMathContentDocument(msg.content))
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : []

        const handleCopy = async () => {
          const text = textContent
          if (!text) return
          let success = false

          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(text)
              success = true
            }
          } catch {
            success = false
          }

          if (!success) {
            try {
              const textarea = document.createElement('textarea')
              textarea.value = text
              textarea.setAttribute('readonly', 'true')
              textarea.style.position = 'fixed'
              textarea.style.opacity = '0'
              textarea.style.pointerEvents = 'none'
              document.body.appendChild(textarea)
              textarea.select()
              textarea.setSelectionRange(0, text.length)
              success = document.execCommand('copy')
              document.body.removeChild(textarea)
            } catch {
              success = false
            }
          }

          if (success) {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          }
        }

        return (
          <div className="group flex gap-3 flex-row-reverse">
            <div className="h-9 w-9 rounded-full shrink-0 inline-flex items-center justify-center bg-slate-200 text-slate-600">
              {user.display_name?.slice(0, 1) || t('agent_chat.user_default_name')}
            </div>
            <div className="relative max-w-[72%]">
              <div className="rounded-2xl px-4 py-3 bg-slate-100 text-slate-800 shadow-sm text-left">
                {textContent.trim() ? <MarkdownWithMath>{textContent}</MarkdownWithMath> : null}
                {attachments.length > 0 && (
                  <div className={`${textContent.trim() ? 'mt-3' : ''} flex flex-wrap gap-1.5`}>
                    {attachments.map((file: any, index: number) => {
                      const name = typeof file?.filename === 'string' ? file.filename : ''
                      if (!name.trim()) return null
                      return (
                        <span
                          key={`${name}-${index}`}
                          className="inline-flex max-w-full items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600"
                          title={name}
                        >
                          <Icon name={'description'} className="text-[12px] mr-1 text-slate-500" />
                          <span className="truncate max-w-[220px]">{name}</span>
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label={t('agent_chat.copy_message')}
                title={t('agent_chat.copy_message')}
                onClick={handleCopy}
                className="absolute -right-6 bottom-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-slate-700"
              >
                <Icon name={copied ? 'check' : 'content_copy'} className="text-[16px] leading-none" />
              </button>
            </div>
          </div>
        )
      }, (prev, next) => {
        const prevContent = typeof prev.msg?.content === 'string' ? prev.msg.content : JSON.stringify(prev.msg?.content ?? null)
        const nextContent = typeof next.msg?.content === 'string' ? next.msg.content : JSON.stringify(next.msg?.content ?? null)
        const prevAttachments = JSON.stringify(
          Array.isArray(prev.msg?.attachments)
            ? prev.msg.attachments.map((file: any) => ({ filename: file?.filename, mime: file?.mime }))
            : [],
        )
        const nextAttachments = JSON.stringify(
          Array.isArray(next.msg?.attachments)
            ? next.msg.attachments.map((file: any) => ({ filename: file?.filename, mime: file?.mime }))
            : [],
        )
        return prev.msg?.id === next.msg?.id && prevContent === nextContent && prevAttachments === nextAttachments
      }),
    [user.display_name],
  )

  const renderComposer = useCallback(
    (variant: 'centered' | 'bottom') => {
    const isBottom = variant === 'bottom'
    return (
      <form
        onSubmit={handleSend}
        className={
          isBottom
            ? 'px-3 py-2.5 text-left'
            : 'w-full max-w-lg px-4 text-left'
        }
      >
        <MetalInputBox
          value={input}
          onChange={setInput}
          onKeyDown={handleKeyDown}
          placeholder={
            mathInputEnabled
              ? '输入消息，可直接写数理化表达'
              : t('agent_chat.input_placeholder')
          }
          inputHeight={inputHeight}
          onHeightChange={setInputHeight}
          sendButtonSize={sendButtonSize}
          onSend={handleSend}
          onStop={handleStopGenerating}
          canSend={canSend}
          disabled={false}
          isGenerating={isLoading}
          selectedModel={selectedModel}
          onModelChange={handleSelectedModelChange}
          modelOptions={modelOptions}
          onOpenSkillSettings={() => setIsSkillSettingsOpen(true)}
          onOpenMcpSettings={() => setIsMcpSettingsOpen(true)}
          onUploadAgentFiles={handleUploadAgentFiles}
          attachedFileNames={inputFiles.map((item) => item.name)}
          mathInputEnabled={mathInputEnabled}
          backendBaseUrl={backendBaseUrl}
          userId={user.id}
        />
        {error && !isBottom && <div className="mt-3 text-sm text-red-500 text-center">{error}</div>}
      </form>
    )
  },
    [backendBaseUrl, canSend, error, handleKeyDown, handleSelectedModelChange, handleSend, handleStopGenerating, handleUploadAgentFiles, input, inputFiles, inputHeight, isLoading, mathInputEnabled, modelOptions, selectedModel, sendButtonSize, t, user.id],
  )

  return (
    <div className="fixed inset-0 z-40 pointer-events-none">
      <aside
        className={`fixed top-0 right-0 h-full bg-white flex flex-col transition-transform duration-300 pointer-events-auto ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        ref={drawerRef}
        data-agent-panel
        style={{
          width: Math.min(Math.max(width, 360), 640),
          maxWidth: '90vw',
        }}
      >
        <div className="flex flex-col h-full">
          {/* 顶部工具栏：标题下拉 + 新建按钮 */}
          <div className="relative h-[46px] flex items-center justify-between px-6 border-b border-neutral-200 bg-white/80 backdrop-blur-sm">
            <button
              onClick={() => setIsHistoryOpen(!isHistoryOpen)}
              className="flex items-center space-x-2 group max-w-[85%] -ml-1 px-2 py-1.5 rounded-lg hover:bg-neutral-100 transition-colors"
            >
              <span className="text-sm font-semibold text-neutral-900 truncate">
                {(activeConversation?.title && activeConversation.title !== '新的会话') ? activeConversation.title : t('agent_chat.new_conversation')}
              </span>
              <svg
                className={`w-3.5 h-3.5 text-neutral-400 transition-transform ${isHistoryOpen ? 'rotate-180' : ''}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
            <button
              onClick={handleStartNewConversation}
              className="text-neutral-400 hover:text-neutral-900 p-2 hover:bg-neutral-100 rounded-full transition-colors"
              aria-label={t('agent_chat.new_conversation_aria')}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
          </div>

          <div className="relative flex-1 flex flex-col min-h-0">
            {isHistoryOpen ? (
              <AgentConversationHistory
                conversations={conversations}
                activeConversationKey={activeConversationKey}
                isOpen={isHistoryOpen}
                onClose={() => setIsHistoryOpen(false)}
                onSelectConversation={handleSelectConversation}
                onDeleteConversation={handleDeleteConversation}
                onRenameConversation={handleRenameConversation}
              />
            ) : null}

            <div className={`flex-1 flex flex-col min-w-0 min-h-0 ${!isHistoryOpen ? 'border-t border-neutral-200' : ''}`}>
              {hasMessages ? (
                <>
                  <div className={`flex-1 overflow-y-auto px-4 pt-6 pb-5 ${!isHistoryOpen ? 'border-t border-neutral-200' : ''}`}>
                    <div className="flex flex-col gap-4 text-sm text-slate-700 min-h-[340px]">
                      {deferredMessages.map((msg, idx) => {
                        const key = `${msg.role}-${idx}`
                        const isAssistant = msg.role === 'assistant'
                        const shouldShowHitlForm = Boolean(pendingInteraction) && hitlAnchorIndex === idx && isAssistant

                        return (
                          <React.Fragment key={key}>
                            {isAssistant ? <AssistantMessage msg={msg} /> : <UserMessage msg={msg} />}
                            {shouldShowHitlForm && (
                              <div className="flex gap-3">
                                <div className="flex-1 min-w-0">
                                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
                                  {t('agent_chat.form_title')}
                                </div>
                                <div className="rounded-2xl border border-slate-200 bg-white/80 shadow-sm px-4 py-3">
                                  <div className="text-xs font-semibold text-slate-600 mb-2">
                                    {pendingInteraction?.kind === 'permission'
                                      ? `Approval required: ${pendingInteraction.request.permission}`
                                      : 'Agent requires input'}
                                  </div>
                                  {pendingInteraction?.kind === 'permission' &&
                                    Array.isArray(pendingInteraction.request.patterns) &&
                                    pendingInteraction.request.patterns.length > 0 && (
                                      <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
                                        <div className="font-medium text-slate-700 mb-1">Requested paths</div>
                                        <div className="space-y-1">
                                          {pendingInteraction.request.patterns.map((pattern) => (
                                            <div key={pattern} className="break-all font-mono">
                                              {pattern}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  <form onSubmit={handleHitlSubmit} className="space-y-3">
                                    {pendingInteraction?.kind === 'permission' ? (
                                      <>
                                        <div className="flex flex-col gap-1.5">
                                          <label className="text-xs text-slate-500">Decision</label>
                                          <div className="grid gap-1.5">
                                            {[
                                              { value: 'once', label: 'Allow once' },
                                              { value: 'always', label: 'Always allow' },
                                              { value: 'reject', label: 'Reject' },
                                            ].map((opt) => {
                                              const checked = String(hitlFormValues.reply ?? 'once') === opt.value
                                              return (
                                                <label
                                                  key={opt.value}
                                                  className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition ${
                                                    checked
                                                      ? 'border-slate-500 bg-slate-50 text-slate-900'
                                                      : 'border-slate-300 text-slate-700'
                                                  }`}
                                                >
                                                  <input
                                                    type="radio"
                                                    name="reply"
                                                    value={opt.value}
                                                    checked={checked}
                                                    disabled={isSubmittingHitlForm}
                                                    onChange={(e) => handleHitlFieldChange('reply', e.target.value)}
                                                  />
                                                  <span>{opt.label}</span>
                                                </label>
                                              )
                                            })}
                                          </div>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                          <label className="text-xs text-slate-500">Message</label>
                                          <textarea
                                            value={String(hitlFormValues.message ?? '')}
                                            disabled={isSubmittingHitlForm}
                                            placeholder="Optional feedback"
                                            onChange={(e) => handleHitlFieldChange('message', e.target.value)}
                                            className="w-full min-h-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
                                          />
                                        </div>
                                      </>
                                    ) : (
                                      pendingInteraction?.request.questions.map((question, index) => {
                                        const fieldId = `q${index}`
                                        const value = hitlFormValues[fieldId] ?? ''
                                        if (question.multiple || question.custom) {
                                          return (
                                            <div key={fieldId} className="flex flex-col gap-1">
                                              <label className="text-xs text-slate-500">{question.header || question.question}</label>
                                              <textarea
                                                value={String(value)}
                                                disabled={isSubmittingHitlForm}
                                                placeholder={question.multiple ? 'One answer per line' : ''}
                                                onChange={(e) => handleHitlFieldChange(fieldId, e.target.value)}
                                                className="w-full min-h-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
                                              />
                                            </div>
                                          )
                                        }
                                        return (
                                          <div key={fieldId} className="flex flex-col gap-1">
                                            <label className="text-xs text-slate-500">{question.header || question.question}</label>
                                            <select
                                              value={String(value)}
                                              disabled={isSubmittingHitlForm}
                                              onChange={(e) => handleHitlFieldChange(fieldId, e.target.value)}
                                              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
                                            >
                                              {question.options.map((opt) => (
                                                <option key={opt.label} value={opt.label}>
                                                  {opt.label}
                                                </option>
                                              ))}
                                            </select>
                                          </div>
                                        )
                                      })
                                    )}
                                    <div className="pt-1 flex justify-end gap-2">
                                        <button
                                          type="button"
                                          className="px-3 py-1.5 rounded-full text-xs border border-slate-300 text-slate-500 hover:bg-slate-100 transition disabled:opacity-50"
                                          onClick={handleHitlCancel}
                                          disabled={isSubmittingHitlForm}
                                        >
                                          {t('agent_chat.cancel')}
                                        </button>
                                        <button
                                          type="submit"
                                          disabled={isSubmittingHitlForm}
                                          className="px-3 py-1.5 rounded-full text-xs bg-slate-900 text-white disabled:opacity-60"
                                        >
                                          {isSubmittingHitlForm ? t('agent_chat.submitting') : t('agent_chat.confirm')}
                                        </button>
                                    </div>
                                  </form>
                                </div>
                                </div>
                              </div>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </div>

                    {error && <div className="mt-3 text-sm text-red-500">{error}</div>}
                  </div>
                  {renderComposer('bottom')}
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-6">
                  <div>
                    <div className="mb-4 flex items-center justify-center">
                      <Lottie
                        animationData={greeting.animation ?? defaultAnimation}
                        loop
                        autoPlay
                        className="h-28 w-40 drop-shadow-[0_10px_30px_rgba(15,23,42,0.15)]"
                      />
                    </div>
                    <h2 className="text-xl font-semibold text-slate-900">{greeting.title}</h2>
                    <blockquote className="mt-3 text-left text-[15px] text-slate-500 italic leading-relaxed border-l-4 border-slate-200 pl-4">
                      {greeting.subtitle}
                    </blockquote>
                  </div>
                  {renderComposer('centered')}
                </div>
              )}
            </div>
          </div>
        </div>

        {onResize && (
          <div
            className="absolute top-0 left-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-slate-200/60 transition-colors"
            onMouseDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const pane = drawerRef.current
              const rect = pane?.getBoundingClientRect()
              const startWidth = rect?.width ?? width
              let pendingWidth = startWidth
              const handleMove = (evt: MouseEvent) => {
                const delta = startX - evt.clientX
                const next = Math.min(Math.max(startWidth + delta, 360), 640)
                pendingWidth = next
                const currentPane = drawerRef.current
                if (currentPane) {
                  currentPane.style.width = `${next}px`
                  currentPane.style.maxWidth = '90vw'
                }
              }
              const handleUp = () => {
                window.removeEventListener('mousemove', handleMove)
                window.removeEventListener('mouseup', handleUp)
                if (onResize) {
                  onResize(pendingWidth)
                }
              }
              window.addEventListener('mousemove', handleMove)
              window.addEventListener('mouseup', handleUp)
            }}
          />
        )}
      </aside>

      <SkillSettingsDialog
        open={isSkillSettingsOpen}
        onClose={() => setIsSkillSettingsOpen(false)}
        backendBaseUrl={backendBaseUrl}
        workroomId={workroomId}
        sessionId={sessionId}
      />

      <McpSettingsDialog
        open={isMcpSettingsOpen}
        onClose={() => setIsMcpSettingsOpen(false)}
        backendBaseUrl={backendBaseUrl}
        workroomId={workroomId}
      />

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #d1d1d6;
          border-radius: 10px;
          border: 1px solid white;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #a2a2a7;
        }
      `}</style>
    </div>
  )
}
