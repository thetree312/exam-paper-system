import React from 'react'
import MindElixir, {
  LEFT,
  RIGHT,
  SIDE,
  THEME,
  type MindElixirData,
  type MindElixirInstance,
  type NodeObj,
} from 'mind-elixir'
import 'mind-elixir/style.css'

import type {
  MindMapDocumentPayload,
  MindMapNodeTree,
  MindMapRelation,
  MindMapSummary,
  MindMapViewState,
} from '../domain/types'

interface MindElixirArrow {
  id: string
  from: string
  to: string
  label: string
}

interface MindElixirSummary {
  id: string
  label: string
  parent: string
  start: number
  end: number
  style?: {
    stroke?: string
    labelColor?: string
  }
}

export type MindMapActionFailureReason = 'requires_multiple_nodes' | 'requires_same_parent' | 'unknown'

export interface MindMapActionResult {
  ok: boolean
  reason?: MindMapActionFailureReason
}

export interface MindMapEditorController {
  flushSnapshot: () => MindMapDocumentPayload | null
  fitView: () => void
  centerView: () => void
  setLayout: (layout: 'side' | 'left' | 'right') => void
  expandAll: () => void
  collapseAll: () => void
  exportPng: () => Promise<void>
  undo: () => boolean
  redo: () => boolean
  addChildNode: () => boolean
  addParentNode: () => boolean
  addSiblingNode: () => boolean
  moveNodeUp: () => boolean
  moveNodeDown: () => boolean
  focusNode: () => boolean
  cancelFocusMode: () => boolean
  removeSelection: () => boolean
  createArrow: () => boolean
  createBidirectionalArrow: () => boolean
  beginLinkMode: (bidirectional?: boolean) => boolean
  editArrow: () => boolean
  removeArrow: () => boolean
  createSummary: () => MindMapActionResult
  editSummary: () => boolean
  removeSummary: () => boolean
}

export interface MindMapEditorSelectionState {
  selectedNodeCount: number
  hasSelectedArrow: boolean
  hasSelectedSummary: boolean
}

export interface MindMapNodeAnchor {
  nodeId: string
  x: number
  y: number
}

export interface MindMapNodeContextMenuRequest {
  targetType: 'node' | 'summary'
  nodeId?: string
  summaryId?: string
  x: number
  y: number
}

export interface MindMapNodeHoverRequest {
  nodeId: string
  x: number
  y: number
}

interface MindElixirCanvasProps {
  document: MindMapDocumentPayload
  onDocumentChange: (next: MindMapDocumentPayload) => void
  onNodeSelect?: (nodeId: string) => void
  onNodeDoubleClick?: (nodeId: string) => void
  onNodeHoverChange?: (request: MindMapNodeHoverRequest | null) => void
  onNodeAnchorChange?: (anchor: MindMapNodeAnchor | null) => void
  onNodeContextMenu?: (request: MindMapNodeContextMenuRequest | null) => void
  onControllerReady?: (controller: MindMapEditorController | null) => void
  initialViewState?: MindMapViewState | null
  onViewStateChange?: (viewState: MindMapViewState) => void
  onSelectionStateChange?: (selection: MindMapEditorSelectionState) => void
}

const SNAPSHOT_DEBOUNCE_MS = 180
const VIEW_STATE_DEBOUNCE_MS = 120
const STRUCTURE_SNAPSHOT_DELAY_MS = 80
const DEBUG_PREFIX = '[mindmap-debug]'

function summarizeExpandedState(node: NodeObj | MindMapNodeTree | undefined | null): {
  total: number
  expanded: number
  collapsed: number
} {
  if (!node) {
    return { total: 0, expanded: 0, collapsed: 0 }
  }
  let total = 0
  let expanded = 0
  let collapsed = 0
  const stack = [node as NodeObj | MindMapNodeTree]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    total += 1
    if ((current as NodeObj).expanded === false || (current as MindMapNodeTree).expanded === false) collapsed += 1
    else expanded += 1
    const children = Array.isArray(current.children) ? current.children : []
    for (const child of children) stack.push(child)
  }
  return { total, expanded, collapsed }
}

function debugLog(event: string, payload?: Record<string, unknown>) {
  if (payload) console.log(DEBUG_PREFIX, event, payload)
  else console.log(DEBUG_PREFIX, event)
}

function parseTransform(transform: string): MindMapViewState {
  const translateMatch = transform.match(/translate3d\(([^,]+),\s*([^,]+),/)
  const scaleMatch = transform.match(/scale\(([^)]+)\)/)
  return {
    scale: Number.parseFloat(scaleMatch?.[1] ?? '1') || 1,
    translateX: Number.parseFloat(translateMatch?.[1] ?? '0') || 0,
    translateY: Number.parseFloat(translateMatch?.[2] ?? '0') || 0,
  }
}

function readViewState(instance: MindElixirInstance): MindMapViewState {
  return parseTransform(instance.map.style.transform)
}

function applyViewState(instance: MindElixirInstance, viewState: MindMapViewState | null | undefined): void {
  if (!viewState) return
  if (!instance.map?.style) return
  instance.scaleVal = viewState.scale > 0 ? viewState.scale : 1
  instance.map.style.transform = `translate3d(${viewState.translateX}px, ${viewState.translateY}px, 0) scale(${instance.scaleVal})`
}

function readSelectionState(instance: MindElixirInstance): MindMapEditorSelectionState {
  return {
    selectedNodeCount: Array.isArray(instance.currentNodes) ? instance.currentNodes.length : 0,
    hasSelectedArrow: Boolean(instance.currentArrow),
    hasSelectedSummary: Boolean(instance.currentSummary),
  }
}

function clampContextMenuAnchor(x: number, y: number, hostRect: DOMRect): { x: number; y: number } {
  const horizontalMargin = 124
  const verticalMargin = 124
  return {
    x: Math.max(horizontalMargin, Math.min(hostRect.width - horizontalMargin, x)),
    y: Math.max(verticalMargin, Math.min(hostRect.height - verticalMargin, y)),
  }
}

function toMindElixirNode(node: MindMapNodeTree): NodeObj {
  const metadata: Record<string, unknown> = {}
  if (node.summary) metadata.summary = node.summary
  if (node.questionRefs.length > 0) metadata.questionRefs = node.questionRefs
  if (node.side) metadata.side = node.side

  return {
    id: node.id,
    topic: node.topic,
    expanded: node.expanded ?? true,
    note: node.summary ?? undefined,
    direction: node.side === 'left' ? LEFT : node.side === 'right' ? RIGHT : undefined,
    metadata,
    children: node.children.map((child) => toMindElixirNode(child)),
  }
}

function fromMindElixirNode(node: NodeObj): MindMapNodeTree {
  const metadata = (node.metadata ?? {}) as Record<string, unknown>
  const questionRefs = Array.isArray(metadata.questionRefs) ? metadata.questionRefs : []
  const side = metadata.side === 'left' || metadata.side === 'right'
    ? metadata.side
    : node.direction === LEFT
      ? 'left'
      : node.direction === RIGHT
        ? 'right'
        : null

  return {
    id: String(node.id),
    topic: String(node.topic ?? ''),
    summary: typeof metadata.summary === 'string' ? metadata.summary : node.note ?? null,
    expanded: node.expanded !== false,
    side,
    questionRefs: questionRefs as MindMapNodeTree['questionRefs'],
    children: Array.isArray(node.children) ? node.children.map((child) => fromMindElixirNode(child)) : [],
  }
}

function toMindElixirArrows(relations: MindMapRelation[]): MindElixirArrow[] {
  return relations.map((relation) => ({
    id: relation.id,
    from: relation.from,
    to: relation.to,
    label: relation.label ?? '',
  }))
}

function fromMindElixirArrows(arrows: MindElixirArrow[] | undefined): MindMapRelation[] {
  if (!Array.isArray(arrows)) return []
  return arrows.map((arrow) => ({
    id: String(arrow.id),
    from: String(arrow.from),
    to: String(arrow.to),
    label: arrow.label ? String(arrow.label) : null,
  }))
}

function toMindElixirSummaries(summaries: MindMapSummary[]): MindElixirSummary[] {
  return summaries.map((summary) => ({
    id: summary.id,
    label: summary.label,
    parent: summary.parent,
    start: summary.start,
    end: summary.end,
    style: summary.style
      ? {
          stroke: summary.style.stroke ?? undefined,
          labelColor: summary.style.labelColor ?? undefined,
        }
      : undefined,
  }))
}

function fromMindElixirSummaries(summaries: MindElixirSummary[] | undefined): MindMapSummary[] {
  if (!Array.isArray(summaries)) return []
  return summaries.map((summary) => ({
    id: String(summary.id),
    label: String(summary.label ?? ''),
    parent: String(summary.parent),
    start: Number(summary.start ?? 0),
    end: Number(summary.end ?? 0),
    style: summary.style
      ? {
          stroke: summary.style.stroke ?? null,
          labelColor: summary.style.labelColor ?? null,
        }
      : null,
  }))
}

function toMindElixirData(document: MindMapDocumentPayload): MindElixirData {
  return {
    nodeData: toMindElixirNode(document.root),
    arrows: toMindElixirArrows(document.relations),
    summaries: toMindElixirSummaries(document.summaries),
    direction: SIDE,
  }
}

export const MindElixirCanvas: React.FC<MindElixirCanvasProps> = ({
  document,
  onDocumentChange,
  onNodeSelect,
  onNodeDoubleClick,
  onNodeHoverChange,
  onNodeAnchorChange,
  onNodeContextMenu,
  onControllerReady,
  initialViewState,
  onViewStateChange,
  onSelectionStateChange,
}) => {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const instanceRef = React.useRef<MindElixirInstance | null>(null)
  const latestDocumentRef = React.useRef(document)
  const fittedViewKeyRef = React.useRef<string | null>(null)
  const snapshotTimerRef = React.useRef<number | null>(null)
  const structureSnapshotTimerRef = React.useRef<number | null>(null)
  const viewStateTimerRef = React.useRef<number | null>(null)
  const appliedViewStateKeyRef = React.useRef<string | null>(null)
  const lastAppliedViewStateRef = React.useRef<string | null>(null)
  const fitFrameRef = React.useRef<number | null>(null)
  const fitTimeoutRef = React.useRef<number | null>(null)
  const refreshFrameRef = React.useRef<number | null>(null)
  const pendingLinkRef = React.useRef<{ fromId: string; bidirectional: boolean } | null>(null)
  const onDocumentChangeRef = React.useRef(onDocumentChange)
  const onNodeSelectRef = React.useRef(onNodeSelect)
  const onNodeDoubleClickRef = React.useRef(onNodeDoubleClick)
  const onNodeHoverChangeRef = React.useRef(onNodeHoverChange)
  const onNodeAnchorChangeRef = React.useRef(onNodeAnchorChange)
  const onNodeContextMenuRef = React.useRef(onNodeContextMenu)
  const onControllerReadyRef = React.useRef(onControllerReady)
  const onViewStateChangeRef = React.useRef(onViewStateChange)
  const onSelectionStateChangeRef = React.useRef(onSelectionStateChange)

  latestDocumentRef.current = document
  onDocumentChangeRef.current = onDocumentChange
  onNodeSelectRef.current = onNodeSelect
  onNodeDoubleClickRef.current = onNodeDoubleClick
  onNodeHoverChangeRef.current = onNodeHoverChange
  onNodeAnchorChangeRef.current = onNodeAnchorChange
  onNodeContextMenuRef.current = onNodeContextMenu
  onControllerReadyRef.current = onControllerReady
  onViewStateChangeRef.current = onViewStateChange
  onSelectionStateChangeRef.current = onSelectionStateChange

  const fitDocumentToViewport = React.useCallback((instance: MindElixirInstance) => {
    const run = () => {
      if (instanceRef.current !== instance || !instance.container || !instance.nodes) return
      instance.scaleFit()
      instance.toCenter()
    }
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current)
    }
    if (fitTimeoutRef.current !== null) {
      window.clearTimeout(fitTimeoutRef.current)
    }
    fitFrameRef.current = window.requestAnimationFrame(() => {
      run()
      fitTimeoutRef.current = window.setTimeout(run, 80)
    })
  }, [])

  const emitSnapshot = React.useCallback(() => {
    const instance = instanceRef.current
    if (!instance) return null
    const exported = instance.getData() as MindElixirData & { arrows?: MindElixirArrow[]; summaries?: MindElixirSummary[] }
    debugLog('emitSnapshot', {
      documentId: latestDocumentRef.current.id,
      version: latestDocumentRef.current.version,
      expandedState: summarizeExpandedState(exported.nodeData),
    })
    const nextDocument = {
      ...latestDocumentRef.current,
      root: fromMindElixirNode(exported.nodeData),
      relations: fromMindElixirArrows(exported.arrows),
      summaries: fromMindElixirSummaries(exported.summaries),
      meta: {
        ...latestDocumentRef.current.meta,
        updatedAt: new Date().toISOString(),
      },
    }
    onDocumentChangeRef.current(nextDocument)
    return nextDocument
  }, [])

  const flushSnapshot = React.useCallback(() => {
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current)
      snapshotTimerRef.current = null
    }
    return emitSnapshot()
  }, [emitSnapshot])

  const scheduleSnapshot = React.useCallback(() => {
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current)
    }
    snapshotTimerRef.current = window.setTimeout(() => {
      snapshotTimerRef.current = null
      emitSnapshot()
    }, SNAPSHOT_DEBOUNCE_MS)
  }, [emitSnapshot])

  const scheduleStructureSnapshot = React.useCallback(() => {
    if (structureSnapshotTimerRef.current !== null) {
      window.clearTimeout(structureSnapshotTimerRef.current)
    }
    structureSnapshotTimerRef.current = window.setTimeout(() => {
      structureSnapshotTimerRef.current = null
      emitSnapshot()
    }, STRUCTURE_SNAPSHOT_DELAY_MS)
  }, [emitSnapshot])

  const emitViewState = React.useCallback(() => {
    const instance = instanceRef.current
    if (!instance) return null
    const nextViewState = readViewState(instance)
    onViewStateChangeRef.current?.(nextViewState)
    return nextViewState
  }, [])

  const scheduleViewState = React.useCallback(() => {
    if (viewStateTimerRef.current !== null) {
      window.clearTimeout(viewStateTimerRef.current)
    }
    viewStateTimerRef.current = window.setTimeout(() => {
      viewStateTimerRef.current = null
      emitViewState()
    }, VIEW_STATE_DEBOUNCE_MS)
  }, [emitViewState])

  const emitSelectionState = React.useCallback(() => {
    const instance = instanceRef.current
    if (!instance) return null
    const nextSelection = readSelectionState(instance)
    onSelectionStateChangeRef.current?.(nextSelection)
    return nextSelection
  }, [])

  const emitNodeAnchor = React.useCallback(() => {
    const instance = instanceRef.current
    const host = hostRef.current
    const onNodeAnchorChange = onNodeAnchorChangeRef.current
    if (!instance || !host || !onNodeAnchorChange) return null
    if (instance.currentArrow || instance.currentSummary || !instance.currentNode || instance.currentNodes.length !== 1) {
      onNodeAnchorChange(null)
      return null
    }
    const nodeRect = instance.currentNode.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const anchor = {
      nodeId: String(instance.currentNode.nodeObj.id),
      x: nodeRect.right - hostRect.left,
      y: nodeRect.top - hostRect.top,
    }
    onNodeAnchorChange(anchor)
    return anchor
  }, [])

  React.useEffect(() => {
    if (!hostRef.current) return

    hostRef.current.innerHTML = ''

    let instance!: MindElixirInstance

    instance = new MindElixir({
      el: hostRef.current,
      direction: SIDE,
      theme: {
        ...THEME,
        cssVar: {
          ...THEME.cssVar,
          '--bgcolor': '#f8fafc',
          '--panel-bgcolor': '#ffffff',
          '--panel-color': '#334155',
          '--panel-border-color': '#dbe2ea',
          '--root-bgcolor': '#ffffff',
          '--root-color': '#0f172a',
          '--root-border-color': '#cbd5e1',
          '--main-bgcolor': '#eef4ff',
          '--main-color': '#334155',
          '--color': '#334155',
          '--selected': '#2563eb',
          '--map-padding': '48px',
        },
      },
      editable: true,
      contextMenu: false,
      toolBar: false,
      keypress: true,
      allowUndo: true,
      overflowHidden: false,
      locale: 'en',
    })

    instance.init(toMindElixirData(document))
    const initialKey = `${document.id}:${document.version}`
    if (initialViewState) {
      window.requestAnimationFrame(() => applyViewState(instance, initialViewState))
      appliedViewStateKeyRef.current = initialKey
      fittedViewKeyRef.current = null
    } else {
      fitDocumentToViewport(instance)
      fittedViewKeyRef.current = initialKey
      appliedViewStateKeyRef.current = null
    }
    instanceRef.current = instance

    const controller: MindMapEditorController = {
      flushSnapshot,
      fitView: () => {
        fitDocumentToViewport(instance)
        scheduleViewState()
      },
      centerView: () => {
        instance.toCenter()
        scheduleViewState()
      },
      setLayout: (layout) => {
        if (layout === 'left') instance.initLeft()
        else if (layout === 'right') instance.initRight()
        else instance.initSide()
        fitDocumentToViewport(instance)
        emitSelectionState()
        emitNodeAnchor()
        scheduleViewState()
      },
      expandAll: () => {
        const rootTopic = instance.findEle(latestDocumentRef.current.root.id)
        debugLog('expandAll.before', {
          documentId: latestDocumentRef.current.id,
          expandedState: summarizeExpandedState((instance.getData() as MindElixirData).nodeData),
        })
        instance.expandNodeAll(rootTopic, true)
        debugLog('expandAll.after', {
          documentId: latestDocumentRef.current.id,
          expandedState: summarizeExpandedState((instance.getData() as MindElixirData).nodeData),
        })
        scheduleStructureSnapshot()
      },
      collapseAll: () => {
        const rootTopic = instance.findEle(latestDocumentRef.current.root.id)
        debugLog('collapseAll.before', {
          documentId: latestDocumentRef.current.id,
          expandedState: summarizeExpandedState((instance.getData() as MindElixirData).nodeData),
        })
        instance.expandNodeAll(rootTopic, false)
        debugLog('collapseAll.after', {
          documentId: latestDocumentRef.current.id,
          expandedState: summarizeExpandedState((instance.getData() as MindElixirData).nodeData),
        })
        scheduleStructureSnapshot()
      },
      exportPng: async () => {
        flushSnapshot()
        const blob = await instance.exportPng()
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const link = window.document.createElement('a')
        link.href = url
        link.download = `${latestDocumentRef.current.title || 'mindmap'}.png`
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 500)
      },
      undo: () => {
        instance.undo()
        emitSelectionState()
        scheduleSnapshot()
        return true
      },
      redo: () => {
        instance.redo()
        emitSelectionState()
        scheduleSnapshot()
        return true
      },
      addChildNode: () => {
        const currentNode = instance.currentNode
        if (!currentNode) return false
        void instance.addChild(currentNode).then(() => {
          emitSelectionState()
          scheduleSnapshot()
        })
        return true
      },
      addParentNode: () => {
        const currentNode = instance.currentNode
        if (!currentNode) return false
        void instance.insertParent(currentNode).then(() => {
          emitSelectionState()
          scheduleSnapshot()
        })
        return true
      },
      addSiblingNode: () => {
        const currentNode = instance.currentNode
        if (!currentNode) return false
        void instance.insertSibling('after', currentNode).then(() => {
          emitSelectionState()
          scheduleSnapshot()
        })
        return true
      },
      moveNodeUp: () => {
        const currentNode = instance.currentNode
        if (!currentNode) return false
        void instance.moveUpNode(currentNode).then(() => {
          emitSelectionState()
          scheduleSnapshot()
        })
        return true
      },
      moveNodeDown: () => {
        const currentNode = instance.currentNode
        if (!currentNode) return false
        void instance.moveDownNode(currentNode).then(() => {
          emitSelectionState()
          scheduleSnapshot()
        })
        return true
      },
      focusNode: () => {
        const currentNode = instance.currentNode
        if (!currentNode) return false
        instance.focusNode(currentNode)
        emitSelectionState()
        scheduleViewState()
        return true
      },
      cancelFocusMode: () => {
        instance.cancelFocus()
        emitSelectionState()
        scheduleViewState()
        return true
      },
      removeSelection: () => {
        if (instance.currentArrow) {
          instance.removeArrow(instance.currentArrow)
          emitSelectionState()
          scheduleSnapshot()
          return true
        }
        if (instance.currentSummary) {
          instance.removeSummary(instance.currentSummary.summaryObj.id)
          emitSelectionState()
          scheduleSnapshot()
          return true
        }
        if (!instance.currentNodes || instance.currentNodes.length === 0) return false
        void instance.removeNodes(instance.currentNodes).then(() => {
          emitSelectionState()
          scheduleSnapshot()
        })
        return true
      },
      createArrow: () => {
        if (!instance.currentNodes || instance.currentNodes.length !== 2) return false
        instance.createArrow(instance.currentNodes[0], instance.currentNodes[1])
        emitSelectionState()
        scheduleSnapshot()
        return true
      },
      createBidirectionalArrow: () => {
        if (!instance.currentNodes || instance.currentNodes.length !== 2) return false
        instance.createArrow(instance.currentNodes[0], instance.currentNodes[1], { bidirectional: true })
        emitSelectionState()
        scheduleSnapshot()
        return true
      },
      beginLinkMode: (bidirectional = false) => {
        const currentNode = instance.currentNode
        if (!currentNode) return false
        pendingLinkRef.current = {
          fromId: String(currentNode.nodeObj.id),
          bidirectional,
        }
        return true
      },
      editArrow: () => {
        if (!instance.currentArrow) return false
        instance.editArrowLabel(instance.currentArrow)
        emitSelectionState()
        return true
      },
      removeArrow: () => {
        if (!instance.currentArrow) return false
        instance.removeArrow(instance.currentArrow)
        emitSelectionState()
        scheduleSnapshot()
        return true
      },
      createSummary: () => {
        if (!instance.currentNodes || instance.currentNodes.length < 2) {
          return { ok: false, reason: 'requires_multiple_nodes' }
        }
        const before = ((instance.getData() as MindElixirData & { summaries?: MindElixirSummary[] }).summaries ?? []).length
        try {
          instance.createSummary()
          const after = ((instance.getData() as MindElixirData & { summaries?: MindElixirSummary[] }).summaries ?? []).length
          if (after <= before) return { ok: false, reason: 'requires_same_parent' }
          emitSelectionState()
          scheduleSnapshot()
          return { ok: true }
        } catch {
          return { ok: false, reason: 'requires_same_parent' }
        }
      },
      editSummary: () => {
        if (!instance.currentSummary) return false
        instance.editSummary(instance.currentSummary)
        emitSelectionState()
        return true
      },
      removeSummary: () => {
        if (!instance.currentSummary) return false
        instance.removeSummary(instance.currentSummary.summaryObj.id)
        emitSelectionState()
        scheduleSnapshot()
        return true
      },
    }
    onControllerReadyRef.current?.(controller)

    instance.bus.addListener('operation', (operation) => {
      debugLog('operation', {
        name: operation?.name,
        expandedState: summarizeExpandedState((instance.getData() as MindElixirData).nodeData),
      })
      scheduleSnapshot()
    })
    instance.bus.addListener('expandNode', (node) => {
      debugLog('expandNode', {
        nodeId: node?.id,
        expanded: node?.expanded,
        expandedState: summarizeExpandedState((instance.getData() as MindElixirData).nodeData),
      })
      scheduleStructureSnapshot()
    })
    instance.bus.addListener('move', () => {
      scheduleViewState()
      emitNodeAnchor()
    })
    instance.bus.addListener('scale', () => {
      scheduleViewState()
      emitNodeAnchor()
    })
    instance.bus.addListener('selectNodes', (nodes: NodeObj[]) => {
      const node = nodes[0]
      emitSelectionState()
      emitNodeAnchor()
      if (!node?.id) return
      if (pendingLinkRef.current) {
        const pending = pendingLinkRef.current
        const targetId = String(node.id)
        if (targetId !== pending.fromId) {
          const from = instance.findEle(pending.fromId)
          const to = instance.findEle(targetId)
          pendingLinkRef.current = null
          instance.createArrow(from, to, pending.bidirectional ? { bidirectional: true } : undefined)
          emitSelectionState()
          scheduleSnapshot()
        }
      }
      onNodeSelectRef.current?.(String(node.id))
    })
    const handleDoubleClick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target.closest('me-tpc') : null
      if (!target) return
      const nodeId = target.getAttribute('data-nodeid')?.replace(/^me/, '')
      if (!nodeId) return
      onNodeDoubleClickRef.current?.(nodeId)
    }
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const hostRect = hostRef.current?.getBoundingClientRect()
      if (!hostRect) return
      const anchor = clampContextMenuAnchor(event.clientX - hostRect.left, event.clientY - hostRect.top, hostRect)
      const htmlTarget = event.target instanceof HTMLElement ? event.target : null
      if (!htmlTarget) return

      const summaryLabel = htmlTarget.closest('.svg-label[data-type="summary"]') as HTMLElement | null
      const summaryGroup = htmlTarget.closest('.summary') as SVGGElement | null
      if (summaryLabel || summaryGroup) {
        const summarySvgId = summaryLabel?.dataset.svgId
        const summaryEl = (summarySvgId ? window.document.getElementById(summarySvgId) : summaryGroup) as
          | (SVGGElement & { summaryObj?: { id?: string } })
          | null
        const summaryId = String(summaryEl?.summaryObj?.id ?? '').trim()
        if (!summaryEl || !summaryId) return
        try {
          ;(instance as MindElixirInstance & {
            selectSummary: (element: typeof summaryEl) => void
          }).selectSummary(summaryEl)
        } catch {
          return
        }
        emitSelectionState()
        emitNodeAnchor()
        onNodeContextMenuRef.current?.({
          targetType: 'summary',
          summaryId,
          x: anchor.x,
          y: anchor.y,
        })
        return
      }

      const target = htmlTarget.closest('me-tpc')
      if (!target) return
      const nodeId = target.getAttribute('data-nodeid')?.replace(/^me/, '')
      if (!nodeId) return
      const topic = instance.findEle(nodeId)
      const currentNodes = Array.isArray(instance.currentNodes) ? instance.currentNodes : []
      if (topic && !currentNodes.some((node) => node.nodeObj.id === nodeId)) {
        try {
          instance.selectNode(topic)
        } catch {
          // Some internal plugin states can be stale during context-menu dispatch.
          // Retry in next tick to avoid surfacing uncaught runtime errors.
          window.setTimeout(() => {
            try {
              instance.selectNode(topic)
            } catch {
              // Swallow to prevent console spam; menu can still open on targeted node.
            }
          }, 0)
        }
      }
      emitSelectionState()
      emitNodeAnchor()
      onNodeSelectRef.current?.(nodeId)
      onNodeContextMenuRef.current?.({
        targetType: 'node',
        nodeId,
        x: anchor.x,
        y: anchor.y,
      })
    }
    const handlePointerOver = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return
      const target = event.target instanceof HTMLElement ? event.target.closest('me-tpc') : null
      if (!target) return
      const nodeId = target.getAttribute('data-nodeid')?.replace(/^me/, '')
      const hostRect = hostRef.current?.getBoundingClientRect()
      if (!nodeId || !hostRect) return
      const targetRect = target.getBoundingClientRect()
      onNodeHoverChangeRef.current?.({
        nodeId,
        x: targetRect.left - hostRect.left + targetRect.width / 2,
        y: targetRect.top - hostRect.top,
      })
    }
    const handlePointerOut = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return
      const target = event.target instanceof HTMLElement ? event.target.closest('me-tpc') : null
      if (!target) return
      const relatedTarget = event.relatedTarget instanceof HTMLElement ? event.relatedTarget.closest('me-tpc') : null
      if (relatedTarget === target) return
      onNodeHoverChangeRef.current?.(null)
    }
    const handlePointerLeaveCanvas = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return
      onNodeHoverChangeRef.current?.(null)
    }
    const handlePointerUp = () => {
      emitSelectionState()
      emitNodeAnchor()
    }
    hostRef.current.addEventListener('pointerup', handlePointerUp)
    hostRef.current.addEventListener('pointerover', handlePointerOver)
    hostRef.current.addEventListener('pointerout', handlePointerOut)
    hostRef.current.addEventListener('pointerleave', handlePointerLeaveCanvas)
    hostRef.current.addEventListener('dblclick', handleDoubleClick)
    hostRef.current.addEventListener('contextmenu', handleContextMenu)
    window.setTimeout(() => emitSelectionState(), 0)
    window.setTimeout(() => emitNodeAnchor(), 0)

    return () => {
      pendingLinkRef.current = null
      if (snapshotTimerRef.current !== null) {
        window.clearTimeout(snapshotTimerRef.current)
        snapshotTimerRef.current = null
      }
      if (structureSnapshotTimerRef.current !== null) {
        window.clearTimeout(structureSnapshotTimerRef.current)
        structureSnapshotTimerRef.current = null
      }
      if (viewStateTimerRef.current !== null) {
        window.clearTimeout(viewStateTimerRef.current)
        viewStateTimerRef.current = null
      }
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      if (fitTimeoutRef.current !== null) {
        window.clearTimeout(fitTimeoutRef.current)
        fitTimeoutRef.current = null
      }
      if (refreshFrameRef.current !== null) {
        window.cancelAnimationFrame(refreshFrameRef.current)
        refreshFrameRef.current = null
      }
      onControllerReadyRef.current?.(null)
      hostRef.current?.removeEventListener('pointerup', handlePointerUp)
      hostRef.current?.removeEventListener('pointerover', handlePointerOver)
      hostRef.current?.removeEventListener('pointerout', handlePointerOut)
      hostRef.current?.removeEventListener('pointerleave', handlePointerLeaveCanvas)
      hostRef.current?.removeEventListener('dblclick', handleDoubleClick)
      hostRef.current?.removeEventListener('contextmenu', handleContextMenu)
      instance.destroy()
      instanceRef.current = null
    }
  }, [
    document.id,
    document.version,
    fitDocumentToViewport,
    flushSnapshot,
    emitNodeAnchor,
    scheduleSnapshot,
    scheduleStructureSnapshot,
    scheduleViewState,
    emitSelectionState,
  ])

  React.useEffect(() => {
    const instance = instanceRef.current
    if (!instance) return
    if (refreshFrameRef.current !== null) {
      window.cancelAnimationFrame(refreshFrameRef.current)
      refreshFrameRef.current = null
    }
    refreshFrameRef.current = window.requestAnimationFrame(() => {
      refreshFrameRef.current = null
      debugLog('refresh.before', {
        documentId: document.id,
        version: document.version,
        expandedState: summarizeExpandedState(document.root),
      })
      instance.refresh(toMindElixirData(document))
      debugLog('refresh.after', {
        documentId: document.id,
        version: document.version,
        expandedState: summarizeExpandedState((instance.getData() as MindElixirData).nodeData),
      })
      emitNodeAnchor()
      const viewKey = `${document.id}:${document.version}`
      if (initialViewState && appliedViewStateKeyRef.current !== viewKey) {
        applyViewState(instance, initialViewState)
        appliedViewStateKeyRef.current = viewKey
        fittedViewKeyRef.current = null
        return
      }
      if (!initialViewState && fittedViewKeyRef.current !== viewKey) {
        fitDocumentToViewport(instance)
        fittedViewKeyRef.current = viewKey
        appliedViewStateKeyRef.current = null
      }
    })
    return () => {
      if (refreshFrameRef.current !== null) {
        window.cancelAnimationFrame(refreshFrameRef.current)
        refreshFrameRef.current = null
      }
    }
  }, [document, fitDocumentToViewport, emitNodeAnchor])

  React.useEffect(() => {
    const instance = instanceRef.current
    if (!instance || !initialViewState) return
    const serialized = JSON.stringify(initialViewState)
    if (lastAppliedViewStateRef.current === serialized) return
    applyViewState(instance, initialViewState)
    lastAppliedViewStateRef.current = serialized
    emitNodeAnchor()
  }, [initialViewState, emitNodeAnchor])

  return (
    <>
      <style>
        {`
          .mindmap-canvas-host .mind-elixir-toolbar.lt,
          .mindmap-canvas-host .mind-elixir-toolbar.rb {
            display: none !important;
          }

          .mindmap-canvas-host me-tpc {
            max-width: min(26rem, 32vw);
          }
        `}
      </style>
      <div ref={hostRef} className="mindmap-canvas-host h-full min-h-0 min-w-0 w-full overflow-hidden bg-slate-50" />
    </>
  )
}
