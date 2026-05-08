import React, { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentSendPayload,
  AggregatedOcrItem,
  StudioPreviewTabPayload,
  StudioTabKind,
  StudioWorkspaceTab,
  UploadedFileTab,
  UserInfo,
} from '../types'
import type { MathContentDocument } from '../lib/mathContent'
import { MindMapPanel } from '../features/mindmap/MindMapPanel'
import { AgentWorkspacePanel } from './AgentWorkspacePanel'
import { FlashcardPanel } from './FlashcardPanel'
import Icon from './Icon'
import { ContextMenuList, type ContextMenuAction } from './contextMenu'
import { revealWorkroomPathInOs } from '../services/workroomTreeApi'
import { useAppStore } from '../store/appStore'
import { MarkdownWithMath } from './MarkdownWithMath'


interface EditorWorkspaceShellProps {
  backendBaseUrl: string
  user: UserInfo | null
  workroomId?: string | null
  studioTabs: StudioWorkspaceTab[]
  activeStudioTabId: string
  onOpenStudioTab: (kind: StudioTabKind) => void
  onActivateStudioTab: (tabId: string) => void
  onCloseStudioTab: (tabId: string) => void
  onReorderStudioTabs: (fromTabId: string, toTabId: string) => void
  onUpdateStudioPreviewContent: (tabId: string, content: string) => void
  onUpdateStudioPreviewViewMode: (tabId: string, viewMode: 'edit' | 'markdown-read') => void
  onSaveStudioPreviewTab: (tabId: string) => Promise<boolean>
  studioDataSourceMode: 'follow_preview' | 'keep_workset'
  onStudioDataSourceModeChange: (mode: 'follow_preview' | 'keep_workset') => void
  isAnswerMode: boolean
  onToggleAnswerMode: () => void
  onOpenAgentDrawer: () => void
  currentFile: UploadedFileTab | null
  sessionId: string | null
  ocrItems: AggregatedOcrItem[]
  studioDocumentId: string | null
  sourceDocumentId: string | null
  onDocumentChange: (id: string | null) => void
  onUpdateItem: (id: string, updater: (prev: AggregatedOcrItem) => AggregatedOcrItem) => void
  onDeleteItem: (id: string) => void
  onSendToAgent: (payload: AgentSendPayload) => void
  onAnswerChange: (id: string, value: MathContentDocument) => void
  onSubmitGrading: () => void
  isGrading: boolean
  onSplitItem: (item: AggregatedOcrItem, index: number) => void
  splittingItemId: string | null
  previewScrollRef: React.RefObject<HTMLDivElement>
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
  onRunGlmOcr: () => Promise<string | null>
  modelSettingsRevision?: number
  agentDrawerInset?: number
}

const EditorWorkspaceShellComponent: React.FC<EditorWorkspaceShellProps> = ({
  backendBaseUrl,
  user,
  workroomId = null,
  studioTabs,
  activeStudioTabId,
  onOpenStudioTab,
  onActivateStudioTab,
  onCloseStudioTab,
  onReorderStudioTabs,
  onUpdateStudioPreviewContent,
  onUpdateStudioPreviewViewMode,
  onSaveStudioPreviewTab,
  studioDataSourceMode,
  onStudioDataSourceModeChange,
  isAnswerMode,
  onToggleAnswerMode,
  onOpenAgentDrawer,
  currentFile,
  sessionId,
  ocrItems,
  studioDocumentId,
  sourceDocumentId,
  onDocumentChange,
  onUpdateItem,
  onDeleteItem,
  onSendToAgent,
  onAnswerChange,
  onSubmitGrading,
  isGrading,
  onSplitItem,
  splittingItemId,
  previewScrollRef,
  onToast,
  onRunGlmOcr,
  modelSettingsRevision = 0,
  agentDrawerInset = 0,
}) => {
  const { t } = useTranslation('common')
  const tabsScrollRef = useRef<HTMLDivElement | null>(null)
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const previewTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const previewLineGutterRef = useRef<HTMLDivElement | null>(null)
  const markdownReadContainerRef = useRef<HTMLDivElement | null>(null)
  const activeStudioTab = studioTabs.find((tab) => tab.id === activeStudioTabId) ?? studioTabs[0]
  const activeStudioView = activeStudioTab?.kind ?? 'editor'
  const activePreviewPayload = (activeStudioTab?.payload ?? null) as StudioPreviewTabPayload | null
  const activePreviewViewMode = activePreviewPayload?.viewMode === 'markdown-read' ? 'markdown-read' : 'edit'
  const previewLineCount = useMemo(() => {
    const content = activePreviewPayload?.draftContent ?? ''
    if (!content) return 1
    return content.split('\n').length
  }, [activePreviewPayload?.draftContent])
  const previewLineNumberText = useMemo(() => {
    const count = Math.max(1, previewLineCount)
    const lines = new Array<string>(count)
    for (let idx = 0; idx < count; idx += 1) {
      lines[idx] = String(idx + 1)
    }
    return lines.join('\n')
  }, [previewLineCount])
  const [isSavingPreview, setIsSavingPreview] = React.useState(false)
  const [editorContextMenu, setEditorContextMenu] = React.useState<{ x: number; y: number } | null>(null)
  const [tabContextMenu, setTabContextMenu] = React.useState<{
    x: number
    y: number
    tabId: string
  } | null>(null)
  const requestWorkroomTreeReveal = useAppStore((state) => state.requestWorkroomTreeReveal)

  const contentShellClassName =
    activeStudioView === 'mindmap'
      ? 'flex-1 overflow-hidden pt-[42px] sm:pt-[42px] lg:pt-6'
      : activeStudioView === 'preview'
        ? 'flex-1 overflow-hidden p-0 pt-[42px]'
      : 'scrollbar-hidden flex-1 overflow-y-auto p-0 pt-[42px] lg:p-6 lg:pt-[42px]'

  useEffect(() => {
    const el = tabsScrollRef.current
    if (!el) return
    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault()
        el.scrollBy({ left: event.deltaY, behavior: 'auto' })
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  useEffect(() => {
    const container = tabsScrollRef.current
    const activeTabButton = tabButtonRefs.current[activeStudioTabId]
    if (!container || !activeTabButton) return
    activeTabButton.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeStudioTabId])

  useEffect(() => {
    if (!editorContextMenu && !tabContextMenu) return
    const close = () => {
      setEditorContextMenu(null)
      setTabContextMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [editorContextMenu, tabContextMenu])

  useEffect(() => {
    const onGlobalOpen = (event: Event) => {
      const source = (event as CustomEvent<{ source?: string }>).detail?.source
      if (source !== 'editor-shell') {
        setEditorContextMenu(null)
        setTabContextMenu(null)
      }
    }
    window.addEventListener('app:context-menu-open', onGlobalOpen as EventListener)
    return () => window.removeEventListener('app:context-menu-open', onGlobalOpen as EventListener)
  }, [])

  const closeTabContextMenu = React.useCallback(() => setTabContextMenu(null), [])

  const tabMenuActions = React.useMemo<ContextMenuAction[]>(() => {
    if (!tabContextMenu) return []
    const targetTab = studioTabs.find((tab) => tab.id === tabContextMenu.tabId) ?? null
    const closeOthersTargets = studioTabs.filter((tab) => tab.id !== tabContextMenu.tabId && tab.closable)
    const closeRightTargets = (() => {
      const idx = studioTabs.findIndex((tab) => tab.id === tabContextMenu.tabId)
      if (idx < 0) return [] as StudioWorkspaceTab[]
      return studioTabs.slice(idx + 1).filter((tab) => tab.closable)
    })()
    const actions: ContextMenuAction[] = [
      {
        key: 'activate',
        label: '激活标签',
        shortcut: 'Enter',
        onSelect: async () => onActivateStudioTab(tabContextMenu.tabId),
      },
    ]
    if (targetTab?.kind === 'preview' && targetTab.payload?.isDirty) {
      actions.push({
        key: 'save',
        label: '保存',
        shortcut: 'Ctrl+S',
        onSelect: async () => {
          setIsSavingPreview(true)
          try {
            await onSaveStudioPreviewTab(targetTab.id)
          } finally {
            setIsSavingPreview(false)
          }
        },
      })
    }
    if (targetTab?.closable) {
      actions.push({
        key: 'close',
        label: '关闭',
        shortcut: 'Ctrl+W',
        onSelect: async () => onCloseStudioTab(tabContextMenu.tabId),
      })
    }
    actions.push(
      {
        key: 'close-others',
        label: '关闭其他标签',
        shortcut: 'Alt+W',
        disabled: closeOthersTargets.length === 0,
        onSelect: async () => {
          closeOthersTargets.forEach((tab) => onCloseStudioTab(tab.id))
        },
      },
      {
        key: 'close-right',
        label: '关闭右侧标签',
        shortcut: 'Ctrl+Alt+W',
        disabled: closeRightTargets.length === 0,
        onSelect: async () => {
          closeRightTargets.forEach((tab) => onCloseStudioTab(tab.id))
        },
      },
    )
    if (targetTab?.kind === 'preview' && targetTab.payload?.path) {
      const previewTabs = studioTabs.filter((tab) => tab.kind === 'preview')
      const savedPreviewTabs = previewTabs.filter((tab) => !tab.payload?.isDirty)
      actions.push(
        {
          key: 'close-saved',
          label: '关闭已保存',
          shortcut: 'Ctrl+K W',
          separatorBefore: true,
          disabled: savedPreviewTabs.length === 0,
          onSelect: async () => {
            savedPreviewTabs.forEach((tab) => onCloseStudioTab(tab.id))
          },
        },
        {
          key: 'close-all-preview',
          label: '全部关闭',
          shortcut: 'Ctrl+K Ctrl+W',
          disabled: previewTabs.length === 0,
          onSelect: async () => {
            previewTabs.forEach((tab) => onCloseStudioTab(tab.id))
          },
        },
        {
          key: 'copy-path',
          label: '复制路径',
          shortcut: 'Ctrl+Shift+C',
          separatorBefore: true,
          onSelect: async () => {
            await navigator.clipboard.writeText(`workroom/${String(workroomId ?? '')}/${targetTab.payload?.path ?? ''}`)
          },
        },
        {
          key: 'copy-relative-path',
          label: '复制相对路径',
          shortcut: 'Alt+Shift+C',
          onSelect: async () => {
            await navigator.clipboard.writeText(targetTab.payload?.path ?? '')
          },
        },
        {
          key: 'reveal-tree',
          label: '在文件树视图中显示',
          shortcut: 'Ctrl+Shift+R',
          onSelect: async () => {
            requestWorkroomTreeReveal(targetTab.payload?.path ?? '')
          },
        },
        {
          key: 'reveal-os',
          label: '在文件资源管理器中显示',
          shortcut: 'Alt+E',
          onSelect: async () => {
            if (!workroomId) return
            const result = await revealWorkroomPathInOs(backendBaseUrl, workroomId, targetTab.payload?.path ?? '')
            if (!result.supported) {
              onToast?.('当前环境暂不支持在系统资源管理器中打开', 'info')
            }
          },
        },
      )
    }
    return actions
  }, [
    backendBaseUrl,
    onActivateStudioTab,
    onCloseStudioTab,
    onSaveStudioPreviewTab,
    onToast,
    requestWorkroomTreeReveal,
    studioTabs,
    tabContextMenu,
    workroomId,
  ])

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--ui-bg-app)]"
      style={{ marginRight: agentDrawerInset > 0 ? `${agentDrawerInset}px` : undefined, transition: 'margin-right 200ms ease' }}
    >
      <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-20 flex justify-center">
        <div className="pointer-events-auto inline-flex max-w-full gap-1 overflow-x-auto rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-bg-elevated)] p-1.5 shadow-none backdrop-blur scrollbar-hidden">
          <button
          className="shrink-0 rounded-full p-2 text-[var(--ui-text-primary)]"
          type="button"
          title={t('editor_workspace.text_button')}
          onClick={() => {
            void onRunGlmOcr()
          }}
        >
          <Icon name={"title"} className="text-[18px] leading-none" />
        </button>
        <button
          className={`shrink-0 rounded-full p-2 text-[var(--ui-text-primary)] ${activeStudioView === 'flashcard' ? 'bg-[var(--ui-bg-panel-muted)]' : ''}`}
          type="button"
          title={t('editor_workspace.flashcard_button')}
          onClick={() => onOpenStudioTab('flashcard')}
        >
          <Icon name={"image"} className="text-[18px] leading-none" />
        </button>
        <button
          className={`shrink-0 rounded-full p-2 text-[var(--ui-text-primary)] ${activeStudioView === 'mindmap' ? 'bg-[var(--ui-bg-panel-muted)]' : ''}`}
          type="button"
          title={t('editor_workspace.mindmap_button')}
          onClick={() => onOpenStudioTab('mindmap')}
        >
          <Icon name={"account_tree"} className="text-[18px] leading-none" />
        </button>
        <button
          className={`shrink-0 rounded-full p-2 text-[var(--ui-text-primary)] ${activeStudioView === 'editor' ? 'bg-[var(--ui-bg-panel-muted)]' : ''}`}
          type="button"
          title={t('editor_workspace.workspace_title')}
          onClick={() => onOpenStudioTab('editor')}
        >
          <Icon name={"article"} className="text-[18px] leading-none" />
        </button>
        <button
          className={`shrink-0 rounded-full p-2 ${
            studioDataSourceMode === 'keep_workset'
              ? 'bg-[var(--ui-btn-solid-bg)] text-white'
              : 'text-[var(--ui-text-primary)]'
          }`}
          type="button"
          title={
            studioDataSourceMode === 'keep_workset'
              ? t('editor_workspace.toolbar.mode_keep_workset')
              : t('editor_workspace.toolbar.mode_follow_preview')
          }
          onClick={() =>
            onStudioDataSourceModeChange(
              studioDataSourceMode === 'keep_workset' ? 'follow_preview' : 'keep_workset',
            )
          }
        >
          <Icon
            name={studioDataSourceMode === 'keep_workset' ? "layers" : "link"}
            className="text-[16px] leading-none"
          />
        </button>
        <button
          className={`flex shrink-0 items-center gap-1.5 rounded-full p-2 text-sm ${
            isAnswerMode ? 'bg-[var(--ui-btn-solid-bg)] text-white' : 'text-[var(--ui-text-primary)]'
          }`}
          type="button"
          title={t('editor_workspace.answer_mode_button')}
          onClick={onToggleAnswerMode}
        >
          <Icon name={"edit_note"} className="text-[16px] leading-none" />
        </button>
        <div className="mx-1 hidden w-px bg-[var(--ui-border-default)] sm:block" />
        <button
          className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-purple-600"
          type="button"
          onClick={onOpenAgentDrawer}
          title={t('editor_workspace.copilot_button')}
        >
          <Icon name={"auto_awesome"} className="text-[16px] leading-none" />
          {t('editor_workspace.copilot_button')}
        </button>
        </div>
      </div>

      <div className="absolute inset-x-0 top-0 z-10 h-[34px] border-y border-[var(--ui-border-default)] bg-[var(--ui-bg-tabbar)] px-0">
        <div ref={tabsScrollRef} className="scrollbar-hidden flex h-full w-full items-end gap-0 overflow-x-auto pr-0">
          {studioTabs.map((tab, index) => {
            const isActive = tab.id === activeStudioTabId
            const prevActive = studioTabs[index - 1]?.id === activeStudioTabId
            const nextActive = studioTabs[index + 1]?.id === activeStudioTabId
            const showDivider = !isActive && !prevActive && !nextActive && index < studioTabs.length - 1
            return (
              <div key={tab.id} className="group relative flex shrink-0 items-center">
                <button
                  ref={(el) => {
                    tabButtonRefs.current[tab.id] = el
                  }}
                  type="button"
                  onClick={() => onActivateStudioTab(tab.id)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    window.dispatchEvent(new CustomEvent('app:context-menu-open', { detail: { source: 'editor-shell' } }))
                    setEditorContextMenu(null)
                    setTabContextMenu({ x: event.clientX, y: event.clientY, tabId: tab.id })
                  }}
                  onMouseDown={(event) => {
                    if (event.button === 1 && tab.closable) {
                      event.preventDefault()
                      onCloseStudioTab(tab.id)
                    }
                  }}
                  className={`flex h-[32px] min-w-[120px] max-w-[220px] items-center gap-1.5 rounded-t-[6px] border-none pl-3 pr-2 text-[13px] transition-colors ${
                    isActive
                      ? 'z-10 bg-[var(--ui-bg-panel)] text-[var(--ui-text-primary)] shadow-none'
                      : 'text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]'
                  }`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/studio-tab-id', tab.id)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const fromTabId = event.dataTransfer.getData('text/studio-tab-id')
                    if (!fromTabId || fromTabId === tab.id) return
                    onReorderStudioTabs(fromTabId, tab.id)
                  }}
                >
                  <Icon
                    name={tab.kind === 'mindmap' ? 'account_tree' : tab.kind === 'flashcard' ? 'image' : tab.kind === 'preview' ? 'description' : 'article'}
                    className="text-[14px]"
                  />
                  <span className="min-w-0 flex-1 truncate text-left" title={tab.title}>{tab.title}</span>
                  {tab.kind === 'preview' && tab.payload?.isDirty ? (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--ui-text-primary)]" title="未保存改动" />
                  ) : null}
                  {tab.closable && (!(tab.kind === 'preview' && tab.payload?.isDirty && !isActive)) && (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t('file_tabs.close_label')}
                      className={`rounded-sm p-0.5 transition-opacity hover:bg-[var(--ui-bg-panel-muted)] ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onCloseStudioTab(tab.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          event.stopPropagation()
                          onCloseStudioTab(tab.id)
                        }
                      }}
                    >
                      <Icon name="close" className="text-[14px] leading-none text-[var(--ui-text-primary)]" />
                    </span>
                  )}
                </button>
                {showDivider && <div className="h-[16px] w-[1px] bg-[var(--ui-border-default)]" />}
              </div>
            )
          })}
        </div>
      </div>

      <div className={contentShellClassName}>
        {activeStudioView === 'mindmap' ? (
          <div className="flex h-full min-h-0 min-w-0 w-full overflow-hidden">
            <MindMapPanel
              backendBaseUrl={backendBaseUrl}
              documentId={studioDocumentId}
              fileId={currentFile?.fileId != null ? String(currentFile.fileId) : null}
              user={user}
              workroomId={workroomId}
              onBack={() => onOpenStudioTab('editor')}
              onNavigateToQuestion={(target) => {
                if (!target) return
                if (typeof target.sequenceIndex === 'number') {
                  const index = target.sequenceIndex
                  const el = document.querySelector(`#question-card-${index + 1}`)
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                }
                if (typeof target.page === 'number' && previewScrollRef.current) {
                  previewScrollRef.current.scrollTo({
                    top: (target.page - 1) * 400,
                    behavior: 'smooth',
                  })
                }
              }}
            />
          </div>
        ) : activeStudioView === 'flashcard' ? (
          <FlashcardPanel
            backendBaseUrl={backendBaseUrl}
            workroomId={workroomId}
            documentId={currentFile?.fileId != null ? String(currentFile.fileId) : null}
            documentTitle={currentFile?.name ?? null}
            user={user}
            onBack={() => onOpenStudioTab('editor')}
            onToast={onToast}
            ensureDocument={onRunGlmOcr}
            onDocumentResolved={onDocumentChange}
          />
        ) : activeStudioView === 'preview' ? (
          <div className="flex h-full min-h-0 w-full flex-col">
            {activePreviewViewMode === 'markdown-read' ? (
              <div
                ref={markdownReadContainerRef}
                className="min-h-0 flex-1 overflow-auto px-3 py-2"
                onContextMenu={(event) => {
                  event.preventDefault()
                  window.dispatchEvent(new CustomEvent('app:context-menu-open', { detail: { source: 'editor-shell' } }))
                  setEditorContextMenu({ x: event.clientX, y: event.clientY })
                }}
              >
                <MarkdownWithMath className="markdown-body font-serif text-[15px] leading-7 text-[var(--ui-text-primary)]">
                  {activePreviewPayload?.draftContent ?? ''}
                </MarkdownWithMath>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  ref={previewLineGutterRef}
                  className="min-h-0 w-[56px] shrink-0 overflow-hidden border-r border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)] px-2 py-2 text-right font-mono text-[12px] leading-7 text-[var(--ui-text-primary)] select-none"
                >
                  <pre className="m-0 whitespace-pre">{previewLineNumberText}</pre>
                </div>
                <textarea
                  ref={previewTextareaRef}
                  className="min-h-0 flex-1 resize-none overflow-auto whitespace-pre bg-transparent px-3 py-2 font-mono text-[15px] leading-7 text-[var(--ui-text-primary)] outline-none"
                  spellCheck={false}
                  wrap="off"
                  value={activePreviewPayload?.draftContent ?? ''}
                  onScroll={(event) => {
                    if (previewLineGutterRef.current) {
                      previewLineGutterRef.current.scrollTop = event.currentTarget.scrollTop
                    }
                  }}
                  onChange={(event) => {
                    if (!activeStudioTab?.id.startsWith('preview:')) return
                    onUpdateStudioPreviewContent(activeStudioTab.id, event.target.value)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    window.dispatchEvent(new CustomEvent('app:context-menu-open', { detail: { source: 'editor-shell' } }))
                    setEditorContextMenu({ x: event.clientX, y: event.clientY })
                  }}
                  onKeyDown={async (event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                      event.preventDefault()
                      if (!activeStudioTab?.id.startsWith('preview:')) return
                      setIsSavingPreview(true)
                      try {
                        await onSaveStudioPreviewTab(activeStudioTab.id)
                      } finally {
                        setIsSavingPreview(false)
                      }
                    }
                  }}
                />
              </div>
            )}
            {activePreviewPayload?.saveError ? (
              <div className="border-t border-rose-100 bg-rose-50 px-3 py-1 text-xs text-rose-600">
                {activePreviewPayload.saveError}
              </div>
            ) : null}
            {editorContextMenu && (
              <div
                className="fixed z-[90] min-w-[180px] rounded-md border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] py-1 text-sm shadow-xl"
                style={{ left: editorContextMenu.x, top: editorContextMenu.y }}
              >
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--ui-bg-panel-muted)] disabled:text-[var(--ui-text-primary)] disabled:hover:bg-transparent"
                  disabled={activePreviewViewMode === 'markdown-read'}
                  onClick={async () => {
                    setEditorContextMenu(null)
                    if (!activeStudioTab?.id.startsWith('preview:')) return
                    setIsSavingPreview(true)
                    try {
                      await onSaveStudioPreviewTab(activeStudioTab.id)
                    } finally {
                      setIsSavingPreview(false)
                    }
                  }}
                >
                  {isSavingPreview ? '保存中...' : '保存'}
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--ui-bg-panel-muted)] disabled:text-[var(--ui-text-primary)] disabled:hover:bg-transparent"
                  disabled={activePreviewViewMode === 'markdown-read'}
                  onClick={() => document.execCommand('undo')}
                >
                  撤销
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--ui-bg-panel-muted)] disabled:text-[var(--ui-text-primary)] disabled:hover:bg-transparent"
                  disabled={activePreviewViewMode === 'markdown-read'}
                  onClick={() => document.execCommand('redo')}
                >
                  重做
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--ui-bg-panel-muted)] disabled:text-[var(--ui-text-primary)] disabled:hover:bg-transparent"
                  disabled={activePreviewViewMode === 'markdown-read'}
                  onClick={() => document.execCommand('cut')}
                >
                  剪切
                </button>
                <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--ui-bg-panel-muted)]" onClick={() => document.execCommand('copy')}>
                  复制
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--ui-bg-panel-muted)] disabled:text-[var(--ui-text-primary)] disabled:hover:bg-transparent"
                  disabled={activePreviewViewMode === 'markdown-read'}
                  onClick={() => document.execCommand('paste')}
                >
                  粘贴
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--ui-bg-panel-muted)]"
                  onClick={() => {
                    if (!activeStudioTab?.id.startsWith('preview:')) return
                    onUpdateStudioPreviewViewMode(
                      activeStudioTab.id,
                      activePreviewViewMode === 'markdown-read' ? 'edit' : 'markdown-read',
                    )
                    setEditorContextMenu(null)
                  }}
                >
                  {activePreviewViewMode === 'markdown-read' ? '切换到编辑模式' : 'Markdown 阅读模式'}
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--ui-bg-panel-muted)]"
                  onClick={() => {
                    if (activePreviewViewMode === 'markdown-read') {
                      const selected = window.getSelection()
                      if (!selected || selected.toString()) return
                      selected.removeAllRanges()
                      const range = document.createRange()
                      range.selectNodeContents(
                        markdownReadContainerRef.current ?? document.body,
                      )
                      selected.addRange(range)
                      return
                    }
                    previewTextareaRef.current?.focus()
                    previewTextareaRef.current?.select()
                  }}
                >
                  全选
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto flex min-h-[900px] w-full max-w-[800px] flex-col gap-6 rounded-sm border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] p-12 shadow-sm">
            <div className="border-b-2 border-[var(--ui-text-primary)] pb-6 text-center">
              <h1 className="mb-2 text-3xl font-bold text-[var(--ui-text-primary)]">{t('editor_workspace.workspace_title')}</h1>
              <p className="font-medium text-[var(--ui-text-primary)]">
                {sessionId
                  ? t('editor_workspace.session_label', { sessionId })
                  : t('editor_workspace.session_not_started')}
              </p>
            </div>

            <div className="mb-2 text-sm text-[var(--ui-text-primary)]">{t('editor_workspace.recognition_results')}</div>
            <div className="space-y-6">
              <AgentWorkspacePanel
                backendBaseUrl={backendBaseUrl}
                user={user!}
                items={ocrItems}
                documentTitle={currentFile?.name}
                studioDocumentId={studioDocumentId}
                sourceDocumentId={sourceDocumentId}
                workroomId={workroomId}
                onUpdateItem={onUpdateItem}
                onDeleteItem={onDeleteItem}
                onSendToAgent={onSendToAgent}
                onAnswerChange={onAnswerChange}
                onSubmitGrading={onSubmitGrading}
                isGrading={isGrading}
                answerMode={isAnswerMode}
                onSplitItem={onSplitItem}
                splittingItemId={splittingItemId}
                onToast={onToast}
                modelSettingsRevision={modelSettingsRevision}
              />
            </div>
          </div>
        )}
      </div>
      {tabContextMenu && (
        <ContextMenuList
          actions={tabMenuActions}
          onClose={closeTabContextMenu}
          x={tabContextMenu.x}
          y={tabContextMenu.y}
        />
      )}
    </section>
  )
}

export const EditorWorkspaceShell = React.memo(EditorWorkspaceShellComponent)



