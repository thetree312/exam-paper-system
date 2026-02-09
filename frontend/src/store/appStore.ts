import { create } from 'zustand'
import type {
  AggregatedOcrItem,
  AgentConversationMeta,
  AgentRunMessage,
  UploadedFileTab,
  UserInfo,
} from '../types'

interface AppState {
  // 用户认证
  user: UserInfo | null
  setUser: (user: UserInfo | null) => void

  // 文件管理
  fileTabs: UploadedFileTab[]
  setFileTabs: (tabs: UploadedFileTab[] | ((prev: UploadedFileTab[]) => UploadedFileTab[])) => void
  activeTabIndex: number
  setActiveTabIndex: (index: number) => void
  previewScrollPositions: Record<number, number>
  setPreviewScrollPositions: (positions: Record<number, number> | ((prev: Record<number, number>) => Record<number, number>)) => void

  // OCR 题目管理
  ocrItems: AggregatedOcrItem[]
  setOcrItems: (items: AggregatedOcrItem[] | ((prev: AggregatedOcrItem[]) => AggregatedOcrItem[])) => void

  // 会话管理
  conversations: AgentConversationMeta[]
  setConversations: (convs: AgentConversationMeta[] | ((prev: AgentConversationMeta[]) => AgentConversationMeta[])) => void
  conversationMessages: Record<string, AgentRunMessage[]>
  setConversationMessages: (msgs: Record<string, AgentRunMessage[]> | ((prev: Record<string, AgentRunMessage[]>) => Record<string, AgentRunMessage[]>)) => void
  activeConversationKey: string | null
  setActiveConversationKey: (key: string | null) => void

  // Agent 文档
  agentDocumentId: number | null
  setAgentDocumentId: (id: number | null) => void

  // UI 状态
  isAgentDrawerOpen: boolean
  setIsAgentDrawerOpen: (open: boolean) => void
  agentDrawerWidth: number
  setAgentDrawerWidth: (width: number) => void
  isUserMenuOpen: boolean
  setIsUserMenuOpen: (open: boolean) => void
  isPreviewCollapsed: boolean
  setIsPreviewCollapsed: (collapsed: boolean) => void
  isAnswerMode: boolean
  setIsAnswerMode: (mode: boolean) => void
  workspaceView: 'editor' | 'mindmap' | 'flashcard'
  setWorkspaceView: (view: 'editor' | 'mindmap' | 'flashcard') => void
  appView: 'editor' | 'favorites'
  setAppView: (view: 'editor' | 'favorites') => void
  leftWidth: number
  setLeftWidth: (width: number) => void
  isResizing: boolean
  setIsResizing: (resizing: boolean) => void
  isExportDialogOpen: boolean
  setIsExportDialogOpen: (open: boolean) => void
  viewportWidth: number
  setViewportWidth: (width: number) => void
}

export const useAppStore = create<AppState>((set) => ({
  // 用户认证
  user: null,
  setUser: (user) => set({ user }),

  // 文件管理
  fileTabs: [],
  setFileTabs: (tabs) =>
    set((state) => ({
      fileTabs: typeof tabs === 'function' ? tabs(state.fileTabs) : tabs,
    })),
  activeTabIndex: -1,
  setActiveTabIndex: (index) => set({ activeTabIndex: index }),
  previewScrollPositions: {},
  setPreviewScrollPositions: (positions) =>
    set((state) => ({
      previewScrollPositions:
        typeof positions === 'function' ? positions(state.previewScrollPositions) : positions,
    })),

  // OCR 题目管理
  ocrItems: [],
  setOcrItems: (items) =>
    set((state) => ({
      ocrItems: typeof items === 'function' ? items(state.ocrItems) : items,
    })),

  // 会话管理
  conversations: [],
  setConversations: (convs) =>
    set((state) => ({
      conversations: typeof convs === 'function' ? convs(state.conversations) : convs,
    })),
  conversationMessages: {},
  setConversationMessages: (msgs) =>
    set((state) => ({
      conversationMessages: typeof msgs === 'function' ? msgs(state.conversationMessages) : msgs,
    })),
  activeConversationKey: null,
  setActiveConversationKey: (key) => set({ activeConversationKey: key }),

  // Agent 文档
  agentDocumentId: null,
  setAgentDocumentId: (id) => set({ agentDocumentId: id }),

  // UI 状态
  isAgentDrawerOpen: false,
  setIsAgentDrawerOpen: (open) => set({ isAgentDrawerOpen: open }),
  agentDrawerWidth: 360,
  setAgentDrawerWidth: (width) => set({ agentDrawerWidth: width }),
  isUserMenuOpen: false,
  setIsUserMenuOpen: (open) => set({ isUserMenuOpen: open }),
  isPreviewCollapsed: false,
  setIsPreviewCollapsed: (collapsed) => set({ isPreviewCollapsed: collapsed }),
  isAnswerMode: false,
  setIsAnswerMode: (mode) => set({ isAnswerMode: mode }),
  workspaceView: 'editor',
  setWorkspaceView: (view) => set({ workspaceView: view }),
  appView: 'editor',
  setAppView: (view) => set({ appView: view }),
  leftWidth: 420,
  setLeftWidth: (width) => set({ leftWidth: width }),
  isResizing: false,
  setIsResizing: (resizing) => set({ isResizing: resizing }),
  isExportDialogOpen: false,
  setIsExportDialogOpen: (open) => set({ isExportDialogOpen: open }),
  viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 1024,
  setViewportWidth: (width) => set({ viewportWidth: width }),
}))
