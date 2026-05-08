import React from 'react'
import type { UserInfo, WorkspaceInfo, WorkroomInfo } from '../types'
import BrandIcon from './BrandIcon'
import { WorkroomSourceTimeline } from './WorkroomSourceTimeline'
import Icon from './Icon'


interface WorkroomHomeShellProps {
  user: UserInfo
  workspace?: WorkspaceInfo | null
  workroom: WorkroomInfo | null
  onBackToWorkspace?: () => void
  onUploadClick: () => void
  onLogout: () => void
  children: React.ReactNode
}

export const WorkroomHomeShell: React.FC<WorkroomHomeShellProps> = ({
  user,
  workspace,
  workroom,
  onBackToWorkspace,
  onUploadClick,
  onLogout,
  children,
}) => {
  return (
    <div className="min-h-screen bg-[#f7f8fb] text-[var(--ui-text-primary)]">
      <header className="sticky top-0 z-30 border-b border-[var(--ui-border-default)] bg-[var(--ui-bg-elevated)] backdrop-blur">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            {onBackToWorkspace && (
              <button
                type="button"
                onClick={onBackToWorkspace}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] px-3 text-sm font-medium text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-bg-panel-muted)]"
              >
                <Icon name={"arrow_back"} className="text-[18px]" />
                Workspace
              </button>
            )}
            <BrandIcon />
            <div className="h-8 w-px bg-[var(--ui-border-default)]" />
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--ui-text-primary)]">
                {workspace?.name || 'Exam Workroom'}
              </div>
              <div className="mt-1 text-lg font-semibold tracking-tight text-[var(--ui-text-primary)]">
                {workroom?.name || 'Current Workroom'}
              </div>
              <div className="mt-1 text-xs text-[var(--ui-text-primary)]">
                {workspace?.topic || 'Active learning workbench under the current workspace'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-sm font-medium text-[var(--ui-text-primary)]">{user.display_name}</div>
              <div className="text-xs text-[var(--ui-text-primary)]">{user.email}</div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] px-4 text-sm font-medium text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-bg-panel-muted)]"
            >
              <Icon name={"logout"} className="text-[18px]" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-73px)]">
        <WorkroomSourceTimeline
          workspaceName={workspace?.name ?? null}
          workspaceTopic={workspace?.topic ?? null}
          onUploadClick={onUploadClick}
        />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}


