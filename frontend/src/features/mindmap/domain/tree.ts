import type { MindMapDocumentPayload, MindMapNodeTree, MindMapQuestionRef } from './types'

export function findNodeById(root: MindMapNodeTree, nodeId: string): MindMapNodeTree | null {
  if (root.id === nodeId) return root
  for (const child of root.children) {
    const found = findNodeById(child, nodeId)
    if (found) return found
  }
  return null
}

export function updateNodeById(
  root: MindMapNodeTree,
  nodeId: string,
  updater: (node: MindMapNodeTree) => MindMapNodeTree,
): MindMapNodeTree {
  if (root.id === nodeId) return updater(root)
  return {
    ...root,
    children: root.children.map((child) => updateNodeById(child, nodeId, updater)),
  }
}

export function firstQuestionRef(node: MindMapNodeTree): MindMapQuestionRef | null {
  if (node.questionRefs.length > 0) return node.questionRefs[0] ?? null
  for (const child of node.children) {
    const found = firstQuestionRef(child)
    if (found) return found
  }
  return null
}

export function cloneMindMapDocument(document: MindMapDocumentPayload): MindMapDocumentPayload {
  return JSON.parse(JSON.stringify(document)) as MindMapDocumentPayload
}
