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
  const agentDocumentId = useAppStore((state) => state.agentDocumentId)
  const setAgentDocumentId = useAppStore((state) => state.setAgentDocumentId)

  const { currentFile, sessionId } = useFileUpload(backendBaseUrl, user, () => {})
  const { handleAgUiEvent } = useOcrManager(backendBaseUrl, () => {}, () => {}, agentDocumentId)

  const [agentAppendToken, setAgentAppendToken] = useState<
    | {
        id: number
        payload: AgentSendPayload
      }
    | null
  >(null)

  const agentViewId = React.useMemo(() => {
    if (!currentFile) return null
    return `view-${currentFile.fileId}-${currentFile.sessionId}`
  }, [currentFile])

  return (
    <AgentChatPanel
      backendBaseUrl={backendBaseUrl}
      user={user}
      documentId={agentDocumentId}
      viewId={agentViewId ?? undefined}
      isOpen={isAgentDrawerOpen}
      onClose={() => setIsAgentDrawerOpen(false)}
      width={agentDrawerWidth}
      onResize={setAgentDrawerWidth}
      appendToken={agentAppendToken}
      onAgUiEvent={handleAgUiEvent}
      onDocumentResolved={setAgentDocumentId}
    />
  )
}
