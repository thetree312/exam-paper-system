import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

interface AgentChatPanelProps {
  backendBaseUrl: string
  user: UserInfo
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

export const AgentChatPanel: React.FC<AgentChatPanelProps> = ({
  backendBaseUrl,
  user,
  documentId,
  viewId,
  isOpen,
  onClose,
  width = 480,
  onResize,
  appendToken,
  onAgUiEvent,
  onAppendTokenConsumed,
  onDocumentResolved,
}) => {
  const [input, setInput] = useState('')
  const [inputHeight, setInputHeight] = useState(36)
  const [hitlFormUi, setHitlFormUi] = useState<any | null>(null)
  const [hitlFormValues, setHitlFormValues] = useState<Record<string, any>>({})
  const [isSubmittingHitlForm, setIsSubmittingHitlForm] = useState(false)
  const [hitlAnchorIndex, setHitlAnchorIndex] = useState<number | null>(null)
  const hitlResumeInFlightRef = useRef(false)
  // 当前 useAgentChat 状态所“绑定”的会话 key，用于避免在切换会话过程中
  // 将上一会话的消息和 sessionId 写入到新激活的会话元信息中。
  const [boundConversationKey, setBoundConversationKey] = useState<string | null>(null)

  const batchMeta = appendToken?.payload.batchMeta
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
  } = useConversation(backendBaseUrl, {
    tenantId: user?.tenant_id,
    userId: user?.id,
    documentId: documentId ?? null,
  })

  const {
    messages,
    isLoading,
    isAwaitingFirstToken,
    error,
    sendMessage,
    resumeWithPayload,
    resetChat,
    isReady,
    sessionId,
    setSessionId,
    setMessagesFromHistory,
  } = useAgentChat({
    backendBaseUrl,
    tenantId: user?.tenant_id,
    userId: user?.id,
    uiContext: effectiveUiContext,
    documentId,
    viewId,
    onAgUiEvent: (event) => {
        const inner = event.event as any
        if (inner && inner.action === 'form.show' && inner.payload && inner.payload.ui) {
          const ui = inner.payload.ui
          // 如果当前正处于提交过程中，则忽略新的 form.show，避免在同一轮 resume 过程中
          // 再次出现表单；下一轮对话会重新进入 HITL 时再接收新的表单。
          if (isSubmittingHitlForm || hitlResumeInFlightRef.current) {
            return
          }
          if (ui && ui.type === 'form') {
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
            setIsSubmittingHitlForm(false)
          }
        }
        if (onAgUiEvent) {
          onAgUiEvent(inner)
        }
      },
      // 如果当前有来自题卡/笔记的 noteFocus，就优先携带给本轮对话
      noteFocus: appendToken?.payload.noteFocus,
      onDocumentResolved,
    })

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

  // 将当前 messages 同步回会话 store，便于下次切换/恢复
  useEffect(() => {
    if (!activeConversationKey) return
    // 仅当 useAgentChat 明确绑定到当前激活会话时才回写，
    // 防止在点击切换会话但尚未完成历史灌入阶段，把上一会话的
    // 消息和 sessionId 写进新会话，导致两个会话绑定到同一个 sessionId。
    if (boundConversationKey !== activeConversationKey) return
    handleConversationMessagesChange(activeConversationKey, messages as any, sessionId ?? null)
  }, [activeConversationKey, boundConversationKey, handleConversationMessagesChange, messages, sessionId])

  const canSend = useMemo(() => !!input.trim() && !isLoading, [input, isLoading])
  const hasMessages = messages.length > 0
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
    if (hitlFormUi && hitlAnchorIndex == null) {
      for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
        if (messages[idx]?.role === 'assistant') {
          setHitlAnchorIndex(idx)
          break
        }
      }
    }
    if (!hitlFormUi && hitlAnchorIndex != null) {
      setHitlAnchorIndex(null)
    }
  }, [hitlFormUi, hitlAnchorIndex, messages])

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
        const maxCapacity = typeof batchMeta?.maxCapacity === 'number' ? batchMeta.maxCapacity : undefined
        if (typeof payload.count === 'number' && typeof maxCapacity === 'number') {
          payload.count = Math.max(1, Math.min(payload.count, maxCapacity))
        }
        if (batchMeta) {
          payload.maxCapacity = maxCapacity
          if (batchMeta.baseQuestionId != null) payload.baseQuestionId = batchMeta.baseQuestionId
          if (batchMeta.baseSequenceIndex != null) payload.baseSequenceIndex = batchMeta.baseSequenceIndex
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
    [batchMeta, hitlFormUi, hitlFormValues, resumeWithPayload],
  )

  const handleHitlCancel = useCallback(() => {
    hitlResumeInFlightRef.current = false
    setHitlFormUi(null)
    setHitlFormValues({})
    setIsSubmittingHitlForm(false)
  }, [])

  const defaultAnimation = workingCatAnimation

  const greeting = useMemo<GreetingInfo>(() => {
    const hour = new Date().getHours()
    const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)]

    if (hour < 6) {
      return {
        title: '夜深了',
        subtitle: pick([
          '夜深人静的时候，喝口温水再继续也不迟。',
          '凌晨的空气适合装下一点小小的灵感。',
          '夜猫子专属时段：安静得连思绪都能发光。',
        ]),
        animation: workingCatAnimation,
      }
    }
    if (hour < 12) {
      return {
        title: '早安',
        subtitle: pick([
          '向太阳借点能量，我们慢慢展开计划。',
          '早起的脑袋最清醒，记得把灵感随手记下。',
          '给自己一口热饮，再用好奇心开启这一天。',
        ]),
        animation: workingCatAnimation,
      }
    }
    if (hour < 18) {
      return {
        title: '下午好',
        subtitle: pick([
          '冷笑话：电脑为什么会累？因为它一直在“处理器”。',
          '午后小困就走走路，再把想法告诉我。',
          '学习小贴士：把问题分段写下来，灵感更容易浮现。',
        ]),
        animation: noInternetAnimation,
      }
    }
    return {
      title: '晚上好',
      subtitle: pick([
        '冷笑话：铅笔为什么瘦？因为它总在削自己。',
        '晚风最适合慢下来整理思路。',
        '夜晚是反刍知识的好时候，先写下一两个问题吧。',
      ]),
      animation: workingCatAnimation,
    }
  }, [])

  const handleReset = useCallback(() => {
    resetChat()
  }, [resetChat])

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
        if (!msg.content?.trim()) {
          return null
        }
        const keyLabel = 'AI Copilot'
        return (
          <div className="flex gap-3">
            <div className="shrink-0">
              <RobotGlowFace className="pointer-events-none select-none" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{keyLabel}</div>
              <div className="prose prose-slate max-w-none text-[15px] leading-relaxed">
                <MarkdownWithMath>{normalizeAiMarkdown(msg.content)}</MarkdownWithMath>
              </div>
            </div>
          </div>
        )
      }, (prev, next) => prev.msg?.id === next.msg?.id && prev.msg?.content === next.msg?.content),
    [],
  )

  const UserMessage: React.FC<{ msg: any }> = useMemo(
    () =>
      React.memo(({ msg }: { msg: any }) => {
        return (
          <div className="flex gap-3 flex-row-reverse text-right">
            <div className="h-9 w-9 rounded-full shrink-0 inline-flex items-center justify-center bg-slate-200 text-slate-600">
              {user.display_name?.slice(0, 1) || '我'}
            </div>
            <div className="max-w-[72%] rounded-2xl px-4 py-3 bg-slate-100 text-slate-800 shadow-sm">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                {user.display_name || '我'}
              </div>
              <MarkdownWithMath>{msg.content}</MarkdownWithMath>
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
          placeholder="不懂的尽管问我哦"
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
    [canSend, error, handleKeyDown, handleSend, input, inputHeight, sendButtonSize, isLoading],
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
                {activeConversation?.title || '新对话'}
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
              aria-label="新建会话"
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
                      {messages.map((msg, idx) => {
                        const key = msg.id ?? msg.created_at ?? `msg-${idx}`
                        const isAssistant = msg.role === 'assistant'
                        const shouldShowHitlForm = Boolean(hitlFormUi) && hitlAnchorIndex === idx && isAssistant

                        return (
                          <React.Fragment key={key}>
                            {isAssistant ? <AssistantMessage msg={msg} /> : <UserMessage msg={msg} />}
                            {shouldShowHitlForm && (
                              <div className="flex gap-3">
                                <div className="shrink-0">
                                  <RobotGlowFace className="pointer-events-none select-none" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
                                    AI Copilot · 批量出题配置
                                  </div>
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
                                          取消
                                        </button>
                                        <button
                                          type="submit"
                                          disabled={isSubmittingHitlForm || isLoading}
                                          className="px-3 py-1.5 rounded-full text-xs bg-slate-900 text-white disabled:opacity-60"
                                        >
                                          {isSubmittingHitlForm ? '提交中…' : hitlFormUi?.submit?.label || '确认'}
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
                      {isAwaitingFirstToken && (
                        <div className="flex gap-3">
                          <div className="shrink-0">
                            <RobotGlowFace className="pointer-events-none select-none" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">AI Copilot</div>
                            <div className="flex flex-col gap-2 text-sm text-slate-500">
                              <span className="font-medium text-slate-600">正在整理思路…</span>
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
                          </div>
                        </div>
                      )}
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
