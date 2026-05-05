import { resolveCatalogProviderDefaultBaseURL } from "./catalog"

function sanitizeBaseURL(value: string | undefined | null) {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (normalized.endsWith("/chat/completions")) {
    return normalized.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "")
  }
  return normalized.replace(/\/+$/, "")
}

function buildModelsEndpoint(baseURL: string) {
  return `${sanitizeBaseURL(baseURL)}/models`
}

async function requestWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 12_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function parseModelsPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return []
  const record = payload as Record<string, unknown>
  const raw = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : []
  const models: Array<{ modelID: string; label?: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const id = String(row.id ?? row.model ?? "").trim()
    if (!id) continue
    const label = String(row.name ?? "").trim() || undefined
    if (!models.some((x) => x.modelID === id)) {
      models.push({ modelID: id, label })
    }
  }
  return models
}

export type ProviderConnectionTestResult = {
  success: boolean
  latencyMs: number
  error?: string
  httpStatus?: number
  providerID: string
  baseURL: string
}

export async function testProviderConnection(input: {
  providerID: string
  apiKey: string
  baseURL?: string
}) : Promise<ProviderConnectionTestResult> {
  const baseURL = sanitizeBaseURL(input.baseURL) ?? resolveCatalogProviderDefaultBaseURL(input.providerID)
  if (!baseURL) {
    return {
      success: false,
      latencyMs: 0,
      error: `Provider base URL is not configured: ${input.providerID}`,
      providerID: input.providerID,
      baseURL: "",
    }
  }
  const start = Date.now()
  try {
    const response = await requestWithTimeout(buildModelsEndpoint(baseURL), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
    })
    const latencyMs = Date.now() - start
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      return {
        success: false,
        latencyMs,
        error: text.slice(0, 300) || `HTTP ${response.status}`,
        httpStatus: response.status,
        providerID: input.providerID,
        baseURL,
      }
    }
    return {
      success: true,
      latencyMs,
      httpStatus: response.status,
      providerID: input.providerID,
      baseURL,
    }
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : "request_failed",
      providerID: input.providerID,
      baseURL,
    }
  }
}

export type ProviderModelSyncResult = {
  success: boolean
  providerID: string
  baseURL: string
  syncedCount: number
  models: Array<{ modelID: string; label?: string }>
  latencyMs: number
  error?: string
  httpStatus?: number
  lastSyncAt?: string
}

export async function syncProviderModels(input: {
  providerID: string
  apiKey: string
  baseURL?: string
}) : Promise<ProviderModelSyncResult> {
  const baseURL = sanitizeBaseURL(input.baseURL) ?? resolveCatalogProviderDefaultBaseURL(input.providerID)
  if (!baseURL) {
    return {
      success: false,
      providerID: input.providerID,
      baseURL: "",
      syncedCount: 0,
      models: [],
      latencyMs: 0,
      error: `Provider base URL is not configured: ${input.providerID}`,
    }
  }
  const start = Date.now()
  try {
    const response = await requestWithTimeout(buildModelsEndpoint(baseURL), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
    })
    const latencyMs = Date.now() - start
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      return {
        success: false,
        providerID: input.providerID,
        baseURL,
        syncedCount: 0,
        models: [],
        latencyMs,
        error: text.slice(0, 300) || `HTTP ${response.status}`,
        httpStatus: response.status,
      }
    }
    const payload = await response.json().catch(() => ({}))
    const models = parseModelsPayload(payload)
    return {
      success: true,
      providerID: input.providerID,
      baseURL,
      syncedCount: models.length,
      models,
      latencyMs,
      httpStatus: response.status,
      lastSyncAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      success: false,
      providerID: input.providerID,
      baseURL,
      syncedCount: 0,
      models: [],
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : "request_failed",
    }
  }
}
