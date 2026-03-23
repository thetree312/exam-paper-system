import React from 'react'
import { useTranslation } from 'react-i18next'

import type { MindMapNavigateTarget, MindMapSourceRef, UserInfo } from '../../types'
import { fetchWorkroomArtifact, upsertWorkroomArtifact } from '../../services/workroomApi'
import { useAppStore } from '../../store/appStore'
import { generateMindMap, getCurrentMindMap, saveMindMap } from './api/mindmapApi'
import MindMapNodeEditor from './components/MindMapNodeEditor'
import MindMapContextActions from './components/MindMapContextActions'
import { MindMapLoadingAnimation } from './components/MindMapLoadingAnimation'
import MindMapRadialMenu from './components/MindMapRadialMenu'
import MindMapToolbar from './components/MindMapToolbar'
import { findNodeById, firstQuestionRef, updateNodeById } from './domain/tree'
import type { MindMapDocumentPayload, MindMapMode, MindMapNodeTree, MindMapViewState } from './domain/types'
import {
  MindElixirCanvas,
  type MindMapEditorController,
  type MindMapActionResult,
  type MindMapNodeContextMenuRequest,
  type MindMapEditorSelectionState,
  type MindMapNodeHoverRequest,
} from './editor/MindElixirCanvas'

interface MindMapPanelProps {
  backendBaseUrl: string
  documentId: number | null
  fileId: number | null
  user: UserInfo | null
  workroomId?: number | null
  onBack?: () => void
  onNavigateToQuestion?: (target: MindMapNavigateTarget) => void
}

export const MindMapPanel: React.FC<MindMapPanelProps> = ({
  backendBaseUrl,
  documentId,
  fileId,
  user,
  workroomId = null,
  onNavigateToQuestion,
}) => {
  const { t, i18n } = useTranslation('common')
  const [mode, setMode] = React.useState<'document' | 'file'>(() => (documentId ? 'document' : 'file'))
  const [mindmapMode, setMindmapMode] = React.useState<MindMapMode>('knowledge_structure')
  const [document, setDocument] = React.useState<MindMapDocumentPayload | null>(null)
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null)
  const [editingNodeId, setEditingNodeId] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [loadingLabel, setLoadingLabel] = React.useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = React.useState<string | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [editorReady, setEditorReady] = React.useState(false)
  const [viewState, setViewState] = React.useState<MindMapViewState | null>(null)
  const [layoutMode, setLayoutMode] = React.useState<'side' | 'left' | 'right'>('right')
  const [isCoarsePointer, setIsCoarsePointer] = React.useState(false)
  const [radialMenu, setRadialMenu] = React.useState<MindMapNodeContextMenuRequest | null>(null)
  const [actionHint, setActionHint] = React.useState<string | null>(null)
  const [isFocusMode, setIsFocusMode] = React.useState(false)
  const [hoveredNode, setHoveredNode] = React.useState<MindMapNodeHoverRequest | null>(null)
  const [selectionState, setSelectionState] = React.useState<MindMapEditorSelectionState>({
    selectedNodeCount: 0,
    hasSelectedArrow: false,
    hasSelectedSummary: false,
  })
  const editorControllerRef = React.useRef<MindMapEditorController | null>(null)
  const actionHintTimerRef = React.useRef<number | null>(null)
  const loadingTimerRefs = React.useRef<number[]>([])
  const restoredPanelStateKeyRef = React.useRef<string | null>(null)
  const handleControllerReady = React.useCallback((controller: MindMapEditorController | null) => {
    editorControllerRef.current = controller
    setEditorReady(Boolean(controller))
    if (controller) {
      controller.setLayout(layoutMode)
    }
  }, [layoutMode])

  const source: MindMapSourceRef | null = React.useMemo(() => {
    if (!user) return null
    if (mode === 'document' && documentId) return { sourceType: 'exam_document', sourceId: documentId, kind: 'knowledge' }
    if (mode === 'file' && fileId) return { sourceType: 'uploaded_file', sourceId: fileId, sourceIds: [], kind: 'knowledge' }
    return null
  }, [user, mode, documentId, fileId])

  const editingNode = React.useMemo(
    () => (document && editingNodeId ? findNodeById(document.root, editingNodeId) : null),
    [document, editingNodeId],
  )
  const selectedNode = React.useMemo(
    () => (document && selectedNodeId ? findNodeById(document.root, selectedNodeId) : null),
    [document, selectedNodeId],
  )
  const hoveredNodeData = React.useMemo(
    () => (document && hoveredNode?.nodeId ? findNodeById(document.root, hoveredNode.nodeId) : null),
    [document, hoveredNode],
  )

  const canUseDocument = Boolean(documentId)
  const canUseFile = Boolean(fileId)
  const canGenerateCurrent = Boolean(source && user && workroomId)
  const sourceCount = React.useMemo(() => {
    if (!source) return 0
    return source.sourceIds && source.sourceIds.length > 0 ? source.sourceIds.length : 1
  }, [source])
  const sourceSignature = React.useMemo(() => {
    if (!source) return null
    const ids = source.sourceIds && source.sourceIds.length > 0 ? [...source.sourceIds].sort((a, b) => a - b) : []
    return ids.length > 1 ? `${source.sourceType}:${ids.join(',')}` : null
  }, [source])
  const panelStateKey = React.useMemo(() => {
    if (!source || !workroomId || !user) return null
    return `${workroomId}:${source.sourceType}:${source.sourceId}:${sourceSignature ?? ''}:${user.id}`
  }, [source, sourceSignature, user, workroomId])

  const setLoadingState = React.useCallback(
    (phase: 'load' | 'outline' | 'merge' | 'expand') => {
      if (phase === 'load') {
        setLoadingLabel(t('mindmap_panel.loading_existing'))
        setLoadingDetail(t('mindmap_panel.loading_existing_detail'))
        return
      }
      if (phase === 'outline') {
        setLoadingLabel(
          sourceCount > 1 ? t('mindmap_panel.stage_outline_multi') : t('mindmap_panel.stage_outline_single'),
        )
        setLoadingDetail(
          sourceCount > 1
            ? t('mindmap_panel.stage_outline_multi_detail', { count: sourceCount })
            : t('mindmap_panel.stage_outline_single_detail'),
        )
        return
      }
      if (phase === 'merge') {
        setLoadingLabel(t('mindmap_panel.stage_merge'))
        setLoadingDetail(t('mindmap_panel.stage_merge_detail', { count: sourceCount }))
        return
      }
      setLoadingLabel(t('mindmap_panel.stage_expand'))
      setLoadingDetail(
        mindmapMode === 'knowledge_structure'
          ? t('mindmap_panel.stage_expand_structure')
          : t('mindmap_panel.stage_expand_review'),
      )
    },
    [mindmapMode, sourceCount, t],
  )

  const loadCurrentDocument = React.useCallback(async () => {
    if (!source || !user || !workroomId) return
    loadingTimerRefs.current.forEach((timer) => window.clearTimeout(timer))
    loadingTimerRefs.current = []
    setIsLoading(true)
    setLoadingState('load')
    setError(null)
    setDocument(null)
    try {
      const current = await getCurrentMindMap(
        backendBaseUrl,
        source,
        user.tenant_id,
        workroomId,
        user.id,
        mindmapMode,
      )
      setDocument(current)
    } catch (err) {
      console.error('[mindmap] load current failed', err)
      setError(err instanceof Error ? err.message : 'Unknown error')
      setDocument(null)
    } finally {
      setIsLoading(false)
      setLoadingLabel(null)
      setLoadingDetail(null)
    }
  }, [backendBaseUrl, mindmapMode, setLoadingState, source, user, workroomId])

  const generateDocument = React.useCallback(
    async (force = true) => {
      if (!source || !user || !workroomId) return
      loadingTimerRefs.current.forEach((timer) => window.clearTimeout(timer))
      loadingTimerRefs.current = []
      setIsLoading(true)
      setLoadingState('outline')
      setError(null)
      setDocument(null)
      try {
        if ((source.sourceIds?.length ?? 0) > 1) {
          loadingTimerRefs.current.push(window.setTimeout(() => setLoadingState('merge'), 800))
          loadingTimerRefs.current.push(window.setTimeout(() => setLoadingState('expand'), 1600))
        } else {
          loadingTimerRefs.current.push(window.setTimeout(() => setLoadingState('expand'), 900))
        }
        const generated = await generateMindMap(
          backendBaseUrl,
          source,
          user.tenant_id,
          workroomId,
          user.id,
          mindmapMode,
          force,
        )
        setDocument(generated)
      } catch (err) {
        console.error('[mindmap] load failed', err)
        setError(err instanceof Error ? err.message : 'Unknown error')
        setDocument(null)
      } finally {
        loadingTimerRefs.current.forEach((timer) => window.clearTimeout(timer))
        loadingTimerRefs.current = []
        setIsLoading(false)
        setLoadingLabel(null)
        setLoadingDetail(null)
      }
    },
    [backendBaseUrl, mindmapMode, setLoadingState, source, user, workroomId],
  )

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia('(pointer: coarse)')
    const updatePointerMode = () => setIsCoarsePointer(mediaQuery.matches)
    updatePointerMode()
    mediaQuery.addEventListener?.('change', updatePointerMode)
    return () => mediaQuery.removeEventListener?.('change', updatePointerMode)
  }, [])

  React.useEffect(() => {
    setSelectedNodeId(null)
    setEditingNodeId(null)
    setRadialMenu(null)
    setHoveredNode(null)
    setActionHint(null)
    setIsFocusMode(false)
    setSelectionState({
      selectedNodeCount: 0,
      hasSelectedArrow: false,
      hasSelectedSummary: false,
    })
    void loadCurrentDocument()
  }, [loadCurrentDocument])

  React.useEffect(() => {
    if (restoredPanelStateKeyRef.current !== panelStateKey) {
      restoredPanelStateKeyRef.current = null
    }
  }, [panelStateKey])

  React.useEffect(() => {
    if (!document || !source || !user || !workroomId) return
    setViewState(null)
    let cancelled = false
    void fetchWorkroomArtifact(
      backendBaseUrl,
      workroomId,
      user.tenant_id,
      user.id,
      'mindmap_panel',
      'current',
    )
      .then((artifact) => {
        if (cancelled || !artifact) return
        const payload = artifact.payload_json ?? {}
        const artifactSourceType = payload.sourceType
        const artifactSourceId = payload.sourceId
        const artifactMindmapId = payload.mindmapId
        const artifactSelectedNodeId = payload.selectedNodeId
        const artifactViewState = payload.viewState
        const artifactLayoutMode = payload.layoutMode
        const artifactMindmapMode = payload.mindmapMode
        const artifactSourceIds = Array.isArray(payload.sourceIds)
          ? payload.sourceIds.map((value: unknown) => Number(value)).filter((value: number) => Number.isFinite(value) && value > 0)
          : []
        const artifactSourceSignature =
          typeof payload.sourceSignature === 'string' && payload.sourceSignature.trim()
            ? payload.sourceSignature.trim()
            : artifactSourceIds.length > 1
              ? `${artifactSourceType}:${[...artifactSourceIds].sort((a, b) => a - b).join(',')}`
              : null
        if (artifactSourceType !== source.sourceType || artifactSourceId !== source.sourceId) return
        if ((artifactSourceSignature ?? null) !== (sourceSignature ?? null)) return
        if (typeof artifactSelectedNodeId === 'string') {
          setSelectedNodeId(artifactSelectedNodeId)
        }
        const shouldRestorePanelPreferences =
          restoredPanelStateKeyRef.current == null && restoredPanelStateKeyRef.current !== panelStateKey
        if (shouldRestorePanelPreferences) {
          if (artifactMindmapMode === 'knowledge_structure' || artifactMindmapMode === 'exam_review') {
            setMindmapMode(artifactMindmapMode)
          }
          restoredPanelStateKeyRef.current = panelStateKey
        }
        if (artifactLayoutMode === 'side' || artifactLayoutMode === 'left' || artifactLayoutMode === 'right') {
          setLayoutMode(artifactLayoutMode)
        } else {
          setLayoutMode('right')
        }
        if (
          artifactMindmapId === document.id &&
          artifactViewState &&
          typeof artifactViewState === 'object' &&
          typeof (artifactViewState as Record<string, unknown>).scale === 'number' &&
          typeof (artifactViewState as Record<string, unknown>).translateX === 'number' &&
          typeof (artifactViewState as Record<string, unknown>).translateY === 'number'
        ) {
          setViewState(artifactViewState as MindMapViewState)
        } else {
          setViewState(null)
        }
      })
      .catch((err) => {
        console.error('[mindmap] failed to load panel state', err)
      })
    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, document?.id, panelStateKey, source, sourceSignature, user, workroomId])

  React.useEffect(() => {
    if (!radialMenu) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.mindmap-radial-menu')) return
      setRadialMenu(null)
      if (isCoarsePointer) setHoveredNode(null)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRadialMenu(null)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [isCoarsePointer, radialMenu])

  React.useEffect(() => {
    if (!radialMenu) return
    if (isCoarsePointer) {
      setRadialMenu(null)
      return
    }
    if (radialMenu.targetType === 'node' && selectedNodeId !== radialMenu.nodeId) {
      setRadialMenu(null)
    }
  }, [radialMenu, selectedNodeId, isCoarsePointer])

  React.useEffect(() => {
    if (!editorReady) return
    editorControllerRef.current?.setLayout(layoutMode)
  }, [editorReady, layoutMode])

  React.useEffect(() => {
    if (!document || !user || !workroomId) return
    const timer = window.setTimeout(() => {
      void upsertWorkroomArtifact(
        backendBaseUrl,
        workroomId,
        user.tenant_id,
        user.id,
        'mindmap_panel',
        'current',
        {
          source_file_id: mode === 'file' ? fileId ?? undefined : undefined,
          studio_document_id: mode === 'document' ? documentId ?? undefined : undefined,
          payload_json: {
            mindmapId: document.id,
            sourceType: document.source.type,
            sourceId: document.source.id,
            sourceIds: document.source.ids,
            sourceSignature: document.source.signature,
            selectedNodeId,
            viewState,
            layoutMode,
            mindmapMode,
          },
        },
      ).catch((err) => {
        console.error('[mindmap] failed to persist panel state', err)
      })
    }, 220)

    return () => window.clearTimeout(timer)
  }, [
    backendBaseUrl,
    workroomId,
    user,
    document?.id,
    document?.source?.type,
    document?.source?.id,
    selectedNodeId,
    viewState,
    layoutMode,
    mindmapMode,
    mode,
    fileId,
    documentId,
    sourceSignature,
  ])

  const handleSave = React.useCallback(async () => {
    if (!document || !user || !workroomId) return
    setIsSaving(true)
    try {
      const snapshot = editorControllerRef.current?.flushSnapshot() ?? document
      const saved = await saveMindMap(backendBaseUrl, user.tenant_id, workroomId, user.id, snapshot)
      setDocument(saved)
    } catch (err) {
      console.error('[mindmap] save failed', err)
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }, [backendBaseUrl, document, user, workroomId])

  const handleNavigate = React.useCallback(
    (node: MindMapNodeTree) => {
      if (!onNavigateToQuestion) return
      const ref = firstQuestionRef(node)
      onNavigateToQuestion({
        questionId: ref?.questionId ?? null,
        sequenceIndex: ref?.sequenceIndex ?? null,
        page: ref?.page ?? null,
        label: node.topic,
      })
    },
    [onNavigateToQuestion],
  )

  const closeRadialMenu = React.useCallback(() => {
    setRadialMenu(null)
  }, [])

  const showActionHint = React.useCallback((message: string) => {
    if (actionHintTimerRef.current !== null) {
      window.clearTimeout(actionHintTimerRef.current)
    }
    setActionHint(message)
    actionHintTimerRef.current = window.setTimeout(() => {
      setActionHint(null)
      actionHintTimerRef.current = null
    }, 1800)
  }, [])

  React.useEffect(() => {
    return () => {
      if (actionHintTimerRef.current !== null) {
        window.clearTimeout(actionHintTimerRef.current)
      }
      loadingTimerRefs.current.forEach((timer) => window.clearTimeout(timer))
      loadingTimerRefs.current = []
    }
  }, [])

  const isZh = React.useMemo(() => {
    const lang = (i18n.resolvedLanguage ?? i18n.language ?? '').toLowerCase()
    return lang.startsWith('zh')
  }, [i18n.language, i18n.resolvedLanguage])

  const menuLabel = React.useCallback(
    (zh: string, en: string) => (isZh ? zh : en),
    [isZh],
  )

  const radialActions = React.useMemo(() => {
    const controller = editorControllerRef.current
    const selectedCount = selectionState.selectedNodeCount
    const hasSelectedArrow = selectionState.hasSelectedArrow
    const hasSelectedSummary = selectionState.hasSelectedSummary
    const isSummaryMenu = radialMenu?.targetType === 'summary'

    const run = (action: () => void) => () => {
      action()
      closeRadialMenu()
    }

    const runBoolean = (
      action: () => boolean | undefined,
      okMessage: string,
      failMessage: string,
    ) =>
      run(() => {
        const ok = Boolean(action())
        showActionHint(ok ? okMessage : failMessage)
      })

    const nodeActions = [
      {
        icon: 'edit_note',
        label: menuLabel('编辑节点', 'Edit Node'),
        angle: -120,
        onClick: run(() => {
          if (selectedNodeId) setEditingNodeId(selectedNodeId)
        }),
      },
      {
        icon: 'account_tree',
        label: menuLabel('新增子节点', 'Add Child'),
        angle: -75,
        onClick: runBoolean(
          () => controller?.addChildNode(),
          menuLabel('已新增子节点', 'Child node added'),
          menuLabel('无法新增子节点', 'Unable to add child node'),
        ),
      },
      {
        icon: 'add_2',
        label: menuLabel('新增同级', 'Add Sibling'),
        angle: -30,
        onClick: runBoolean(
          () => controller?.addSiblingNode(),
          menuLabel('已新增同级节点', 'Sibling node added'),
          menuLabel('无法新增同级节点', 'Unable to add sibling node'),
        ),
      },
      {
        icon: 'timeline',
        label: selectedCount === 2 ? menuLabel('创建连线', 'Create Link') : menuLabel('连线模式', 'Link Mode'),
        angle: 15,
        onClick: run(() => {
          if (selectedCount === 2) {
            controller?.createArrow()
            showActionHint(menuLabel('已创建连线', 'Link created'))
            return
          }
          if (controller?.beginLinkMode(false)) {
            showActionHint(menuLabel('请点击目标节点完成连线', 'Select target node to finish link'))
          }
        }),
      },
      {
        icon: 'swap_horiz',
        label:
          selectedCount === 2
            ? menuLabel('双向连线', 'Bidirectional Link')
            : menuLabel('双向连线模式', 'Bidirectional Mode'),
        angle: 60,
        onClick: run(() => {
          if (selectedCount === 2) {
            const ok = controller?.createBidirectionalArrow()
            showActionHint(
              ok
                ? menuLabel('已创建双向连线', 'Bidirectional link created')
                : menuLabel('无法创建双向连线', 'Unable to create bidirectional link'),
            )
            return
          }
          if (controller?.beginLinkMode(true)) {
            showActionHint(menuLabel('请点击目标节点完成双向连线', 'Select target node to finish bidirectional link'))
          }
        }),
      },
      {
        icon: 'join_inner',
        label:
          selectedCount >= 2 ? menuLabel('总结', 'Summary') : menuLabel('总结（需先多选）', 'Summary (multi-select)'),
        angle: 105,
        disabled: selectedCount < 2,
        onClick: run(() => {
          const result: MindMapActionResult = controller?.createSummary() ?? { ok: false, reason: 'unknown' }
          if (result.ok) {
            showActionHint(menuLabel('已创建总结，可继续创建更多总结', 'Summary created, you can add more'))
            return
          }
          if (result.reason === 'requires_multiple_nodes') {
            showActionHint(menuLabel('请先多选至少两个节点', 'Select at least two nodes'))
            return
          }
          if (result.reason === 'requires_same_parent') {
            showActionHint(menuLabel('请选择同一主节点下的多个同级节点', 'Select sibling nodes under the same main topic'))
            return
          }
          showActionHint(menuLabel('当前选择无法创建总结', 'Cannot create summary for current selection'))
        }),
      },
      {
        icon: 'edit',
        label: hasSelectedSummary ? menuLabel('编辑总结', 'Edit Summary') : menuLabel('编辑总结（需先选中）', 'Edit Summary (select first)'),
        angle: 128,
        disabled: !hasSelectedSummary,
        onClick: runBoolean(
          () => controller?.editSummary(),
          menuLabel('已进入总结编辑', 'Summary edit opened'),
          menuLabel('请先选中一个总结', 'Select a summary first'),
        ),
      },
      {
        icon: 'delete_sweep',
        label: hasSelectedSummary ? menuLabel('删除总结', 'Remove Summary') : menuLabel('删除总结（需先选中）', 'Remove Summary (select first)'),
        angle: 144,
        disabled: !hasSelectedSummary,
        onClick: runBoolean(
          () => controller?.removeSummary(),
          menuLabel('已删除总结', 'Summary removed'),
          menuLabel('请先选中一个总结', 'Select a summary first'),
        ),
      },
      {
        icon: 'filter_center_focus',
        label: isFocusMode ? menuLabel('退出聚焦', 'Cancel Focus') : menuLabel('退出聚焦（未启用）', 'Cancel Focus (inactive)'),
        angle: 150,
        disabled: !isFocusMode,
        onClick: run(() => {
          if (controller?.cancelFocusMode()) {
            setIsFocusMode(false)
            showActionHint(menuLabel('已退出聚焦模式', 'Focus mode cancelled'))
          }
        }),
      },
      {
        icon: 'center_focus_strong',
        label: menuLabel('聚焦模式', 'Focus Mode'),
        angle: 195,
        onClick: run(() => {
          if (controller?.focusNode()) {
            setIsFocusMode(true)
            showActionHint(menuLabel('已进入聚焦模式', 'Focus mode enabled'))
          }
        }),
      },
      {
        icon: 'delete',
        label: menuLabel('删除节点', 'Delete Node'),
        angle: 240,
        tone: 'danger' as const,
        onClick: runBoolean(
          () => controller?.removeSelection(),
          menuLabel('已删除当前对象', 'Current selection removed'),
          menuLabel('当前没有可删除对象', 'Nothing selected to remove'),
        ),
      },
      {
        icon: 'playlist_add',
        label: menuLabel('新增父节点', 'Add Parent'),
        angle: 285,
        onClick: runBoolean(
          () => controller?.addParentNode(),
          menuLabel('已新增父节点', 'Parent node added'),
          menuLabel('无法新增父节点', 'Unable to add parent node'),
        ),
      },
      {
        icon: 'arrow_upward',
        label: menuLabel('上移节点', 'Move Up'),
        angle: 330,
        onClick: runBoolean(
          () => controller?.moveNodeUp(),
          menuLabel('已上移节点', 'Node moved up'),
          menuLabel('该节点无法上移', 'Node cannot be moved up'),
        ),
      },
      {
        icon: 'arrow_downward',
        label: menuLabel('下移节点', 'Move Down'),
        angle: 375,
        onClick: runBoolean(
          () => controller?.moveNodeDown(),
          menuLabel('已下移节点', 'Node moved down'),
          menuLabel('该节点无法下移', 'Node cannot be moved down'),
        ),
      },
      {
        icon: 'edit_square',
        label: hasSelectedArrow ? menuLabel('编辑连线', 'Edit Link') : menuLabel('编辑连线（需先选中）', 'Edit Link (select first)'),
        angle: 30,
        disabled: !hasSelectedArrow,
        onClick: runBoolean(
          () => controller?.editArrow(),
          menuLabel('已进入连线编辑', 'Link edit opened'),
          menuLabel('请先选中一条连线', 'Select a link first'),
        ),
      },
      {
        icon: 'link_off',
        label: hasSelectedArrow ? menuLabel('删除连线', 'Remove Link') : menuLabel('删除连线（需先选中）', 'Remove Link (select first)'),
        angle: 46,
        disabled: !hasSelectedArrow,
        onClick: runBoolean(
          () => controller?.removeArrow(),
          menuLabel('已删除连线', 'Link removed'),
          menuLabel('请先选中一条连线', 'Select a link first'),
        ),
      },
    ]

    if (isSummaryMenu) {
      return [
        {
          icon: 'edit',
          label: menuLabel('编辑总结', 'Edit Summary'),
          onClick: runBoolean(
            () => controller?.editSummary(),
            menuLabel('已进入总结编辑', 'Summary edit opened'),
            menuLabel('请先选中一个总结', 'Select a summary first'),
          ),
        },
        {
          icon: 'delete',
          label: menuLabel('删除总结', 'Remove Summary'),
          tone: 'danger' as const,
          onClick: runBoolean(
            () => controller?.removeSummary(),
            menuLabel('已删除总结', 'Summary removed'),
            menuLabel('请先选中一个总结', 'Select a summary first'),
          ),
        },
      ]
    }

    return nodeActions
  }, [
    closeRadialMenu,
    isFocusMode,
    menuLabel,
    radialMenu?.targetType,
    selectedNodeId,
    selectionState.hasSelectedArrow,
    selectionState.hasSelectedSummary,
    selectionState.selectedNodeCount,
    showActionHint,
  ])

  const showTouchContextActions =
    isCoarsePointer &&
    editorReady &&
    (selectionState.selectedNodeCount === 1 ||
      selectionState.selectedNodeCount === 2 ||
      selectionState.selectedNodeCount >= 2 ||
      selectionState.hasSelectedArrow ||
      selectionState.hasSelectedSummary)

  if (!user || !workroomId || (!documentId && !fileId)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-slate-500">
        <p>{!user ? t('mindmap.login_required') : !workroomId ? 'Workroom context required' : t('mindmap.no_source')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-transparent">
      <div className="flex shrink-0 flex-col gap-1 px-2 py-2 sm:px-3 sm:py-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 sm:text-[11px]">Mindmap Workspace</p>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <h2 className="truncate text-base font-semibold leading-none text-slate-900 sm:text-lg">{t('mindmap_panel.title')}</h2>
            {document && (
              <span className="shrink-0 pb-0.5 text-[11px] font-semibold text-emerald-600 sm:text-xs">
                {'v' +
                  document.version +
                  ' | ' +
                  document.meta.generatedBy +
                  ' | ' +
                  (mindmapMode === 'knowledge_structure'
                    ? t('mindmap_toolbar.mode_knowledge_short')
                    : t('mindmap_toolbar.mode_exam_short'))}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-white/88 shadow-[0_18px_48px_rgba(15,23,42,0.08)] sm:border sm:border-slate-200">
        <MindMapToolbar
          mode={mode}
          onModeChange={setMode}
          mindmapMode={mindmapMode}
          onMindmapModeChange={setMindmapMode}
          layoutMode={layoutMode}
          onCycleLayout={() => {
            const nextLayout = layoutMode === 'right' ? 'side' : layoutMode === 'side' ? 'left' : 'right'
            setLayoutMode(nextLayout)
            editorControllerRef.current?.setLayout(nextLayout)
          }}
          canUseDocument={canUseDocument}
          canUseFile={canUseFile}
          onRefresh={() => void generateDocument(true)}
          refreshDisabled={!canGenerateCurrent || isLoading}
          refreshLabel={isLoading ? t('mindmap.generating') : document ? t('mindmap.regenerate') : t('mindmap.generate')}
          showSave={Boolean(document)}
          onSave={() => void handleSave()}
          saveDisabled={isSaving || !document}
          canControlView={Boolean(document && editorReady)}
          onUndo={() => {
            editorControllerRef.current?.undo()
          }}
          onRedo={() => {
            editorControllerRef.current?.redo()
          }}
          onFitView={() => editorControllerRef.current?.fitView()}
          onExpandAll={() => editorControllerRef.current?.expandAll()}
          onCollapseAll={() => editorControllerRef.current?.collapseAll()}
          onExportPng={() => {
            void editorControllerRef.current?.exportPng()
          }}
        />
        {actionHint && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-[0_10px_28px_rgba(15,23,42,0.12)] backdrop-blur">
            {actionHint}
          </div>
        )}
        {isLoading && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
            <MindMapLoadingAnimation label={loadingLabel ?? undefined} detail={loadingDetail} />
          </div>
        )}
        {error && !isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-sm text-rose-600">
            <p>{t('mindmap_panel.load_failed', { error })}</p>
            <button
              type="button"
              className="rounded-full border border-rose-200 px-3 py-1.5 text-rose-600 hover:bg-rose-50"
              onClick={() => void loadCurrentDocument()}
            >
              {t('mindmap_panel.retry')}
            </button>
          </div>
        )}
        {!document && !isLoading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-4 text-center text-slate-500">
            <p className="text-sm">
              {mode === 'document'
                ? canUseDocument
                  ? t('mindmap_panel.document_ready')
                  : t('mindmap_panel.document_not_ready')
                : canUseFile
                  ? t('mindmap_panel.file_ready')
                  : t('mindmap_panel.file_not_ready')}
            </p>
            <button
              type="button"
              className="rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg hover:bg-slate-800"
              onClick={() => void generateDocument(true)}
              disabled={!canGenerateCurrent}
            >
              {t('mindmap_panel.generate_now')}
            </button>
          </div>
        )}
        {document && !isLoading && (
          <MindElixirCanvas
            document={document}
            onDocumentChange={setDocument}
            onNodeSelect={(nodeId) => {
              setSelectedNodeId(nodeId)
              if (radialMenu && radialMenu.nodeId !== nodeId) setRadialMenu(null)
            }}
            onNodeDoubleClick={(nodeId) => {
              setRadialMenu(null)
              setEditingNodeId(nodeId)
            }}
            onNodeHoverChange={(request) => {
              setHoveredNode(request)
            }}
            onNodeContextMenu={(request) => {
              if (isCoarsePointer) return
              setRadialMenu(request)
            }}
            initialViewState={viewState}
            onViewStateChange={setViewState}
            onSelectionStateChange={setSelectionState}
            onControllerReady={handleControllerReady}
          />
        )}
        {document && !isLoading && !isCoarsePointer && hoveredNode && hoveredNodeData?.summary && (
          <div
            className="pointer-events-none absolute z-20 w-[min(20rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-full rounded-2xl border border-slate-200 bg-white/97 p-3 shadow-[0_16px_40px_rgba(15,23,42,0.14)] backdrop-blur"
            style={{
              left: hoveredNode.x,
              top: hoveredNode.y - 14,
            }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {t('mindmap_node_editor.description_label', { remaining: Math.max(0, 240 - hoveredNodeData.summary.length) })}
            </p>
            <h3 className="mt-1 text-sm font-semibold text-slate-900">{hoveredNodeData.topic}</h3>
            <p className="mt-2 text-xs leading-6 text-slate-600">{hoveredNodeData.summary}</p>
          </div>
        )}
        {document && !isLoading && isCoarsePointer && selectedNode && (selectedNode.summary || selectedNode.questionRefs.length > 0) && (
          <div
            className="pointer-events-none absolute left-4 z-20 max-w-[min(24rem,calc(100%-2rem))] rounded-2xl border border-slate-200 bg-white/96 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.12)] backdrop-blur sm:left-5 lg:left-6"
            style={{
              bottom: showTouchContextActions ? '8.75rem' : '1rem',
            }}
          >
            <div className="space-y-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {t('mindmap_node_editor.title')}
                </p>
                <h3 className="mt-1 text-sm font-semibold text-slate-900 sm:text-base">{selectedNode.topic}</h3>
              </div>
              {selectedNode.summary && (
                <p className="text-xs leading-6 text-slate-600 sm:text-[13px]">{selectedNode.summary}</p>
              )}
              {selectedNode.questionRefs.length > 0 && (
                <p className="text-[11px] font-medium text-emerald-600 sm:text-xs">
                  {t('mindmap_node_editor.view_question')}
                </p>
              )}
            </div>
          </div>
        )}
        <MindMapRadialMenu
          anchor={radialMenu ? { x: radialMenu.x, y: radialMenu.y } : null}
          visible={Boolean(radialMenu && editorReady && !isCoarsePointer)}
          actions={radialActions}
          onClose={closeRadialMenu}
          uiLabels={{
            close: menuLabel('关闭菜单', 'Close menu'),
            more: menuLabel('更多操作', 'More actions'),
            back: menuLabel('返回主菜单', 'Back to primary'),
          }}
        />
        {isCoarsePointer && (
          <MindMapContextActions
            canEditNode={
              selectionState.selectedNodeCount === 1 &&
              !selectionState.hasSelectedArrow &&
              !selectionState.hasSelectedSummary &&
              editorReady
            }
            canAddChild={
              selectionState.selectedNodeCount === 1 &&
              !selectionState.hasSelectedArrow &&
              !selectionState.hasSelectedSummary &&
              editorReady
            }
            canAddSibling={
              selectionState.selectedNodeCount === 1 &&
              !selectionState.hasSelectedArrow &&
              !selectionState.hasSelectedSummary &&
              editorReady
            }
            canRemoveSelection={
              selectionState.selectedNodeCount === 1 &&
              !selectionState.hasSelectedArrow &&
              !selectionState.hasSelectedSummary &&
              editorReady
            }
            onEditNode={() => {
              if (selectedNodeId) setEditingNodeId(selectedNodeId)
            }}
            onAddChild={() => {
              editorControllerRef.current?.addChildNode()
            }}
            onAddSibling={() => {
              editorControllerRef.current?.addSiblingNode()
            }}
            onRemoveSelection={() => {
              editorControllerRef.current?.removeSelection()
            }}
            canCreateArrow={selectionState.selectedNodeCount === 2 && editorReady}
            canEditArrow={selectionState.hasSelectedArrow && editorReady}
            canRemoveArrow={selectionState.hasSelectedArrow && editorReady}
            onCreateArrow={() => {
              editorControllerRef.current?.createArrow()
            }}
            onEditArrow={() => {
              editorControllerRef.current?.editArrow()
            }}
            onRemoveArrow={() => {
              editorControllerRef.current?.removeArrow()
            }}
            canCreateSummary={selectionState.selectedNodeCount >= 2 && editorReady}
            canEditSummary={selectionState.hasSelectedSummary && editorReady}
            canRemoveSummary={selectionState.hasSelectedSummary && editorReady}
            onCreateSummary={() => {
              editorControllerRef.current?.createSummary()
            }}
            onEditSummary={() => {
              editorControllerRef.current?.editSummary()
            }}
            onRemoveSummary={() => {
              editorControllerRef.current?.removeSummary()
            }}
          />
        )}
        <MindMapNodeEditor
          node={editingNode}
          onClose={() => setEditingNodeId(null)}
          onNavigate={handleNavigate}
          onSubmit={(updated) => {
            if (!document) return
            setDocument({
              ...document,
              root: updateNodeById(document.root, updated.id, () => updated),
              meta: {
                ...document.meta,
                updatedAt: new Date().toISOString(),
              },
            })
            setEditingNodeId(null)
          }}
        />
      </div>
    </div>
  )
}

