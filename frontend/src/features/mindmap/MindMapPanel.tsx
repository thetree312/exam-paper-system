import React, { useState, useMemo, useCallback } from 'react'
import { ReactFlowProvider } from 'reactflow'
import 'reactflow/dist/style.css'

import { useMindMapGraph } from '../../hooks/useMindMapGraph'
import type {
  MindMapEdgePayload,
  MindMapNavigateTarget,
  MindMapNodePayload,
  MindMapSourceRef,
  UserInfo,
} from '../../types'
import type { Connection, EdgeChange } from 'reactflow'
import { saveMindMapGraph } from '../../services/mindMapApi'
import MindMapToolbar from './components/MindMapToolbar'
import { MindMapFlow } from './components/MindMapFlow'
import type { MindMapLayoutStyle } from './components/MindMapFlow'
import MindMapNodeEditor from './components/MindMapNodeEditor'
import { MindMapLoadingAnimation } from './components/MindMapLoadingAnimation'
import { useEditableMindMap } from './hooks/useEditableMindMap'

interface MindMapPanelProps {
  backendBaseUrl: string
  documentId: number | null
  fileId: number | null
  user: UserInfo | null
  onBack?: () => void
  onNavigateToQuestion?: (target: MindMapNavigateTarget) => void
}

const generateEdgeId = () => `edge_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const MindMapPanel: React.FC<MindMapPanelProps> = ({
  backendBaseUrl,
  documentId,
  fileId,
  user,
  onBack,
  onNavigateToQuestion,
}) => {
  const [mode, setMode] = useState<'document' | 'file'>(() => (documentId ? 'document' : 'file'))
  const [layoutStyle, setLayoutStyle] = useState<MindMapLayoutStyle>('xmind')
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set())
  const [isSaving, setIsSaving] = useState(false)

  const source: MindMapSourceRef | null = React.useMemo(() => {
    if (!user) return null
    if (mode === 'document' && documentId) {
      return { sourceType: 'exam_document', sourceId: documentId, kind: 'knowledge' }
    }
    if (mode === 'file' && fileId) {
      return { sourceType: 'uploaded_file', sourceId: fileId, kind: 'knowledge' }
    }
    return null
  }, [user, mode, documentId, fileId])

  const { data, isLoading, error, refresh } = useMindMapGraph(
    backendBaseUrl,
    source,
    user?.tenant_id ?? null,
    user?.id ?? null,
  )
  const {
    nodes: editableNodes,
    edges: editableEdges,
    setNodes: setEditableNodes,
    setEdges: setEditableEdges,
  } = useEditableMindMap(data?.nodes, data?.edges)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const selectedNode = useMemo(
    () => editableNodes.find((node) => node.id === selectedNodeId) ?? null,
    [selectedNodeId, editableNodes],
  )

  const showQuestionAnchors = mode === 'document'
  const hasGraph = editableNodes.length > 0
  const primaryButtonLabel = isLoading ? '生成中...' : hasGraph ? '重新生成' : '生成图谱'

  const canUseDocument = Boolean(documentId)
  const canUseFile = Boolean(fileId)
  const canGenerateCurrent = Boolean(source)

  const handleNavigate = useCallback(
    (node: MindMapNodePayload) => {
      if (!onNavigateToQuestion) return
      const target: MindMapNavigateTarget = {
        questionId: node.data?.questionIds?.[0],
        sequenceIndex: node.data?.sequenceIndexes?.[0],
        page: node.data?.page,
        label: node.label,
        rawNode: node,
      }
      onNavigateToQuestion(target)
    },
    [onNavigateToQuestion],
  )

  const handleNodeSelect = useCallback((node: MindMapNodePayload) => {
    setSelectedNodeId(node.id)
  }, [])

  const handleNodeUpdate = useCallback(
    (updated: MindMapNodePayload) => {
      setEditableNodes((prev) => prev.map((node) => (node.id === updated.id ? updated : node)))
    },
    [setEditableNodes],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEditableEdges((prev) => {
        let next = [...prev]
        changes.forEach((change) => {
          if (change.type === 'remove') {
            next = next.filter((edge) => edge.id !== change.id)
          }
        })
        return next
      })
    },
    [setEditableEdges],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      setEditableEdges((prev) => [
        ...prev,
        {
          id: generateEdgeId(),
          source: connection.source,
          target: connection.target,
          label: '',
          type: 'hierarchy',
        },
      ])
    },
    [setEditableEdges],
  )

  React.useEffect(() => {
    if (selectedNodeId && !editableNodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null)
    }
  }, [editableNodes, selectedNodeId])

  const handleToggleCollapse = (nodeId: string) => {
    setCollapsedNodeIds((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const handleSave = async () => {
    if (!hasGraph || !user || !source) return
    if (isSaving) return
    setIsSaving(true)
    try {
      const rootId =
        data?.rootId ?? editableNodes.find((n) => !n.parentId)?.id ?? null
      await saveMindMapGraph(backendBaseUrl, {
        source,
        tenantId: user.tenant_id,
        userId: user.id,
        rootId,
        nodes: editableNodes,
        edges: editableEdges,
      })
    } catch (err) {
      // 这里不弹 toast，交给上层或控制台
      console.error('[mindmap] save failed', err)
    } finally {
      setIsSaving(false)
    }
  }

  if (!user || (!documentId && !fileId)) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-4">
        <p>
          {!user
            ? '请先登录以查看知识图谱'
            : '请先在左侧上传文件，或在编辑区生成一份试卷文档后再使用思维导图'}
        </p>
      </div>
    )
  }

  const handleModeChange = (nextMode: 'document' | 'file') => {
    if (nextMode === 'document' && mode !== 'document') {
      setMode('document')
    }
    if (nextMode === 'file' && mode !== 'file') {
      setMode('file')
    }
  }

  const toolbarRefreshDisabled = isLoading || !canGenerateCurrent

  return (
    <div className="h-full w-full flex flex-col bg-white">
      <header className="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50 pr-44">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Knowledge Map</p>
          <h2 className="text-xl font-semibold text-slate-900">知识点思维导图</h2>
          {data?.cached && (
            <span className="text-xs text-emerald-600 font-semibold">已使用缓存</span>
          )}
        </div>
      </header>
      <div className="flex-1 relative">
        <MindMapToolbar
          mode={mode}
          onModeChange={handleModeChange}
          canUseDocument={canUseDocument}
          canUseFile={canUseFile}
          layoutStyle={layoutStyle}
          onLayoutChange={setLayoutStyle}
          onRefresh={refresh}
          refreshDisabled={toolbarRefreshDisabled}
          refreshLabel={primaryButtonLabel}
          showSave={hasGraph}
          onSave={handleSave}
          saveDisabled={isSaving}
        />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center z-40 pointer-events-none">
            <MindMapLoadingAnimation />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-rose-600 text-sm gap-3">
            <p>加载失败：{error}</p>
            <button
              type="button"
              className="px-3 py-1.5 rounded-full border border-rose-200 text-rose-600 hover:bg-rose-50"
              onClick={refresh}
            >
              重试
            </button>
          </div>
        )}
        {!hasGraph && !isLoading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 gap-4">
            <p className="text-sm">
              {mode === 'document'
                ? canUseDocument
                  ? '当前基于编辑区文档，还未生成知识图谱，点击下方按钮开始提炼。'
                  : '当前尚未生成试卷文档，请先在编辑区完成一次同步，或切换为“上传文件”模式。'
                : canUseFile
                  ? '当前基于左侧上传的原始文件，还未生成知识图谱，点击下方按钮开始提炼。'
                  : '当前没有检测到正在预览的文件，请先在左侧上传文件。'}
            </p>
            <button
              type="button"
              className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm shadow-lg hover:bg-slate-800"
              onClick={refresh}
              disabled={!canGenerateCurrent}
            >
              立即生成
            </button>
          </div>
        )}
        {hasGraph && (
          <ReactFlowProvider>
            <MindMapFlow
              nodes={editableNodes}
              edges={editableEdges}
              layoutStyle={layoutStyle}
              rootId={data?.rootId}
              collapsedIds={collapsedNodeIds}
              onNodeSelect={handleNodeSelect}
              onEdgesChange={handleEdgesChange}
              onConnect={handleConnect}
              showQuestionAnchors={showQuestionAnchors}
            />
          </ReactFlowProvider>
        )}
        <MindMapNodeEditor
          node={selectedNode}
          onClose={() => setSelectedNodeId(null)}
          onSubmit={(updated) => {
            handleNodeUpdate(updated)
            setSelectedNodeId(null)
          }}
          onNavigate={handleNavigate}
        />
      </div>
    </div>
  )
}
