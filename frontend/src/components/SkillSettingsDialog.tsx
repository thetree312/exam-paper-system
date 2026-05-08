import React, { useEffect, useMemo, useState } from 'react'
import type { AgentSkillItemDto } from '../types'
import { fetchAgentSkills, saveAgentSkills } from '../services/agentApi'
import Icon from './Icon'


interface SkillSettingsDialogProps {
  open: boolean
  onClose: () => void
  backendBaseUrl: string
  workroomId: string | number
  sessionId?: string | null
}

export const SkillSettingsDialog: React.FC<SkillSettingsDialogProps> = ({
  open,
  onClose,
  backendBaseUrl,
  workroomId,
  sessionId,
}) => {
  const [items, setItems] = useState<AgentSkillItemDto[]>([])
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setIsLoading(true)
    setError(null)

    void fetchAgentSkills(backendBaseUrl, { workroomId })
      .then((response) => {
        if (cancelled) return
        const nextItems = [...response.items].sort((a, b) => a.name.localeCompare(b.name))
        setItems(nextItems)
        setDraft(
          Object.fromEntries(nextItems.map((item) => [item.name, item.enabled])),
        )
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '加载技能列表失败')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, open, workroomId])

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return items
    return items.filter((item) =>
      [item.name, item.description, item.location].some((field) => field.toLowerCase().includes(keyword)),
    )
  }, [items, query])

  const enabledCount = useMemo(
    () => items.filter((item) => draft[item.name] !== false).length,
    [draft, items],
  )

  const isDirty = useMemo(
    () => items.some((item) => item.enabled !== (draft[item.name] !== false)),
    [draft, items],
  )

  const handleClose = () => {
    if (isSaving) return
    onClose()
  }

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)
    try {
      const disabledSkillNames = items
        .filter((item) => draft[item.name] === false)
        .map((item) => item.name)

      const response = await saveAgentSkills(backendBaseUrl, {
        workroomId,
        sessionId,
        disabledSkillNames,
      })
      const nextItems = [...response.items].sort((a, b) => a.name.localeCompare(b.name))
      setItems(nextItems)
      setDraft(Object.fromEntries(nextItems.map((item) => [item.name, item.enabled])))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存技能设置失败')
    } finally {
      setIsSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="skill-settings-dialog fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] pointer-events-auto">
      <div className="flex h-[82vh] w-full max-w-5xl flex-col overflow-hidden border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] shadow-none">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--ui-border-default)] px-6 py-5">
          <div>
            <h2 className="text-xl font-semibold text-[var(--ui-text-primary)]">技能控制面板</h2>
            <p className="mt-2 text-sm text-[var(--ui-text-primary)]">
              当前已安装 {items.length} 个 skill，已启用 {enabledCount} 个。关闭后的 skill 不会再进入当前 agent 会话的可用技能集合。
            </p>
            <p className="mt-1 text-xs text-amber-600">
              启用越多，消耗 token 越高。
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full p-2 text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-bg-panel-muted)] hover:text-[var(--ui-text-primary)]"
            aria-label="关闭"
          >
            <Icon name={"close"} className="text-[20px]" />
          </button>
        </div>

        <div className="flex items-center gap-3 border-b border-[var(--ui-border-default)] px-6 py-4">
          <div className="relative flex-1">
            <Icon name={"search"} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-[var(--ui-text-primary)]" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 skill 名称、描述或路径"
              className="w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)] py-2.5 pl-10 pr-4 text-sm text-[var(--ui-text-primary)] outline-none transition focus:border-[var(--ui-border-strong)] focus:bg-[var(--ui-bg-panel)]"
            />
          </div>
          <button
            type="button"
            onClick={() => setDraft(Object.fromEntries(items.map((item) => [item.name, true])))}
            className="rounded-2xl border border-[var(--ui-border-default)] px-4 py-2 text-sm font-medium text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-bg-panel-muted)]"
          >
            全部启用
          </button>
          <button
            type="button"
            onClick={() => setDraft(Object.fromEntries(items.map((item) => [item.name, false])))}
            className="rounded-2xl border border-[var(--ui-border-default)] px-4 py-2 text-sm font-medium text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-bg-panel-muted)]"
          >
            全部停用
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--ui-text-primary)]">正在加载 skill 列表…</div>
          ) : filteredItems.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--ui-text-primary)]">没有匹配的 skill</div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredItems.map((item) => {
                const enabled = draft[item.name] !== false
                return (
                  <div
                    key={item.name}
                    className={`group grid cursor-pointer grid-cols-[1fr_auto] gap-4 rounded-2xl border px-4 py-4 transition ${
                      enabled
                        ? 'border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)]'
                        : 'border-[var(--ui-border-default)] bg-[var(--ui-bg-panel-muted)]/70'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-semibold text-[var(--ui-text-primary)]">{item.name}</div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            enabled ? 'bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)]' : 'bg-[var(--ui-border-default)] text-[var(--ui-text-primary)]'
                          }`}
                        >
                          {enabled ? '已启用' : '已停用'}
                        </span>
                      </div>
                      <div className="mt-1 text-sm leading-6 text-[var(--ui-text-primary)]">{item.description}</div>
                      <div className="mt-2 truncate font-mono text-[11px] text-[var(--ui-text-primary)]">{item.location}</div>
                    </div>
                    <div className="flex items-center">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        onClick={() => setDraft((current) => ({ ...current, [item.name]: !enabled }))}
                        className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
                          enabled ? 'bg-slate-900' : 'bg-[var(--ui-border-strong)]'
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-[var(--ui-bg-panel)] transition ${
                            enabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-[var(--ui-border-default)] px-6 py-4">
          <div className="min-h-[20px] text-sm text-rose-500">{error ?? ''}</div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSaving}
              className="rounded-2xl px-4 py-2 text-sm font-medium text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-bg-panel-muted)] disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isLoading || isSaving || !isDirty}
              className="rounded-2xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? '确认中…' : '确认'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}




