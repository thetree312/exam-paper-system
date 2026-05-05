import {
  AI_CAPABILITIES,
  MODEL_OPERATION_TYPES,
  ModelSettingsService,
  type AiCapability,
  type CapabilityBindingRecord,
  type ModelOperationType,
  type ProviderAccountRecord,
} from "./service"
import {
  classifyCatalogProviderAdapter,
  loadLocalModelsCatalog,
  resolveCatalogProviderDefaultBaseURL,
} from "./catalog"

export type ResolvedModelExecution = {
  capability: AiCapability
  providerID: string
  modelID: string
  accountID: string
  operationType: ModelOperationType
  apiKey: string
  baseURL: string
  baseURLSource: "binding_override" | "account" | "provider_default"
  source: "capability_binding" | "default_model"
  bindingID?: string
}

export type ModelCatalogEntry = {
  providerID: string
  label: string
  iconKey?: string
  defaultBaseURL?: string
  adapterNpm?: string
  adapterApi?: string
  adapterKind: "official" | "openai_compatible"
  docsUrl?: string
  envKeys: string[]
  supportedOperations: ModelOperationType[]
  models: Array<{
    modelID: string
    label: string
    operationType: ModelOperationType
    attachment?: boolean
    reasoning?: boolean
    toolCall?: boolean
    iconKey?: string
  }>
}

export type CapabilityCatalogGroup = {
  key: string
  label: string
  capabilities: Array<{
    capability: AiCapability
    label: string
    operationType: ModelOperationType
  }>
}

const OCR_LAYOUT_PROVIDER_IDS = new Set(["alibaba-cn", "siliconflow", "siliconflow-cn", "zhipu", "zhipuai"])
const SUPPORTED_PROVIDER_IDS = new Set(["alibaba-cn", "siliconflow-cn", "deepseek", "zhipu", "modelscope"])

const CAPABILITY_GROUPS: CapabilityCatalogGroup[] = [
  {
    key: "agent",
    label: "Agent",
    capabilities: [{ capability: "agent_chat", label: "Agent 对话", operationType: "chat_completion" }],
  },
  {
    key: "question",
    label: "题卡处理",
    capabilities: [
      { capability: "question_split", label: "智能拆题", operationType: "chat_completion" },
      { capability: "question_grading", label: "智能批改", operationType: "chat_completion" },
    ],
  },
  {
    key: "learning",
    label: "学习产物",
    capabilities: [
      { capability: "flashcard_generation", label: "闪卡生成", operationType: "chat_completion" },
      { capability: "flashcard_long_outline", label: "长文闪卡提纲", operationType: "chat_completion" },
      { capability: "mindmap_outline_generation", label: "脑图提纲", operationType: "chat_completion" },
      { capability: "mindmap_generation", label: "脑图生成", operationType: "chat_completion" },
    ],
  },
  {
    key: "translation",
    label: "翻译",
    capabilities: [
      { capability: "translation_math", label: "数理化输入", operationType: "chat_completion" },
      { capability: "translation_word", label: "单词翻译", operationType: "chat_completion" },
      { capability: "translation_sentence", label: "句子翻译", operationType: "chat_completion" },
    ],
  },
  {
    key: "ocr",
    label: "OCR 与文档解析",
    capabilities: [
      { capability: "studio_selection_ocr", label: "框选 OCR", operationType: "ocr_layout" },
      { capability: "document_layout_ocr", label: "全文 OCR / Layout", operationType: "ocr_layout" },
    ],
  },
]

function resolveDefaultBaseURL(providerID: string) {
  return loadLocalModelsCatalog().then((catalog) => {
    const provider = catalog[providerID]
    const baseURL = resolveCatalogProviderDefaultBaseURL(providerID, provider)
    if (!baseURL) {
      throw new Error(`Provider base URL is not configured: ${providerID}`)
    }
    return baseURL
  })
}

function resolveSupportedOperations(providerID: string) {
  if (OCR_LAYOUT_PROVIDER_IDS.has(providerID)) {
    return ["chat_completion", "ocr_layout"] satisfies ModelOperationType[]
  }
  return ["chat_completion"] satisfies ModelOperationType[]
}

async function buildProviderCatalog() {
  const catalog = await loadLocalModelsCatalog()
  return Object.entries(catalog)
    .filter(([providerID]) => SUPPORTED_PROVIDER_IDS.has(providerID))
    .map(([providerID, provider]): ModelCatalogEntry => {
      const supportedOperations = resolveSupportedOperations(providerID)
      return {
        providerID,
        label: provider.name?.trim() || providerID,
        defaultBaseURL: resolveCatalogProviderDefaultBaseURL(providerID, provider),
        adapterNpm: provider.npm?.trim(),
        adapterApi: provider.api?.trim(),
        adapterKind: classifyCatalogProviderAdapter(provider.npm),
        docsUrl: provider.doc?.trim(),
        envKeys: Array.isArray(provider.env) ? provider.env.filter((item) => typeof item === "string") : [],
        supportedOperations,
        models: Object.entries(provider.models ?? {})
          .map(([modelID, model]) => ({
            modelID,
            label: model.name?.trim() || modelID,
            operationType: "chat_completion" as const,
            attachment: Boolean(model.attachment),
            reasoning: Boolean(model.reasoning),
            toolCall: Boolean(model.tool_call),
          }))
          .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN")),
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"))
}

function resolveBindingByCapability(bindings: CapabilityBindingRecord[], capability: AiCapability) {
  return bindings.find((binding) => binding.capability === capability && binding.enabled)
}

function resolveAccount(accounts: ProviderAccountRecord[], accountID: string) {
  return accounts.find((account) => account.accountID === accountID)
}

export const ModelSettingsResolver = {
  listCapabilities() {
    return [...AI_CAPABILITIES]
  },

  async listCatalog() {
    return {
      providers: await buildProviderCatalog(),
      capabilityGroups: CAPABILITY_GROUPS,
      operationTypes: [...MODEL_OPERATION_TYPES],
    }
  },

  async resolveCapability(input: {
    userID: string
    capability: AiCapability
  }): Promise<ResolvedModelExecution> {
    const settings = await ModelSettingsService.get(input.userID)
    const binding = resolveBindingByCapability(settings.capabilityBindings, input.capability)

    if (binding) {
      const account = resolveAccount(settings.providerAccounts, binding.accountID)
      if (!account) throw new Error(`Provider account not found: ${binding.accountID}`)
      if (!account.apiKey.trim()) throw new Error(`Provider account is missing API key: ${account.label}`)

      const baseURL = binding.baseURLOverride || account.baseURL || (await resolveDefaultBaseURL(account.providerID))
      return {
        capability: input.capability,
        providerID: account.providerID,
        modelID: binding.modelID,
        accountID: account.accountID,
        operationType: binding.operationType,
        apiKey: account.apiKey,
        baseURL,
        baseURLSource: binding.baseURLOverride ? "binding_override" : account.baseURL ? "account" : "provider_default",
        source: "capability_binding",
        bindingID: binding.bindingID,
      }
    }

    const defaultModel = settings.defaultModel
    if (!defaultModel) {
      throw new Error(`Model setting is missing for capability: ${input.capability}`)
    }

    const account = resolveAccount(settings.providerAccounts, defaultModel.accountID)
    if (!account) throw new Error(`Provider account not found: ${defaultModel.accountID}`)
    if (!account.apiKey.trim()) throw new Error(`Provider account is missing API key: ${account.label}`)

    const baseURL = defaultModel.baseURLOverride || account.baseURL || (await resolveDefaultBaseURL(account.providerID))
    return {
      capability: input.capability,
      providerID: account.providerID,
      modelID: defaultModel.modelID,
      accountID: account.accountID,
      operationType: defaultModel.operationType,
      apiKey: account.apiKey,
      baseURL,
      baseURLSource: defaultModel.baseURLOverride ? "binding_override" : account.baseURL ? "account" : "provider_default",
      source: "default_model",
    }
  },
}
