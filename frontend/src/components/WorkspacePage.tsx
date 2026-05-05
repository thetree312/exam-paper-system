import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserInfo, WorkspaceInfo } from '../types'
import BrandIcon from './BrandIcon'
import Icon from './Icon'


interface WorkspacePageProps {
  user: UserInfo
  workspaces: WorkspaceInfo[]
  onCreateWorkspace: () => void | Promise<void>
  onOpenWorkspace: (workspace: WorkspaceInfo) => void
  onDeleteWorkspace?: (workspace: WorkspaceInfo) => void | Promise<void>
}

const folderAccentClass = (index: number) => {
  switch (index % 5) {
    case 0:
      return 'bg-yellow-50 text-yellow-600 border-yellow-100'
    case 1:
      return 'bg-blue-50 text-blue-600 border-blue-100'
    case 2:
      return 'bg-purple-50 text-purple-600 border-purple-100'
    case 3:
      return 'bg-green-50 text-green-600 border-green-100'
    default:
      return 'bg-red-50 text-red-600 border-red-100'
  }
}

const topicBadgeClass = (index: number) => {
  switch (index % 5) {
    case 0:
      return 'text-blue-600 bg-blue-50 border-blue-100'
    case 1:
      return 'text-purple-600 bg-purple-50 border-purple-100'
    case 2:
      return 'text-green-600 bg-green-50 border-green-100'
    case 3:
      return 'text-orange-600 bg-orange-50 border-orange-100'
    default:
      return 'text-rose-600 bg-rose-50 border-rose-100'
  }
}

export const WorkspacePage: React.FC<WorkspacePageProps> = ({
  user,
  workspaces,
  onCreateWorkspace,
  onOpenWorkspace,
  onDeleteWorkspace,
}) => {
  const { t } = useTranslation('common')
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<WorkspaceInfo | null>(null)

  const [todayItems, yesterdayItems, olderItems] = useMemo(() => {
    const today = workspaces.slice(0, 3)
    const yesterday = workspaces.slice(3, 6)
    const older = workspaces.slice(6)
    return [today, yesterday, older]
  }, [workspaces])

  const confirmDeleteWorkspace = async () => {
    if (!pendingDeleteWorkspace) return
    await onDeleteWorkspace?.(pendingDeleteWorkspace)
    setPendingDeleteWorkspace(null)
  }

  return (
    <div className="flex min-h-screen flex-col overflow-hidden bg-background-light font-display text-slate-800 antialiased">
      <header className="z-20 flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-8 py-4 shadow-sm">
        <div className="flex w-[30%] items-center gap-3 pr-8">
          <BrandIcon />
          <h1 className="text-lg font-bold tracking-tight text-slate-900">{t('workspace_page.header.title')}</h1>
        </div>

        <div className="flex h-8 w-[70%] items-center justify-between gap-6 border-l border-slate-200 pl-8">
          <div className="relative w-full max-w-2xl">
            <Icon name={"search"} className="absolute left-3 top-1/2 -translate-y-1/2 text-[20px] text-slate-400" />
            <input
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-10 pr-4 text-sm text-slate-900 placeholder-slate-400 transition-all focus:border-transparent focus:ring-2 focus:ring-slate-400"
              placeholder={t('workspace_page.header.search_placeholder')}
              type="text"
            />
          </div>

          <div className="flex items-center gap-3 border-l border-slate-200 pl-6">
            <div className="text-right">
              <div className="text-sm font-medium text-slate-900">{user.display_name}</div>
              <div className="text-xs text-slate-500">{user.email}</div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden">
        <aside className="flex w-[30%] flex-col border-r border-slate-200 bg-white">
          <div className="px-8 pb-4 pt-8">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xl font-bold tracking-tight text-slate-900">{t('workspace_page.knowledge_base.title')}</h2>
              <button
                type="button"
                onClick={() => void onCreateWorkspace()}
                className="flex items-center gap-1 rounded-md border border-transparent px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-200 hover:bg-slate-100 hover:text-slate-900"
              >
                <Icon name={"create_new_folder"} className="text-[18px]" />
                {t('workspace_page.actions.new_workspace')}
              </button>
            </div>
            <p className="text-sm text-slate-500">{t('workspace_page.knowledge_base.subtitle')}</p>
          </div>

          <div className="flex-1 overflow-y-auto px-8 pb-8">
            <div className="relative">
              <div className="absolute bottom-0 left-[19px] top-0 w-px bg-slate-200" />

              {workspaces.length === 0 ? (
                <div className="space-y-4 pt-4">
                  <div className="mb-2 flex items-center gap-4">
                    <div className="z-10 flex w-10 justify-center bg-white py-1">
                      <div className="h-3 w-3 rounded-full border-2 border-slate-900 bg-white" />
                    </div>
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{t('workspace_page.timeline.today')}</span>
                  </div>
                  <div className="pl-10">
                    <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-6 py-8 text-center shadow-sm">
                      <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full border border-slate-100 bg-white">
                        <Icon name={"folder_open"} className="text-4xl text-slate-300" />
                      </div>
                      <h3 className="mb-2 text-lg font-semibold text-slate-900">{t('workspace_page.empty.title')}</h3>
                      <p className="mx-auto mb-6 max-w-[260px] text-sm leading-relaxed text-slate-500">
                        {t('workspace_page.empty.description')}
                      </p>
                      <button
                        type="button"
                        onClick={() => void onCreateWorkspace()}
                        className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white shadow-md transition-all hover:bg-slate-800 hover:shadow-lg"
                      >
                        <Icon name={"create_new_folder"} className="text-[18px]" />
                        {t('workspace_page.empty.create_button')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-8">
                  <div className="relative">
                    <div className="mb-4 flex items-center gap-4">
                      <div className="z-10 flex w-10 justify-center bg-white py-1">
                        <div className="h-3 w-3 rounded-full border-2 border-slate-900 bg-white" />
                      </div>
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{t('workspace_page.timeline.today')}</span>
                    </div>
                    <div className="space-y-3 pl-10">
                      {todayItems.map((workspace, index) => (
                        <div key={workspace.id} className="group/item relative">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              setPendingDeleteWorkspace(workspace)
                            }}
                            className="absolute left-0 top-1/2 z-10 -translate-x-2 -translate-y-1/2 p-1 text-rose-500 opacity-0 transition-all duration-300 hover:text-rose-600 group-hover/item:translate-x-0 group-hover/item:opacity-100"
                            title={t('workspace_page.actions.delete_workspace')}
                          >
                            <Icon name={"delete"} className="text-[18px]" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenWorkspace(workspace)}
                            className="group -ml-3 flex w-full translate-x-0 items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-all duration-300 hover:border-slate-200 hover:bg-slate-50 group-hover/item:translate-x-10"
                          >
                            <div className={`shrink-0 rounded-md border p-2 ${folderAccentClass(index)}`}>
                              <Icon name={"folder"} className="text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-slate-800 group-hover:text-slate-900">
                                {workspace.name}
                              </p>
                              <p className="mt-0.5 truncate text-xs text-slate-500">
                                {workspace.topic || t('workspace_page.workspace.open_hint')}
                              </p>
                            </div>
                            <Icon name={"chevron_right"} className="text-[18px] text-slate-300 group-hover:text-slate-400" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {yesterdayItems.length > 0 && (
                    <div className="relative">
                      <div className="mb-4 flex items-center gap-4">
                        <div className="z-10 flex w-10 justify-center bg-white py-1">
                          <div className="h-3 w-3 rounded-full border-2 border-slate-300 bg-white" />
                        </div>
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">{t('workspace_page.timeline.yesterday')}</span>
                      </div>
                      <div className="space-y-3 pl-10">
                        {yesterdayItems.map((workspace, index) => (
                          <div key={workspace.id} className="group/item relative">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                setPendingDeleteWorkspace(workspace)
                              }}
                              className="absolute left-0 top-1/2 z-10 -translate-x-2 -translate-y-1/2 p-1 text-rose-500 opacity-0 transition-all duration-300 hover:text-rose-600 group-hover/item:translate-x-0 group-hover/item:opacity-100"
                              title={t('workspace_page.actions.delete_workspace')}
                            >
                              <Icon name={"delete"} className="text-[18px]" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenWorkspace(workspace)}
                              className="group -ml-3 flex w-full translate-x-0 items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-all duration-300 hover:border-slate-200 hover:bg-slate-50 group-hover/item:translate-x-10"
                            >
                              <div className={`shrink-0 rounded-md border p-2 ${folderAccentClass(index + 3)}`}>
                                <Icon name={"folder"} className="text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-slate-800 group-hover:text-slate-900">
                                  {workspace.name}
                                </p>
                                <p className="mt-0.5 truncate text-xs text-slate-500">
                                  {workspace.topic || t('workspace_page.workspace.open_hint')}
                                </p>
                              </div>
                              <Icon name={"chevron_right"} className="text-[18px] text-slate-300 group-hover:text-slate-400" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {olderItems.length > 0 && (
                    <div className="relative">
                      <div className="mb-4 flex items-center gap-4">
                        <div className="z-10 flex w-10 justify-center bg-white py-1">
                          <div className="h-3 w-3 rounded-full border-2 border-slate-300 bg-white" />
                        </div>
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">{t('workspace_page.timeline.earlier')}</span>
                      </div>
                      <div className="space-y-3 pl-10">
                        {olderItems.map((workspace, index) => (
                          <div key={workspace.id} className="group/item relative">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                setPendingDeleteWorkspace(workspace)
                              }}
                              className="absolute left-0 top-1/2 z-10 -translate-x-2 -translate-y-1/2 p-1 text-rose-500 opacity-0 transition-all duration-300 hover:text-rose-600 group-hover/item:translate-x-0 group-hover/item:opacity-100"
                              title={t('workspace_page.actions.delete_workspace')}
                            >
                              <Icon name={"delete"} className="text-[18px]" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenWorkspace(workspace)}
                              className="group -ml-3 flex w-full translate-x-0 items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-all duration-300 hover:border-slate-200 hover:bg-slate-50 group-hover/item:translate-x-10"
                            >
                              <div className={`shrink-0 rounded-md border p-2 ${folderAccentClass(index + 6)}`}>
                                <Icon name={"folder"} className="text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-slate-800 group-hover:text-slate-900">
                                  {workspace.name}
                                </p>
                                <p className="mt-0.5 truncate text-xs text-slate-500">
                                  {workspace.topic || t('workspace_page.workspace.open_hint')}
                                </p>
                              </div>
                              <Icon name={"chevron_right"} className="text-[18px] text-slate-300 group-hover:text-slate-400" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </aside>

        <section className="flex w-[70%] flex-col overflow-hidden bg-[#f8fafc]">
          <div className="shrink-0 px-8 pb-6 pt-8">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold tracking-tight text-slate-900">{t('workspace_page.saved_questions.title')}</h2>
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-bold text-slate-600 shadow-sm">
                {workspaces.length}
              </span>
            </div>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-8 pb-10">
            {workspaces.map((workspace, index) => (
              <button
                key={`card-${workspace.id}`}
                type="button"
                onClick={() => onOpenWorkspace(workspace)}
                className="group relative flex w-full flex-col gap-6 rounded-xl border border-slate-200 bg-white p-5 text-left transition-all duration-300 hover:shadow-lg hover:shadow-slate-200/50 sm:flex-row"
              >
                <div className="flex flex-1 flex-col justify-between gap-4">
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${topicBadgeClass(index)}`}
                      >
                        {t('workspace_page.saved_questions.workspace_badge')}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('workspace_page.saved_questions.topic_badge')}</span>
                    </div>
                    <h3 className="text-lg font-bold leading-snug text-slate-900 transition-colors group-hover:text-slate-700">
                      {workspace.name}
                    </h3>
                    <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-600">
                      {workspace.topic ||
                        t('workspace_page.saved_questions.default_topic')}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs font-medium text-slate-400">
                    <span>{t('workspace_page.saved_questions.workspace_id', { id: workspace.id })}</span>
                    <span className="h-1 w-1 rounded-full bg-slate-300" />
                    <span className="text-slate-500">{workspace.status}</span>
                  </div>
                </div>

                <div className="flex aspect-video items-center justify-center rounded-lg border border-slate-200 bg-slate-100 shadow-sm sm:w-48">
                  <Icon name={"school"} className="text-4xl text-slate-300" />
                </div>
              </button>
            ))}
          </div>
        </section>
      </main>

      {pendingDeleteWorkspace && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-900">{t('workspace_page.delete_modal.title')}</h3>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              {t('workspace_page.delete_modal.description', { name: pendingDeleteWorkspace.name })}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingDeleteWorkspace(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                {t('workspace_page.delete_modal.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteWorkspace()}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700"
              >
                {t('workspace_page.delete_modal.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
