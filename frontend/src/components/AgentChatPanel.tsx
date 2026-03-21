import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentChat } from '../hooks/useAgentChat'
import { useConversation } from '../hooks'
import type { AgentRunContext, AgentSendPayload, AgUiEvent, UserInfo } from '../types'
import { MarkdownWithMath } from './MarkdownWithMath'
import Lottie from 'lottie-react'
import workingCatAnimation from '../assets/animations/workingCat.json'
import noInternetAnimation from '../assets/animations/noInternet.json'
import { RobotGlowFace } from './RobotGlowFace'
import { AgentConversationHistory } from './AgentConversationHistory'
import { MetalInputBox } from './MetalInputBox'
import { useQuestionTypeOptions } from '../hooks/useQuestionTypeOptions'
import { QuestionTypeSelectField } from './QuestionTypeSelectField'
import { OpenUiHitlRenderer } from './OpenUiHitlRenderer'

interface AgentChatPanelProps {
  backendBaseUrl: string
  user: UserInfo
  workroomId: number
  documentId?: number | null
  /** 会话视图 ID，用于区分同一文档下不同编辑视图/标签 */
  viewId?: string | null
  isOpen: boolean
  onClose: () => void
  width?: number
  onResize?: (width: number) => void
  appendToken?: { id: number; payload: AgentSendPayload } | null
  onAgUiEvent?: (event: AgUiEvent) => void
  onAppendTokenConsumed?: (id: number) => void
  onDocumentResolved?: (documentId: number) => void
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

function normalizeFormUiCandidate(raw: unknown): any | null {
  if (!raw || typeof raw !== 'object') return null
  const ui = raw as Record<string, any>
  if (ui.type === 'form' || Array.isArray(ui.fields)) {
    const normalized = { ...ui, type: 'form' } as Record<string, any>
    if (Array.isArray(normalized.actions)) {
      const actions = normalized.actions.filter((action: any) => action && typeof action === 'object')
      const submitAction =
        actions.find((action: any) => String(action.id || '').toLowerCase() === 'submit') ||
        actions.find((action: any) => String(action.variant || '').toLowerCase() === 'primary')
      const cancelAction =
        actions.find((action: any) => String(action.id || '').toLowerCase() === 'cancel') ||
        actions.find((action: any) => String(action.variant || '').toLowerCase() === 'secondary')
      if (submitAction?.label) {
        normalized.submit = { ...(normalized.submit || {}), label: String(submitAction.label) }
      }
      if (cancelAction?.label) {
        normalized.cancel = { ...(normalized.cancel || {}), label: String(cancelAction.label) }
      }
    }
    if (Array.isArray(normalized.fields)) {
      normalized.fields = normalized.fields
        .map((field: any) => {
          if (!field || typeof field !== 'object') return null
          const fieldId = String(field.id || field.name || '').trim()
          if (!fieldId) return null
          const rawType = String(field.type || 'text').trim().toLowerCase()
          const normalizedType =
            rawType === 'longtext' || rawType === 'textarea'
              ? 'textarea'
              : rawType === 'radio' || rawType === 'choice'
                ? 'radio'
                : rawType
          const out: Record<string, any> = {
            ...field,
            id: fieldId,
            name: String(field.name || fieldId),
            label: String(field.label || fieldId),
            type: normalizedType || 'text',
          }
          if (Array.isArray(field.options)) {
            out.options = field.options
              .map((opt: any) => {
                if (opt == null) return null
                if (typeof opt === 'string' || typeof opt === 'number' || typeof opt === 'boolean') {
                  const value = String(opt)
                  return { value, label: value }
                }
                if (typeof opt === 'object') {
                  const value = String((opt as any).value ?? (opt as any).id ?? (opt as any).label ?? '').trim()
                  if (!value) return null
                  return { value, label: String((opt as any).label ?? value) }
                }
                return null
              })
              .filter(Boolean)
          }
          if (Object.prototype.hasOwnProperty.call(field, 'defaultValue') && !Object.prototype.hasOwnProperty.call(field, 'default')) {
            out.default = field.defaultValue
          }
          return out
        })
        .filter(Boolean)
    }
    return normalized
  }
  return null
}

function extractInterruptFormFromAgUiEvent(rawEvent: unknown): any | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null
  const event = rawEvent as Record<string, any>
  const action = String(event.action || '')

  if (action === 'form.show') {
    return normalizeFormUiCandidate(event?.payload?.ui)
  }

  if (action !== 'openui.render') {
    return null
  }

  const openui = event?.payload?.openui
  if (openui && typeof openui === 'object') {
    const ui = normalizeFormUiCandidate(openui)
    if (ui) return ui
  }

  return null
}

function extractOpenUiResponseFromAgUiEvent(rawEvent: unknown): string | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null
  const event = rawEvent as Record<string, any>
  if (String(event.action || '') !== 'openui.render') return null
  const payload = event.payload as Record<string, any>
  const response = payload?.response
  if (typeof response === 'string' && response.trim()) return response
  return null
}

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
  onAgUiEvent,
  onAppendTokenConsumed,
  onDocumentResolved,
}) => {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [inputHeight, setInputHeight] = useState(36)
  const [hitlFormUi, setHitlFormUi] = useState<any | null>(null)
  const [hitlOpenUiResponse, setHitlOpenUiResponse] = useState<string | null>(null)
  const [hitlFormValues, setHitlFormValues] = useState<Record<string, any>>({})
  const [isSubmittingHitlForm, setIsSubmittingHitlForm] = useState(false)
  const [hitlAnchorIndex, setHitlAnchorIndex] = useState<number | null>(null)
  const hitlResumeInFlightRef = useRef(false)
  const [isQuestionTypeEnsuring, setIsQuestionTypeEnsuring] = useState(false)
  // 当前 useAgentChat 状态所“绑定”的会话 key，用于避免在切换会话过程中
  // 将上一会话的消息和 sessionId 写入到新激活的会话元信息中。
  const [boundConversationKey, setBoundConversationKey] = useState<string | null>(null)

  const batchMeta = appendToken?.payload.batchMeta
  const effectiveUiContext: AgentRunContext = appendToken?.payload.uiContextOverride ?? 'exam_editor'

  const questionTypeField = useMemo(() => {
    if (!Array.isArray(hitlFormUi?.fields)) return null
    return hitlFormUi.fields.find((field: any) => field && field.id === 'question_type') ?? null
  }, [hitlFormUi])

  const questionTypeSeedOptions = useMemo(() => {
    if (!questionTypeField || !Array.isArray(questionTypeField.options)) return []
    return questionTypeField.options
      .map((opt: any) => {
        if (!opt) return ''
        if (typeof opt.value === 'string' && opt.value.trim()) return opt.value.trim()
        if (typeof opt.label === 'string' && opt.label.trim()) return opt.label.trim()
        return ''
      })
      .filter((name: string, idx: number, arr: string[]) => Boolean(name) && arr.indexOf(name) === idx)
  }, [questionTypeField])

  const {
    options: questionTypeOptions,
    isLoading: questionTypeOptionsLoading,
    error: questionTypeOptionsError,
    ensureQuestionTypeExists,
    refresh: refreshQuestionTypeOptions,
  } = useQuestionTypeOptions({
    backendBaseUrl,
    tenantId: user?.tenant_id,
    enabled: Boolean(questionTypeField),
    seedOptions: questionTypeSeedOptions,
  })

  const questionTypeOptionSet = useMemo(() => {
    return new Set(
      (questionTypeOptions || [])
        .map((name) => (typeof name === 'string' ? name.trim() : ''))
        .filter((name) => Boolean(name)),
    )
  }, [questionTypeOptions])

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
  } = useConversation(backendBaseUrl, {
    tenantId: user?.tenant_id,
    userId: user?.id,
    workroomId,
    documentId: documentId ?? null,
  })

  const {
    messages,
    isLoading,
    error,
    sendMessage,
    resumeWithPayload,
    resetChat,
    sessionId,
    setSessionId,
    setMessagesFromHistory,
  } = useAgentChat({
    backendBaseUrl,
    tenantId: user?.tenant_id,
    userId: user?.id,
    workroomId,
    uiContext: effectiveUiContext,
    documentId,
    viewId,
    onAgUiEvent: (event) => {
        const inner = event.event as any
        const openUiResponse = extractOpenUiResponseFromAgUiEvent(inner)
        if (openUiResponse) {
          if (isSubmittingHitlForm || hitlResumeInFlightRef.current) {
            return
          }
          setHitlOpenUiResponse(openUiResponse)
          setHitlFormUi(null)
          setHitlFormValues({})
          setIsSubmittingHitlForm(false)
          if (onAgUiEvent) {
            onAgUiEvent(inner)
          }
          return
        }
        const ui = extractInterruptFormFromAgUiEvent(inner)
        if (ui) {
          // 如果当前正处于提交过程中，则忽略新的 form.show，避免在同一轮 resume 过程中
          // 再次出现表单；下一轮对话会重新进入 HITL 时再接收新的表单。
          if (isSubmittingHitlForm || hitlResumeInFlightRef.current) {
            return
          }
          const patchedUi = { ...ui }
          if (Array.isArray(patchedUi.fields)) {
            patchedUi.fields = patchedUi.fields.map((field: any) => {
              if (!field || field.type !== 'number' || field.id !== 'count') return field
              const originalMax = typeof field.max === 'number' ? field.max : 5
              const capacity = typeof batchMeta?.maxCapacity === 'number' ? batchMeta.maxCapacity : originalMax
              const nextMax = Math.max(1, Math.min(originalMax, capacity))
              return {
                ...field,
                max: nextMax,
                default:
                  typeof field.default === 'number'
                    ? Math.min(field.default, nextMax)
                    : Math.min(3, nextMax),
              }
            })
          }
          setHitlFormUi(patchedUi)
          const initial: Record<string, any> = {}
          if (Array.isArray(patchedUi.fields)) {
            for (const field of patchedUi.fields) {
              if (!field || !field.id) continue
              initial[field.id] = field.default ?? ''
            }
          }
          setHitlFormValues(initial)
          setHitlOpenUiResponse(null)
          setIsSubmittingHitlForm(false)
        }
        if (onAgUiEvent) {
          onAgUiEvent(inner)
        }
      },
      // 如果当前有来自题卡/笔记的 noteFocus，就优先携带给本轮对话
      noteFocus: appendToken?.payload.noteFocus,
      onDocumentResolved,
    })
  const deferredMessages = useDeferredValue(messages)

  // 会话重置信号变化时（新建/切换会话），根据当前会话元信息和存量消息灌入 useAgentChat。
  // 仅在 conversationResetSignal 变化时运行一次，避免与 messages -> store 同步形成更新环。
  useEffect(() => {
    if (!conversationResetSignal) return
    if (!activeConversationKey || !activeConversation) return

    // 在真正灌入消息之前，先将 useAgentChat 绑定到当前激活会话 key，
    // 后续 messages -> store 的同步只会作用于这个已绑定会话，
    // 避免在“激活 key 已变、更但消息仍是旧会话”的中间态下发生串写。
    setBoundConversationKey(activeConversationKey)

    ;(setSessionId as (id: number | null) => void)(activeConversation.sessionId ?? null)
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
  const sendButtonSize = useMemo(() => Math.max(Math.min(inputHeight - 10, 38), 28), [inputHeight])

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
    if ((hitlFormUi || hitlOpenUiResponse) && hitlAnchorIndex == null) {
      for (let idx = deferredMessages.length - 1; idx >= 0; idx -= 1) {
        if (deferredMessages[idx]?.role === 'assistant') {
          setHitlAnchorIndex(idx)
          break
        }
      }
    }
    if (!hitlFormUi && !hitlOpenUiResponse && hitlAnchorIndex != null) {
      setHitlAnchorIndex(null)
    }
  }, [hitlFormUi, hitlOpenUiResponse, hitlAnchorIndex, deferredMessages])

  const handleSend = useCallback(
    async (evt?: React.FormEvent) => {
      evt?.preventDefault()
      if (!canSend) return
      const content = input.trim()
      setInput('')
      setInputHeight(36)
      try {
        await sendMessage(content)
      } catch {
        // error state is handled in hook
      }
    },
    [canSend, input, sendMessage],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
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
      if (!hitlFormUi || !resumeWithPayload) return
      const uiSnapshot = hitlFormUi
      const valuesSnapshot = { ...hitlFormValues }
      setIsSubmittingHitlForm(true)
      try {
        const payload: Record<string, any> = { ...hitlFormValues }
        if (typeof payload.question_type === 'string') {
          payload.question_type = payload.question_type.trim()
        }
        const maxCapacity = typeof batchMeta?.maxCapacity === 'number' ? batchMeta.maxCapacity : undefined
        if (typeof payload.count === 'number' && typeof maxCapacity === 'number') {
          payload.count = Math.max(1, Math.min(payload.count, maxCapacity))
        }
        if (batchMeta) {
          payload.maxCapacity = maxCapacity
          if (batchMeta.baseQuestionId != null) payload.baseQuestionId = batchMeta.baseQuestionId
          if (batchMeta.baseSequenceIndex != null) payload.baseSequenceIndex = batchMeta.baseSequenceIndex
        }

        if (questionTypeField) {
          const rawType = typeof payload.question_type === 'string' ? payload.question_type.trim() : ''
          if (rawType) {
            payload.question_type = rawType
            if (!questionTypeOptionSet.has(rawType)) {
              setIsQuestionTypeEnsuring(true)
              try {
                const ensuredName = await ensureQuestionTypeExists(rawType)
                if (ensuredName) {
                  payload.question_type = ensuredName
                  refreshQuestionTypeOptions()
                }
              } finally {
                setIsQuestionTypeEnsuring(false)
              }
            }
          }
        }

        // 在真正发起 resume 之前，立即清空表单及其锚点，避免在后续流式回复
        // 中继续渲染同一块表单。
        hitlResumeInFlightRef.current = true
        setHitlFormUi(null)
        setHitlFormValues({})
        setHitlAnchorIndex(null)
        await resumeWithPayload(payload)
        hitlResumeInFlightRef.current = false
      } catch (err) {
        hitlResumeInFlightRef.current = false
        // 如果恢复流程失败，重新展示表单供用户再次提交
        setHitlFormUi(uiSnapshot)
        setHitlFormValues(valuesSnapshot)
        throw err
      } finally {
        setIsSubmittingHitlForm(false)
      }
    },
    [
      batchMeta,
      ensureQuestionTypeExists,
      hitlFormUi,
      hitlFormValues,
      questionTypeField,
      questionTypeOptionSet,
      refreshQuestionTypeOptions,
      resumeWithPayload,
    ],
  )

  const handleOpenUiContinue = useCallback(
    async (evt: { params: Record<string, any>; formState: Record<string, any> }) => {
      if (!resumeWithPayload) return
      const actionId = String(evt?.params?.actionId || '').toLowerCase()
      if (actionId === 'cancel') {
        hitlResumeInFlightRef.current = false
        setHitlOpenUiResponse(null)
        setHitlFormUi(null)
        setHitlFormValues({})
        setIsSubmittingHitlForm(false)
        return
      }
      const payload: Record<string, any> = { ...(evt?.formState || {}) }
      setIsSubmittingHitlForm(true)
      try {
        if (typeof payload.question_type === 'string') {
          payload.question_type = payload.question_type.trim()
        }
        const maxCapacity = typeof batchMeta?.maxCapacity === 'number' ? batchMeta.maxCapacity : undefined
        if (typeof payload.count === 'number' && typeof maxCapacity === 'number') {
          payload.count = Math.max(1, Math.min(payload.count, maxCapacity))
        }
        if (batchMeta) {
          payload.maxCapacity = maxCapacity
          if (batchMeta.baseQuestionId != null) payload.baseQuestionId = batchMeta.baseQuestionId
          if (batchMeta.baseSequenceIndex != null) payload.baseSequenceIndex = batchMeta.baseSequenceIndex
        }
        if (questionTypeField) {
          const rawType = typeof payload.question_type === 'string' ? payload.question_type.trim() : ''
          if (rawType) {
            payload.question_type = rawType
            if (!questionTypeOptionSet.has(rawType)) {
              setIsQuestionTypeEnsuring(true)
              try {
                const ensuredName = await ensureQuestionTypeExists(rawType)
                if (ensuredName) {
                  payload.question_type = ensuredName
                  refreshQuestionTypeOptions()
                }
              } finally {
                setIsQuestionTypeEnsuring(false)
              }
            }
          }
        }
        hitlResumeInFlightRef.current = true
        setHitlOpenUiResponse(null)
        setHitlFormUi(null)
        setHitlFormValues({})
        setHitlAnchorIndex(null)
        await resumeWithPayload(payload)
        hitlResumeInFlightRef.current = false
      } catch (err) {
        hitlResumeInFlightRef.current = false
        throw err
      } finally {
        setIsSubmittingHitlForm(false)
      }
    },
    [
      batchMeta,
      ensureQuestionTypeExists,
      questionTypeField,
      questionTypeOptionSet,
      refreshQuestionTypeOptions,
      resumeWithPayload,
    ],
  )

  const handleHitlCancel = useCallback(() => {
    hitlResumeInFlightRef.current = false
    setHitlFormUi(null)
    setHitlOpenUiResponse(null)
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

  const AssistantMessage: React.FC<{ msg: any }> = useMemo(
    () =>
      React.memo(({ msg }: { msg: any }) => {
        const traces = Array.isArray(msg.historyTraces) ? msg.historyTraces : []
        const hasTrace = traces.length > 0
        const hasContent = Boolean(msg.content?.trim())
        const showPendingOnly = Boolean(msg.isStreaming) && !hasContent && !hasTrace
        const [traceExpanded, setTraceExpanded] = useState(Boolean(msg.isStreaming) && hasTrace)
        useEffect(() => {
          if (!hasTrace) {
            setTraceExpanded(false)
            return
          }
          if (msg.isStreaming) {
            setTraceExpanded(true)
            return
          }
          setTraceExpanded(false)
        }, [hasTrace, msg.isStreaming])
        if (!hasContent && !hasTrace && !showPendingOnly) {
          return null
        }
        const keyLabel = 'Ordis'
        return (
          <div className="flex gap-3">
            <div className="shrink-0">
              <RobotGlowFace className="pointer-events-none select-none" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{keyLabel}</div>
              {hasTrace && (
                <div className={`mb-3 ${(Boolean(msg.isStreaming) || traceExpanded) ? 'border-l border-slate-200 pl-3' : ''}`}>
                  <button
                    type="button"
                    onClick={() => setTraceExpanded((prev) => !prev)}
                    className="inline-flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-700 transition-colors"
                    aria-expanded={traceExpanded}
                  >
                    <span className={`material-symbols-outlined text-[14px] leading-none transition-transform ${traceExpanded ? 'rotate-90' : ''}`}>
                      chevron_right
                    </span>
                    <span>思考过程</span>
                  </button>
                  {traceExpanded && (
                    <div className="mt-1.5 space-y-1.5">
                      {traces.map((trace: any, idx: number) => (
                        <div key={trace.id ?? `${trace.type}-${idx}`} className="text-[12px] leading-relaxed text-slate-500">
                          {trace.type === 'tool' ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="material-symbols-outlined text-[16px] leading-none text-slate-500">build_circle</span>
                              <span>{trace.name || 'tool'}</span>
                              {trace.status === 'calling' ? (
                                <span className="material-symbols-outlined text-[16px] leading-none text-slate-400 animate-spin">progress_activity</span>
                              ) : trace.status === 'success' ? (
                                <span className="material-symbols-outlined text-[16px] leading-none text-emerald-600">check</span>
                              ) : trace.status === 'fail' ? (
                                <span className="material-symbols-outlined text-[16px] leading-none text-rose-600">close</span>
                              ) : null}
                            </span>
                          ) : (
                            <div className="prose prose-slate max-w-none text-[12px] leading-relaxed [&_.katex]:text-[12px] [&_.katex-display]:my-1.5">
                              <MarkdownWithMath>{normalizeAiMarkdown(String(trace.text || ''))}</MarkdownWithMath>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {msg.content?.trim() && (
                <div className="prose prose-slate max-w-none text-[15px] leading-relaxed">
                  <MarkdownWithMath>{normalizeAiMarkdown(msg.content)}</MarkdownWithMath>
                </div>
              )}

              {showPendingOnly && (
                <div className="flex flex-col gap-2 text-sm text-slate-500">
                  <span className="font-medium text-slate-600">{t('agent_chat.thinking')}</span>
                  <span className="flex items-center gap-1.5" aria-label="thinking animation">
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: '0ms' }}
                    />
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: '120ms' }}
                    />
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: '240ms' }}
                    />
                  </span>
                </div>
              )}
            </div>
          </div>
        )
      }, (prev, next) => (
        prev.msg?.id === next.msg?.id
        && prev.msg?.content === next.msg?.content
        && prev.msg?.isStreaming === next.msg?.isStreaming
        && prev.msg?.historyTraces === next.msg?.historyTraces
      )),
    [],
  )

  const UserMessage: React.FC<{ msg: any }> = useMemo(
    () =>
      React.memo(({ msg }: { msg: any }) => {
        const [copied, setCopied] = useState(false)

        const handleCopy = async () => {
          const text = String(msg?.content ?? '')
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
          <div className="group flex gap-3 flex-row-reverse text-right">
            <div className="h-9 w-9 rounded-full shrink-0 inline-flex items-center justify-center bg-slate-200 text-slate-600">
              {user.display_name?.slice(0, 1) || t('agent_chat.user_default_name')}
            </div>
            <div className="relative max-w-[72%]">
              <div className="rounded-2xl px-4 py-3 bg-slate-100 text-slate-800 shadow-sm">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                  {user.display_name || t('agent_chat.user_default_name')}
                </div>
                <MarkdownWithMath>{msg.content}</MarkdownWithMath>
              </div>
              <button
                type="button"
                aria-label={t('agent_chat.copy_message')}
                title={t('agent_chat.copy_message')}
                onClick={handleCopy}
                className="absolute -right-6 bottom-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-slate-700"
              >
                <span className="material-symbols-outlined text-[16px] leading-none">
                  {copied ? 'check' : 'content_copy'}
                </span>
              </button>
            </div>
          </div>
        )
      }, (prev, next) => prev.msg?.id === next.msg?.id && prev.msg?.content === next.msg?.content),
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
            ? 'px-3 py-2.5'
            : 'w-full max-w-lg px-4'
        }
      >
        <MetalInputBox
          value={input}
          onChange={setInput}
          onKeyDown={handleKeyDown}
          placeholder={t('agent_chat.input_placeholder')}
          inputHeight={inputHeight}
          onHeightChange={setInputHeight}
          sendButtonSize={sendButtonSize}
          onSend={handleSend}
          canSend={canSend}
          disabled={isLoading}
        />
        {error && !isBottom && <div className="mt-3 text-sm text-red-500 text-center">{error}</div>}
      </form>
    )
  },
    [canSend, error, handleKeyDown, handleSend, input, inputHeight, sendButtonSize, isLoading, t],
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
          <div className="relative h-14 flex items-center justify-between px-6 border-neutral-200 bg-white/80 backdrop-blur-sm">
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
                        const shouldShowHitlForm = Boolean(hitlFormUi || hitlOpenUiResponse) && hitlAnchorIndex === idx && isAssistant

                        return (
                          <React.Fragment key={key}>
                            {isAssistant ? <AssistantMessage msg={msg} /> : <UserMessage msg={msg} />}
                            {shouldShowHitlForm && (
                              <div className="flex gap-3">
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
                                    {t('agent_chat.form_title')}
                                  </div>
                                  {hitlOpenUiResponse ? (
                                    <OpenUiHitlRenderer response={hitlOpenUiResponse} onContinue={handleOpenUiContinue} />
                                  ) : (
                                    <div className="rounded-2xl border border-slate-200 bg-white/80 shadow-sm px-4 py-3">
                                      {hitlFormUi?.title && (
                                        <div className="text-xs font-semibold text-slate-600 mb-2">{hitlFormUi.title}</div>
                                      )}
                                      <form onSubmit={handleHitlSubmit} className="space-y-3">
                                      {Array.isArray(hitlFormUi?.fields) &&
                                        hitlFormUi.fields.map((field: any) => {
                                          if (!field || !field.id) return null
                                          const value = hitlFormValues[field.id] ?? ''
                                          if (field.type === 'number') {
                                            return (
                                              <div key={field.id} className="flex flex-col gap-1">
                                                <label className="text-xs text-slate-500">{field.label || field.id}</label>
                                                <input
                                                  type="number"
                                                  min={field.min}
                                                  max={field.max}
                                                  value={value}
                                                  disabled={isSubmittingHitlForm}
                                                  onChange={(e) =>
                                                    handleHitlFieldChange(
                                                      field.id,
                                                      e.target.value === '' ? '' : Number(e.target.value),
                                                    )
                                                  }
                                                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
                                                />
                                              </div>
                                            )
                                          }
                                          if (field.type === 'text' || field.type === 'textarea') {
                                            return (
                                              <div key={field.id} className="flex flex-col gap-1">
                                                <label className="text-xs text-slate-500">{field.label || field.id}</label>
                                                {field.type === 'textarea' ? (
                                                  <textarea
                                                    value={value}
                                                    disabled={isSubmittingHitlForm}
                                                    placeholder={field.placeholder || ''}
                                                    onChange={(e) => handleHitlFieldChange(field.id, e.target.value)}
                                                    className="w-full min-h-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
                                                  />
                                                ) : (
                                                  <input
                                                    type="text"
                                                    value={value}
                                                    disabled={isSubmittingHitlForm}
                                                    placeholder={field.placeholder || ''}
                                                    onChange={(e) => handleHitlFieldChange(field.id, e.target.value)}
                                                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
                                                  />
                                                )}
                                              </div>
                                            )
                                          }
                                          if (field.type === 'radio' && Array.isArray(field.options)) {
                                            return (
                                              <div key={field.id} className="flex flex-col gap-1.5">
                                                <label className="text-xs text-slate-500">{field.label || field.id}</label>
                                                <div className="grid gap-1.5">
                                                  {field.options.map((opt: any) => {
                                                    const optValue = String(opt?.value ?? '')
                                                    const checked = String(value ?? '') === optValue
                                                    return (
                                                      <label
                                                        key={optValue}
                                                        className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition ${
                                                          checked
                                                            ? 'border-slate-500 bg-slate-50 text-slate-900'
                                                            : 'border-slate-300 text-slate-700'
                                                        }`}
                                                      >
                                                        <input
                                                          type="radio"
                                                          name={field.id}
                                                          value={optValue}
                                                          checked={checked}
                                                          disabled={isSubmittingHitlForm}
                                                          onChange={(e) => handleHitlFieldChange(field.id, e.target.value)}
                                                        />
                                                        <span>{opt?.label ?? optValue}</span>
                                                      </label>
                                                    )
                                                  })}
                                                </div>
                                              </div>
                                            )
                                          }
                                          if (field.id === 'question_type' && field.type === 'select') {
                                            return (
                                              <QuestionTypeSelectField
                                                key={field.id}
                                                label={field.label || t('agent_chat.question_type_label')}
                                                value={value}
                                                options={questionTypeOptions}
                                                placeholder={field.placeholder || t('agent_chat.question_type_placeholder')}
                                                disabled={isSubmittingHitlForm || isQuestionTypeEnsuring}
                                                isLoading={questionTypeOptionsLoading}
                                                error={questionTypeOptionsError || undefined}
                                                onChange={(next) => handleHitlFieldChange(field.id, next)}
                                              />
                                            )
                                          }
                                          if (field.type === 'select' && Array.isArray(field.options)) {
                                            return (
                                              <div key={field.id} className="flex flex-col gap-1">
                                                <label className="text-xs text-slate-500">{field.label || field.id}</label>
                                                <select
                                                  value={value}
                                                  disabled={isSubmittingHitlForm}
                                                  onChange={(e) => handleHitlFieldChange(field.id, e.target.value)}
                                                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
                                                >
                                                  {field.options.map((opt: any) => (
                                                    <option key={opt.value} value={opt.value}>
                                                      {opt.label ?? opt.value}
                                                    </option>
                                                  ))}
                                                </select>
                                              </div>
                                            )
                                          }
                                          return null
                                        })}
                                      <div className="pt-1 flex justify-end gap-2">
                                        <button
                                          type="button"
                                          className="px-3 py-1.5 rounded-full text-xs border border-slate-300 text-slate-500 hover:bg-slate-100 transition disabled:opacity-50"
                                          onClick={handleHitlCancel}
                                          disabled={isSubmittingHitlForm}
                                        >
                                          {hitlFormUi?.cancel?.label || t('agent_chat.cancel')}
                                        </button>
                                        <button
                                          type="submit"
                                          disabled={isSubmittingHitlForm || isLoading || isQuestionTypeEnsuring}
                                          className="px-3 py-1.5 rounded-full text-xs bg-slate-900 text-white disabled:opacity-60"
                                        >
                                          {isQuestionTypeEnsuring
                                            ? t('agent_chat.creating_question_type')
                                            : isSubmittingHitlForm
                                              ? t('agent_chat.submitting')
                                              : hitlFormUi?.submit?.label || t('agent_chat.confirm')}
                                        </button>
                                      </div>
                                      </form>
                                    </div>
                                  )}
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
