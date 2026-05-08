import { create } from 'zustand'
import type {
  AggregatedOcrItem,
  AgentConversationMeta,
  AgentRunMessage,
  UploadedFileTab,
  UserInfo,
  WorkroomInfo,
  WorkroomRuntimeState,
  WorkroomSourceBinding,
  WorkroomArtifact,
} from '../types'
import { readStoredTheme, writeStoredTheme, type UITheme } from '../lib/theme'

interface AppState {
  // 用户认证
  user: UserInfo | null
  setUser: (user: UserInfo | null) => void

  workroom: WorkroomInfo | null
  setWorkroom: (workroom: WorkroomInfo | null) => void
  workroomRuntimeState: WorkroomRuntimeState | null
  setWorkroomRuntimeState: (state: WorkroomRuntimeState | null) => void
  workroomSources: WorkroomSourceBinding[]
  setWorkroomSources: (sources: WorkroomSourceBinding[]) => void
  workroomArtifacts: WorkroomArtifact[]
  setWorkroomArtifacts: (artifacts: WorkroomArtifact[]) => void

  // 文件管理
  fileTabs: UploadedFileTab[]
  setFileTabs: (tabs: UploadedFileTab[] | ((prev: UploadedFileTab[]) => UploadedFileTab[])) => void
  activeTabIndex: number
  setActiveTabIndex: (index: number) => void
  previewScrollPositions: Record<string, number>
  setPreviewScrollPositions: (positions: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)) => void

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

  // 当前题卡工作文档
  studioDocumentId: string | null
  setStudioDocumentId: (id: string | null) => void

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
  studioView: 'editor' | 'mindmap' | 'flashcard'
  setStudioView: (view: 'editor' | 'mindmap' | 'flashcard') => void
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
  workroomTreeRevealRequest: { path: string; id: number } | null
  requestWorkroomTreeReveal: (path: string) => void
  theme: UITheme
  setTheme: (theme: UITheme) => void
}

export const useAppStore = create<AppState>((set) => ({
  // 用户认证
  user: null,
  setUser: (user) => set({ user }),
  workroom: null,
  setWorkroom: (workroom) => set({ workroom }),
  workroomRuntimeState: null,
  setWorkroomRuntimeState: (workroomRuntimeState) => set({ workroomRuntimeState }),
  workroomSources: [],
  setWorkroomSources: (workroomSources) => set({ workroomSources }),
  workroomArtifacts: [],
  setWorkroomArtifacts: (workroomArtifacts) => set({ workroomArtifacts }),

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

  // 当前题卡工作文档
  studioDocumentId: null,
  setStudioDocumentId: (id) => set({ studioDocumentId: id }),

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
  studioView: 'editor',
  setStudioView: (view) => set({ studioView: view }),
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
  workroomTreeRevealRequest: null,
  requestWorkroomTreeReveal: (path) =>
    set({
      workroomTreeRevealRequest: {
        path,
        id: Date.now(),
      },
    }),
  theme: readStoredTheme(),
  setTheme: (theme) => {
    writeStoredTheme(theme)
    set({ theme })
  },
}))
