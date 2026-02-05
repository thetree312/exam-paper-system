import { useEffect, useState } from 'react'
import type { MindMapEdgePayload, MindMapNodePayload } from '../../../types'

export function useEditableMindMap(
  sourceNodes: MindMapNodePayload[] | undefined,
  sourceEdges: MindMapEdgePayload[] | undefined,
) {
  const [nodes, setNodes] = useState<MindMapNodePayload[]>([])
  const [edges, setEdges] = useState<MindMapEdgePayload[]>([])

  useEffect(() => {
    if (sourceNodes && sourceNodes.length) {
      setNodes(sourceNodes.map((node) => ({ ...node, data: { ...node.data } })))
    } else {
      setNodes([])
    }
  }, [sourceNodes])

  useEffect(() => {
    if (sourceEdges && sourceEdges.length) {
      setEdges(sourceEdges.map((edge) => ({ ...edge })))
    } else {
      setEdges([])
    }
  }, [sourceEdges])

  return { nodes, edges, setNodes, setEdges }
}
