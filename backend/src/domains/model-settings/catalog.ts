import path from "node:path"
import { promises as fs } from "node:fs"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const localModelsCatalogPath = path.join(repoRoot, "backend", "vendor", "models.dev", "dist", "_api.json")
const localModelsCatalogOverridePath = path.join(
  repoRoot,
  "backend",
  "local-data",
  "model-catalog-overrides.json",
)

export type LocalModelCatalogModel = {
  id: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
  cost?: Record<string, number>
  limit?: {
    context?: number
    input?: number
    output?: number
  }
}

export type LocalModelCatalogProvider = {
  name?: string
  npm?: string
  api?: string
  doc?: string
  env?: string[]
  models?: Record<string, LocalModelCatalogModel>
}

export type LocalModelCatalog = Record<string, LocalModelCatalogProvider>

let localCatalogPromise: Promise<LocalModelCatalog> | undefined

const BASE_URL_OVERRIDE_ENV_BY_PROVIDER: Record<string, string[]> = {
  "alibaba-cn": ["ALIBABA_BASE_URL"],
  alibaba: ["ALIBABA_BASE_URL"],
  deepseek: ["DEEPSEEK_BASE_URL"],
  "siliconflow-cn": ["SILICONFLOW_BASE_URL", "SILICONFLOW_CN_BASE_URL"],
  siliconflow: ["SILICONFLOW_BASE_URL"],
  modelscope: ["MODELSCOPE_BASE_URL", "PHONE_AGENT_BASE_URL"],
  zhipu: ["ZHIPU_BASE_URL"],
  zhipuai: ["ZHIPU_BASE_URL"],
}

const BASE_URL_FALLBACK_BY_PROVIDER: Record<string, string> = {
  "alibaba-cn": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  alibaba: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  deepseek: "https://api.deepseek.com",
}

function sanitizeBaseURL(value: string | undefined | null) {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (normalized.endsWith("/chat/completions")) {
    return normalized.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "")
  }
  return normalized.replace(/\/+$/, "")
}

function resolveProviderBaseURLOverride(providerID: string) {
  const envNames = BASE_URL_OVERRIDE_ENV_BY_PROVIDER[providerID] ?? []
  for (const envName of envNames) {
    const value = sanitizeBaseURL(process.env[envName])
    if (value) return value
  }
  return undefined
}

function parseCatalog(text: string): LocalModelCatalog {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid local models catalog at ${localModelsCatalogPath}`)
  }
  return parsed as LocalModelCatalog
}

async function readCatalogOverride() {
  try {
    const text = await fs.readFile(localModelsCatalogOverridePath, "utf8")
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as LocalModelCatalog
  } catch {
    return undefined
  }
}

function mergeCatalog(base: LocalModelCatalog, override: LocalModelCatalog | undefined): LocalModelCatalog {
  if (!override) return base
  const merged: LocalModelCatalog = { ...base }

  for (const [providerID, providerOverride] of Object.entries(override)) {
    const providerBase = merged[providerID] ?? {}
    const baseModels = providerBase.models ?? {}
    const overrideModels = providerOverride.models ?? {}
    merged[providerID] = {
      ...providerBase,
      ...providerOverride,
      models: {
        ...baseModels,
        ...overrideModels,
      },
    }
  }

  return merged
}

export async function loadLocalModelsCatalog() {
  if (!localCatalogPromise) {
    localCatalogPromise = (async () => {
      const baseCatalog = parseCatalog(await fs.readFile(localModelsCatalogPath, "utf8"))
      const overrideCatalog = await readCatalogOverride()
      return mergeCatalog(baseCatalog, overrideCatalog)
    })()
  }
  return localCatalogPromise
}

export async function getLocalCatalogProvider(providerID: string) {
  const catalog = await loadLocalModelsCatalog()
  return catalog[providerID]
}

export async function hasLocalCatalogProvider(providerID: string) {
  const provider = await getLocalCatalogProvider(providerID)
  return Boolean(provider)
}

export async function hasLocalCatalogModel(providerID: string, modelID: string) {
  const provider = await getLocalCatalogProvider(providerID)
  return Boolean(provider?.models?.[modelID])
}

export async function listLocalCatalogModels(providerID: string) {
  const provider = await getLocalCatalogProvider(providerID)
  return Object.keys(provider?.models ?? {})
}

export function resolveCatalogProviderDefaultBaseURL(
  providerID: string,
  provider?: LocalModelCatalogProvider,
) {
  return (
    resolveProviderBaseURLOverride(providerID) ??
    sanitizeBaseURL(provider?.api) ??
    BASE_URL_FALLBACK_BY_PROVIDER[providerID]
  )
}

export function classifyCatalogProviderAdapter(npm: string | undefined) {
  const normalized = String(npm || "").trim()
  if (!normalized) return "openai_compatible"
  if (normalized === "@ai-sdk/openai-compatible") return "openai_compatible"
  return "official"
}
