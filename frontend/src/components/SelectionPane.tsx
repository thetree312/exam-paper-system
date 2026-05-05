import React, { useEffect } from 'react'
import { SelectionWorkspace } from './SelectionWorkspace'
import { useSelectionInteraction } from '../hooks/useSelectionInteraction'
import type {
  AgentCitationFocus,
  DocumentPreviewAssetRef,
  PageSelectionSegment,
  SelectionBox,
  RegionPayload,
  LegendRegionPayload,
} from '../types'

interface SelectionPaneProps {
  backendBaseUrl: string
  previewSources: DocumentPreviewAssetRef[]
  previewType: string | null
  activeStatus: string
  hasActiveFile: boolean
  activeFileId?: string | number | null
  pageRefs: React.MutableRefObject<Record<number, HTMLDivElement | null>>
  imageRefs: React.MutableRefObject<Record<number, HTMLImageElement | null>>
  isExtracting: boolean
  previewScrollRef: React.RefObject<HTMLDivElement>
  citationFocus?: AgentCitationFocus | null
  onSelectionSnapshotChange?: (snapshot: {
    selection: SelectionBox | null
    pendingExclusions: PageSelectionSegment[]
    pendingLegends: PageSelectionSegment[]
    buildRegionsPayload: () => RegionPayload[] | null
    buildLegendsPayload: () => LegendRegionPayload[] | null
    clearSelection: () => void
  }) => void
  onAddClick: () => void
  onClearSelection: () => void
}

export const SelectionPane: React.FC<SelectionPaneProps> = ({
  backendBaseUrl,
  previewSources,
  previewType,
  activeStatus,
  hasActiveFile,
  activeFileId,
  pageRefs,
  imageRefs,
  isExtracting,
  previewScrollRef,
  citationFocus,
  onSelectionSnapshotChange,
  onAddClick,
  onClearSelection,
}) => {
  const {
    selection,
    pendingExclusions,
    pendingLegends,
    isExclusionMode,
    isLegendMode,
    handlePointerDown,
    toggleExclusionMode,
    toggleLegendMode,
    clearSelection,
    removeExclusion,
    removeLegend,
    buildRegionsPayload,
    buildLegendsPayload,
  } = useSelectionInteraction({
    previewScrollRef,
    pageRefs,
    imageRefs,
  })

  useEffect(() => {
    if (!onSelectionSnapshotChange) return
    onSelectionSnapshotChange({
      selection,
      pendingExclusions,
      pendingLegends,
      buildRegionsPayload,
      buildLegendsPayload,
      clearSelection,
    })
  }, [
    buildLegendsPayload,
    buildRegionsPayload,
    clearSelection,
    onSelectionSnapshotChange,
    pendingExclusions,
    pendingLegends,
    selection,
  ])

  const handleAdd = () => {
    onAddClick()
  }

  const handleClear = () => {
    clearSelection()
    onClearSelection()
  }

  useEffect(() => {
    if (!citationFocus || !hasActiveFile) return
    if (activeFileId != null && String(citationFocus.fileId) !== String(activeFileId)) return
    const pageNode = pageRefs.current[citationFocus.pageNo]
    if (!pageNode) return
    pageNode.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeFileId, citationFocus, hasActiveFile, pageRefs])

  return (
    <div
      ref={previewScrollRef}
      className="relative flex-1 overflow-y-auto bg-slate-100 p-2 sm:p-2.5 lg:p-3 scrollbar-hidden"
      onPointerDown={handlePointerDown}
    >
      <SelectionWorkspace
        backendBaseUrl={backendBaseUrl}
        previewSources={previewSources}
        previewType={previewType}
        activeStatus={activeStatus}
        hasActiveFile={hasActiveFile}
        citationFocus={citationFocus}
        selection={selection}
        pendingExclusions={pendingExclusions}
        pendingLegends={pendingLegends}
        isExclusionMode={isExclusionMode}
        isLegendMode={isLegendMode}
        pageRefs={pageRefs}
        imageRefs={imageRefs}
        isExtracting={isExtracting}
        onAddClick={handleAdd}
        onClearClick={handleClear}
        onToggleExclude={toggleExclusionMode}
        onRemoveExclusion={removeExclusion}
        onToggleLegend={toggleLegendMode}
        onRemoveLegend={removeLegend}
      />
    </div>
  )
}
