import React from 'react'
import type { UserInfo, WorkspaceInfo, WorkroomInfo } from '../types'
import BrandIcon from './BrandIcon'
import { WorkroomSourceTimeline } from './WorkroomSourceTimeline'

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
    <div className="min-h-screen bg-[#f7f8fb] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            {onBackToWorkspace && (
              <button
                type="button"
                onClick={onBackToWorkspace}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                Workspace
              </button>
            )}
            <BrandIcon />
            <div className="h-8 w-px bg-slate-200" />
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                {workspace?.name || 'Exam Workroom'}
              </div>
              <div className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
                {workroom?.name || 'Current Workroom'}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {workspace?.topic || 'Active learning workbench under the current workspace'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-sm font-medium text-slate-900">{user.display_name}</div>
              <div className="text-xs text-slate-500">{user.email}</div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <span className="material-symbols-outlined text-[18px]">logout</span>
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
