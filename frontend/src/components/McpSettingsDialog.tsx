import React, { useEffect, useMemo, useState } from 'react'
import type { AgentMcpConfigDto, AgentMcpItemDto } from '../types'
import {
  addAgentMcp,
  authenticateAgentMcp,
  connectAgentMcp,
  deleteAgentMcp,
  disconnectAgentMcp,
  fetchAgentMcps,
  removeAgentMcpAuth,
} from '../services/agentApi'
import Icon from './Icon'

interface McpSettingsDialogProps {
  open: boolean
  onClose: () => void
  backendBaseUrl: string
  workroomId: string | number
}

type FormState = {
  name: string
  type: 'local' | 'remote'
  commandText: string
  environmentRows: Array<{ key: string; value: string }>
  url: string
  headersRows: Array<{ key: string; value: string }>
  enabled: boolean
  timeoutText: string
  oauthEnabled: boolean
  oauthClientId: string
  oauthClientSecret: string
  oauthScope: string
  oauthRedirectUri: string
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'remote',
  commandText: '',
  environmentRows: [{ key: '', value: '' }],
  url: '',
  headersRows: [{ key: '', value: '' }],
  enabled: true,
  timeoutText: '',
  oauthEnabled: false,
  oauthClientId: '',
  oauthClientSecret: '',
  oauthScope: '',
  oauthRedirectUri: '',
}

function toKeyValueRows(input?: Record<string, string>) {
  const rows = Object.entries(input ?? {}).map(([key, value]) => ({ key, value }))
  return rows.length > 0 ? rows : [{ key: '', value: '' }]
}

function parseKeyValueRows(rows: Array<{ key: string; value: string }>) {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (!key && !value) continue
    if (!key) {
      throw new Error('键不能为空')
    }
    result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function toFormState(item?: AgentMcpItemDto): FormState {
  if (!item) return EMPTY_FORM
  const config = item.config
  if (config.type === 'local') {
    return {
      name: item.name,
      type: 'local',
      commandText: config.command.join('\n'),
      environmentRows: toKeyValueRows(config.environment),
      url: '',
      headersRows: [{ key: '', value: '' }],
      enabled: config.enabled !== false,
      timeoutText: config.timeout != null ? String(config.timeout) : '',
      oauthEnabled: false,
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
      oauthRedirectUri: '',
    }
  }

  const oauthConfig = config.oauth && typeof config.oauth === 'object' ? config.oauth : null

  return {
    name: item.name,
    type: 'remote',
    commandText: '',
    environmentRows: [{ key: '', value: '' }],
    url: config.url,
    headersRows: toKeyValueRows(config.headers),
    enabled: config.enabled !== false,
    timeoutText: config.timeout != null ? String(config.timeout) : '',
    oauthEnabled: Boolean(oauthConfig),
    oauthClientId: oauthConfig?.clientId ?? '',
    oauthClientSecret: oauthConfig?.clientSecret ?? '',
    oauthScope: oauthConfig?.scope ?? '',
    oauthRedirectUri: oauthConfig?.redirectUri ?? '',
  }
}

function buildConfig(form: FormState): AgentMcpConfigDto {
  const timeout = form.timeoutText.trim() ? Number(form.timeoutText.trim()) : undefined
  if (timeout != null && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error('timeout 必须是正整数')
  }

  if (form.type === 'local') {
    const command = form.commandText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (command.length === 0) {
      throw new Error('本地 MCP 至少需要一条启动命令')
    }
    const environment = parseKeyValueRows(form.environmentRows)
    return {
      type: 'local',
      command,
      environment,
      enabled: form.enabled,
      timeout,
    }
  }

  if (!form.url.trim()) {
    throw new Error('远程 MCP 必须填写地址')
  }
  const headers = parseKeyValueRows(form.headersRows)
  return {
    type: 'remote',
    url: form.url.trim(),
    headers,
    enabled: form.enabled,
    timeout,
    oauth: form.oauthEnabled
      ? {
          clientId: form.oauthClientId.trim() || undefined,
          clientSecret: form.oauthClientSecret.trim() || undefined,
          scope: form.oauthScope.trim() || undefined,
          redirectUri: form.oauthRedirectUri.trim() || undefined,
        }
      : false,
  }
}

function formatStatusLabel(item: AgentMcpItemDto) {
  const status = item.status.status
  if (status === 'connected') return '已启动'
  if (status === 'disabled') return '已关闭'
  if (status === 'unknown') return '未探测'
  if (status === 'needs_auth') return '待登录'
  if (status === 'needs_client_registration') return '待注册'
  return '异常'
}

function statusTone(status: AgentMcpItemDto['status']['status']) {
  switch (status) {
    case 'connected':
      return 'bg-emerald-50 text-emerald-700'
    case 'unknown':
      return 'bg-slate-100 text-slate-600'
    case 'needs_auth':
      return 'bg-amber-50 text-amber-700'
    case 'needs_client_registration':
    case 'failed':
      return 'bg-rose-50 text-rose-700'
    default:
      return 'bg-slate-100 text-slate-600'
  }
}

function itemSummary(item: AgentMcpItemDto) {
  return item.config.type === 'remote' ? item.config.url : item.config.command.join(' ')
}

function KeyValueEditor({
  title,
  rows,
  onChange,
  addLabel,
}: {
  title: string
  rows: Array<{ key: string; value: string }>
  onChange: (rows: Array<{ key: string; value: string }>) => void
  addLabel: string
}) {
  const updateRow = (index: number, field: 'key' | 'value', value: string) => {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)))
  }

  const removeRow = (index: number) => {
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index)
    onChange(nextRows.length > 0 ? nextRows : [{ key: '', value: '' }])
  }

  const addRow = () => {
    onChange([...rows, { key: '', value: '' }])
  }

  return (
    <div className="col-span-2">
      <label className="mb-3 block text-sm font-medium text-slate-700">{title}</label>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={`${title}-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-3">
            <input
              type="text"
              value={row.key}
              onChange={(event) => updateRow(index, 'key', event.target.value)}
              placeholder="键"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
            />
            <input
              type="text"
              value={row.value}
              onChange={(event) => updateRow(index, 'value', event.target.value)}
              placeholder="值"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
            />
            <button
              type="button"
              onClick={() => removeRow(index)}
              className="flex h-[42px] w-[42px] items-center justify-center rounded-xl border border-slate-200 text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
              aria-label={`删除${title}`}
            >
              <Icon name={"delete"} className="text-[18px]" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
        >
          <span className="text-base leading-none">+</span>
          {addLabel}
        </button>
      </div>
    </div>
  )
}

export const McpSettingsDialog: React.FC<McpSettingsDialogProps> = ({
  open,
  onClose,
  backendBaseUrl,
  workroomId,
}) => {
  const [items, setItems] = useState<AgentMcpItemDto[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [runningName, setRunningName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState<'list' | 'form'>('list')

  const loadItems = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetchAgentMcps(backendBaseUrl, { workroomId })
      setItems(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 MCP 列表失败')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setPage('list')
    void loadItems()
  }, [open, backendBaseUrl, workroomId])

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return items
    return items.filter((item) =>
      [item.name, item.config.type, itemSummary(item)].some((value) => value.toLowerCase().includes(keyword)),
    )
  }, [items, query])

  const enabledCount = useMemo(
    () => items.filter((item) => item.status.status === 'connected').length,
    [items],
  )

  const openCreateForm = () => {
    setSelectedName(null)
    setForm(EMPTY_FORM)
    setError(null)
    setPage('form')
  }

  const openEditForm = (item: AgentMcpItemDto) => {
    setSelectedName(item.name)
    setForm(toFormState(item))
    setError(null)
    setPage('form')
  }

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)
    try {
      const config = buildConfig(form)
      const response = await addAgentMcp(backendBaseUrl, {
        workroomId,
        name: form.name.trim(),
        config,
      })
      setItems(response.items)
      const saved = response.items.find((item) => item.name === form.name.trim())
      setSelectedName(saved?.name ?? null)
      setForm(toFormState(saved))
      setPage('list')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 MCP 配置失败')
    } finally {
      setIsSaving(false)
    }
  }

  const handleAction = async (name: string, action: 'connect' | 'disconnect' | 'auth' | 'remove-auth') => {
    setRunningName(name)
    setError(null)
    try {
      const response =
        action === 'connect'
          ? await connectAgentMcp(backendBaseUrl, { workroomId, name })
          : action === 'disconnect'
            ? await disconnectAgentMcp(backendBaseUrl, { workroomId, name })
            : action === 'auth'
              ? await authenticateAgentMcp(backendBaseUrl, { workroomId, name })
              : await removeAgentMcpAuth(backendBaseUrl, { workroomId, name })
      setItems(response.items)
      if (selectedName) {
        const selected = response.items.find((item) => item.name === selectedName)
        if (selected) setForm(toFormState(selected))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MCP 操作失败')
    } finally {
      setRunningName(null)
    }
  }

  const handleDelete = async (name: string) => {
    const confirmed = window.confirm(`确认卸载 MCP “${name}”吗？这会删除配置并断开当前运行实例。`)
    if (!confirmed) return

    setRunningName(name)
    setError(null)
    try {
      const response = await deleteAgentMcp(backendBaseUrl, { workroomId, name })
      setItems(response.items)
      if (selectedName === name) {
        setSelectedName(null)
        setForm(EMPTY_FORM)
        setPage('list')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '卸载 MCP 失败')
    } finally {
      setRunningName(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] pointer-events-auto">
      <div className="flex h-[82vh] w-full max-w-5xl flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">MCP 控制面板</h2>
            {page === 'list' ? (
              <>
                <p className="mt-2 text-sm text-slate-500">
                  当前已配置 {items.length} 个 MCP，已启动 {enabledCount} 个。
                </p>
                <p className="mt-1 text-xs text-amber-600">
                  MCP 加载越多，消耗 token 越高。
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-500">
                {selectedName ? `调整 ${selectedName} 的配置` : '新增一个 MCP'}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="关闭"
          >
            <Icon name={"close"} className="text-[20px]" />
          </button>
        </div>

        {page === 'list' ? (
          <>
            <div className="flex items-center gap-3 border-b border-slate-100 px-6 py-4">
              <div className="relative flex-1">
                <Icon name={"search"} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-slate-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索 MCP 名称"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-4 text-sm text-slate-700 outline-none transition focus:border-slate-400 focus:bg-white"
                />
              </div>
              <button
                type="button"
                onClick={openCreateForm}
                className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-black"
              >
                新增
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {isLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">正在加载 MCP 列表…</div>
              ) : filteredItems.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">还没有可显示的 MCP</div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {filteredItems.map((item) => {
                    const isBusy = runningName === item.name
                    const isRunning = item.status.status === 'connected'
                    return (
                      <div
                        key={item.name}
                        className={`grid grid-cols-[1fr_auto] gap-4 rounded-2xl border px-4 py-4 transition ${
                          isRunning
                            ? 'border-slate-200 bg-white'
                            : 'border-slate-200 bg-slate-50/70'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="truncate text-sm font-semibold text-slate-900">{item.name}</div>
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(item.status.status)}`}>
                              {formatStatusLabel(item)}
                            </span>
                          </div>
                          <div className="mt-2 truncate text-sm text-slate-600">{itemSummary(item)}</div>
                          {(item.status.status === 'failed' || item.status.status === 'needs_client_registration') && item.status.error ? (
                            <div className="mt-2 text-xs text-rose-600">{item.status.error}</div>
                          ) : null}
                        </div>

                        <div className="flex flex-col items-end justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openEditForm(item)}
                              className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                            >
                              配置
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDelete(item.name)}
                              className="rounded-full border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                            >
                              {isBusy ? '处理中…' : '卸载'}
                            </button>
                          </div>
                          <div className="flex flex-wrap justify-end gap-2">
                            {item.supportsOAuth ? (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleAction(item.name, 'auth')}
                                className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                              >
                                {isBusy ? '处理中…' : item.authStatus === 'authenticated' ? '重新登录' : '登录'}
                              </button>
                            ) : null}
                            {item.supportsOAuth && item.authStatus !== 'not_authenticated' ? (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleAction(item.name, 'remove-auth')}
                                className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                              >
                                {isBusy ? '处理中…' : '清除登录'}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              role="switch"
                              aria-checked={isRunning}
                              aria-label={`${item.name}${isRunning ? '已启动，点击关闭' : '已关闭，点击启动'}`}
                              disabled={isBusy}
                              onClick={() => void handleAction(item.name, isRunning ? 'disconnect' : 'connect')}
                              className={`relative inline-flex h-7 w-12 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                isRunning ? 'bg-slate-900' : 'bg-slate-300'
                              }`}
                            >
                              <span
                                className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                                  isRunning ? 'translate-x-6' : 'translate-x-1'
                                }`}
                              />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-slate-100 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  if (isSaving) return
                  setPage('list')
                  setError(null)
                }}
                className="rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
              >
                返回
              </button>
              <div className="text-sm text-slate-500">
                {selectedName ? '配置详情' : '新增配置'}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="mb-1 block text-sm font-medium text-slate-700">名称</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                    disabled={Boolean(selectedName)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400 disabled:bg-slate-50"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">类型</label>
                  <select
                    value={form.type}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        type: event.target.value as 'local' | 'remote',
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                  >
                    <option value="remote">远程</option>
                    <option value="local">本地</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">超时</label>
                  <input
                    type="text"
                    value={form.timeoutText}
                    onChange={(event) => setForm((current) => ({ ...current, timeoutText: event.target.value }))}
                    placeholder="30000"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                  />
                </div>

                <div className="col-span-2 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <input
                    id="mcp-enabled"
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  <label htmlFor="mcp-enabled" className="text-sm text-slate-700">
                    默认启动
                  </label>
                </div>

                {form.type === 'local' ? (
                  <>
                    <div className="col-span-2">
                      <label className="mb-1 block text-sm font-medium text-slate-700">启动命令</label>
                      <textarea
                        value={form.commandText}
                        onChange={(event) => setForm((current) => ({ ...current, commandText: event.target.value }))}
                        placeholder={'每行一个参数，例如：\nuvx\nmcp-server-sqlite\n--db\n./demo.db'}
                        className="min-h-36 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                      />
                    </div>
                    <KeyValueEditor
                      title="环境变量"
                      rows={form.environmentRows}
                      onChange={(environmentRows) => setForm((current) => ({ ...current, environmentRows }))}
                      addLabel="添加环境变量"
                    />
                  </>
                ) : (
                  <>
                    <div className="col-span-2">
                      <label className="mb-1 block text-sm font-medium text-slate-700">服务地址</label>
                      <input
                        type="text"
                        value={form.url}
                        onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
                        placeholder="https://example.com/mcp"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                      />
                    </div>
                    <KeyValueEditor
                      title="请求头"
                      rows={form.headersRows}
                      onChange={(headersRows) => setForm((current) => ({ ...current, headersRows }))}
                      addLabel="添加请求头"
                    />

                    <div className="col-span-2 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <input
                        id="mcp-oauth"
                        type="checkbox"
                        checked={form.oauthEnabled}
                        onChange={(event) => setForm((current) => ({ ...current, oauthEnabled: event.target.checked }))}
                      />
                      <label htmlFor="mcp-oauth" className="text-sm text-slate-700">
                        需要登录
                      </label>
                    </div>

                    {form.oauthEnabled ? (
                      <>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-slate-700">Client ID</label>
                          <input
                            type="text"
                            value={form.oauthClientId}
                            onChange={(event) => setForm((current) => ({ ...current, oauthClientId: event.target.value }))}
                            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-slate-700">Client Secret</label>
                          <input
                            type="text"
                            value={form.oauthClientSecret}
                            onChange={(event) => setForm((current) => ({ ...current, oauthClientSecret: event.target.value }))}
                            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-slate-700">Scope</label>
                          <input
                            type="text"
                            value={form.oauthScope}
                            onChange={(event) => setForm((current) => ({ ...current, oauthScope: event.target.value }))}
                            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-slate-700">Redirect URI</label>
                          <input
                            type="text"
                            value={form.oauthRedirectUri}
                            onChange={(event) => setForm((current) => ({ ...current, oauthRedirectUri: event.target.value }))}
                            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                          />
                        </div>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-slate-100 px-6 py-4">
          <div className="min-h-[20px] text-sm text-rose-500">{error ?? ''}</div>
          <div className="flex items-center gap-3">
            {page === 'form' && selectedName ? (
              <button
                type="button"
                onClick={() => void handleDelete(selectedName)}
                disabled={isSaving || runningName === selectedName}
                className="rounded-2xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-60"
              >
                {runningName === selectedName ? '处理中…' : '卸载'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="rounded-2xl px-4 py-2 text-sm font-medium text-slate-500 transition hover:bg-slate-100 disabled:opacity-60"
            >
              关闭
            </button>
            {page === 'form' ? (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving || !form.name.trim()}
                className="rounded-2xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? '保存中…' : selectedName ? '保存配置' : '添加'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
