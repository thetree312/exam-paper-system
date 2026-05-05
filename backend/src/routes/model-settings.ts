import { Hono } from "hono"
import { z } from "zod"
import { hasLocalCatalogModel, hasLocalCatalogProvider, listLocalCatalogModels } from "../domains/model-settings/catalog"
import { ModelSettingsResolver } from "../domains/model-settings/resolver"
import {
  AI_CAPABILITIES,
  MODEL_OPERATION_TYPES,
  ModelSettingsService,
  type UserModelSettings,
} from "../domains/model-settings/service"
import { syncProviderModels, testProviderConnection } from "../domains/model-settings/provider-runtime"
import { requireAuth } from "./auth-context"

const providerAccountSchema = z.object({
  accountID: z.string().min(1).optional(),
  providerID: z.string().min(1),
  label: z.string().min(1),
  apiKey: z.string(),
  baseURL: z.string().trim().min(1).optional(),
  lastSyncAt: z.string().optional(),
  lastTestAt: z.string().optional(),
  lastTestStatus: z.enum(["success", "failed"]).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

const providerModelCatalogSchema = z.object({
  providerID: z.string().min(1),
  models: z.array(
    z.object({
      modelID: z.string().min(1),
      label: z.string().trim().min(1).optional(),
    }),
  ),
})

const defaultModelSchema = z
  .object({
    accountID: z.string().min(1),
    modelID: z.string().min(1),
    operationType: z.enum(MODEL_OPERATION_TYPES),
    baseURLOverride: z.string().trim().min(1).optional(),
  })
  .nullable()
  .optional()

const capabilityBindingSchema = z.object({
  bindingID: z.string().min(1).optional(),
  capability: z.enum(AI_CAPABILITIES),
  enabled: z.boolean().default(true),
  accountID: z.string().min(1),
  modelID: z.string().min(1),
  operationType: z.enum(MODEL_OPERATION_TYPES),
  baseURLOverride: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

const bodySchema = z.object({
  providerAccounts: z.array(providerAccountSchema),
  providerModelCatalogs: z.array(providerModelCatalogSchema).default([]),
  defaultModel: defaultModelSchema,
  capabilityBindings: z.array(capabilityBindingSchema),
  experimentalFeatures: z
    .object({
      mathInput: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
    })
    .default({
      mathInput: {
        enabled: false,
      },
    }),
  bindingSchemaVersion: z.number().int().positive().optional(),
})

function maskApiKey(value: string) {
  if (value.length <= 8) return "*".repeat(value.length)
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`
}

function toClientSettings(input: UserModelSettings) {
  return {
    userID: input.userID,
    providerAccounts: input.providerAccounts.map((account) => ({
      accountID: account.accountID,
      providerID: account.providerID,
      label: account.label,
      apiKeyMasked: maskApiKey(account.apiKey),
      hasApiKey: account.apiKey.length > 0,
      baseURL: account.baseURL,
      lastSyncAt: account.lastSyncAt,
      lastTestAt: account.lastTestAt,
      lastTestStatus: account.lastTestStatus,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    })),
    providerModelCatalogs: input.providerModelCatalogs,
    defaultModel: input.defaultModel ?? null,
    capabilityBindings: input.capabilityBindings,
    experimentalFeatures: input.experimentalFeatures,
    bindingSchemaVersion: input.bindingSchemaVersion,
    updatedAt: input.updatedAt,
  }
}

function hasInvalidNonAgentBinding(input: UserModelSettings["capabilityBindings"]) {
  const enabledCountByCapability = new Map<string, number>()
  for (const binding of input) {
    if (binding.capability === "agent_chat") continue
    if (!binding.enabled) continue
    enabledCountByCapability.set(binding.capability, (enabledCountByCapability.get(binding.capability) ?? 0) + 1)
    if ((enabledCountByCapability.get(binding.capability) ?? 0) > 1) return true
  }
  return false
}

async function validateKnownCatalogModels(input: UserModelSettings) {
  const accountByID = new Map(input.providerAccounts.map((account) => [account.accountID, account]))

  for (const item of input.providerModelCatalogs) {
    if (!(await hasLocalCatalogProvider(item.providerID))) continue
    for (const model of item.models) {
      if (!model.modelID) continue
      if (await hasLocalCatalogModel(item.providerID, model.modelID)) continue
      const available = await listLocalCatalogModels(item.providerID)
      return {
        error: `模型不存在于当前 runtime catalog: ${item.providerID}/${model.modelID}`,
        details: {
          providerID: item.providerID,
          modelID: model.modelID,
          availableSample: available.slice(0, 20),
        },
      }
    }
  }

  const validateModelSelection = async (selection: {
    accountID: string
    modelID: string
    capability?: string
    source: "default_model" | "capability_binding"
  }) => {
    const account = accountByID.get(selection.accountID)
    if (!account) return null
    if (!(await hasLocalCatalogProvider(account.providerID))) return null
    if (await hasLocalCatalogModel(account.providerID, selection.modelID)) return null
    const available = await listLocalCatalogModels(account.providerID)
    return {
      error: `模型不存在于当前 runtime catalog: ${account.providerID}/${selection.modelID}`,
      details: {
        source: selection.source,
        capability: selection.capability,
        providerID: account.providerID,
        accountID: account.accountID,
        modelID: selection.modelID,
        availableSample: available.slice(0, 20),
      },
    }
  }

  if (input.defaultModel) {
    const invalidDefault = await validateModelSelection({
      accountID: input.defaultModel.accountID,
      modelID: input.defaultModel.modelID,
      source: "default_model",
    })
    if (invalidDefault) return invalidDefault
  }

  for (const binding of input.capabilityBindings) {
    const invalidBinding = await validateModelSelection({
      accountID: binding.accountID,
      modelID: binding.modelID,
      capability: binding.capability,
      source: "capability_binding",
    })
    if (invalidBinding) return invalidBinding
  }

  return null
}

export const modelSettingsRoutes = new Hono()

modelSettingsRoutes.get("/", async (c) => {
  const { user } = await requireAuth(c)
  return c.json(toClientSettings(await ModelSettingsService.get(user.id)))
})

modelSettingsRoutes.put("/", async (c) => {
  const { user } = await requireAuth(c)
  const rawBody = await c.req.json()
  const normalizedRawBody =
    rawBody && typeof rawBody === "object"
      ? {
          ...rawBody,
          capabilityBindings: Array.isArray((rawBody as { capabilityBindings?: unknown[] }).capabilityBindings)
            ? (rawBody as { capabilityBindings: unknown[] }).capabilityBindings.filter((binding) => {
                if (!binding || typeof binding !== "object") return false
                const accountID = (binding as { accountID?: unknown }).accountID
                const modelID = (binding as { modelID?: unknown }).modelID
                const capability = (binding as { capability?: unknown }).capability
                return (
                  typeof accountID === "string" &&
                  accountID.trim().length > 0 &&
                  typeof modelID === "string" &&
                  modelID.trim().length > 0 &&
                  typeof capability === "string" &&
                  capability.trim().length > 0
                )
              })
            : [],
        }
      : rawBody
  const body = bodySchema.parse(normalizedRawBody)
  const now = new Date().toISOString()
  const nextSettings: UserModelSettings = {
    userID: user.id,
    providerAccounts: body.providerAccounts.map((account) => ({
      ...account,
      accountID: account.accountID ?? "",
      baseURL: account.baseURL,
      lastSyncAt: account.lastSyncAt,
      lastTestAt: account.lastTestAt,
      lastTestStatus: account.lastTestStatus,
      createdAt: account.createdAt ?? now,
      updatedAt: now,
    })),
    providerModelCatalogs: body.providerModelCatalogs.map((item) => ({
      providerID: item.providerID.trim(),
      models: item.models
        .map((model) => ({
          modelID: model.modelID.trim(),
          label: model.label?.trim(),
        }))
        .filter((model) => model.modelID.length > 0),
    })),
    defaultModel: body.defaultModel
      ? {
          ...body.defaultModel,
          baseURLOverride: body.defaultModel.baseURLOverride,
        }
      : undefined,
    capabilityBindings: body.capabilityBindings.map((binding) => ({
      ...binding,
      bindingID: binding.bindingID ?? "",
      createdAt: binding.createdAt ?? now,
      updatedAt: now,
    })),
    experimentalFeatures: {
      mathInput: {
        enabled: body.experimentalFeatures.mathInput.enabled,
      },
    },
    bindingSchemaVersion: body.bindingSchemaVersion ?? 2,
    updatedAt: now,
  }

  if (hasInvalidNonAgentBinding(nextSettings.capabilityBindings)) {
    return c.json({ error: "non-agent capability allows only one enabled binding" }, 400)
  }

  const invalidModel = await validateKnownCatalogModels(nextSettings)
  if (invalidModel) {
    return c.json(invalidModel, 400)
  }

  const saved = await ModelSettingsService.put(nextSettings)
  return c.json(toClientSettings(saved))
})

modelSettingsRoutes.get("/catalog", async (c) => {
  await requireAuth(c)
  return c.json(await ModelSettingsResolver.listCatalog())
})

modelSettingsRoutes.get("/resolve", async (c) => {
  const { user } = await requireAuth(c)
  const capability = c.req.query("capability")
  if (!capability || !AI_CAPABILITIES.includes(capability as (typeof AI_CAPABILITIES)[number])) {
    return c.json({ error: "capability is required" }, 400)
  }
  const resolved = await ModelSettingsResolver.resolveCapability({
    userID: user.id,
    capability: capability as (typeof AI_CAPABILITIES)[number],
  })
  return c.json(resolved)
})

modelSettingsRoutes.post("/provider-accounts/:accountID/test", async (c) => {
  const { user } = await requireAuth(c)
  const accountID = String(c.req.param("accountID") || "").trim()
  if (!accountID) return c.json({ error: "accountID is required" }, 400)
  const account = await ModelSettingsService.getAccount(user.id, accountID)
  if (!account) return c.json({ error: "provider account not found" }, 404)
  if (!account.apiKey?.trim()) return c.json({ error: "provider account api key is missing" }, 400)

  const result = await testProviderConnection({
    providerID: account.providerID,
    apiKey: account.apiKey,
    baseURL: account.baseURL,
  })

  await ModelSettingsService.patchAccountMeta({
    userID: user.id,
    accountID,
    patch: {
      lastTestAt: new Date().toISOString(),
      lastTestStatus: result.success ? "success" : "failed",
    },
  })

  if (!result.success) return c.json(result, 400)
  return c.json(result)
})

modelSettingsRoutes.post("/provider-accounts/:accountID/sync-models", async (c) => {
  const { user } = await requireAuth(c)
  const accountID = String(c.req.param("accountID") || "").trim()
  if (!accountID) return c.json({ error: "accountID is required" }, 400)
  const account = await ModelSettingsService.getAccount(user.id, accountID)
  if (!account) return c.json({ error: "provider account not found" }, 404)
  if (!account.apiKey?.trim()) return c.json({ error: "provider account api key is missing" }, 400)

  const result = await syncProviderModels({
    providerID: account.providerID,
    apiKey: account.apiKey,
    baseURL: account.baseURL,
  })
  if (!result.success) return c.json(result, 400)

  await ModelSettingsService.replaceProviderModels({
    userID: user.id,
    providerID: account.providerID,
    models: result.models,
    updateAccountIDs: [accountID],
  })
  await ModelSettingsService.patchAccountMeta({
    userID: user.id,
    accountID,
    patch: {
      lastSyncAt: result.lastSyncAt ?? new Date().toISOString(),
    },
  })
  return c.json(result)
})
