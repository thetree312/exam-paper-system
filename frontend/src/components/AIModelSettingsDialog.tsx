import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'
import LobeIcon from './LobeIcon'
import { LanguageSelector } from './LanguageSelector'
import { resolveModelIconKey, resolveProviderIconKey } from '../lib/modelBranding'
import { fetchModelSettings, fetchModelSettingsCatalog, saveModelSettings, syncProviderModels, testProviderConnection } from '../services/modelSettingsApi'
import openSourceLicenses from '../data/open-source-licenses.json'
import type { AiModelOperationType, ModelCatalogDto, ProviderAccountDto, ProviderModelCatalogDto, UserInfo, UserModelSettingsDto } from '../types'

type MenuKey =
  | 'settings_center'
  | 'provider_accounts'
  | 'custom_model'
  | 'experimental'
  | 'appearance'
  | 'language'
  | 'security'
  | 'open_source'

interface AIModelSettingsDialogProps {
  open: boolean
  onClose: () => void
  backendBaseUrl: string
  user: UserInfo
  onLogout: () => void
  onSaved?: (settings: UserModelSettingsDto) => void
  studioAutoSaveMode?: 'off' | 'afterDelay'
  onStudioAutoSaveModeChange?: (mode: 'off' | 'afterDelay') => void
}

type DraftState = {
  providerAccounts: Array<ProviderAccountDto & { localId: string; apiKey: string }>
  providerModelCatalogs: ProviderModelCatalogDto[]
  defaultModel: UserModelSettingsDto['defaultModel']
  capabilityBindings: UserModelSettingsDto['capabilityBindings']
  experimentalFeatures: UserModelSettingsDto['experimentalFeatures']
  bindingSchemaVersion?: number
}

function toLocalId() {
  return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function toDraft(settings: UserModelSettingsDto): DraftState {
  return {
    providerAccounts: settings.providerAccounts.map((item) => ({
      ...item,
      localId: toLocalId(),
      apiKey: '',
    })),
    providerModelCatalogs: settings.providerModelCatalogs ?? [],
    defaultModel: settings.defaultModel ?? null,
    capabilityBindings: settings.capabilityBindings ?? [],
    experimentalFeatures: settings.experimentalFeatures,
    bindingSchemaVersion: settings.bindingSchemaVersion,
  }
}

function fmtRelative(ts?: string, t?: (key: string, opts?: Record<string, unknown>) => string) {
  if (!ts) return '—'
  const d = new Date(ts).getTime()
  if (!Number.isFinite(d)) return '—'
  const sec = Math.max(1, Math.floor((Date.now() - d) / 1000))
  if (!t) {
    if (sec < 60) return `${sec}s ago`
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
    return `${Math.floor(sec / 86400)}d ago`
  }
  if (sec < 60) return t('settings_modal.time_ago.seconds', { value: sec })
  if (sec < 3600) return t('settings_modal.time_ago.minutes', { value: Math.floor(sec / 60) })
  if (sec < 86400) return t('settings_modal.time_ago.hours', { value: Math.floor(sec / 3600) })
  return t('settings_modal.time_ago.days', { value: Math.floor(sec / 86400) })
}

type IconSelectOption = {
  value: string
  label: string
  iconKey?: string
  fallbackIconName?: string
}

interface IconSelectProps {
  value: string
  options: IconSelectOption[]
  placeholder: string
  onChange: (nextValue: string) => void
  className?: string
}

const IconSelect: React.FC<IconSelectProps> = ({ value, options, placeholder, onChange, className }) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  return (
    <div ref={rootRef} className={['relative', className ?? ''].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-left text-[12px] text-slate-700"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[13px] text-slate-500">
          {selected ? <LobeIcon iconKey={selected.iconKey} fallbackIconName={selected.fallbackIconName || 'help'} /> : <Icon name="help" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{selected?.label || placeholder}</span>
        <Icon name={open ? 'expand_less' : 'expand_more'} className="text-[14px] text-slate-400" />
      </button>
      {open ? (
        <div className="scrollbar-hidden absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-56 overflow-y-auto rounded border border-slate-200 bg-white shadow-lg">
          {options.map((option) => {
            const active = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] ${active ? 'bg-[#EEF4FF] text-[#2D6CFF]' : 'text-slate-700 hover:bg-slate-50'}`}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[13px]">
                  <LobeIcon iconKey={option.iconKey} fallbackIconName={option.fallbackIconName || 'help'} />
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

const AIModelSettingsDialogInner: React.FC<AIModelSettingsDialogProps> = ({
  open,
  onClose,
  backendBaseUrl,
  user,
  onLogout,
  onSaved,
  studioAutoSaveMode = 'off',
  onStudioAutoSaveModeChange,
}) => {
  const { t } = useTranslation('common')
  const [menu, setMenu] = useState<MenuKey>('provider_accounts')
  const [catalog, setCatalog] = useState<ModelCatalogDto | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedLocalId, setExpandedLocalId] = useState<string | null>(null)
  const [pendingByAccount, setPendingByAccount] = useState<Record<string, 'test' | 'sync' | undefined>>({})
  const [showApiKey, setShowApiKey] = useState(false)
  const [accountFeedback, setAccountFeedback] = useState<Record<string, { type: 'success' | 'error'; text: string } | undefined>>({})
  const [showModelListByProvider, setShowModelListByProvider] = useState<Record<string, boolean>>({})
  const [agentAutoFallback, setAgentAutoFallback] = useState(true)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setIsLoading(true)
    setError(null)
    setMessage(null)
    void Promise.all([fetchModelSettings(backendBaseUrl), fetchModelSettingsCatalog(backendBaseUrl)])
      .then(([settings, nextCatalog]) => {
        if (cancelled) return
        const nextDraft = toDraft(settings)
        setCatalog(nextCatalog)
        setDraft(nextDraft)
        setExpandedLocalId(null)
        setIsDirty(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'load_failed')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backendBaseUrl, open])

  const providerMetaById = useMemo(() => {
    return new Map((catalog?.providers ?? []).map((x) => [x.providerID, x]))
  }, [catalog])

  const selected = useMemo(
    () => draft?.providerAccounts.find((x) => x.localId === expandedLocalId) ?? null,
    [draft?.providerAccounts, expandedLocalId],
  )

  const selectedProviderModels = useMemo(() => {
    if (!selected) return []
    const official = catalog?.providers.find((x) => x.providerID === selected.providerID)?.models ?? []
    if (official.length > 0) {
      return official.map((m) => ({ modelID: m.modelID, label: m.label }))
    }
    return draft?.providerModelCatalogs.find((x) => x.providerID === selected.providerID)?.models ?? []
  }, [catalog?.providers, draft?.providerModelCatalogs, selected])

  const selectedProviderListVisible = useMemo(() => {
    if (!selected) return false
    return Boolean(showModelListByProvider[selected.providerID])
  }, [selected, showModelListByProvider])

  const markDirty = useCallback((next: DraftState | null) => {
    setDraft(next)
    setIsDirty(true)
  }, [])

  const updateAccount = useCallback((localId: string, patch: Partial<DraftState['providerAccounts'][number]>) => {
    if (!draft) return
    markDirty({
      ...draft,
      providerAccounts: draft.providerAccounts.map((x) => (x.localId === localId ? { ...x, ...patch } : x)),
    })
  }, [draft, markDirty])

  const addAccount = useCallback(() => {
    if (!draft) return
    const providerID = catalog?.providers?.[0]?.providerID ?? 'deepseek'
    const now = new Date().toISOString()
    const localId = toLocalId()
    markDirty({
      ...draft,
      providerAccounts: [
        ...draft.providerAccounts,
        {
          localId,
          accountID: '',
          providerID,
          label: providerID,
          apiKey: '',
          hasApiKey: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    setExpandedLocalId(localId)
  }, [catalog?.providers, draft, markDirty])

  const removeAccount = useCallback((localId: string) => {
    if (!draft) return
    const account = draft.providerAccounts.find((x) => x.localId === localId)
    if (!account) return
    markDirty({
      ...draft,
      providerAccounts: draft.providerAccounts.filter((x) => x.localId !== localId),
      providerModelCatalogs: draft.providerModelCatalogs.filter((x) => x.providerID !== account.providerID),
      capabilityBindings: draft.capabilityBindings.map((x) => (x.accountID === account.accountID ? { ...x, accountID: '', modelID: '' } : x)),
      defaultModel: draft.defaultModel?.accountID === account.accountID ? null : draft.defaultModel,
    })
    if (expandedLocalId === localId) {
      const next = draft.providerAccounts.find((x) => x.localId !== localId)
      setExpandedLocalId(next?.localId ?? null)
    }
  }, [draft, expandedLocalId, markDirty])

  const handleClose = useCallback(() => {
    if (isDirty && !window.confirm(t('settings_modal.unsaved_confirm'))) return
    onClose()
  }, [isDirty, onClose, t])

  const handleSave = useCallback(async () => {
    if (!draft) return
    setIsSaving(true)
    setError(null)
    setMessage(null)
    try {
      const payload = {
        providerAccounts: draft.providerAccounts.map((account) => ({
          accountID: account.accountID || undefined,
          providerID: account.providerID,
          label: account.label,
          apiKey: account.apiKey.trim(),
          baseURL: account.baseURL?.trim() || undefined,
          lastSyncAt: account.lastSyncAt,
          lastTestAt: account.lastTestAt,
          lastTestStatus: account.lastTestStatus,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        })),
        providerModelCatalogs: draft.providerModelCatalogs,
        defaultModel: draft.defaultModel,
        capabilityBindings: draft.capabilityBindings.map((binding) => ({
          ...binding,
          bindingID: binding.bindingID && binding.bindingID.trim().length > 0 ? binding.bindingID : undefined,
        })),
        experimentalFeatures: draft.experimentalFeatures,
        bindingSchemaVersion: draft.bindingSchemaVersion,
      }
      const saved = await saveModelSettings(backendBaseUrl, payload)
      const nextDraft = toDraft(saved)
      setDraft(nextDraft)
      setExpandedLocalId(null)
      setIsDirty(false)
      setMessage(t('settings_modal.save_success'))
      onSaved?.(saved)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed')
    } finally {
      setIsSaving(false)
    }
  }, [backendBaseUrl, draft, onSaved, t])

  const runTest = useCallback(async (account: DraftState['providerAccounts'][number]) => {
    if (!account.accountID) {
      setError(t('settings_modal.provider.error_save_before_test'))
      return
    }
    setPendingByAccount((prev) => ({ ...prev, [account.localId]: 'test' }))
    setError(null)
    setMessage(null)
    setAccountFeedback((prev) => ({ ...prev, [account.localId]: undefined }))
    try {
      const result = await testProviderConnection(backendBaseUrl, account.accountID)
      setDraft((current) =>
        current
          ? {
              ...current,
              providerAccounts: current.providerAccounts.map((x) =>
                x.localId === account.localId
                  ? {
                      ...x,
                      lastTestAt: new Date().toISOString(),
                      lastTestStatus: result.success ? 'success' : 'failed',
                    }
                  : x,
              ),
            }
          : current,
      )
      const feedbackText = result.success ? t('settings_modal.provider_runtime.connection_success', { latency: result.latencyMs }) : t('settings_modal.provider_runtime.connection_failed', { error: result.error ?? 'unknown' })
      setAccountFeedback((prev) => ({
        ...prev,
        [account.localId]: { type: result.success ? 'success' : 'error', text: feedbackText },
      }))
      setMessage(feedbackText)
    } catch (e) {
      const text = e instanceof Error ? e.message : t('settings_modal.provider.error_test_failed')
      setAccountFeedback((prev) => ({ ...prev, [account.localId]: { type: 'error', text } }))
      setError(text)
    } finally {
      setPendingByAccount((prev) => ({ ...prev, [account.localId]: undefined }))
    }
  }, [backendBaseUrl])

  const runSync = useCallback(async (account: DraftState['providerAccounts'][number]) => {
    if (!account.accountID) {
      setError(t('settings_modal.provider.error_save_before_sync'))
      return
    }
    setPendingByAccount((prev) => ({ ...prev, [account.localId]: 'sync' }))
    setError(null)
    setMessage(null)
    try {
      const result = await syncProviderModels(backendBaseUrl, account.accountID)
      if (!draft) return
      const nextCatalogs = draft.providerModelCatalogs.filter((x) => x.providerID !== account.providerID)
      nextCatalogs.push({
        providerID: account.providerID,
        models: result.models,
      })
      setDraft({
        ...draft,
        providerModelCatalogs: nextCatalogs,
        providerAccounts: draft.providerAccounts.map((x) =>
          x.localId === account.localId
            ? { ...x, lastSyncAt: result.lastSyncAt ?? new Date().toISOString() }
            : x,
        ),
      })
      setCatalog((current) =>
        current
          ? {
              ...current,
              providers: current.providers.map((provider) =>
                provider.providerID === account.providerID
                  ? {
                      ...provider,
                      models: result.models.map((m) => ({
                        modelID: m.modelID,
                        label: m.label || m.modelID,
                        operationType: 'chat_completion',
                      })),
                    }
                  : provider,
              ),
            }
          : current,
      )
      setMessage(t('settings_modal.provider_runtime.sync_success', { count: result.syncedCount }))
      setShowModelListByProvider((prev) => ({ ...prev, [account.providerID]: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings_modal.provider.error_sync_failed'))
    } finally {
      setPendingByAccount((prev) => ({ ...prev, [account.localId]: undefined }))
    }
  }, [backendBaseUrl, draft])

  const accountById = useMemo(() => new Map((draft?.providerAccounts ?? []).map((a) => [a.accountID, a])), [draft?.providerAccounts])
  const providerModelsById = useMemo(() => {
    const map = new Map<string, Array<{ modelID: string; label?: string }>>()
    for (const p of catalog?.providers ?? []) {
      map.set(
        p.providerID,
        (p.models ?? []).map((m) => ({ modelID: m.modelID, label: m.label })),
      )
    }
    for (const c of draft?.providerModelCatalogs ?? []) {
      if (!map.has(c.providerID) || (map.get(c.providerID)?.length ?? 0) === 0) {
        map.set(c.providerID, c.models)
      }
    }
    return map
  }, [catalog?.providers, draft?.providerModelCatalogs])

  const updateBinding = useCallback((index: number, patch: Partial<UserModelSettingsDto['capabilityBindings'][number]>) => {
    if (!draft) return
    const next = [...draft.capabilityBindings]
    if (!next[index]) return
    next[index] = { ...next[index], ...patch }
    markDirty({ ...draft, capabilityBindings: next })
  }, [draft, markDirty])

  const renderSwitch = useCallback((enabled: boolean, onToggle: () => void) => (
    <button type="button" onClick={onToggle} className={`relative inline-flex h-5 w-9 shrink-0 overflow-hidden rounded-full ${enabled ? 'bg-[#2D6CFF]' : 'bg-slate-300'}`}>
      <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  ), [])

  const renderConnectionIconAction = useCallback((account?: DraftState['providerAccounts'][number]) => {
    const feedback = account?.localId ? accountFeedback[account.localId] : undefined
    const status: 'success' | 'error' | null =
      feedback?.type === 'success'
        ? 'success'
        : feedback?.type === 'error'
        ? 'error'
        : account?.lastTestStatus === 'success'
        ? 'success'
        : account?.lastTestStatus === 'failed'
        ? 'error'
        : null
    const pending = account?.localId ? pendingByAccount[account.localId] === 'test' : false
    const disabled = !account || pending
    const iconName = status === 'success' ? 'network_wifi_3_bar' : 'network_wifi_3_bar_off'
    const iconTone = status === 'success' ? 'text-emerald-600' : status === 'error' ? 'text-rose-600' : 'text-slate-300'
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!account) return
          void runTest(account)
        }}
        className={`inline-flex items-center rounded p-1 ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-slate-100'}`}
        title={pending ? t('settings_modal.provider_runtime.testing_connection') : account ? t('settings_modal.provider_runtime.test_connection') : t('settings_modal.empty_provider_pool')}
      >
        <Icon name={iconName} className={`text-[14px] ${iconTone}`} />
      </button>
    )
  }, [accountFeedback, pendingByAccount, runTest, t])

  const nav = [
    { group: t('settings_modal.menu_group.settings'), items: [{ key: 'settings_center' as const, label: t('settings_modal.menu.settings_center'), icon: 'home' }] },
    { group: t('settings_modal.menu_group.model_service'), items: [{ key: 'provider_accounts' as const, label: t('settings_modal.menu.api_key'), icon: 'key' }, { key: 'custom_model' as const, label: t('settings_modal.menu.custom_model'), icon: 'grid_view' }] },
    { group: t('settings_modal.menu_group.preference'), items: [{ key: 'appearance' as const, label: t('settings_modal.menu.appearance'), icon: 'desktop_windows' }, { key: 'language' as const, label: t('settings_modal.menu.language'), icon: 'translate' }, { key: 'experimental' as const, label: t('settings_modal.menu.experimental_features'), icon: 'science' }] },
    { group: t('settings_modal.menu_group.security_privacy'), items: [{ key: 'security' as const, label: t('settings_modal.menu.security'), icon: 'shield' }] },
    { group: t('settings_modal.menu_group.developer'), items: [{ key: 'open_source' as const, label: t('settings_modal.menu.open_source_license'), icon: 'policy' }] },
  ]

  const openSourceComponents = useMemo(() => {
    const base = (openSourceLicenses as Array<{ name: string; packageName: string; license: string }>)
      .filter((item) => item.packageName !== '@types/node' && item.packageName !== '@types/pg')
    const extra: Array<{ name: string; packageName: string; license: string }> = [
      { name: 'OpenCode Runtime (@llm-wiki/agent)', packageName: '@llm-wiki/agent', license: 'MIT' },
      { name: 'models.dev (local workspace)', packageName: 'models.dev', license: 'UNKNOWN' },
    ]
    const map = new Map<string, { name: string; packageName: string; license: string }>()
    for (const item of [...base, ...extra]) map.set(item.packageName, item)
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [])

  const renderCredentials = () => (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-[22px] font-semibold tracking-tight text-slate-900">{t('settings_modal.sections.provider_accounts')}</h3>
          <p className="mt-1 text-[12px] text-slate-500">{t('settings_modal.sections.provider_accounts_desc')}</p>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
          <div className="text-[12px] font-medium text-slate-700">{t('settings_modal.provider.connected_platforms')}</div>
          <button
            type="button"
            onClick={addAccount}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-[#2D6CFF]"
            title={t('settings_modal.actions.add_account')}
          >
            <Icon name="add" className="text-[14px]" />
          </button>
        </div>
        <div className="divide-y divide-slate-200">
          {(draft?.providerAccounts ?? []).map((account) => {
            const selectedRow = account.localId === expandedLocalId
            const statusDone = Boolean(account.hasApiKey || account.apiKey.trim())
            const providerMeta = providerMetaById.get(account.providerID)
            const iconKey = resolveProviderIconKey(account.providerID, providerMeta?.iconKey)
            const pending = pendingByAccount[account.localId]
            return (
              <div key={account.localId} className="px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    onClick={() => setExpandedLocalId((prev) => (prev === account.localId ? null : account.localId))}
                  >
                    <div className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white">
                      <LobeIcon iconKey={iconKey} fallbackIconName="language" className="text-[12px]" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-slate-800">{account.label || account.providerID}</div>
                    </div>
                    <span className={`ml-2 rounded-md px-1.5 py-0.5 text-[10px] ${statusDone ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                      {statusDone ? t('settings_modal.connected') : t('settings_modal.disconnected')}
                    </span>
                  </button>
                  {renderConnectionIconAction(account)}
                  <span className="rounded p-1 text-slate-400">
                    <Icon name={selectedRow ? 'expand_less' : 'expand_more'} className="text-[16px]" />
                  </span>
                  <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={() => removeAccount(account.localId)}>
                    <Icon name="delete" className="text-[16px]" />
                  </button>
                </div>
                {selectedRow && selected ? (
                  <div className="mt-2.5 rounded-2xl border border-slate-200 bg-[#F7F9FC] p-3">
                    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-[11px] text-slate-600">{t('settings_modal.fields.provider')}</span>
                        <IconSelect
                          value={selected.providerID}
                          placeholder={t('settings_modal.unconfigured')}
                          options={(catalog?.providers ?? []).map((provider) => ({
                            value: provider.providerID,
                            label: provider.label,
                            iconKey: resolveProviderIconKey(provider.providerID, provider.iconKey),
                            fallbackIconName: 'language',
                          }))}
                          onChange={(nextProviderID) => {
                            const nextProviderMeta = providerMetaById.get(nextProviderID)
                            updateAccount(selected.localId, {
                              providerID: nextProviderID,
                              label: nextProviderMeta?.label || nextProviderID,
                              baseURL: selected.baseURL || nextProviderMeta?.defaultBaseURL,
                            })
                          }}
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-[11px] text-slate-600">Base URL</span>
                        <input className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-[#2D6CFF]" value={selected.baseURL ?? ''} onChange={(e) => updateAccount(selected.localId, { baseURL: e.target.value })} />
                      </label>
                      <label className="space-y-1 md:col-span-2">
                        <span className="text-[11px] text-slate-600">API Key</span>
                        <div className="flex gap-2">
                          <input type={showApiKey ? 'text' : 'password'} className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-[#2D6CFF]" value={selected.apiKey} onChange={(e) => updateAccount(selected.localId, { apiKey: e.target.value })} placeholder={selected.hasApiKey ? `${t('settings_modal.placeholders.keep_existing_key')} ${selected.apiKeyMasked ?? ''}` : t('settings_modal.placeholders.api_key')} />
                          <button type="button" className="rounded-md border border-slate-300 px-2.5 text-[11px] text-slate-600" onClick={() => setShowApiKey((s) => !s)}>{showApiKey ? t('settings_modal.actions.hide_api_key') : t('settings_modal.actions.show_api_key')}</button>
                        </div>
                      </label>
                    </div>
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                        <Icon name="verified_user" className="text-[14px] text-[#2D6CFF]" />
                        <span>{t('settings_modal.provider.security_local_only')}</span>
                        <span>{t('settings_modal.provider.last_sync')}: {fmtRelative(selected.lastSyncAt, t)}</span>
                        <span
                          className={
                            accountFeedback[selected.localId]?.type === 'success'
                              ? 'text-emerald-600'
                              : accountFeedback[selected.localId]?.type === 'error'
                              ? 'text-rose-600'
                              : 'text-slate-500'
                          }
                        >
                          {accountFeedback[selected.localId]?.text ?? (selected.lastTestAt ? `${t('settings_modal.provider.last_test')}: ${fmtRelative(selected.lastTestAt, t)}` : `${t('settings_modal.provider.last_test')}: —`)}
                        </span>
                      </div>
                      <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50"
                        onClick={() =>
                          setShowModelListByProvider((prev) => ({
                            ...prev,
                            [selected.providerID]: !prev[selected.providerID],
                          }))
                        }
                      >
                        {selectedProviderListVisible ? t('settings_modal.provider.hide_model_catalog') : t('settings_modal.provider.show_model_catalog')}
                      </button>
                      <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 text-[12px] text-slate-700 disabled:text-slate-300" disabled={pending === 'test'} onClick={() => runTest(selected)}>
                        {pending === 'test' ? t('settings_modal.provider_runtime.testing_connection') : t('settings_modal.provider_runtime.test_connection')}
                      </button>
                      <button type="button" className="rounded-md border border-[#2D6CFF] px-3 py-1.5 text-[12px] text-[#2D6CFF] disabled:text-slate-300" disabled={pending === 'sync'} onClick={() => runSync(selected)}>
                        {pending === 'sync' ? t('settings_modal.provider_runtime.syncing_models') : t('settings_modal.provider_runtime.sync_models')}
                      </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
      {selected ? (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-2.5 flex items-center justify-between">
            <div className="text-[13px] font-medium text-slate-800">{t('settings_modal.provider.model_catalog')}</div>
            <span className="text-[10px] text-slate-400"> </span>
          </div>
          <div className="mb-2.5 grid grid-cols-5 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-2 text-[11px] text-slate-600">
            <div className="truncate">{t('settings_modal.provider.catalog_source')}　{selected.lastSyncAt ? t('settings_modal.provider.catalog_source_synced') : t('settings_modal.provider.catalog_source_official')}</div>
            <div className="truncate">{t('settings_modal.provider.visible_models')}　{selectedProviderModels.length} {t('settings_modal.provider.items_suffix')}</div>
            <div className="truncate">
              {t('settings_modal.provider.adapter_mode')}　
              {providerMetaById.get(selected.providerID)?.adapterKind === 'official' ? t('settings_modal.provider.adapter_official') : 'OpenAI-compatible'}
            </div>
            <div className="truncate">
              {t('settings_modal.fields.status')}　
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600">
                {selectedProviderModels.length > 0 ? t('settings_modal.provider.synced') : t('settings_modal.provider.not_synced')}
              </span>
            </div>
            <div className="truncate text-right text-[10px] text-slate-400">
              {selected.lastSyncAt ? fmtRelative(selected.lastSyncAt, t) : '—'}
            </div>
          </div>
          {selectedProviderListVisible ? (
            <div className="max-h-32 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2">
              {selectedProviderModels.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-slate-400">{t('settings_modal.provider.empty_model_catalog')}</div>
              ) : (
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                  {selectedProviderModels.map((m) => (
                    <div key={m.modelID} className="truncate rounded bg-white px-2 py-1 text-[11px] text-slate-700">{m.label || m.modelID}</div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="rounded-xl border border-slate-200 bg-white p-3 text-[12px] text-slate-600">
        <div className="font-medium text-[12px] text-slate-800">{t('settings_modal.provider.security_notes_title')}</div>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>{t('settings_modal.provider.security_note_1')}</li>
          <li>{t('settings_modal.provider.security_note_2')}</li>
          <li>{t('settings_modal.provider.security_note_3')}</li>
        </ul>
      </div>
    </div>
  )

  const renderCustomModel = () => {
    const bindings = draft?.capabilityBindings ?? []
    const providerAccounts = draft?.providerAccounts ?? []
    const capabilityGroups = catalog?.capabilityGroups ?? []
    const groupTitle: Record<string, string> = {
      question: t('settings_modal.capability_group.question'),
      learning: t('settings_modal.capability_group.learning'),
      translation: t('settings_modal.capability_group.translation'),
      ocr: t('settings_modal.capability_group.ocr'),
    }
    const capabilityTitle: Partial<Record<UserModelSettingsDto['capabilityBindings'][number]['capability'], string>> = {
      question_split: t('settings_modal.capability_label.question_split'),
      question_grading: t('settings_modal.capability_label.question_grading'),
      flashcard_generation: t('settings_modal.capability_label.flashcard_generation'),
      flashcard_long_outline: t('settings_modal.capability_label.flashcard_long_outline'),
      mindmap_outline_generation: t('settings_modal.capability_label.mindmap_outline_generation'),
      mindmap_generation: t('settings_modal.capability_label.mindmap_generation'),
      translation_math: t('settings_modal.capability_label.translation_math'),
      translation_word: t('settings_modal.capability_label.translation_word'),
      translation_sentence: t('settings_modal.capability_label.translation_sentence'),
      studio_selection_ocr: t('settings_modal.capability_label.studio_selection_ocr'),
      document_layout_ocr: t('settings_modal.capability_label.document_layout_ocr'),
    }
    const renderProviderSelect = (
      value: string,
      onChange: (value: string) => void,
      className = '',
    ) => {
      return (
        <IconSelect
          value={value}
          placeholder={t('settings_modal.unconfigured')}
          className={className}
          options={[
            { value: '', label: t('settings_modal.unconfigured'), fallbackIconName: 'language' },
            ...providerAccounts.map((a) => ({
              value: a.accountID,
              label: a.label || a.providerID,
              iconKey: resolveProviderIconKey(a.providerID, providerMetaById.get(a.providerID)?.iconKey),
              fallbackIconName: 'language',
            })),
          ]}
          onChange={onChange}
        />
      )
    }

    const renderModelSelect = (
      value: string,
      onChange: (value: string) => void,
      modelOptions: Array<{ modelID: string; label?: string }>,
      providerID?: string,
      className = '',
    ) => {
      const providerIconKey = resolveProviderIconKey(providerID, providerMetaById.get(providerID || '')?.iconKey)
      return (
        <IconSelect
          value={value}
          placeholder={t('settings_modal.unconfigured')}
          className={className}
          options={[
            { value: '', label: t('settings_modal.unconfigured'), iconKey: providerIconKey, fallbackIconName: 'stars' },
            ...modelOptions.map((m) => ({
              value: m.modelID,
              label: m.label || m.modelID,
              iconKey: resolveModelIconKey(m.modelID) || providerIconKey,
              fallbackIconName: 'stars',
            })),
          ]}
          onChange={onChange}
        />
      )
    }

    const renderConnectionAction = (accountOrId?: DraftState['providerAccounts'][number] | string) => {
      const account =
        typeof accountOrId === 'string'
          ? providerAccounts.find((a) => a.accountID === accountOrId)
          : accountOrId
      return renderConnectionIconAction(account)
    }

    const upsertBinding = (capability: string, patch: Partial<UserModelSettingsDto['capabilityBindings'][number]>) => {
      if (!draft) return
      const idx = draft.capabilityBindings.findIndex((b) => b.capability === capability)
      if (idx >= 0) {
        updateBinding(idx, patch)
        return
      }
      const now = new Date().toISOString()
      const next = [
        ...draft.capabilityBindings,
        {
          bindingID: '',
          capability: capability as UserModelSettingsDto['capabilityBindings'][number]['capability'],
          enabled: true,
          accountID: '',
          modelID: '',
          operationType: 'chat_completion' as AiModelOperationType,
          createdAt: now,
          updatedAt: now,
          ...patch,
        },
      ]
      markDirty({ ...draft, capabilityBindings: next })
    }

    const agentRows = bindings
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => b.capability === 'agent_chat')

    const mathInputEnabled = Boolean(draft?.experimentalFeatures.mathInput.enabled)

    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-[20px] font-semibold text-slate-900">{t('settings_modal.menu.custom_model')}</h3>
          <p className="mt-1 text-[12px] text-slate-500">{t('settings_modal.custom_model.desc')}</p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-[#CFE0FF] bg-[#F4F8FF] px-3 py-2 text-[11px] text-slate-600">
          <Icon name="info" className="text-[13px] text-[#2D6CFF]" />
          <span>{t('settings_modal.custom_model.catalog_hint')}</span>
        </div>

        {capabilityGroups
          .filter((g) => ['question', 'learning', 'translation', 'ocr'].includes(g.key))
          .map((group) => (
            <div key={group.key} className="rounded-lg border border-[#E6EAF0] bg-white">
              <div className="px-3 py-2 text-[13px] font-semibold text-slate-800">{groupTitle[group.key] ?? group.label}</div>
              <table className="w-full table-fixed border-t border-[#E9EDF3] text-[12px]">
                <thead className="bg-[#F8FAFD] text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-[11px] font-medium">{t('settings_modal.custom_model.col_capability')}</th>
                    <th className="px-3 py-1.5 text-left text-[11px] font-medium">{t('settings_modal.custom_model.col_account')}</th>
                    <th className="px-3 py-1.5 text-left text-[11px] font-medium">{t('settings_modal.custom_model.col_model')}</th>
                    <th className="px-3 py-1.5 text-left text-[11px] font-medium">{t('settings_modal.fields.status')}</th>
                    <th className="px-3 py-1.5 text-right text-[11px] font-medium">{t('settings_modal.custom_model.col_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.capabilities
                    .filter((cap) => (mathInputEnabled ? true : cap.capability !== 'translation_math'))
                    .map((cap) => {
                    const binding = bindings.find((b) => b.capability === cap.capability)
                    const account = binding ? accountById.get(binding.accountID) : undefined
                    const modelOptions = providerModelsById.get(account?.providerID ?? '') ?? []
                    return (
                      <tr key={cap.capability} className="border-t border-[#EEF2F7]">
                        <td className="px-3 py-1.5 text-[12px] text-slate-700">
                          {capabilityTitle[cap.capability as UserModelSettingsDto['capabilityBindings'][number]['capability']] ?? cap.label}
                        </td>
                        <td className="px-3 py-1.5">
                          {renderProviderSelect(
                            binding?.accountID ?? '',
                            (nextValue) => upsertBinding(cap.capability, { accountID: nextValue, modelID: '' }),
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          {renderModelSelect(
                            binding?.modelID ?? '',
                            (nextValue) => upsertBinding(cap.capability, { modelID: nextValue }),
                            modelOptions,
                            account?.providerID,
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-2">
                            {renderSwitch(Boolean(binding?.enabled), () => upsertBinding(cap.capability, { enabled: !binding?.enabled }))}
                            <span className="text-[11px] text-slate-600">{binding?.enabled ? t('settings_modal.enabled') : t('settings_modal.disabled')}</span>
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {renderConnectionAction(binding?.accountID)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}

        <div className="rounded-lg border border-[#E6EAF0] bg-white">
          <div className="flex items-center gap-2 border-b border-[#E9EDF3] px-3 py-2">
            <div className="text-[13px] font-semibold text-slate-800">{t('settings_modal.custom_model.agent_config_title')}</div>
            <div className="text-[11px] text-slate-500">{t('settings_modal.custom_model.agent_config_desc')}</div>
          </div>
          <table className="w-full table-fixed text-[12px]">
            <thead className="bg-[#F8FAFD] text-slate-500">
              <tr>
                <th className="w-10 px-2 py-1.5 text-left text-[11px] font-medium"> </th>
                <th className="w-12 px-2 py-1.5 text-left text-[11px] font-medium">{t('settings_modal.custom_model.col_priority')}</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-medium">{t('settings_modal.fields.provider')}</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-medium">{t('settings_modal.custom_model.col_model')}</th>
                <th className="w-24 px-2 py-1.5 text-left text-[11px] font-medium">{t('settings_modal.fields.status')}</th>
                <th className="w-12 px-2 py-1.5 text-right text-[11px] font-medium">{t('settings_modal.custom_model.col_action')}</th>
              </tr>
            </thead>
            <tbody>
              {agentRows.map(({ b, idx }, i) => {
                const account = accountById.get(b.accountID)
                const modelOptions = providerModelsById.get(account?.providerID ?? '') ?? []
                return (
                  <tr key={b.bindingID || `agent-${idx}`} className="border-t border-[#EEF2F7]">
                    <td className="px-2 py-1.5 text-slate-400"><Icon name="drag_indicator" className="text-[13px]" /></td>
                    <td className="px-2 py-1.5 text-slate-700">{i + 1}</td>
                    <td className="px-2 py-1.5">
                      {renderProviderSelect(
                        b.accountID,
                        (nextValue) => updateBinding(idx, { accountID: nextValue, modelID: '' }),
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {renderModelSelect(
                        b.modelID,
                        (nextValue) => updateBinding(idx, { modelID: nextValue }),
                        modelOptions,
                        account?.providerID,
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        {renderSwitch(Boolean(b.enabled), () => updateBinding(idx, { enabled: !b.enabled }))}
                        <span className="text-[11px] text-slate-600">{b.enabled ? t('settings_modal.enabled') : t('settings_modal.disabled')}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        {renderConnectionAction(b.accountID)}
                        <button
                          type="button"
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          title={t('settings_modal.actions.delete')}
                          onClick={() => {
                            if (!draft) return
                            markDirty({
                              ...draft,
                              capabilityBindings: draft.capabilityBindings.filter((_, bindingIndex) => bindingIndex !== idx),
                            })
                          }}
                        >
                          <Icon name="delete" className="text-[14px]" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-[#E9EDF3] px-3 py-2">
            <button
              type="button"
              className="rounded border border-[#BFD4FF] bg-[#F4F8FF] px-2 py-1 text-[11px] text-[#2D6CFF]"
              onClick={() => {
                if (!draft) return
                const now = new Date().toISOString()
                markDirty({
                  ...draft,
                  capabilityBindings: [
                    ...draft.capabilityBindings,
                    {
                      bindingID: '',
                      capability: 'agent_chat',
                      enabled: true,
                      accountID: '',
                      modelID: '',
                      operationType: 'chat_completion' as AiModelOperationType,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ],
                })
              }}
            >
              {t('settings_modal.custom_model.add_model')}
            </button>
            <label className="flex items-center gap-2 text-[11px] text-slate-600">
              {renderSwitch(agentAutoFallback, () => setAgentAutoFallback((v) => !v))}
              <span>{t('settings_modal.custom_model.auto_fallback')}</span>
            </label>
          </div>
          <div className="flex items-center gap-2 border-t border-[#EEF2F7] bg-[#F8FAFD] px-3 py-2 text-[11px] text-slate-500">
            <Icon name="info" className="text-[12px] text-slate-400" />
            <span>{t('settings_modal.custom_model.final_order')}</span>
            <span className="truncate">
              {agentRows
                .map(({ b }) => b)
                .filter((b) => b.enabled)
                .map((b) => {
                  const acc = accountById.get(b.accountID)
                  return `${acc?.label || t('settings_modal.unconfigured')} / ${b.modelID || t('settings_modal.unconfigured')}`
                })
                .join('  →  ') || t('settings_modal.unconfigured')}
            </span>
          </div>
        </div>
      </div>
    )
  }

  const renderSimplePanel = (title: string, desc: string, extra?: React.ReactNode) => (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[18px] font-semibold text-slate-900">{title}</div>
      <div className="mt-1.5 text-[12px] text-slate-500">{desc}</div>
      {extra ? <div className="mt-4">{extra}</div> : null}
    </div>
  )

  const renderOpenSourcePanel = () => {
    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-[22px] font-semibold tracking-tight text-slate-900">{t('settings_modal.license.hero_title')}</h3>
          <p className="mt-1 text-[13px] text-slate-500">{t('settings_modal.license.hero_desc')}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center text-[#2D6CFF]">
              <Icon name="info" className="text-[20px]" />
            </span>
            <div className="text-[13px] text-slate-600">
              <div>• {t('settings_modal.license.note_1')}</div>
              <div className="mt-1">• {t('settings_modal.license.note_2')}</div>
            </div>
          </div>
        </div>
        <div className="pt-1 text-[20px] font-semibold tracking-tight text-slate-900">{t('settings_modal.license.list_title')}</div>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full table-fixed text-[12px]">
            <thead className="bg-[#F8FAFD] text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t('settings_modal.license.col_project')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('settings_modal.license.col_license')}</th>
                <th className="w-40 px-3 py-2 text-left font-medium">{t('settings_modal.license.col_action')}</th>
              </tr>
            </thead>
            <tbody>
              {openSourceComponents.map((item) => (
                <tr key={item.packageName} className="border-t border-[#EEF2F7]">
                  <td className="px-3 py-2 text-slate-700">{item.name}</td>
                  <td className="px-3 py-2 text-slate-500">{item.license}</td>
                  <td className="px-3 py-2">
                    <button type="button" className="text-[13px] font-medium text-[#2D6CFF] hover:text-[#1f5cf2]">{t('settings_modal.license.view_license')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="inline-flex items-center gap-2 text-[16px] font-medium text-slate-900">
            <Icon name="description" className="text-[18px] text-[#2D6CFF]" />
            <span>{t('settings_modal.license.full_notice_title')}</span>
          </div>
          <button type="button" className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50">
            <span>{t('settings_modal.license.full_notice_action')}</span>
            <Icon name="link" className="text-[14px]" />
          </button>
        </div>
      </div>
    )
  }

  const content = (() => {
    if (menu === 'provider_accounts') return renderCredentials()
    if (menu === 'custom_model') return renderCustomModel()
    if (menu === 'experimental') {
      const mathInputEnabled = Boolean(draft?.experimentalFeatures.mathInput.enabled)
      return (
        <div className="space-y-3">
          <div>
            <h3 className="text-[22px] font-semibold tracking-tight text-slate-900">{t('settings_modal.menu.experimental_features')}</h3>
            <p className="mt-1 text-[12px] text-slate-500">{t('settings_modal.experimental.hero_desc')}</p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            <Icon name="warning" className="text-[14px] text-amber-500" />
            <span>{t('settings_modal.experimental.hero_warning')}</span>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="inline-flex items-center justify-center text-[#2D6CFF]">
                  <Icon name="function" className="text-[24px]" />
                </span>
                <div>
                  <div className="text-[15px] font-medium text-slate-900">{t('settings_modal.experimental.math_input_title')}</div>
                  <div className="mt-0.5 text-[12px] text-slate-500">{t('settings_modal.experimental.math_input_desc')}</div>
                </div>
              </div>
              {(() => {
                const toggleMathInput = () => {
                  if (!draft) return
                  markDirty({
                    ...draft,
                    experimentalFeatures: { mathInput: { enabled: !mathInputEnabled } },
                  })
                }
                return renderSwitch(mathInputEnabled, toggleMathInput)
              })()}
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <Icon name="info" className="text-[12px] text-slate-400" />
            <span>{t('settings_modal.experimental.math_input_hint')}</span>
          </div>
        </div>
      )
    }
    if (menu === 'language') return renderSimplePanel(t('settings_modal.menu.language'), t('settings_modal.general.language_desc'), <LanguageSelector />)
    if (menu === 'appearance') return renderSimplePanel(t('settings_modal.menu.appearance'), t('settings_modal.appearance.desc'), (
      <div className="inline-flex rounded-md border border-slate-200 p-1 text-[12px]">
        <button type="button" className={`rounded px-3 py-1 ${studioAutoSaveMode === 'off' ? 'bg-slate-900 text-white' : 'text-slate-600'}`} onClick={() => onStudioAutoSaveModeChange?.('off')}>{t('settings_modal.appearance.manual')}</button>
        <button type="button" className={`rounded px-3 py-1 ${studioAutoSaveMode === 'afterDelay' ? 'bg-slate-900 text-white' : 'text-slate-600'}`} onClick={() => onStudioAutoSaveModeChange?.('afterDelay')}>{t('settings_modal.appearance.auto_delay')}</button>
      </div>
    ))
    if (menu === 'security') return renderSimplePanel(t('settings_modal.menu.security'), t('settings_modal.account.security_desc'), (
      <button type="button" className="rounded-md border border-rose-200 px-3 py-1.5 text-[12px] text-rose-600 hover:bg-rose-50" onClick={onLogout}>{t('app.buttons.logout')}</button>
    ))
    if (menu === 'open_source') return renderOpenSourcePanel()
    return renderSimplePanel(t('settings_modal.menu.settings_center'), t('settings_modal.subtitle'))
  })()

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-2 md:p-4">
      <div className="flex h-[84vh] w-full max-w-[1080px] overflow-hidden rounded-xl border border-slate-200 bg-[#F7F8FA] shadow-xl">
        <aside className="w-[210px] shrink-0 border-r border-slate-200 bg-[#F4F5F7] p-3">
          <div className="mb-2 text-[22px] font-semibold tracking-tight text-slate-900">{t('settings_modal.title')}</div>
          <nav className="scrollbar-hidden space-y-3 overflow-y-auto pr-1">
            {nav.map((section) => (
              <div key={section.group}>
                <div className="mb-1.5 px-2 text-[11px] font-medium text-slate-400">{section.group}</div>
                <div className="space-y-1">
                  {section.items.map((item) => (
                    <button key={item.key} type="button" onClick={() => setMenu(item.key)} className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] ${menu === item.key ? 'bg-[#E6EEFF] text-[#2D6CFF]' : 'text-slate-600 hover:bg-slate-100'}`}>
                      <Icon name={item.icon} className="text-[14px]" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="mt-4 border-t border-slate-200 pt-3">
            <div className="text-[12px] font-medium text-slate-700">{user.display_name}</div>
            <div className="truncate text-[11px] text-slate-500">{user.email}</div>
          </div>
        </aside>
        <section className="relative flex min-w-0 flex-1 flex-col bg-white">
          <button type="button" onClick={handleClose} className="absolute right-4 top-2 z-20 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <Icon name="close" className="text-[16px]" />
          </button>
          <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-5 md:py-5">
            {isLoading ? <div className="text-[12px] text-slate-500">{t('settings_modal.loading')}</div> : content}
          </div>
          <footer className="flex items-center justify-between border-t border-slate-200 bg-white px-3 py-2.5 md:px-5">
            <div className="min-h-[18px] text-[11px]">
              {error ? <span className="text-rose-600">{error}</span> : message ? <span className="text-emerald-600">{message}</span> : <span className="text-slate-500">{t('settings_modal.footer_hint')}</span>}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={handleClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-[12px] text-slate-700">{t('settings_modal.actions.cancel')}</button>
              <button type="button" onClick={handleSave} disabled={isSaving || !draft} className="rounded-md bg-[#2D6CFF] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-[#1f5cf2] disabled:opacity-60">
                {isSaving ? t('settings_modal.actions.saving') : t('settings_modal.actions.save')}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  )
}

AIModelSettingsDialogInner.displayName = 'AIModelSettingsDialogInner'
export const AIModelSettingsDialog = React.memo(AIModelSettingsDialogInner)
