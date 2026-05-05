import path from "node:path"
import { createID } from "../../lib/ids"
import { getLocalSqlite, parseJsonText, readJsonFileIfExists } from "../../lib/local-sqlite"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")

export const MODEL_OPERATION_TYPES = ["chat_completion", "ocr_layout"] as const
export type ModelOperationType = (typeof MODEL_OPERATION_TYPES)[number]

export const AI_CAPABILITIES = [
  "agent_chat",
  "question_split",
  "question_grading",
  "flashcard_generation",
  "flashcard_long_outline",
  "mindmap_outline_generation",
  "mindmap_generation",
  "translation_math",
  "translation_word",
  "translation_sentence",
  "studio_selection_ocr",
  "document_layout_ocr",
] as const

export type AiCapability = (typeof AI_CAPABILITIES)[number]

export type ProviderAccountRecord = {
  accountID: string
  providerID: string
  label: string
  apiKey: string
  baseURL?: string
  lastSyncAt?: string
  lastTestAt?: string
  lastTestStatus?: "success" | "failed"
  createdAt: string
  updatedAt: string
}

export type ProviderModelRecord = {
  modelID: string
  label?: string
}

export type ProviderModelCatalogRecord = {
  providerID: string
  models: ProviderModelRecord[]
}

export type DefaultModelRecord = {
  accountID: string
  modelID: string
  operationType: ModelOperationType
  baseURLOverride?: string
}

export type CapabilityBindingRecord = {
  bindingID: string
  capability: AiCapability
  enabled: boolean
  accountID: string
  modelID: string
  operationType: ModelOperationType
  baseURLOverride?: string
  label?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

export type UserModelSettings = {
  userID: string
  providerAccounts: ProviderAccountRecord[]
  providerModelCatalogs: ProviderModelCatalogRecord[]
  defaultModel?: DefaultModelRecord
  capabilityBindings: CapabilityBindingRecord[]
  experimentalFeatures: {
    mathInput: {
      enabled: boolean
    }
  }
  bindingSchemaVersion: number
  updatedAt: string
}

export type ExperimentalFeaturesRecord = UserModelSettings["experimentalFeatures"]

type LegacyModelSettings = {
  userID: string
  providerAccounts?: Array<{
    providerID: string
    label: string
    apiKey: string
    createdAt?: string
    updatedAt?: string
  }>
  modelPreferences?: {
    defaultModel?: {
      providerID: string
      modelID: string
    }
    capabilityMapping?: Record<string, { providerID: string; modelID: string }>
    providerModelCatalogs?: ProviderModelCatalogRecord[]
    bindingSchemaVersion?: number
  }
  updatedAt?: string
}

type ModelSettingsState = {
  items: LegacyModelSettings[]
}

let migrated = false
const CURRENT_BINDING_SCHEMA_VERSION = 2

function defaultOperationTypeForCapability(capability: AiCapability): ModelOperationType {
  return capability === "studio_selection_ocr" || capability === "document_layout_ocr"
    ? "ocr_layout"
    : "chat_completion"
}

function sanitizeBaseURL(value: string | undefined | null) {
  const normalized = value?.trim()
  return normalized ? normalized.replace(/\/+$/, "") : undefined
}

function createDefault(userID: string): UserModelSettings {
  return {
    userID,
    providerAccounts: [],
    providerModelCatalogs: [],
    capabilityBindings: [],
    experimentalFeatures: {
      mathInput: {
        enabled: false,
      },
    },
    bindingSchemaVersion: CURRENT_BINDING_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  }
}

function normalizeExperimentalFeatures(input: unknown): ExperimentalFeaturesRecord {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const mathInput =
    record.mathInput && typeof record.mathInput === "object" ? (record.mathInput as Record<string, unknown>) : {}
  return {
    mathInput: {
      enabled: Boolean(mathInput.enabled),
    },
  }
}

function normalizeProviderModelCatalogs(
  input: {
    providerAccounts: ProviderAccountRecord[]
    providerModelCatalogs?: ProviderModelCatalogRecord[]
    defaultModel?: DefaultModelRecord
    capabilityBindings: CapabilityBindingRecord[]
  },
) {
  const providerOrder: string[] = []
  const providerSet = new Set<string>()
  const modelsByProvider = new Map<string, Map<string, string | undefined>>()
  const hasExplicitModelsByProvider = new Map<string, boolean>()
  const accountById = new Map(input.providerAccounts.map((item) => [item.accountID, item]))

  for (const account of input.providerAccounts) {
    if (providerSet.has(account.providerID)) continue
    providerSet.add(account.providerID)
    providerOrder.push(account.providerID)
  }

  const ensureBucket = (providerID: string) => {
    if (!providerSet.has(providerID)) return null
    if (!modelsByProvider.has(providerID)) {
      modelsByProvider.set(providerID, new Map<string, string | undefined>())
    }
    return modelsByProvider.get(providerID)!
  }

  for (const catalog of input.providerModelCatalogs ?? []) {
    const providerID = catalog.providerID?.trim()
    if (!providerID) continue
    const bucket = ensureBucket(providerID)
    if (!bucket) continue
    const hadExplicitModels = hasExplicitModelsByProvider.get(providerID) ?? false
    for (const model of catalog.models ?? []) {
      const modelID = model.modelID?.trim()
      if (!modelID) continue
      hasExplicitModelsByProvider.set(providerID, true)
      bucket.set(modelID, model.label?.trim() || undefined)
    }
    if (!hadExplicitModels && !hasExplicitModelsByProvider.has(providerID)) {
      hasExplicitModelsByProvider.set(providerID, false)
    }
  }

  const collectModel = (providerID: string | undefined, modelID: string | undefined) => {
    const normalizedProviderID = providerID?.trim()
    const normalizedModelID = modelID?.trim()
    if (!normalizedProviderID || !normalizedModelID) return
    if (hasExplicitModelsByProvider.get(normalizedProviderID)) return
    const bucket = ensureBucket(normalizedProviderID)
    if (!bucket) return
    if (!bucket.has(normalizedModelID)) {
      bucket.set(normalizedModelID, undefined)
    }
  }

  if (input.defaultModel) {
    const account = accountById.get(input.defaultModel.accountID)
    collectModel(account?.providerID, input.defaultModel.modelID)
  }
  for (const binding of input.capabilityBindings) {
    if (binding.capability !== "agent_chat") continue
    const account = accountById.get(binding.accountID)
    collectModel(account?.providerID, binding.modelID)
  }

  return providerOrder
    .map((providerID) => {
      const bucket = modelsByProvider.get(providerID)
      const models = bucket
        ? [...bucket.entries()].map(([modelID, label]) => ({
            modelID,
            ...(label ? { label } : {}),
          }))
        : []
      return {
        providerID,
        models,
      } satisfies ProviderModelCatalogRecord
    })
    .filter((item) => item.models.length > 0)
}

function ensureProviderAccountRecord(
  userID: string,
  input: {
    accountID?: string
    providerID: string
    label?: string
    apiKey?: string
    baseURL?: string
    lastSyncAt?: string
    lastTestAt?: string
    lastTestStatus?: "success" | "failed"
    createdAt?: string
    updatedAt?: string
  },
): ProviderAccountRecord {
  const now = new Date().toISOString()
  return {
    accountID: input.accountID?.trim() || createID(`provider_account_${userID}`),
    providerID: input.providerID.trim(),
    label: input.label?.trim() || input.providerID.trim(),
    apiKey: input.apiKey?.trim() ?? "",
    baseURL: sanitizeBaseURL(input.baseURL),
    lastSyncAt: input.lastSyncAt,
    lastTestAt: input.lastTestAt,
    lastTestStatus: input.lastTestStatus,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
}

function ensureCapabilityBindingRecord(
  userID: string,
  accountMap: Map<string, ProviderAccountRecord>,
  input: {
    bindingID?: string
    capability: string
    enabled?: boolean
    accountID?: string
    providerID?: string
    modelID: string
    operationType?: string
    baseURLOverride?: string
    label?: string
    notes?: string
    createdAt?: string
    updatedAt?: string
  },
): CapabilityBindingRecord | null {
  const capability = input.capability as AiCapability
  if (!AI_CAPABILITIES.includes(capability)) return null

  const accountID =
    input.accountID?.trim() ||
    (input.providerID ? [...accountMap.values()].find((account) => account.providerID === input.providerID)?.accountID : undefined)
  if (!accountID || !accountMap.has(accountID)) return null

  const modelID = input.modelID.trim()
  if (!modelID) return null

  const now = new Date().toISOString()
  const operationType = MODEL_OPERATION_TYPES.includes(input.operationType as ModelOperationType)
    ? (input.operationType as ModelOperationType)
    : defaultOperationTypeForCapability(capability)

  return {
    bindingID: input.bindingID?.trim() || createID(`capability_binding_${userID}`),
    capability,
    enabled: input.enabled ?? true,
    accountID,
    modelID,
    operationType,
    baseURLOverride: sanitizeBaseURL(input.baseURLOverride),
    label: input.label?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
}

function normalizeCapabilityBindings(input: {
  capabilityBindings: CapabilityBindingRecord[]
  bindingSchemaVersion: number
}) {
  const uniqueByBindingID = input.capabilityBindings.filter(
    (binding, index, list) => list.findIndex((candidate) => candidate.bindingID === binding.bindingID) === index,
  )

  const migratedBindings =
    input.bindingSchemaVersion >= CURRENT_BINDING_SCHEMA_VERSION
      ? uniqueByBindingID
      : uniqueByBindingID.filter((binding) => binding.capability !== "agent_chat")

  const nonAgentCapabilityFirstBinding = new Set<AiCapability>()
  const normalized: CapabilityBindingRecord[] = []
  for (const binding of migratedBindings) {
    if (binding.capability === "agent_chat") {
      normalized.push(binding)
      continue
    }
    if (nonAgentCapabilityFirstBinding.has(binding.capability)) continue
    nonAgentCapabilityFirstBinding.add(binding.capability)
    normalized.push(binding)
  }

  return normalized
}

function normalizeSettings(userID: string, input: Partial<UserModelSettings> | LegacyModelSettings | null | undefined): UserModelSettings {
  const fallback = createDefault(userID)
  if (!input) return fallback

  const providerAccounts = Array.isArray((input as UserModelSettings).providerAccounts)
    ? (input as UserModelSettings).providerAccounts
    : Array.isArray((input as LegacyModelSettings).providerAccounts)
      ? (input as LegacyModelSettings).providerAccounts!
      : []

  const normalizedAccounts = providerAccounts
    .map((account) => ensureProviderAccountRecord(userID, account))
    .filter((account, index, list) => list.findIndex((candidate) => candidate.accountID === account.accountID) === index)
  const accountMap = new Map(normalizedAccounts.map((account) => [account.accountID, account]))

  const directDefaultModel = (input as UserModelSettings).defaultModel
  const legacyDefaultModel = (input as LegacyModelSettings).modelPreferences?.defaultModel
  const defaultModelCandidate = directDefaultModel ?? legacyDefaultModel
  const defaultModel =
    defaultModelCandidate && normalizedAccounts.length > 0
      ? (() => {
          const resolvedAccountID =
            directDefaultModel?.accountID?.trim() ||
            [...accountMap.values()].find((account) => account.providerID === legacyDefaultModel?.providerID)?.accountID
          if (!resolvedAccountID || !accountMap.has(resolvedAccountID) || !defaultModelCandidate.modelID?.trim()) {
            return undefined
          }
          return {
            accountID: resolvedAccountID,
            modelID: defaultModelCandidate.modelID.trim(),
            operationType:
              (directDefaultModel as DefaultModelRecord | undefined)?.operationType &&
              MODEL_OPERATION_TYPES.includes((directDefaultModel as DefaultModelRecord).operationType)
                ? (directDefaultModel as DefaultModelRecord).operationType
                : "chat_completion",
            baseURLOverride: sanitizeBaseURL((directDefaultModel as DefaultModelRecord | undefined)?.baseURLOverride),
          } satisfies DefaultModelRecord
        })()
      : undefined

  const directBindings = Array.isArray((input as UserModelSettings).capabilityBindings)
    ? (input as UserModelSettings).capabilityBindings
    : []
  const legacyCapabilityMapping = (input as LegacyModelSettings).modelPreferences?.capabilityMapping ?? {}
  const legacyBindings = Object.entries(legacyCapabilityMapping).map(([capability, model]) => ({
    capability,
    providerID: model.providerID,
    modelID: model.modelID,
  }))

  const rawCapabilityBindings = [...directBindings, ...legacyBindings]
    .map((binding) => ensureCapabilityBindingRecord(userID, accountMap, binding))
    .filter((binding): binding is CapabilityBindingRecord => Boolean(binding))
  const bindingSchemaVersionRaw =
    (input as UserModelSettings).bindingSchemaVersion ??
    (input as LegacyModelSettings).modelPreferences?.bindingSchemaVersion ??
    1
  const bindingSchemaVersion =
    Number.isFinite(Number(bindingSchemaVersionRaw)) && Number(bindingSchemaVersionRaw) > 0
      ? Number(bindingSchemaVersionRaw)
      : 1
  const capabilityBindings = normalizeCapabilityBindings({
    capabilityBindings: rawCapabilityBindings,
    bindingSchemaVersion,
  })

  const directProviderModelCatalogs = Array.isArray((input as UserModelSettings).providerModelCatalogs)
    ? (input as UserModelSettings).providerModelCatalogs
    : []
  const legacyProviderModelCatalogs = Array.isArray((input as LegacyModelSettings).modelPreferences?.providerModelCatalogs)
    ? ((input as LegacyModelSettings).modelPreferences?.providerModelCatalogs as ProviderModelCatalogRecord[])
    : []
  const providerModelCatalogs = normalizeProviderModelCatalogs({
    providerAccounts: normalizedAccounts,
    providerModelCatalogs: [...directProviderModelCatalogs, ...legacyProviderModelCatalogs],
    defaultModel,
    capabilityBindings,
  })

  return {
    userID,
    providerAccounts: normalizedAccounts,
    providerModelCatalogs,
    defaultModel,
    capabilityBindings,
    experimentalFeatures: normalizeExperimentalFeatures((input as UserModelSettings).experimentalFeatures),
    bindingSchemaVersion: CURRENT_BINDING_SCHEMA_VERSION,
    updatedAt: input.updatedAt ?? fallback.updatedAt,
  }
}

function ensureMigrated() {
  if (migrated) return
  migrated = true

  const db = getLocalSqlite()
  const count = db.prepare(`SELECT COUNT(*) AS count FROM model_settings`).get() as { count: number }
  if (count.count > 0) return

  const state = readJsonFileIfExists<ModelSettingsState>(path.join(backendRoot, "local-data", "model-settings", "index.json"))
  if (!state) return

  const tx = db.transaction(() => {
    for (const item of state.items) {
      const normalized = normalizeSettings(item.userID, item)
      db.prepare(
        `
          INSERT OR REPLACE INTO model_settings (
            user_id, provider_accounts_json, model_preferences_json, updated_at
          ) VALUES (
            @user_id, @provider_accounts_json, @model_preferences_json, @updated_at
          )
        `,
      ).run({
        user_id: normalized.userID,
        provider_accounts_json: JSON.stringify(normalized.providerAccounts),
        model_preferences_json: JSON.stringify({
          providerModelCatalogs: normalized.providerModelCatalogs,
          defaultModel: normalized.defaultModel,
          capabilityBindings: normalized.capabilityBindings,
          experimentalFeatures: normalized.experimentalFeatures,
          bindingSchemaVersion: normalized.bindingSchemaVersion,
        }),
        updated_at: normalized.updatedAt,
      })
    }
  })

  tx()
}

function persistSettings(input: UserModelSettings) {
  const db = getLocalSqlite()
  db.prepare(
    `
      INSERT INTO model_settings (
        user_id, provider_accounts_json, model_preferences_json, updated_at
      ) VALUES (
        @user_id, @provider_accounts_json, @model_preferences_json, @updated_at
      )
      ON CONFLICT(user_id) DO UPDATE SET
        provider_accounts_json = excluded.provider_accounts_json,
        model_preferences_json = excluded.model_preferences_json,
        updated_at = excluded.updated_at
    `,
  ).run({
    user_id: input.userID,
    provider_accounts_json: JSON.stringify(input.providerAccounts),
    model_preferences_json: JSON.stringify({
      providerModelCatalogs: input.providerModelCatalogs,
      defaultModel: input.defaultModel,
      capabilityBindings: input.capabilityBindings,
      experimentalFeatures: input.experimentalFeatures,
      bindingSchemaVersion: input.bindingSchemaVersion,
    }),
    updated_at: input.updatedAt,
  })
}

export const ModelSettingsService = {
  async get(userID: string) {
    ensureMigrated()
    const db = getLocalSqlite()
    const row = db
      .prepare(
        `
          SELECT user_id, provider_accounts_json, model_preferences_json, updated_at
          FROM model_settings
          WHERE user_id = ?
        `,
      )
      .get(userID) as
      | {
          user_id: string
          provider_accounts_json: string
          model_preferences_json: string
          updated_at: string
        }
      | undefined

    if (!row) return createDefault(userID)

    const modelPreferences = parseJsonText<Record<string, unknown>>(row.model_preferences_json, {})
    const normalized = normalizeSettings(userID, {
      userID: row.user_id,
      providerAccounts: parseJsonText(row.provider_accounts_json, []),
      defaultModel: modelPreferences.defaultModel as DefaultModelRecord | undefined,
      providerModelCatalogs: Array.isArray(modelPreferences.providerModelCatalogs)
        ? (modelPreferences.providerModelCatalogs as ProviderModelCatalogRecord[])
        : undefined,
      capabilityBindings: Array.isArray(modelPreferences.capabilityBindings)
        ? (modelPreferences.capabilityBindings as CapabilityBindingRecord[])
        : undefined,
      experimentalFeatures: normalizeExperimentalFeatures(modelPreferences.experimentalFeatures),
      bindingSchemaVersion:
        typeof modelPreferences.bindingSchemaVersion === "number"
          ? modelPreferences.bindingSchemaVersion
          : undefined,
      modelPreferences: modelPreferences as LegacyModelSettings["modelPreferences"],
      updatedAt: row.updated_at,
    })

    const requiresRewrite =
      JSON.stringify(parseJsonText(row.provider_accounts_json, [])) !== JSON.stringify(normalized.providerAccounts) ||
      JSON.stringify(modelPreferences.providerModelCatalogs ?? []) !== JSON.stringify(normalized.providerModelCatalogs) ||
      JSON.stringify(modelPreferences.defaultModel ?? null) !== JSON.stringify(normalized.defaultModel ?? null) ||
      JSON.stringify(modelPreferences.capabilityBindings ?? []) !== JSON.stringify(normalized.capabilityBindings) ||
      JSON.stringify(normalizeExperimentalFeatures(modelPreferences.experimentalFeatures)) !==
        JSON.stringify(normalized.experimentalFeatures) ||
      Number(modelPreferences.bindingSchemaVersion ?? 1) !== normalized.bindingSchemaVersion

    if (requiresRewrite) {
      persistSettings(normalized)
    }

    return normalized
  },

  async resolveModel(input: { userID: string; capability?: AiCapability }) {
    const settings = await this.get(input.userID)
    if (input.capability) {
      const binding = settings.capabilityBindings.find((item) => item.capability === input.capability && item.enabled)
      if (binding) {
        const account = settings.providerAccounts.find((item) => item.accountID === binding.accountID)
        if (account) {
          return {
            providerID: account.providerID,
            modelID: binding.modelID,
          }
        }
      }
    }

    if (!settings.defaultModel) return undefined
    const account = settings.providerAccounts.find((item) => item.accountID === settings.defaultModel?.accountID)
    if (!account) return undefined
    return {
      providerID: account.providerID,
      modelID: settings.defaultModel.modelID,
    }
  },

  async getAccount(userID: string, accountID: string) {
    const settings = await this.get(userID)
    return settings.providerAccounts.find((item) => item.accountID === accountID)
  },

  async patchAccountMeta(
    input: {
      userID: string
      accountID: string
      patch: Partial<Pick<ProviderAccountRecord, "lastSyncAt" | "lastTestAt" | "lastTestStatus">>
    },
  ) {
    const settings = await this.get(input.userID)
    const target = settings.providerAccounts.find((item) => item.accountID === input.accountID)
    if (!target) return null
    const now = new Date().toISOString()
    const next: UserModelSettings = {
      ...settings,
      updatedAt: now,
      providerAccounts: settings.providerAccounts.map((item) =>
        item.accountID === input.accountID
          ? {
              ...item,
              ...input.patch,
              updatedAt: now,
            }
          : item,
      ),
    }
    persistSettings(next)
    return next.providerAccounts.find((item) => item.accountID === input.accountID) ?? null
  },

  async replaceProviderModels(
    input: {
      userID: string
      providerID: string
      models: ProviderModelRecord[]
      updateAccountIDs?: string[]
    },
  ) {
    const settings = await this.get(input.userID)
    const now = new Date().toISOString()
    const normalizedModels = input.models
      .map((item) => ({
        modelID: String(item.modelID || "").trim(),
        label: item.label?.trim(),
      }))
      .filter((item) => item.modelID.length > 0)
      .filter((item, index, list) => list.findIndex((x) => x.modelID === item.modelID) === index)
    const nextCatalogs = settings.providerModelCatalogs.filter((item) => item.providerID !== input.providerID)
    nextCatalogs.push({
      providerID: input.providerID,
      models: normalizedModels,
    })
    const touchIDs = new Set(input.updateAccountIDs ?? [])
    const next: UserModelSettings = {
      ...settings,
      updatedAt: now,
      providerModelCatalogs: nextCatalogs,
      providerAccounts: settings.providerAccounts.map((item) =>
        item.providerID === input.providerID && (touchIDs.size === 0 || touchIDs.has(item.accountID))
          ? {
              ...item,
              lastSyncAt: now,
              updatedAt: now,
            }
          : item,
      ),
    }
    persistSettings(next)
    return next
  },

  async put(input: UserModelSettings) {
    ensureMigrated()
    const now = new Date().toISOString()
    const previous = await this.get(input.userID)
    const previousAccountMap = new Map(previous.providerAccounts.map((account) => [account.accountID, account]))
    const normalized = normalizeSettings(input.userID, {
      ...input,
      updatedAt: now,
      providerAccounts: input.providerAccounts.map((account) => ({
        ...account,
        apiKey: account.apiKey.trim() || previousAccountMap.get(account.accountID)?.apiKey || "",
        updatedAt: now,
      })),
      capabilityBindings: input.capabilityBindings.map((binding) => ({
        ...binding,
        updatedAt: now,
      })),
    })

    persistSettings(normalized)
    return normalized
  },
}
