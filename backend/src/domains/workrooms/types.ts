export type WorkroomRuntimeState = {
  active_file_id?: string | null
  active_session_id?: string | null
  active_tab_index: number
  active_studio_document_id?: string | null
  active_agent_session_id?: string | null
  active_extraction_session_id?: string | null
  open_document_ids: string[]
  left_panel_state_json: Record<string, unknown>
  center_panel_state_json: Record<string, unknown>
  right_panel_state_json: Record<string, unknown>
}

export type WorkroomRecord = {
  id: string
  userID: string
  name: string
  rootDirectory: string
  wikiDirectory: string
  runtimeState?: WorkroomRuntimeState | null
  createdAt: string
  updatedAt: string
}

export type WorkroomTreeItem = {
  path: string
  type: "file" | "directory"
  sizeBytes: number
  updatedAt: string
}

export type WorkroomTreeVersion = {
  workroomID: string
  versionID: string
  itemCount: number
}

export type WorkroomSourceBindingRecord = {
  id: string
  userID: string
  workroomID: string
  documentID: string
  sourcePackagePath: string
  rawMarkdownPath: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type WorkroomPanelArtifactRecord = {
  id: string
  userID: string
  workroomID: string
  artifactType: string
  artifactRefID: string
  documentID?: string | null
  payloadJson: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type WorkroomCurrentPayload = {
  workroom: WorkroomRecord
  runtimeState: WorkroomRuntimeState
  sources: WorkroomSourceBindingRecord[]
  artifacts: WorkroomPanelArtifactRecord[]
}
