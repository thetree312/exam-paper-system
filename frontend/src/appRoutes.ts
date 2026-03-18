export type AppRoute =
  | { kind: 'workspace-index' }
  | { kind: 'workroom'; workspaceId: number }

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/workspaces'
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

export function parseAppRoute(pathname: string): AppRoute | null {
  const normalized = normalizePathname(pathname)
  if (normalized === '/workspaces') {
    return { kind: 'workspace-index' }
  }

  const match = normalized.match(/^\/workspaces\/(\d+)$/)
  if (match) {
    return { kind: 'workroom', workspaceId: Number(match[1]) }
  }

  return null
}

export function buildWorkspaceIndexPath(): string {
  return '/workspaces'
}

export function buildWorkroomPath(workspaceId: number): string {
  return `/workspaces/${workspaceId}`
}
