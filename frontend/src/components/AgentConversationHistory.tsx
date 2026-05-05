import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentConversationMeta } from '../types'

interface AgentConversationHistoryProps {
  conversations: AgentConversationMeta[]
  activeConversationKey: string | null
  isOpen: boolean
  onClose: () => void
  onSelectConversation: (key: string) => void
  onDeleteConversation: (key: string) => void
  onRenameConversation: (key: string, title: string) => void
}

export const AgentConversationHistory: React.FC<AgentConversationHistoryProps> = ({
  conversations,
  activeConversationKey,
  isOpen,
  onClose,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
}) => {
  const { t } = useTranslation()
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  // 映射出实际需要展示的历史会话：
  // 1）必须已经绑定到真实 sessionId
  // 2）排除已归档会话
  // 3）同一个 sessionId 只保留一条（按原顺序的第一条），避免多次“新会话”指向同一会话时出现重复
  const visibleConversations: AgentConversationMeta[] = []
  const seenSessionIds = new Set<string>()
  for (const conv of conversations) {
    if (conv.sessionId == null || conv.archived) continue
    const sid = conv.sessionId
    if (seenSessionIds.has(sid)) continue
    seenSessionIds.add(sid)
    visibleConversations.push(conv)
  }

  if (!isOpen) return null

  return (
    <div className="w-full bg-white border-b border-neutral-200 shadow-sm">
      <div className="p-2 space-y-1 max-h-[360px] overflow-y-auto custom-scrollbar relative">
        <div className="px-4 py-3 text-[10px] uppercase tracking-[0.2em] text-neutral-400 font-bold sticky top-0 bg-white/95 backdrop-blur-md z-10 border-b border-neutral-50 mb-1 text-left">
          {t('agent_chat.conversation_history_title')} ({visibleConversations.length})
        </div>
        <div className="space-y-1">
          {visibleConversations.length === 0 && (
            <div className="px-4 py-4 text-xs text-neutral-400 text-center">{t('agent_chat.conversation_history_empty')}</div>
          )}
          {visibleConversations.map((conv) => {
            const isActive = conv.key === activeConversationKey
            return (
              <div
                key={conv.key}
                className={`w-full flex items-center justify-between p-3 rounded-xl transition-all group ${
                  isActive ? 'bg-neutral-100' : 'hover:bg-neutral-50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectConversation(conv.key)
                    onClose()
                  }}
                  className="flex items-center overflow-hidden flex-1 text-left min-w-0"
                >
                  <svg
                    className={`w-3.5 h-3.5 mr-3 flex-shrink-0 ${
                      isActive ? 'text-blue-600' : 'text-neutral-300'
                    }`}
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14l4 4V5c0-1.1-.9-2-2-2z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <div className="truncate">
                      {editingKey === conv.key ? (
                        <input
                          autoFocus
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onBlur={() => {
                            const title = editingTitle.trim()
                            onRenameConversation(conv.key, title || '')
                            setEditingKey(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const title = editingTitle.trim()
                              onRenameConversation(conv.key, title || '')
                              setEditingKey(null)
                            } else if (e.key === 'Escape') {
                              setEditingKey(null)
                            }
                          }}
                          className="w-full bg-transparent border-b border-neutral-300 text-xs focus:outline-none"
                        />
                      ) : (
                        <span
                          className={`text-xs truncate ${
                            isActive ? 'font-semibold text-neutral-900' : 'text-neutral-600'
                          }`}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            setEditingKey(conv.key)
                            setEditingTitle(conv.title || '')
                          }}
                        >
                          {conv.title || t('agent_chat.conversation_default_title')}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteConversation(conv.key)
                  }}
                  className="text-neutral-300 hover:text-red-500 opacity-0 group-hover:opacity-100 ml-2 transition-opacity pointer-events-auto"
                  aria-label={t('agent_chat.conversation_delete_aria')}
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
