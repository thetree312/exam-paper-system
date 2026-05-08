import React, { useState } from 'react'
import { AgentChatPanel } from './AgentChatPanel'
import { useAppStore } from '../store/appStore'
import { useFileUpload, useOcrManager } from '../hooks'
import type { AgentSendPayload } from '../types'

interface AgentConnectorProps {
  backendBaseUrl: string
}

export const AgentConnector: React.FC<AgentConnectorProps> = ({ backendBaseUrl }) => {
  const user = useAppStore((state) => state.user)
  const isAgentDrawerOpen = useAppStore((state) => state.isAgentDrawerOpen)
  const setIsAgentDrawerOpen = useAppStore((state) => state.setIsAgentDrawerOpen)
  const agentDrawerWidth = useAppStore((state) => state.agentDrawerWidth)
  const setAgentDrawerWidth = useAppStore((state) => state.setAgentDrawerWidth)
  const studioDocumentId = useAppStore((state) => state.studioDocumentId)
  const setStudioDocumentId = useAppStore((state) => state.setStudioDocumentId)
  const workroom = useAppStore((state) => state.workroom)

  const { currentFile } = useFileUpload(backendBaseUrl, user, () => {})
  const { handleAgUiEvent } = useOcrManager(backendBaseUrl, () => {}, () => {}, studioDocumentId)

  const [agentAppendToken] = useState<
    | {
        id: number
        payload: AgentSendPayload
      }
    | null
  >(null)

  if (!user) {
    return null
  }

  if (!workroom?.id) {
    return null
  }

  const agentViewId = React.useMemo(() => {
    if (!currentFile) return null
    return `view-${currentFile.fileId}-${currentFile.sessionId}`
  }, [currentFile])

  return (
    <AgentChatPanel
      backendBaseUrl={backendBaseUrl}
      user={user}
      workroomId={workroom.id}
      documentId={studioDocumentId}
      viewId={agentViewId ?? undefined}
      isOpen={isAgentDrawerOpen}
      onClose={() => setIsAgentDrawerOpen(false)}
      width={agentDrawerWidth}
      onResize={setAgentDrawerWidth}
      appendToken={agentAppendToken}
      onAgUiEvent={handleAgUiEvent}
      onDocumentResolved={(id) => setStudioDocumentId(id != null ? String(id) : null)}
    />
  )
}


