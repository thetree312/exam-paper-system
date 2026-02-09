import React, { useMemo, useCallback } from 'react'
import ReactFlow, {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  useEdgesState,
  useNodesState,
  getSmoothStepPath,
} from 'reactflow'
import type { EdgeProps, NodeProps, Connection, EdgeChange } from 'reactflow'
import 'reactflow/dist/style.css'

import type { MindMapEdgePayload, MindMapNodePayload } from '../../../types'

export type MindMapLayoutStyle = 'grid' | 'hierarchy' | 'xmind'

// ============================================================
// Groundbase 设计：基于真实树结构深度的视觉系统
// ============================================================

// 基础尺寸（深度 0 的节点）
const BASE_NODE_WIDTH = 280
const BASE_NODE_HEIGHT = 160
const BASE_GAP_X = 80
const BASE_GAP_Y = 50

// 深度颜色映射（基于实际树深度，而非 type）
const DEPTH_COLORS: Array<{ border: string; badge: string; bg: string }> = [
  { border: '#1b4dff', badge: 'bg-blue-100 text-blue-700', bg: '#f0f5ff' },      // 深度 0：root - 蓝色
  { border: '#0d9488', badge: 'bg-teal-100 text-teal-700', bg: '#f0fdfa' },      // 深度 1：分组 - 青色
  { border: '#7c3aed', badge: 'bg-purple-100 text-purple-700', bg: '#faf5ff' },  // 深度 2：知识点 - 紫色
  { border: '#f97316', badge: 'bg-orange-100 text-orange-700', bg: '#fff7ed' },  // 深度 3：细化 - 橙色
  { border: '#ec4899', badge: 'bg-pink-100 text-pink-700', bg: '#fdf2f8' },      // 深度 4：深化 - 粉色
  { border: '#8b5cf6', badge: 'bg-violet-100 text-violet-700', bg: '#f5f3ff' },  // 深度 5+：更深 - 紫罗兰
]

// type 到 badge 文字的映射（仅用于显示，不影响布局）
// 注意：这些标签应该通过 i18n 获取，但为了避免在渲染时频繁调用 hook，
// 我们在这里保留英文作为备用，实际的本地化应该在组件中处理
const TYPE_LABELS_EN: Record<string, string> = {
  topic: 'Topic',
  subtopic: 'Group',
  concept: 'Concept',
  detail: 'Detail',
  sub_detail: 'Sub-detail',
  stage: 'Stage',
  timeline: 'Timeline',
  question_ref: 'Question',
  example: 'Example',
  default: 'Node',
}

// 计算真实树深度（基于 parentId 链，而非 type）
function computeActualDepth(nodes: MindMapNodePayload[], rootId?: string | null): Map<string, number> {
  const depthMap = new Map<string, number>()
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  
  function getDepth(nodeId: string, visited: Set<string> = new Set()): number {
    // 防止循环引用
    if (visited.has(nodeId)) return 0
    visited.add(nodeId)
    
    const cached = depthMap.get(nodeId)
    if (cached !== undefined) return cached
    
    const node = nodeById.get(nodeId)
    if (!node) {
      depthMap.set(nodeId, 0)
      return 0
    }
    
    // root 节点或无 parentId 的节点深度为 0
    if (!node.parentId || node.id === rootId) {
      depthMap.set(nodeId, 0)
      return 0
    }
    
    const parentDepth = getDepth(node.parentId, visited)
    const depth = parentDepth + 1
    depthMap.set(nodeId, depth)
    return depth
  }
  
  nodes.forEach(node => getDepth(node.id))
  return depthMap
}

// 根据真实深度获取颜色配置
function getColorByDepth(depth: number): { border: string; badge: string; bg: string } {
  const index = Math.min(depth, DEPTH_COLORS.length - 1)
  return DEPTH_COLORS[index]
}

// 根据真实深度获取节点尺寸（越深越小，但有下限）
function getNodeDimensions(depth: number): { width: number; height: number } {
  const minScale = 0.65  // 最小缩放比例
  const scaleStep = 0.08 // 每层缩小的比例
  const scale = Math.max(minScale, 1 - depth * scaleStep)
  
  return {
    width: Math.round(BASE_NODE_WIDTH * scale),
    height: Math.round(BASE_NODE_HEIGHT * scale),
  }
}

// 根据真实深度获取间距（越深间距越小）
function getGapByDepth(depth: number): { x: number; y: number } {
  const minScale = 0.5
  const scaleStep = 0.12
  const scale = Math.max(minScale, 1 - depth * scaleStep)
  
  return {
    x: Math.round(BASE_GAP_X * scale),
    y: Math.round(BASE_GAP_Y * scale),
  }
}

// 根据真实深度获取字体大小
function getFontSizeByDepth(depth: number): { title: number; desc: number; badge: number } {
  const sizes = [
    { title: 15, desc: 13, badge: 11 },  // 深度 0
    { title: 14, desc: 12, badge: 10 },  // 深度 1
    { title: 13, desc: 11, badge: 10 },  // 深度 2
    { title: 12, desc: 11, badge: 9 },   // 深度 3
    { title: 11, desc: 10, badge: 9 },   // 深度 4
    { title: 11, desc: 10, badge: 9 },   // 深度 5+
  ]
  const index = Math.min(depth, sizes.length - 1)
  return sizes[index]
}

// 根据真实深度获取描述文字的最大行数
function getDescLineClampByDepth(depth: number): number {
  const clamps = [5, 4, 3, 3, 2, 2]  // 深度越深，显示行数越少
  const index = Math.min(depth, clamps.length - 1)
  return clamps[index]
}

const PARALLEL_EDGE_OFFSET = 10
const EDGE_DASH_PATTERN = '10 6'

type BranchSide = 'left' | 'right' | 'center'

type MindMapEdgeData = {
  parallelIndex?: number
  parallelCount?: number
  sourceOverride?: { x: number; y: number }
  targetOverride?: { x: number; y: number }
  sourceDepth?: number
  targetDepth?: number
}

type MindMapNodeData = {
  raw: MindMapNodePayload
  branchSide: BranchSide
  depth: number  // 真实树深度
  showQuestionAnchors: boolean
  onNodeNavigate?: (node: MindMapNodePayload) => void
}

let edgeAnimationStyleInserted = false
function ensureEdgeAnimationStyle() {
  if (edgeAnimationStyleInserted || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.textContent = `
    @keyframes mindmapEdgeDash {
      from { stroke-dashoffset: 0; }
      to { stroke-dashoffset: -64; }
    }
  `
  document.head.appendChild(style)
  edgeAnimationStyleInserted = true
}

const MindMapEdge: React.FC<EdgeProps<MindMapEdgeData>> = (props) => {
  ensureEdgeAnimationStyle()

  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    label,
    data,
  } = props

  const parallelIndex = data?.parallelIndex ?? 0
  const parallelCount = data?.parallelCount ?? 1
  const sourceOverride = data?.sourceOverride
  const targetOverride = data?.targetOverride
  const computedSourceX = sourceOverride?.x ?? sourceX
  const computedSourceY = sourceOverride?.y ?? sourceY
  const computedTargetX = targetOverride?.x ?? targetX
  const computedTargetY = targetOverride?.y ?? targetY

  const offsetIndex = parallelCount > 1 ? parallelIndex - (parallelCount - 1) / 2 : 0
  const offset = offsetIndex * PARALLEL_EDGE_OFFSET

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: computedSourceX,
    sourceY: computedSourceY + offset,
    sourcePosition,
    targetX: computedTargetX,
    targetY: computedTargetY + offset,
    targetPosition,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          ...style,
          strokeDasharray: EDGE_DASH_PATTERN,
          animation: 'mindmapEdgeDash 2.4s linear infinite',
          strokeLinecap: 'round',
        }}
        markerEnd={markerEnd}
      />
      {label && (
        <text
          x={labelX}
          y={labelY - 4}
          style={{ fill: '#475569', fontSize: 10, fontWeight: 600 }}
          textAnchor="middle"
        >
          {label}
        </text>
      )}
    </>
  )
}

const MindMapNodeComponent: React.FC<NodeProps<MindMapNodeData>> = ({ data, selected }) => {
  if (!data) return null
  const { raw, branchSide, depth, showQuestionAnchors, onNodeNavigate } = data
  
  // 基于真实深度获取视觉配置
  const colors = getColorByDepth(depth)
  const dims = getNodeDimensions(depth)
  const fontSizes = getFontSizeByDepth(depth)
  const descLineClamp = getDescLineClampByDepth(depth)
  
  const isCenter = branchSide === 'center'
  const questions = raw.data?.questionIds ?? []
  const description = raw.data?.description || raw.data?.source || ''
  const showQuestions = showQuestionAnchors && questions.length > 0
  const typeLabel = TYPE_LABELS_EN[raw.type ?? 'default'] ?? TYPE_LABELS_EN.default

  const renderHandles = () => {
    if (isCenter) {
      return (
        <>
          <Handle id="target-left" type="target" position={Position.Left} />
          <Handle id="target-right" type="target" position={Position.Right} />
          <Handle id="source-left" type="source" position={Position.Left} />
          <Handle id="source-right" type="source" position={Position.Right} />
        </>
      )
    }
    const targetId = branchSide === 'left' ? 'target-right' : 'target-left'
    const sourceId = branchSide === 'left' ? 'source-left' : 'source-right'
    const targetPosition = branchSide === 'left' ? Position.Right : Position.Left
    const sourcePosition = branchSide === 'left' ? Position.Left : Position.Right
    return (
      <>
        <Handle id={targetId} type="target" position={targetPosition} />
        <Handle id={sourceId} type="source" position={sourcePosition} />
      </>
    )
  }

  // 根据深度调整边框粗细
  const borderWidth = Math.max(1.5, 3 - depth * 0.3)
  // 根据深度调整圆角
  const borderRadius = Math.max(8, 16 - depth * 2)
  // 根据深度调整内边距
  const padding = Math.max(8, 14 - depth * 1.5)
  // 根据深度调整阴影
  const shadowIntensity = Math.max(0.05, 0.15 - depth * 0.02)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onNodeNavigate?.(raw)}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter') onNodeNavigate?.(raw)
      }}
      style={{
        width: dims.width,
        minHeight: dims.height,
        borderRadius: borderRadius,
        border: `${borderWidth}px solid ${colors.border}`,
        padding: `${padding}px`,
        background: selected ? colors.bg : '#fff',
        boxShadow: selected 
          ? `0 16px 32px rgba(15,23,42,0.2), 0 0 0 3px ${colors.border}40`
          : `0 ${8 - depth}px ${24 - depth * 2}px rgba(15,23,42,${shadowIntensity})`,
        cursor: onNodeNavigate ? 'pointer' : 'default',
        transition: 'all 0.2s ease',
      }}
    >
      {renderHandles()}
      <div className="flex flex-col gap-1.5 text-left">
        <div className="flex items-start justify-between gap-2">
          <span 
            className="font-semibold text-slate-900 leading-tight"
            style={{ fontSize: fontSizes.title }}
            title={raw.label}
          >
            {raw.label}
          </span>
          <span 
            className={`shrink-0 px-1.5 py-0.5 rounded-full font-semibold ${colors.badge}`}
            style={{ fontSize: fontSizes.badge }}
          >
            {typeLabel}
          </span>
        </div>
        {description && (
          <p 
            className="text-slate-600 leading-snug"
            style={{ 
              fontSize: fontSizes.desc,
              display: '-webkit-box',
              WebkitLineClamp: descLineClamp,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
            title={description}
          >
            {description}
          </p>
        )}
        {showQuestions && (
          <div 
            className="text-slate-500 truncate mt-0.5"
            style={{ fontSize: fontSizes.badge }}
          >
            关联题目：
            <span className="font-semibold text-slate-700 ml-1">{questions.join(', ')}</span>
          </div>
        )}
        {/* 深度指示器（调试用，可删除） */}
        {depth > 0 && (
          <div 
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-white font-bold"
            style={{ 
              backgroundColor: colors.border,
              fontSize: 10,
            }}
          >
            {depth}
          </div>
        )}
      </div>
    </div>
  )
}

const nodeTypes = { mindmapNode: MindMapNodeComponent }
const edgeTypes = { mindmap: MindMapEdge }

function layoutNodes(
  nodes: MindMapNodePayload[],
  _edges: MindMapEdgePayload[],
  style: MindMapLayoutStyle,
  rootId?: string | null,
  _collapsedIds?: Set<string>,
  depthMap?: Map<string, number>,
): { x: number; y: number }[] {
  if (!nodes.length) return []

  // 确保有深度映射
  const actualDepthMap = depthMap ?? computeActualDepth(nodes, rootId)

  if (style === 'grid') {
    // 总览网格模式：按深度分层，每层内按列排列，形成紧凑的网格视图
    const idsByDepth: Record<number, string[]> = {}
    nodes.forEach((node) => {
      const depth = actualDepthMap.get(node.id) ?? 0
      if (!idsByDepth[depth]) idsByDepth[depth] = []
      idsByDepth[depth].push(node.id)
    })

    const sortedDepths = Object.keys(idsByDepth)
      .map((v) => Number(v))
      .sort((a, b) => a - b)

    const posById: Record<string, { x: number; y: number }> = {}
    let cumulativeY = 0

    sortedDepths.forEach((depth) => {
      const ids = idsByDepth[depth]
      const dims = getNodeDimensions(depth)
      const gap = getGapByDepth(depth)
      
      // 根据节点数量动态计算列数，保持合理的宽高比
      const maxCols = Math.max(3, Math.min(8, Math.ceil(Math.sqrt(ids.length * 2))))
      
      ids.forEach((id, index) => {
        const row = Math.floor(index / maxCols)
        const col = index % maxCols
        
        posById[id] = {
          x: col * (dims.width + gap.x),
          y: cumulativeY + row * (dims.height + gap.y),
        }
      })
      
      const layerRows = Math.ceil(ids.length / maxCols)
      cumulativeY += layerRows * (dims.height + gap.y) + gap.y  // 层间额外间距
    })

    return nodes.map((node) => posById[node.id] ?? { x: 0, y: 0 })
  }

  const posById: Record<string, { x: number; y: number }> = {}

  if (style === 'hierarchy') {
    // 知识脉络模式：树形布局，子节点在父节点下方居中对齐
    const nodeById = new Map<string, MindMapNodePayload>()
    nodes.forEach((n) => nodeById.set(n.id, n))

    const childrenById = new Map<string, MindMapNodePayload[]>()
    nodes.forEach((n) => {
      const pid = n.parentId ?? null
      if (!pid) return
      if (!childrenById.has(pid)) childrenById.set(pid, [])
      childrenById.get(pid)!.push(n)
    })

    // 计算子树宽度（考虑节点尺寸和子节点）
    const subtreeWidthCache = new Map<string, number>()
    function measureSubtreeWidth(nodeId: string): number {
      const cached = subtreeWidthCache.get(nodeId)
      if (cached !== undefined) return cached

      const children = childrenById.get(nodeId) ?? []
      const depth = actualDepthMap.get(nodeId) ?? 0
      const dims = getNodeDimensions(depth)
      const gap = getGapByDepth(depth)
      
      if (!children.length) {
        const width = dims.width + gap.x
        subtreeWidthCache.set(nodeId, width)
        return width
      }
      
      let totalWidth = 0
      children.forEach((child, idx) => {
        const childWidth = measureSubtreeWidth(child.id)
        totalWidth += childWidth
        if (idx < children.length - 1) {
          const childDepth = actualDepthMap.get(child.id) ?? 0
          const childGap = getGapByDepth(childDepth)
          totalWidth += childGap.x * 0.3  // 兄弟间的额外间距
        }
      })
      
      const width = Math.max(dims.width + gap.x, totalWidth)
      subtreeWidthCache.set(nodeId, width)
      return width
    }

    // 递归布局子树
    function layoutSubtree(nodeId: string, centerX: number, y: number) {
      const depth = actualDepthMap.get(nodeId) ?? 0
      const dims = getNodeDimensions(depth)
      const gap = getGapByDepth(depth)
      
      // 节点位置（左上角）
      posById[nodeId] = {
        x: centerX - dims.width / 2,
        y,
      }
      
      const children = childrenById.get(nodeId) ?? []
      if (!children.length) return
      
      // 计算所有子节点的总宽度
      let totalChildWidth = 0
      children.forEach((child, idx) => {
        const childWidth = measureSubtreeWidth(child.id)
        totalChildWidth += childWidth
        if (idx < children.length - 1) {
          const childDepth = actualDepthMap.get(child.id) ?? 0
          const childGap = getGapByDepth(childDepth)
          totalChildWidth += childGap.x * 0.3
        }
      })
      
      // 子节点起始位置（居中对齐）
      let childX = centerX - totalChildWidth / 2
      const childY = y + dims.height + gap.y
      
      children.forEach((child, idx) => {
        const childWidth = measureSubtreeWidth(child.id)
        const childCenterX = childX + childWidth / 2
        layoutSubtree(child.id, childCenterX, childY)
        childX += childWidth
        if (idx < children.length - 1) {
          const childDepth = actualDepthMap.get(child.id) ?? 0
          const childGap = getGapByDepth(childDepth)
          childX += childGap.x * 0.3
        }
      })
    }

    // 找到 root 节点
    let hierarchyRootId = rootId
    if (!hierarchyRootId) {
      const rootCandidate = nodes.find((n) => !n.parentId) ?? nodes[0]
      hierarchyRootId = rootCandidate?.id ?? nodes[0].id
    }

    const rootNode = nodeById.get(hierarchyRootId)
    if (rootNode) {
      layoutSubtree(hierarchyRootId, 0, 0)
    } else {
      // 回退：简单按深度排列
      nodes.forEach((node, index) => {
        const depth = actualDepthMap.get(node.id) ?? 0
        const dims = getNodeDimensions(depth)
        const gap = getGapByDepth(depth)
        posById[node.id] = {
          x: 0,
          y: index * (dims.height + gap.y),
        }
      })
    }
  } else {
    // xmind 模式：使用 parentId + side 信息做左右对称的树形布局
    if (!rootId) {
      const rootCandidate = nodes.find((n) => !n.parentId) ?? nodes[0]
      rootId = rootCandidate?.id ?? nodes[0].id
    }

    const nodeById = new Map<string, MindMapNodePayload>()
    nodes.forEach((n) => nodeById.set(n.id, n))

    const childrenById = new Map<string, MindMapNodePayload[]>()
    nodes.forEach((n) => {
      const pid = n.parentId ?? null
      if (!pid) return
      if (!childrenById.has(pid)) childrenById.set(pid, [])
      childrenById.get(pid)!.push(n)
    })

    // 计算子树高度（考虑不同深度的节点尺寸）
    function measureSubtree(nodeId: string): number {
      const children = childrenById.get(nodeId) ?? []
      const depth = actualDepthMap.get(nodeId) ?? 0
      const dims = getNodeDimensions(depth)
      const gap = getGapByDepth(depth)
      
      if (!children.length) {
        return dims.height + gap.y
      }
      
      let sum = 0
      children.forEach((c, index) => {
        const h = measureSubtree(c.id)
        sum += h
        if (index < children.length - 1) {
          const childDepth = actualDepthMap.get(c.id) ?? 0
          const childGap = getGapByDepth(childDepth)
          sum += childGap.y * 0.3  // 兄弟节点间的额外间距
        }
      })
      return Math.max(dims.height + gap.y, sum)
    }

    function layoutSubtree(nodeId: string, depth: number, centerY: number, isLeftBranch: boolean) {
      // 水平位置：根据深度和方向计算
      let cumulativeX = 0
      for (let d = 0; d < depth; d++) {
        const dDims = getNodeDimensions(d)
        const dGap = getGapByDepth(d)
        cumulativeX += dDims.width + dGap.x
      }
      
      const x = cumulativeX * (isLeftBranch ? -1 : 1)
      
      posById[nodeId] = {
        x,
        y: centerY,
      }

      const children = childrenById.get(nodeId) ?? []
      if (!children.length) return
      
      const subtreeHeight = measureSubtree(nodeId)
      const topY = centerY - subtreeHeight / 2

      let cursor = topY
      children.forEach((child) => {
        const h = measureSubtree(child.id)
        const childCenterY = cursor + h / 2
        layoutSubtree(child.id, depth + 1, childCenterY, isLeftBranch)
        cursor += h
      })
    }

    const rootNode = nodeById.get(rootId)
    if (rootNode) {
      posById[rootId] = { x: 0, y: 0 }
      const level1Children = (childrenById.get(rootId) ?? []).slice()

      const leftChildren = level1Children.filter((c) => c.side === 'left')
      const rightChildren = level1Children.filter((c) => c.side !== 'left')

      // 计算左右子树的总高度
      const leftTotal = leftChildren.reduce((acc, c) => acc + measureSubtree(c.id), 0)
      const rightTotal = rightChildren.reduce((acc, c) => acc + measureSubtree(c.id), 0)

      // 布局左侧子树
      let leftCursor = -(leftTotal / 2)
      leftChildren.forEach((child) => {
        const h = measureSubtree(child.id)
        const centerY = leftCursor + h / 2
        layoutSubtree(child.id, 1, centerY, true)
        leftCursor += h
      })

      // 布局右侧子树
      let rightCursor = -(rightTotal / 2)
      rightChildren.forEach((child) => {
        const h = measureSubtree(child.id)
        const centerY = rightCursor + h / 2
        layoutSubtree(child.id, 1, centerY, false)
        rightCursor += h
      })
    } else {
      // 回退：若未找到 root，则简单按照深度展开
      nodes.forEach((node, index) => {
        const depth = actualDepthMap.get(node.id) ?? 0
        const dims = getNodeDimensions(depth)
        const gap = getGapByDepth(depth)
        posById[node.id] = {
          x: depth * (dims.width + gap.x),
          y: index * (dims.height + gap.y),
        }
      })
    }
  }

  return nodes.map((node) => posById[node.id] ?? { x: 0, y: 0 })
}

function computeBranchSides(nodes: MindMapNodePayload[], rootId?: string | null) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const branchSides = new Map<string, BranchSide>()

  function resolve(node: MindMapNodePayload): BranchSide {
    const cached = branchSides.get(node.id)
    if (cached) return cached

    let side: BranchSide
    if (!node.parentId || node.id === rootId) {
      side = 'center'
    } else if (node.side === 'left' || node.side === 'right') {
      side = node.side
    } else {
      const parent = nodeById.get(node.parentId)
      if (parent) {
        const parentSide = resolve(parent)
        side = parentSide === 'center' ? 'right' : parentSide
      } else {
        side = 'right'
      }
    }

    branchSides.set(node.id, side)
    return side
  }

  nodes.forEach((node) => resolve(node))
  return branchSides
}

function getSourceHandleId(branch: BranchSide, preferred?: BranchSide) {
  if (branch === 'left') return 'source-left'
  if (branch === 'right') return 'source-right'
  if (preferred === 'left') return 'source-left'
  if (preferred === 'right') return 'source-right'
  return 'source-right'
}

function getTargetHandleId(branch: BranchSide, incomingFrom?: BranchSide) {
  if (branch === 'left') return 'target-right'
  if (branch === 'right') return 'target-left'
  if (incomingFrom === 'left') return 'target-right'
  if (incomingFrom === 'right') return 'target-left'
  return 'target-left'
}

function toFlow(
  nodes: MindMapNodePayload[],
  edges: MindMapEdgePayload[],
  layoutStyle: MindMapLayoutStyle,
  rootId?: string | null,
  collapsedIds?: Set<string>,
  showQuestionAnchors?: boolean,
) {
  // 计算真实深度（核心改动：基于 parentId 而非 type）
  const depthMap = computeActualDepth(nodes, rootId)
  
  const positions = layoutNodes(nodes, edges, layoutStyle, rootId, collapsedIds, depthMap)
  const branchSides = computeBranchSides(nodes, rootId)

  const flowNodes = nodes.map((node, index) => {
    const position = positions[index] ?? { x: 0, y: 0 }
    const branchSide = branchSides.get(node.id) ?? 'right'
    const depth = depthMap.get(node.id) ?? 0
    
    return {
      id: node.id,
      data: { 
        raw: node, 
        branchSide, 
        depth,  // 传递真实深度
        showQuestionAnchors: showQuestionAnchors ?? true,
      },
      position,
      type: 'mindmapNode',
    }
  })

  const visibleIds = collapsedIds
    ? new Set(nodes.map((n) => n.id).filter((id) => !collapsedIds.has(id)))
    : null
  const visibleEdges = edges.filter((edge) =>
    visibleIds ? visibleIds.has(edge.source) && visibleIds.has(edge.target) : true,
  )

  const parallelMeta = new Map<string, number[]>()
  visibleEdges.forEach((edge, index) => {
    const key = `${edge.source}->${edge.target}`
    const list = parallelMeta.get(key)
    if (list) {
      list.push(index)
    } else {
      parallelMeta.set(key, [index])
    }
  })

  const flowEdges = visibleEdges.map((edge, index) => {
    const key = `${edge.source}->${edge.target}`
    const indices = parallelMeta.get(key) ?? [index]
    const positionInGroup = indices.indexOf(index)
    const parallelIndex = positionInGroup === -1 ? 0 : positionInGroup
    const parallelCount = indices.length
    const sourceBranch = branchSides.get(edge.source) ?? 'center'
    const targetBranch = branchSides.get(edge.target) ?? 'right'
    
    // 获取源和目标节点的深度，用于边的样式
    const sourceDepth = depthMap.get(edge.source) ?? 0
    const targetDepth = depthMap.get(edge.target) ?? 0
    
    // 根据深度调整边的粗细
    const avgDepth = (sourceDepth + targetDepth) / 2
    const strokeWidth = Math.max(1, 3 - avgDepth * 0.4)
    
    // 根据深度调整边的颜色
    const edgeColor = getColorByDepth(Math.max(sourceDepth, targetDepth)).border

    return {
      id: edge.id,
      source: edge.source,
      sourceHandle: getSourceHandleId(sourceBranch, targetBranch),
      target: edge.target,
      targetHandle: getTargetHandleId(targetBranch, sourceBranch),
      label: edge.label ?? undefined,
      style: { stroke: edgeColor, strokeWidth },
      labelStyle: { fill: '#475569', fontWeight: 600, fontSize: Math.max(9, 11 - avgDepth) },
      type: 'mindmap',
      data: { parallelIndex, parallelCount, sourceDepth, targetDepth },
    }
  })

  return { flowNodes, flowEdges }
}

export interface MindMapFlowProps {
  nodes: MindMapNodePayload[]
  edges: MindMapEdgePayload[]
  layoutStyle: MindMapLayoutStyle
  rootId?: string | null
  collapsedIds?: Set<string>
  showQuestionAnchors?: boolean
  onNodeSelect?: (node: MindMapNodePayload) => void
  onEdgesChange?: (changes: EdgeChange[]) => void
  onConnect?: (connection: Connection) => void
}

export const MindMapFlow: React.FC<MindMapFlowProps> = ({
  nodes,
  edges,
  layoutStyle,
  rootId,
  collapsedIds,
  showQuestionAnchors = true,
  onNodeSelect,
  onEdgesChange,
  onConnect,
}) => {
  const { flowNodes, flowEdges } = useMemo(
    () => toFlow(nodes, edges, layoutStyle, rootId, collapsedIds, showQuestionAnchors),
    [nodes, edges, layoutStyle, rootId, collapsedIds, showQuestionAnchors],
  )
  const [rfNodes, setNodes, onNodesStateChange] = useNodesState(flowNodes)
  const [rfEdges, setEdges, onEdgesStateChange] = useEdgesState(flowEdges)

  React.useEffect(() => {
    setNodes(flowNodes)
    setEdges(flowEdges)
  }, [flowNodes, flowEdges, setEdges, setNodes])

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange?.(changes)
      onEdgesStateChange(changes)
    },
    [onEdgesChange, onEdgesStateChange],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      onConnect?.(connection)
    },
    [onConnect],
  )

  return (
    <ReactFlow
      nodes={rfNodes.map((node) => ({
        ...node,
        data: {
          ...(node.data as MindMapNodeData),
          onNodeNavigate: onNodeSelect,
        },
      }))}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesStateChange}
      onEdgesChange={handleEdgesChange}
      onConnect={handleConnect}
      fitView
      className="bg-slate-50"
      proOptions={{ hideAttribution: true }}
    >
      <MiniMap pannable zoomable nodeColor={() => '#1e293b'} nodeStrokeWidth={2} />
      <Controls showInteractive={false} position="bottom-right" />
      <Background gap={24} color="#cbd5f5" />
    </ReactFlow>
  )
}
