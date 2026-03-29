import React from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentCitationFocus,
  PageSelectionSegment,
  SelectionBox,
  SelectionExclusion,
  SelectionLegend,
} from '../types'

interface SelectionWorkspaceProps {
  previewSources: string[]
  previewType: string | null
  activeStatus: string
  hasActiveFile: boolean
  citationFocus?: AgentCitationFocus | null
  selection: SelectionBox | null
  pendingExclusions: PageSelectionSegment[]
  pendingLegends: PageSelectionSegment[]
  isExclusionMode: boolean
  isLegendMode: boolean
  pageRefs: React.MutableRefObject<Record<number, HTMLDivElement | null>>
  imageRefs: React.MutableRefObject<Record<number, HTMLImageElement | null>>
  isExtracting: boolean
  onAddClick: () => void
  onClearClick: () => void
  onToggleExclude: () => void
  onRemoveExclusion: (id: string) => void
  onToggleLegend: () => void
  onRemoveLegend: (id: string) => void
}

const SelectionToolbar: React.FC<{
  isExclusionMode: boolean
  isLegendMode: boolean
  isExtracting: boolean
  onAddClick: () => void
  onClearClick: () => void
  onToggleExclude: () => void
  onToggleLegend: () => void
}> = ({
  isExclusionMode,
  isLegendMode,
  isExtracting,
  onAddClick,
  onClearClick,
  onToggleExclude,
  onToggleLegend,
}) => {
  const { t } = useTranslation('common')
  return (
    <div
      className="absolute right-0 -top-3 translate-y-[-100%] flex items-center"
      data-selection-control="true"
      style={{ pointerEvents: 'auto' }}
    >
      <div className="flex items-center gap-2 rounded-full bg-slate-900 text-slate-200 px-3 py-2 shadow-2xl border border-slate-800">
        <button
          type="button"
          className="size-8 min-w-8 inline-flex items-center justify-center rounded-full hover:bg-slate-800 active:scale-95 transition disabled:opacity-50"
          onClick={onAddClick}
          disabled={isExtracting}
          title={t('selection.toolbar.add')}
        >
          <span className="material-symbols-outlined text-[18px]">note_add</span>
        </button>
        <button
          type="button"
          className="size-8 min-w-8 inline-flex items-center justify-center rounded-full hover:bg-slate-800 active:scale-95 transition"
          onClick={onClearClick}
          title={t('selection.toolbar.clear')}
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
        <div className="h-5 w-px bg-slate-700" />
        <button
          type="button"
          className={`size-8 min-w-8 inline-flex items-center justify-center rounded-full active:scale-95 transition ${
            isExclusionMode ? 'bg-slate-800 text-slate-50' : 'hover:bg-slate-800'
          }`}
          onClick={onToggleExclude}
          title={t('selection.toolbar.exclude')}
        >
          <span className="material-symbols-outlined text-[18px]">do_not_disturb_on</span>
        </button>
        <button
          type="button"
          className={`size-8 min-w-8 inline-flex items-center justify-center rounded-md active:scale-95 transition ${
            isLegendMode ? 'bg-slate-800 text-slate-50' : 'hover:bg-slate-800'
          }`}
          onClick={onToggleLegend}
          title={t('selection.toolbar.legend')}
        >
          <span className="material-symbols-outlined text-[18px]">image</span>
        </button>
      </div>
    </div>
  )
}

const ExclusionBadge: React.FC<{ exclusion: SelectionExclusion; onRemove: (id: string) => void }> = ({
  exclusion,
  onRemove,
}) => (
  <div
    className="absolute border-2 border-red-400 bg-red-200/20 ring-2 ring-red-200/40"
    style={{
      left: exclusion.x,
      top: exclusion.y,
      width: exclusion.width,
      height: exclusion.height,
    }}
    data-selection-control="true"
  >
    <button
      type="button"
      className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-[12px] shadow"
      onClick={(event) => {
        event.stopPropagation()
        onRemove(exclusion.id)
      }}
    >
      ×
    </button>
  </div>
)

const PendingExclusion: React.FC<{ segment: PageSelectionSegment }> = ({ segment }) => (
  <div
    className="absolute border-2 border-dashed border-red-300 bg-red-100/40"
    style={{
      left: segment.x,
      top: segment.y,
      width: segment.width,
      height: segment.height,
    }}
  />
)

const LegendBadge: React.FC<{ legend: SelectionLegend; onRemove: (id: string) => void }> = ({
  legend,
  onRemove,
}) => (
  <div
    className="absolute border-2 border-emerald-400 bg-emerald-200/20 ring-2 ring-emerald-200/40"
    style={{
      left: legend.x,
      top: legend.y,
      width: legend.width,
      height: legend.height,
    }}
    data-selection-control="true"
  >
    <button
      type="button"
      className="absolute -top-2 -right-2 bg-emerald-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-[12px] shadow"
      onClick={(event) => {
        event.stopPropagation()
        onRemove(legend.id)
      }}
    >
      ×
    </button>
  </div>
)

const PendingLegend: React.FC<{ segment: PageSelectionSegment }> = ({ segment }) => (
  <div
    className="absolute border-2 border-dashed border-emerald-300 bg-emerald-100/40"
    style={{
      left: segment.x,
      top: segment.y,
      width: segment.width,
      height: segment.height,
    }}
  />
)

export const SelectionWorkspace: React.FC<SelectionWorkspaceProps> = ({
  previewSources,
  previewType,
  activeStatus,
  hasActiveFile,
  citationFocus,
  selection,
  pendingExclusions,
  pendingLegends,
  isExclusionMode,
  isLegendMode,
  pageRefs,
  imageRefs,
  isExtracting,
  onAddClick,
  onClearClick,
  onToggleExclude,
  onRemoveExclusion,
  onToggleLegend,
  onRemoveLegend,
}) => {
  const { t } = useTranslation('common')
  const renderPages = () => {
    if (previewSources.length > 0 && activeStatus === 'ready') {
      const firstSegment = selection?.segments[0]
      return previewSources.map((src, idx) => {
        const page = idx + 1
        const pageSegments = selection?.segments.filter((seg) => seg.page === page) ?? []
        const pageExclusions = selection?.exclusions.filter((seg) => seg.page === page) ?? []
        const pageLegends = selection?.legends?.filter((seg) => seg.page === page) ?? []
        const pending = pendingExclusions.filter((seg) => seg.page === page)
        const pendingLegendSegments = pendingLegends.filter((seg) => seg.page === page)
        const citationOnPage = citationFocus?.pageNo === page ? citationFocus : null
        const citationBBox = citationOnPage?.bboxNorm ?? null
        const isPageLevelCitation = Boolean(citationOnPage && !citationBBox)
        return (
          <div
            key={`${src}-${idx}`}
            ref={(el) => {
              pageRefs.current[page] = el
            }}
            className="relative mb-6 last:mb-0"
          >
            <div className="absolute top-3 left-3 z-10 bg-white/80 backdrop-blur rounded-full px-3 py-1 text-xs font-medium text-slate-700 flex items-center gap-2 shadow">
              <span className="material-symbols-outlined text-[16px]">description</span>
              {t('selection.page_label', { page })}
            </div>
            <img
              ref={(el) => {
                imageRefs.current[page] = el
              }}
              src={src}
              alt={t('selection.preview.alt_page', { page })}
              className="w-full h-auto block select-none"
              draggable={false}
            />
            {isPageLevelCitation && citationOnPage && (
              <div
                className="absolute inset-3 border-[3px] border-amber-500 bg-amber-300/10 shadow-[0_0_0_4px_rgba(251,191,36,0.2)] transition-all duration-300"
                data-citation-highlight="true"
                data-citation-id={citationOnPage.citationId}
              />
            )}
            {citationOnPage && citationBBox && (
              <div
                className="absolute border-[3px] border-amber-500 bg-amber-300/20 shadow-[0_0_0_4px_rgba(251,191,36,0.25)] transition-all duration-300"
                style={{
                  left: `${citationBBox.x * 100}%`,
                  top: `${citationBBox.y * 100}%`,
                  width: `${citationBBox.w * 100}%`,
                  height: `${citationBBox.h * 100}%`,
                }}
                data-citation-highlight="true"
                data-citation-id={citationOnPage.citationId}
              />
            )}
            {pageSegments.map((segment) => {
              const isAnchor = firstSegment &&
                segment.page === firstSegment.page &&
                segment.x === firstSegment.x &&
                segment.y === firstSegment.y
              return (
                <div
                  key={`selection-${page}-${segment.x}-${segment.y}`}
                  className="absolute border-2 border-primary bg-primary/10 shadow-lg ring-4 ring-primary/10"
                  style={{
                    left: segment.x,
                    top: segment.y,
                    width: segment.width,
                    height: segment.height,
                  }}
                >
                  {isAnchor && selection && selection.segments.length > 0 && (
                    <SelectionToolbar
                      isExclusionMode={isExclusionMode}
                      isLegendMode={isLegendMode}
                      isExtracting={isExtracting}
                      onAddClick={onAddClick}
                      onClearClick={onClearClick}
                      onToggleExclude={onToggleExclude}
                      onToggleLegend={onToggleLegend}
                    />
                  )}
                </div>
              )
            })}
            {pageExclusions.map((exclusion) => (
              <ExclusionBadge
                key={exclusion.id}
                exclusion={exclusion}
                onRemove={onRemoveExclusion}
              />
            ))}
            {pageLegends.map((legend) => (
              <LegendBadge
                key={legend.id}
                legend={legend}
                onRemove={onRemoveLegend}
              />
            ))}
            {pending.map((segment, i) => (
              <PendingExclusion key={`pending-${page}-${i}`} segment={segment} />
            ))}
            {pendingLegendSegments.map((segment, i) => (
              <PendingLegend key={`pending-legend-${page}-${i}`} segment={segment} />
            ))}
          </div>
        )
      })
    }

    if (hasActiveFile) {
      if (activeStatus === 'pending' || activeStatus === 'processing') {
        return (
          <div className="flex flex-col items-center justify-center h-[500px] text-slate-400 gap-3">
            <span className="material-symbols-outlined text-[40px] animate-spin">sync</span>
            <p className="text-sm font-medium">{t('selection.preview.loading')}</p>
          </div>
        )
      }

      if (activeStatus === 'failed') {
        return (
          <div className="flex flex-col items-center justify-center h-[500px] text-red-400 gap-3">
            <span className="material-symbols-outlined text-[40px]">error</span>
            <p className="text-sm font-medium">{t('selection.preview.failed')}</p>
          </div>
        )
      }
    }

    return (
      <div className="flex flex-col items-center justify-center h-[500px] text-slate-400 gap-3">
        <span className="material-symbols-outlined text-[40px]">upload_file</span>
        <p className="text-sm font-medium">
          {previewType === null ? t('selection.preview.unsupported') : t('selection.preview.no_file')}
        </p>
      </div>
    )
  }

  return <>{renderPages()}</>
}
