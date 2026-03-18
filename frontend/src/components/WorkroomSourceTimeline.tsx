import React, { useMemo } from 'react'
import { useAppStore } from '../store/appStore'

interface WorkroomSourceTimelineProps {
  workspaceName?: string | null
  workspaceTopic?: string | null
  onUploadClick: () => void
}

export const WorkroomSourceTimeline: React.FC<WorkroomSourceTimelineProps> = ({
  workspaceName,
  workspaceTopic,
  onUploadClick,
}) => {
  const workroom = useAppStore((state) => state.workroom)
  const sources = useAppStore((state) => state.workroomSources)
  const fileTabs = useAppStore((state) => state.fileTabs)

  const items = useMemo(() => {
    return sources.map((source, index) => {
      const tab = fileTabs.find((item) => item.fileId === source.file_id)
      return {
        id: source.file_id,
        title: tab?.name ?? `Source #${source.file_id}`,
        subtitle: source.source_id ? `KB source #${source.source_id}` : 'Waiting for KB ingest',
        accent: index % 4,
      }
    })
  }, [sources, fileTabs])

  const accentClass = (accent: number) => {
    switch (accent % 4) {
      case 0:
        return 'bg-blue-50 text-blue-700 border-blue-100'
      case 1:
        return 'bg-emerald-50 text-emerald-700 border-emerald-100'
      case 2:
        return 'bg-amber-50 text-amber-700 border-amber-100'
      default:
        return 'bg-rose-50 text-rose-700 border-rose-100'
    }
  }

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-6 pb-4 pt-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Workroom
            </div>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
              {workroom?.name || 'Current Workroom'}
            </h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {workspaceName ? `${workspaceName} / Workroom` : 'Workroom under the current workspace'}
            </p>
          </div>
          <button
            type="button"
            onClick={onUploadClick}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-slate-900 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
          >
            <span className="material-symbols-outlined text-[18px]">upload_file</span>
            Upload
          </button>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          {workspaceTopic || 'This panel binds source files to the current workroom and will later connect them to the knowledge base.'}
        </p>
      </div>

      <div className="px-6 py-4">
        <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-slate-400">
          <span>Knowledge Base</span>
          <span>{items.length}</span>
        </div>
      </div>

      <div className="relative flex-1 overflow-y-auto px-6 pb-8">
        <div className="absolute bottom-8 left-[34px] top-0 w-px bg-slate-200" />
        {items.length === 0 ? (
          <div className="relative z-10 mt-16 rounded-3xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-sm">
              <span className="material-symbols-outlined text-4xl text-slate-300">folder_open</span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900">No source files yet</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Upload PDF, Word, or image files. They will bind to this workroom first and then enter the KB pipeline.
            </p>
          </div>
        ) : (
          <div className="relative z-10 space-y-8">
            <div className="flex items-center gap-4">
              <div className="flex w-5 justify-center">
                <div className="h-3 w-3 rounded-full border-2 border-slate-900 bg-white" />
              </div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Today
              </span>
            </div>
            <div className="space-y-3 pl-9">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="group rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"
                >
                  <div
                    className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${accentClass(
                      item.accent,
                    )}`}
                  >
                    source
                  </div>
                  <div className="mt-3 text-sm font-semibold text-slate-900">{item.title}</div>
                  <div className="mt-1 text-sm text-slate-500">{item.subtitle}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
