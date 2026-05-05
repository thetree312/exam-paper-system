import { apiJson, withJsonBody } from '../lib/api'
import type {
  CapabilityBindingDto,
  DefaultModelDto,
  ModelCatalogDto,
  ProviderConnectionTestResultDto,
  ProviderModelSyncResultDto,
  UserModelSettingsDto,
} from '../types'

export type SaveUserModelSettingsPayload = {
  providerAccounts: Array<{
    accountID?: string
    providerID: string
    label: string
    apiKey: string
    baseURL?: string
    createdAt?: string
    updatedAt?: string
  }>
  providerModelCatalogs: Array<{
    providerID: string
    models: Array<{
      modelID: string
      label?: string
    }>
  }>
  defaultModel: DefaultModelDto | null
  capabilityBindings: Array<Omit<CapabilityBindingDto, 'bindingID'> & { bindingID?: string }>
  experimentalFeatures: {
    mathInput: {
      enabled: boolean
    }
  }
  bindingSchemaVersion?: number
}

type FetchModelSettingsOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  bypassCache?: boolean
}

type SaveModelSettingsOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 12_000
const inFlightSettings = new Map<string, Promise<UserModelSettingsDto>>()
const inFlightCatalog = new Map<string, Promise<ModelCatalogDto>>()

function createAbortSignalWithTimeout(timeoutMs: number, externalSignal?: AbortSignal) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Model settings request timed out', 'TimeoutError'))
  }, timeoutMs)

  const handleExternalAbort = () => {
    controller.abort(externalSignal?.reason ?? new DOMException('Request aborted', 'AbortError'))
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      handleExternalAbort()
    } else {
      externalSignal.addEventListener('abort', handleExternalAbort, { once: true })
    }
  }

  const cleanup = () => {
    clearTimeout(timeoutId)
    if (externalSignal) {
      externalSignal.removeEventListener('abort', handleExternalAbort)
    }
  }

  return { signal: controller.signal, cleanup }
}

function createTimeoutOnlySignal(timeoutMs: number) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Model settings request timed out', 'TimeoutError'))
  }, timeoutMs)
  const cleanup = () => {
    clearTimeout(timeoutId)
  }
  return { signal: controller.signal, cleanup }
}

function isTimeoutError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError'
}

function wrapWithConsumerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(new DOMException('Request aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Request aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

export async function fetchModelSettings(
  baseUrl: string,
  options: FetchModelSettingsOptions = {},
): Promise<UserModelSettingsDto> {
  const key = baseUrl
  if (!options.bypassCache) {
    const running = inFlightSettings.get(key)
    if (running) return wrapWithConsumerAbort(running, options.signal)
  }

  const { signal, cleanup } = createTimeoutOnlySignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const promise = apiJson<UserModelSettingsDto>(`${baseUrl}/api/model-settings`, {
    method: 'GET',
    cache: 'no-store',
    signal,
  })
    .catch((error) => {
      if (isTimeoutError(error)) {
        throw new Error('模型设置请求超时，请重试。')
      }
      throw error
    })
    .finally(() => {
      cleanup()
      if (inFlightSettings.get(key) === promise) {
        inFlightSettings.delete(key)
      }
    })

  if (!options.bypassCache) {
    inFlightSettings.set(key, promise)
  }

  return wrapWithConsumerAbort(promise, options.signal)
}

export async function saveModelSettings(
  baseUrl: string,
  payload: SaveUserModelSettingsPayload,
  options: SaveModelSettingsOptions = {},
): Promise<UserModelSettingsDto> {
  const { signal, cleanup } = createAbortSignalWithTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal)
  return apiJson<UserModelSettingsDto>(`${baseUrl}/api/model-settings`, {
    method: 'PUT',
    signal,
    ...withJsonBody(payload),
  }).finally(() => {
    cleanup()
  })
}

export async function fetchModelSettingsCatalog(
  baseUrl: string,
  options: FetchModelSettingsOptions = {},
): Promise<ModelCatalogDto> {
  const key = baseUrl
  if (!options.bypassCache) {
    const running = inFlightCatalog.get(key)
    if (running) return wrapWithConsumerAbort(running, options.signal)
  }

  const { signal, cleanup } = createTimeoutOnlySignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const promise = apiJson<ModelCatalogDto>(`${baseUrl}/api/model-settings/catalog`, {
    method: 'GET',
    cache: 'no-store',
    signal,
  })
    .catch((error) => {
      if (isTimeoutError(error)) {
        throw new Error('模型目录请求超时，请重试。')
      }
      throw error
    })
    .finally(() => {
      cleanup()
      if (inFlightCatalog.get(key) === promise) {
        inFlightCatalog.delete(key)
      }
    })

  if (!options.bypassCache) {
    inFlightCatalog.set(key, promise)
  }

  return wrapWithConsumerAbort(promise, options.signal)
}

export async function testProviderConnection(
  baseUrl: string,
  accountID: string,
  options: SaveModelSettingsOptions = {},
): Promise<ProviderConnectionTestResultDto> {
  const { signal, cleanup } = createAbortSignalWithTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal)
  return apiJson<ProviderConnectionTestResultDto>(`${baseUrl}/api/model-settings/provider-accounts/${encodeURIComponent(accountID)}/test`, {
    method: 'POST',
    signal,
  }).finally(() => {
    cleanup()
  })
}

export async function syncProviderModels(
  baseUrl: string,
  accountID: string,
  options: SaveModelSettingsOptions = {},
): Promise<ProviderModelSyncResultDto> {
  const { signal, cleanup } = createAbortSignalWithTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal)
  return apiJson<ProviderModelSyncResultDto>(`${baseUrl}/api/model-settings/provider-accounts/${encodeURIComponent(accountID)}/sync-models`, {
    method: 'POST',
    signal,
  }).finally(() => {
    cleanup()
  })
}
