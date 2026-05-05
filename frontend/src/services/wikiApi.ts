import { apiJson } from '../lib/api'
import type { WikiTreeItem } from '../types'

export async function fetchWikiTree(baseUrl: string, workroomId: string | number): Promise<WikiTreeItem[]> {
  const data = await apiJson<{ items: WikiTreeItem[] }>(
    `${baseUrl}/api/wiki/tree?workroom_id=${encodeURIComponent(String(workroomId))}`,
    {
      method: 'GET',
    },
  )
  return Array.isArray(data.items) ? data.items : []
}

export async function fetchWikiFile(
  baseUrl: string,
  workroomId: string | number,
  path: string,
): Promise<string> {
  const data = await apiJson<{ content?: string }>(
    `${baseUrl}/api/wiki/file?workroom_id=${encodeURIComponent(String(workroomId))}&path=${encodeURIComponent(path)}`,
    {
      method: 'GET',
    },
  )
  return typeof data.content === 'string' ? data.content : ''
}
