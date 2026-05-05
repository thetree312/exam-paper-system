import { apiJson } from '../lib/api'
import type { WorkroomTreeItem, WorkroomTreeVersion } from '../types'

export async function fetchWorkroomTree(
  baseUrl: string,
  workroomId: string | number,
  signal?: AbortSignal,
): Promise<WorkroomTreeItem[]> {
  const data = await apiJson<{ items: WorkroomTreeItem[] }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/tree`,
    {
      method: 'GET',
      signal,
    },
  )
  return Array.isArray(data.items) ? data.items : []
}

export async function fetchWorkroomTreeVersion(
  baseUrl: string,
  workroomId: string | number,
  signal?: AbortSignal,
): Promise<WorkroomTreeVersion> {
  return apiJson<WorkroomTreeVersion>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/tree-version`,
    {
      method: 'GET',
      signal,
    },
  )
}

export async function fetchWorkroomFile(
  baseUrl: string,
  workroomId: string | number,
  path: string,
): Promise<string> {
  const data = await apiJson<{ content?: string }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/file?path=${encodeURIComponent(path)}`,
    {
      method: 'GET',
    },
  )
  return typeof data.content === 'string' ? data.content : ''
}

export async function saveWorkroomFile(
  baseUrl: string,
  workroomId: string | number,
  path: string,
  content: string,
): Promise<string> {
  const data = await apiJson<{ content?: string }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/file`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, content }),
    },
  )
  return typeof data.content === 'string' ? data.content : content
}

export async function createWorkroomFile(
  baseUrl: string,
  workroomId: string | number,
  path: string,
  content = '',
) {
  return apiJson<{ path: string }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/fs/file`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    },
  )
}

export async function createWorkroomDirectory(
  baseUrl: string,
  workroomId: string | number,
  path: string,
) {
  return apiJson<{ path: string }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/fs/directory`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    },
  )
}

export async function moveWorkroomPath(
  baseUrl: string,
  workroomId: string | number,
  fromPath: string,
  toPath: string,
) {
  return apiJson<{ fromPath: string; toPath: string }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/fs/path`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromPath, toPath }),
    },
  )
}

export async function deleteWorkroomPath(
  baseUrl: string,
  workroomId: string | number,
  path: string,
) {
  return apiJson<{ path: string }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/fs/path?path=${encodeURIComponent(path)}`,
    {
      method: 'DELETE',
    },
  )
}

export async function copyWorkroomPath(
  baseUrl: string,
  workroomId: string | number,
  fromPath: string,
  toPath: string,
) {
  return apiJson<{ fromPath: string; toPath: string; status: 'copied' }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/fs/copy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromPath, toPath }),
    },
  )
}

export async function revealWorkroomPathInOs(
  baseUrl: string,
  workroomId: string | number,
  path: string,
) {
  return apiJson<{ path: string; supported: boolean; reason?: string }>(
    `${baseUrl}/api/workrooms/${encodeURIComponent(String(workroomId))}/fs/reveal-in-os`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    },
  )
}
