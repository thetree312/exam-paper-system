import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  copyWorkroomPath,
  createWorkroomDirectory,
  createWorkroomFile,
  deleteWorkroomPath,
  fetchWorkroomTree,
  fetchWorkroomTreeVersion,
  moveWorkroomPath,
  revealWorkroomPathInOs,
} from '../services/workroomTreeApi'
import { getAuthToken } from '../utils/secureStorage'
import { useAppStore } from '../store/appStore'
import type { WorkroomTreeItem } from '../types'
import Icon from './Icon'
import { ContextMenuList, type ContextMenuAction } from './contextMenu'


type WorkroomTreeNode = {
  name: string
  path: string
  type: 'file' | 'directory'
  sizeBytes: number
  updatedAt: string
  children: WorkroomTreeNode[]
}

interface WorkroomWikiTreeProps {
  backendBaseUrl: string
  onTogglePreview?: () => void
  onFileOpen?: (path: string) => void
  onRequestSaveOpenFile?: (path: string) => Promise<void>
  onOpenToSide?: (path: string) => void
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'md':
    case 'txt':
      return 'article'
    case 'json':
      return 'file_json'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
      return 'image'
    case 'pdf':
      return 'picture_as_pdf'
    default:
      return 'description'
  }
}

function buildTree(items: WorkroomTreeItem[]) {
  const root: WorkroomTreeNode = {
    name: 'workroom',
    path: '',
    type: 'directory',
    sizeBytes: 0,
    updatedAt: '',
    children: [],
  }
  const byPath = new Map<string, WorkroomTreeNode>([['', root]])

  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean)
    let parent = root
    let currentPath = ''

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isLeaf = index === parts.length - 1
      const existing = byPath.get(currentPath)
      if (existing) {
        parent = existing
        return
      }

      const node: WorkroomTreeNode = {
        name: part,
        path: currentPath,
        type: isLeaf ? item.type : 'directory',
        sizeBytes: isLeaf ? item.sizeBytes : 0,
        updatedAt: isLeaf ? item.updatedAt : '',
        children: [],
      }
      byPath.set(currentPath, node)
      parent.children.push(node)
      parent = node
    })
  }

  const sortNodes = (nodes: WorkroomTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((node) => sortNodes(node.children))
  }
  sortNodes(root.children)

  return root.children
}

const TreeNode: React.FC<{
  node: WorkroomTreeNode
  depth: number
  expandedPaths: Set<string>
  highlightedPath?: string | null
  onToggle: (path: string) => void
  onFileOpen?: (path: string) => void
  onOpenContextMenu?: (x: number, y: number, path: string, type: 'file' | 'directory') => void
  renamingPath?: string | null
  renameDraft?: string
  onRenameDraftChange?: (value: string) => void
  onSubmitRename?: (path: string) => Promise<void>
  onCancelRename?: () => void
}> = ({
  node,
  depth,
  expandedPaths,
  highlightedPath,
  onToggle,
  onFileOpen,
  onOpenContextMenu,
  renamingPath,
  renameDraft,
  onRenameDraftChange,
  onSubmitRename,
  onCancelRename,
}) => {
  const isDirectory = node.type === 'directory'
  const isExpanded = isDirectory && expandedPaths.has(node.path)
  const hasChildren = isDirectory && node.children.length > 0
  const icon = isDirectory ? (isExpanded ? 'folder_open' : 'folder') : getFileIcon(node.name)
  const guidePositions = Array.from({ length: depth }, (_, index) => 13 + index * 18)
  const gutterWidth = 2 + depth * 18

  return (
    <div className="relative">
      <div
        role="button"
        tabIndex={0}
        data-workroom-tree-path={node.path}
        className={`group relative flex min-w-0 w-full items-center text-left text-[13px] text-[var(--ui-text-primary)] outline-none ${highlightedPath === node.path ? 'bg-[var(--ui-bg-panel-muted)]' : ''}`}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpenContextMenu?.(event.clientX, event.clientY, node.path, node.type)
        }}
        onClick={() => {
          if (isDirectory) {
            onToggle(node.path)
            return
          }
          onFileOpen?.(node.path)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          if (isDirectory) {
            onToggle(node.path)
            return
          }
          onFileOpen?.(node.path)
        }}
        title={node.path}
      >
        <span className="pointer-events-none relative h-8 shrink-0" style={{ width: gutterWidth }}>
          {guidePositions.map((left) => (
            <span
              key={`${node.path || 'root'}-${left}`}
              className="absolute bottom-[-2px] top-[-2px] w-px bg-[var(--ui-border-default)]/80"
              style={{ left }}
            />
          ))}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1.5 pr-2 transition-[background-color,color] duration-150 group-hover:bg-[var(--ui-bg-panel)] group-hover:text-[var(--ui-text-primary)] group-focus-visible:bg-[var(--ui-bg-panel)] group-focus-visible:ring-1 group-focus-visible:ring-[var(--ui-border-strong)] motion-reduce:transition-none">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
            {isDirectory ? (
              <Icon
                name="chevron_right"
                className={`text-[18px] text-[var(--ui-text-primary)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
                  isExpanded ? 'rotate-90' : ''
                }`}
              />
            ) : (
              <span className="h-5 w-5" />
            )}
          </span>
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)] transition-colors duration-150 group-hover:bg-[var(--ui-bg-elevated)] group-hover:text-[var(--ui-text-primary)]">
            <Icon name={icon} className="text-[18px]" />
          </span>
          {renamingPath === node.path ? (
            <input
              autoFocus
              value={renameDraft ?? ''}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onRenameDraftChange?.(event.target.value)}
              onBlur={() => void onSubmitRename?.(node.path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void onSubmitRename?.(node.path)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  onCancelRename?.()
                }
              }}
              className="min-w-0 flex-1 rounded border border-[var(--ui-border-strong)] bg-[var(--ui-bg-panel)] px-1.5 py-0.5 text-[13px] font-medium text-[var(--ui-text-primary)] outline-none ring-1 ring-[var(--ui-border-default)]"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
          )}
          {!isDirectory && (
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--ui-text-primary)]">
              {formatBytes(node.sizeBytes)}
            </span>
          )}
          {hasChildren && (
            <span className="shrink-0 rounded-full bg-[var(--ui-bg-panel-muted)] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--ui-text-primary)]">
              {node.children.length}
            </span>
          )}
        </span>
      </div>
      {isDirectory && (
        <div
          className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="relative py-0.5">
              <span
                className="pointer-events-none absolute bottom-2 top-0 w-px bg-[var(--ui-border-default)]"
                style={{ left: 13 + depth * 18 }}
              />
              {node.children.map((child) => (
                <TreeNode
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  expandedPaths={expandedPaths}
                  highlightedPath={highlightedPath}
                  onToggle={onToggle}
                  onFileOpen={onFileOpen}
                  onOpenContextMenu={onOpenContextMenu}
                  renamingPath={renamingPath}
                  renameDraft={renameDraft}
                  onRenameDraftChange={onRenameDraftChange}
                  onSubmitRename={onSubmitRename}
                  onCancelRename={onCancelRename}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const WorkroomWikiTree: React.FC<WorkroomWikiTreeProps> = ({
  backendBaseUrl,
  onTogglePreview,
  onFileOpen,
  onRequestSaveOpenFile,
  onOpenToSide,
  onToast,
}) => {
  const { t } = useTranslation('common')
  const workroom = useAppStore((state) => state.workroom)
  const [items, setItems] = useState<WorkroomTreeItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; type: 'file' | 'directory' | 'root' } | null>(null)
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null)
  const [pathClipboard, setPathClipboard] = useState<{ mode: 'cut' | 'copy'; path: string; type: 'file' | 'directory' } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const treeVersionRef = useRef<string | null>(null)
  const loadTreeRef = useRef<(() => Promise<void>) | null>(null)
  const workroomTreeRevealRequest = useAppStore((state) => state.workroomTreeRevealRequest)

  useEffect(() => {
    if (!workroom?.id) {
      setIsLoading(false)
      setError(null)
      setItems([])
      treeVersionRef.current = null
      return
    }

    let cancelled = false
    let pollTimer: number | null = null
    let eventSource: EventSource | null = null

    const loadTree = async () => {
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), 15000)
      try {
        const nextItems = await fetchWorkroomTree(backendBaseUrl, workroom.id, controller.signal)
        if (!cancelled) {
          setItems(nextItems)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setItems([])
          const message =
            err instanceof Error && err.name === 'AbortError'
              ? t('workroom_tree.load_timeout')
              : err instanceof Error
                ? err.message
                : 'load_failed'
          setError(message)
        }
      } finally {
        window.clearTimeout(timeoutId)
      }
    }
    loadTreeRef.current = loadTree

    const pollVersion = async () => {
      if (cancelled) return
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), 10000)
      try {
        const next = await fetchWorkroomTreeVersion(backendBaseUrl, workroom.id, controller.signal)
        if (cancelled) return
        if (treeVersionRef.current == null || treeVersionRef.current !== next.versionID) {
          treeVersionRef.current = next.versionID
          await loadTree()
        }
      } catch {
        // keep silent: fallback to next poll round
      } finally {
        window.clearTimeout(timeoutId)
      }
    }

    const startFallbackPolling = () => {
      if (pollTimer != null) return
      pollTimer = window.setInterval(() => {
        void pollVersion()
      }, 10_000)
    }

    const connectTreeEvents = () => {
      const token = getAuthToken()
      if (!token) {
        startFallbackPolling()
        return
      }
      const url = `${backendBaseUrl}/api/workrooms/${encodeURIComponent(String(workroom.id))}/tree-events?access_token=${encodeURIComponent(token)}`
      eventSource = new EventSource(url)
      eventSource.onmessage = () => {
        void loadTree()
      }
      eventSource.addEventListener('tree.changed', () => {
        void loadTree()
      })
      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close()
          eventSource = null
        }
        startFallbackPolling()
      }
    }

    setIsLoading(true)
    void loadTree().finally(() => {
      if (!cancelled) setIsLoading(false)
    })
    connectTreeEvents()

    return () => {
      cancelled = true
      if (eventSource) {
        eventSource.close()
      }
      if (pollTimer != null) {
        window.clearInterval(pollTimer)
      }
    }
  }, [backendBaseUrl, t, workroom?.id])

  const tree = useMemo(() => buildTree(items), [items])
  const directoryPaths = useMemo(() => items.filter((item) => item.type === 'directory').map((item) => item.path), [items])
  useEffect(() => {
    setExpandedPaths(new Set(directoryPaths))
  }, [directoryPaths])

  const handleToggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [contextMenu])

  useEffect(() => {
    if (!workroomTreeRevealRequest?.path) return
    const normalized = workroomTreeRevealRequest.path.replace(/\\/g, '/').replace(/^\/+/, '')
    const segments = normalized.split('/').filter(Boolean)
    const directories: string[] = []
    for (let idx = 0; idx < segments.length - 1; idx += 1) {
      directories.push(segments.slice(0, idx + 1).join('/'))
    }
    setExpandedPaths((prev) => new Set([...prev, ...directories]))
    setHighlightedPath(normalized)
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-workroom-tree-path="${CSS.escape(normalized)}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      window.setTimeout(() => setHighlightedPath((current) => (current === normalized ? null : current)), 1500)
    }, 80)
    return () => window.clearTimeout(timer)
  }, [workroomTreeRevealRequest])

  const closeMenu = () => setContextMenu(null)
  const openMenu = (next: { x: number; y: number; path: string; type: 'file' | 'directory' | 'root' }) => {
    window.dispatchEvent(new CustomEvent('app:context-menu-open', { detail: { source: 'workroom-tree' } }))
    setContextMenu(next)
  }
  const absoluteDisplayPath = (relativePath: string) => `workroom/${String(workroom?.id ?? '')}/${relativePath}`
  const buildPasteTarget = (fromPath: string, toDirectoryPath: string) => {
    const baseName = fromPath.split('/').filter(Boolean).pop() ?? fromPath
    return toDirectoryPath ? `${toDirectoryPath}/${baseName}` : baseName
  }

  const menuActions = useMemo<ContextMenuAction[]>(() => {
    if (!contextMenu || !workroom?.id) return []
    const ctxPath = contextMenu.path
    const ctxType = contextMenu.type
    const canPaste = Boolean(pathClipboard && (ctxType === 'directory' || ctxType === 'root'))
    const targetDirectory = ctxType === 'directory' ? ctxPath : ''
    const actions: ContextMenuAction[] = []
    if (ctxType === 'file') {
      actions.push(
        {
          key: 'open',
          label: '打开',
          shortcut: 'Enter',
          onSelect: async () => onFileOpen?.(ctxPath),
        },
        {
          key: 'open-side',
          label: '在侧边打开',
          shortcut: 'Ctrl+\\',
          onSelect: async () => onOpenToSide?.(ctxPath),
        },
        {
          key: 'save-open-file',
          label: '保存该文件',
          shortcut: 'Ctrl+S',
          onSelect: async () => {
            await onRequestSaveOpenFile?.(ctxPath)
          },
        },
      )
    }
    actions.push(
      {
        key: 'new-file',
        label: '新建文件',
        shortcut: 'Ctrl+N',
        separatorBefore: ctxType === 'file',
        onSelect: async () => {
          const seed = ctxType === 'directory' ? `${ctxPath}/new-file.md` : 'new-file.md'
          const filePath = window.prompt('新建文件路径', seed)
          if (!filePath) return
          await createWorkroomFile(backendBaseUrl, String(workroom.id), filePath, '')
          await loadTreeRef.current?.()
        },
      },
      {
        key: 'new-folder',
        label: '新建文件夹',
        shortcut: 'Ctrl+Shift+N',
        onSelect: async () => {
          const seed = ctxType === 'directory' ? `${ctxPath}/new-folder` : 'new-folder'
          const dirPath = window.prompt('新建文件夹路径', seed)
          if (!dirPath) return
          await createWorkroomDirectory(backendBaseUrl, String(workroom.id), dirPath)
          await loadTreeRef.current?.()
        },
      },
      {
        key: 'paste',
        label: '粘贴',
        shortcut: 'Ctrl+V',
        disabled: !canPaste || !pathClipboard,
        separatorBefore: true,
        onSelect: async () => {
          if (!pathClipboard) return
          const suggested = buildPasteTarget(pathClipboard.path, targetDirectory)
          const toPath = window.prompt('粘贴目标路径', suggested)
          if (!toPath) return
          if (pathClipboard.mode === 'cut') {
            await moveWorkroomPath(backendBaseUrl, String(workroom.id), pathClipboard.path, toPath)
            setPathClipboard(null)
          } else {
            await copyWorkroomPath(backendBaseUrl, String(workroom.id), pathClipboard.path, toPath)
          }
          await loadTreeRef.current?.()
        },
      },
    )
    if (ctxPath) {
      actions.push(
        {
          key: 'rename',
          label: '重命名',
          shortcut: 'F2',
          separatorBefore: true,
          onSelect: async () => {
            setRenamingPath(ctxPath)
            setRenameDraft(ctxPath.split('/').pop() ?? '')
          },
        },
        {
          key: 'cut',
          label: '剪切',
          shortcut: 'Ctrl+X',
          onSelect: async () => {
            setPathClipboard({ mode: 'cut', path: ctxPath, type: ctxType === 'file' ? 'file' : 'directory' })
          },
        },
        {
          key: 'copy',
          label: '复制',
          shortcut: 'Ctrl+C',
          onSelect: async () => {
            setPathClipboard({ mode: 'copy', path: ctxPath, type: ctxType === 'file' ? 'file' : 'directory' })
          },
        },
        {
          key: 'delete',
          label: '删除',
          shortcut: 'Delete',
          danger: true,
          onSelect: async () => {
            const ok = window.confirm(`确认删除 ${ctxPath} ?`)
            if (!ok) return
            await deleteWorkroomPath(backendBaseUrl, String(workroom.id), ctxPath)
            await loadTreeRef.current?.()
          },
        },
        {
          key: 'copy-path',
          label: '复制路径',
          shortcut: 'Ctrl+Shift+C',
          separatorBefore: true,
          onSelect: async () => {
            await navigator.clipboard.writeText(absoluteDisplayPath(ctxPath))
          },
        },
        {
          key: 'copy-relative-path',
          label: '复制相对路径',
          shortcut: 'Alt+Shift+C',
          onSelect: async () => {
            await navigator.clipboard.writeText(ctxPath)
          },
        },
        {
          key: 'reveal-os',
          label: '在文件资源管理器中显示',
          shortcut: 'Alt+E',
          onSelect: async () => {
            const result = await revealWorkroomPathInOs(backendBaseUrl, String(workroom.id), ctxPath)
            if (!result.supported) {
              onToast?.('当前环境暂不支持在系统资源管理器中打开', 'info')
            }
          },
        },
      )
    }
    actions.push({
      key: 'refresh',
      label: '刷新',
      shortcut: 'F5',
      separatorBefore: true,
      onSelect: async () => {
        await loadTreeRef.current?.()
      },
    })
    return actions
  }, [backendBaseUrl, contextMenu, onFileOpen, onOpenToSide, onRequestSaveOpenFile, onToast, pathClipboard, workroom?.id])

  const handleSubmitRename = React.useCallback(
    async (path: string) => {
      if (!workroom?.id) return
      const trimmed = renameDraft.trim()
      if (!trimmed) {
        setRenamingPath(null)
        setRenameDraft('')
        return
      }
      const segments = path.split('/')
      segments[segments.length - 1] = trimmed
      const nextPath = segments.join('/')
      setRenamingPath(null)
      setRenameDraft('')
      if (nextPath === path) return
      await moveWorkroomPath(backendBaseUrl, String(workroom.id), path, nextPath)
      await loadTreeRef.current?.()
    },
    [backendBaseUrl, renameDraft, workroom?.id],
  )

  useEffect(() => {
    const onGlobalOpen = (event: Event) => {
      const source = (event as CustomEvent<{ source?: string }>).detail?.source
      if (source !== 'workroom-tree') setContextMenu(null)
    }
    window.addEventListener('app:context-menu-open', onGlobalOpen as EventListener)
    return () => window.removeEventListener('app:context-menu-open', onGlobalOpen as EventListener)
  }, [])

  return (
    <div className="workroom-wiki-tree flex h-full min-h-0 flex-col bg-[var(--ui-bg-panel)]">
      {onTogglePreview && (
        <div className="flex h-[34px] shrink-0 items-center justify-end border-b border-[var(--ui-border-default)] bg-[var(--ui-bg-tabbar)] px-2">
          <button
            type="button"
            className="mr-[-8px] inline-flex h-8 flex-shrink-0 items-center justify-center px-1.5 text-[var(--ui-text-primary)] hover:text-[var(--ui-text-primary)]"
            onClick={onTogglePreview}
            title={t('workroom_tree.toggle_preview')}
          >
            <Icon name="alt_route" className="text-[22px] leading-none" />
          </button>
        </div>
      )}

      <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-[var(--ui-text-primary)]">
            <Icon name={"progress_activity"} className="animate-spin text-[26px]" />
            {t('workroom_tree.loading')}
          </div>
        ) : error ? (
          <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-3 text-sm text-rose-600">{error}</div>
        ) : tree.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-sm text-[var(--ui-text-primary)]">
            <Icon name={"folder_open"} className="text-[30px]" />
            {t('workroom_tree.empty')}
          </div>
        ) : (
          <div className="space-y-0.5" onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            openMenu({ x: event.clientX, y: event.clientY, path: '', type: 'root' })
          }}>
            {tree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                expandedPaths={expandedPaths}
                highlightedPath={highlightedPath}
                renamingPath={renamingPath}
                renameDraft={renameDraft}
                onRenameDraftChange={setRenameDraft}
                onSubmitRename={handleSubmitRename}
                onCancelRename={() => {
                  setRenamingPath(null)
                  setRenameDraft('')
                }}
                onToggle={handleToggle}
                onFileOpen={onFileOpen}
                onOpenContextMenu={(x, y, path, type) => openMenu({ x, y, path, type })}
              />
            ))}
          </div>
        )}
      </div>
      {contextMenu && workroom?.id && (
        <ContextMenuList actions={menuActions} onClose={closeMenu} x={contextMenu.x} y={contextMenu.y} />
      )}
    </div>
  )
}



