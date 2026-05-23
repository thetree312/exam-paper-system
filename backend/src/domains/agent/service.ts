import path from "node:path"
import { promises as fs } from "node:fs"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { createLogger } from "../../lib/logger"
import { AgentSkillSettingsService } from "../agent-skill-settings/service"
import { ModelSettingsService } from "../model-settings/service"
import { StudioBridgeTokenRepository } from "../studio/bridge-token-repository"
import {
  classifyCatalogProviderAdapter,
  getLocalCatalogProvider,
  resolveCatalogProviderDefaultBaseURL,
} from "../model-settings/catalog"
import { WorkroomService, type WorkroomRecord } from "../workrooms/service"

type PermissionRule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

type AgentWorkroomScope = {
  workroom: WorkroomRecord
}

type AgentScopeOptions = {
  syncUserSettings?: boolean
  bootstrap?: boolean
}

type AgentProjectInfo = {
  id: string
  worktree: string
  vcs?: "git"
  name?: string
  time: {
    created: number
    updated: number
    initialized?: number
  }
  sandboxes: string[]
}

function mergeAgentConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    if (
      current &&
      value &&
      typeof current === "object" &&
      typeof value === "object" &&
      !Array.isArray(current) &&
      !Array.isArray(value)
    ) {
      result[key] = mergeAgentConfig(current as Record<string, unknown>, value as Record<string, unknown>)
      continue
    }
    result[key] = value
  }
  return result
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const studioQuestionCardsCliPath = path.join(repoRoot, "backend", "src", "cli", "studio-question-cards.ts")
const lectureCliPath = path.join(repoRoot, "backend", "src", "cli", "lecture.ts")
const localModelsCatalogPath = path.join(repoRoot, "backend", "vendor", "models.dev", "dist", "_api.json")
const logger = createLogger({ domain: "agent", source: "runtime" })
export const STUDIO_QUESTION_CARDS_BRIDGE_GUIDE_VERSION = "studio-question-cards-bridge@v15"
let initializePromise: Promise<void> | undefined
let opencodeModulesPromise: Promise<any> | undefined
const instanceBootstrapByDirectory = new Map<string, Promise<void>>()
const opencodeImportBase = "@/"

export function buildAgentBridgeWrapper(input: {
  bridgeBaseURL: string
  bridgeToken: string
  userID: string
  workroomID: string
  cliImportPath: string
  entrypoint: string
}) {
  return [
    "export {}",
    "",
    `process.env.STUDIO_QUESTION_CARDS_BRIDGE_BASE_URL = ${JSON.stringify(input.bridgeBaseURL)}`,
    `process.env.STUDIO_QUESTION_CARDS_BRIDGE_TOKEN = ${JSON.stringify(input.bridgeToken)}`,
    `process.env.STUDIO_QUESTION_CARDS_SCOPE_USER_ID = ${JSON.stringify(input.userID)}`,
    `process.env.STUDIO_QUESTION_CARDS_SCOPE_WORKROOM_ID = ${JSON.stringify(input.workroomID)}`,
    `const { ${input.entrypoint} } = await import(${JSON.stringify(input.cliImportPath.replace(/\\/g, "/"))})`,
    `const exitCode = await ${input.entrypoint}(process.argv.slice(2))`,
    `if (typeof exitCode === "number" && exitCode !== 0) process.exit(exitCode)`,
    "",
  ].join("\n")
}

async function importOpencode(modulePath: string) {
  return import(`${opencodeImportBase}${modulePath}`)
}

function configureAgentEnvironment(rootDirectory: string) {
  const runtimeHome = path.join(rootDirectory, "backend", "local-data", "agent")
  process.env.XDG_DATA_HOME ??= path.join(runtimeHome, "xdg", "data")
  process.env.XDG_STATE_HOME ??= path.join(runtimeHome, "xdg", "state")
  process.env.XDG_CACHE_HOME ??= path.join(runtimeHome, "xdg", "cache")
  process.env.XDG_CONFIG_HOME ??= path.join(runtimeHome, "xdg", "config")
  process.env.OPENCODE_MODELS_PATH ??= path.join(rootDirectory, "backend", "vendor", "models.dev", "dist", "_api.json")
  process.env.OPENCODE_DISABLE_MODELS_FETCH ??= "1"
  process.env.OPENCODE_DISABLE_CONFIG_DEPENDENCY_INSTALL ??= "1"
}

async function ensureLocalModelsCatalogExists() {
  const filepath = process.env.OPENCODE_MODELS_PATH ?? localModelsCatalogPath
  try {
    await fs.access(filepath)
  } catch {
    throw new Error(
      `Local models catalog not found at ${filepath}. Run \`bun --cwd backend run models:build\` to generate it from backend/vendor/models.dev.`,
    )
  }
}

async function migrateLegacyGlobalAgentConfig() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  if (!xdgConfigHome) return

  const primaryLegacyFiles = [
    "opencode.jsonc",
    "opencode.json",
    "config.json",
  ].map((file) => path.join(xdgConfigHome, file))
  const canonicalDir = path.join(xdgConfigHome, "opencode")
  const canonicalFile = path.join(canonicalDir, "opencode.jsonc")
  const canonicalExists = await fs
    .stat(canonicalFile)
    .then(() => true)
    .catch(() => false)

  const fallbackBackupFiles = canonicalExists
    ? []
    : ["opencode.jsonc.migrated.bak", "opencode.json.migrated.bak", "config.json.migrated.bak"].map((file) =>
        path.join(xdgConfigHome, file),
      )

  const legacyFiles = [...primaryLegacyFiles, ...fallbackBackupFiles]

  for (const legacyFile of legacyFiles) {
    try {
      await fs.stat(legacyFile)
      await fs.mkdir(canonicalDir, { recursive: true })
      const legacyText = await fs.readFile(legacyFile, "utf8")
      const canonicalText = await fs.readFile(canonicalFile, "utf8").catch(() => "{}")
      const legacyConfig = JSON.parse(legacyText) as Record<string, unknown>
      const canonicalConfig = JSON.parse(canonicalText) as Record<string, unknown>
      const mergedConfig = mergeAgentConfig(canonicalConfig, legacyConfig)
      await fs.writeFile(canonicalFile, `${JSON.stringify(mergedConfig, null, 2)}\n`, "utf8")
      logger.warn("migrated legacy opencode config into canonical directory", {
        legacy_file: legacyFile,
        canonical_file: canonicalFile,
      })

      if (!legacyFile.endsWith(".migrated.bak")) {
        const backupFile = `${legacyFile}.migrated.bak`
        await fs.rm(backupFile, { force: true })
        await fs.rename(legacyFile, backupFile)
      }
    } catch {}
  }
}

async function initializeAgentRuntime() {
  if (!initializePromise) {
    initializePromise = (async () => {
      logger.info("agent runtime initialize start")
      configureAgentEnvironment(AppFileSystem.resolve(repoRoot))
      await ensureLocalModelsCatalogExists()
      await migrateLegacyGlobalAgentConfig()
      logger.info("agent runtime initialize environment ready", {
        models_path: process.env.OPENCODE_MODELS_PATH,
        models_fetch_disabled: process.env.OPENCODE_DISABLE_MODELS_FETCH,
      })
      const [{ init: initAgentLog }] = await Promise.all([
        importOpencode("util/log"),
      ])
      await initAgentLog({
        print: false,
        level: (process.env.AGENT_RUNTIME_LOG_LEVEL as "DEBUG" | "INFO" | "WARN" | "ERROR" | undefined) ?? "WARN",
        externalLogger: {
          log(input: any) {
            const context = input.context ?? {}
            if (input.level === "DEBUG") return logger.debug(input.message, context)
            if (input.level === "INFO") return logger.info(input.message, context)
            if (input.level === "WARN") return logger.warn(input.message, context)
            return logger.error(input.message, context)
          },
        },
      })
      await importOpencode("server/projectors")
      logger.info("agent runtime initialize completed")
    })()
  }
  return initializePromise
}

async function loadOpencodeModules() {
  await initializeAgentRuntime()
  if (!opencodeModulesPromise) {
    opencodeModulesPromise = (async () => {
      logger.info("agent runtime modules load start")
      const [
        { AppRuntime },
        { Auth },
        { Config },
        { Bus },
        { InstanceBootstrap },
        { Instance },
        { Project },
        { ProjectID },
        { Session },
        { SessionID },
        { SessionPrompt },
        { SessionShare },
        { Permission },
        { PermissionID },
        { Question },
        { QuestionID },
        { Agent },
        { Global },
        { MCP },
        { McpAuth },
        { Skill },
        { Provider },
      ] =
        await Promise.all([
          importOpencode("effect/app-runtime"),
          importOpencode("auth"),
          importOpencode("config"),
          importOpencode("bus"),
          importOpencode("project/bootstrap"),
          importOpencode("project/instance"),
          importOpencode("project"),
          importOpencode("project/schema"),
          importOpencode("session"),
          importOpencode("session/schema"),
          importOpencode("session/prompt"),
          importOpencode("share"),
          importOpencode("permission"),
          importOpencode("permission/schema"),
          importOpencode("question"),
          importOpencode("question/schema"),
          importOpencode("agent/agent"),
          importOpencode("global/global"),
          importOpencode("mcp"),
          importOpencode("mcp/auth"),
          importOpencode("skill"),
          importOpencode("provider/provider"),
        ])
      logger.info("agent runtime modules load completed")
      return {
        AppRuntime,
        Auth,
        Config,
        Bus,
        InstanceBootstrap,
        Instance,
        Project,
        ProjectID,
        Session,
        SessionID,
        SessionPrompt,
        SessionShare,
        Permission,
        PermissionID,
        Question,
        QuestionID,
        Agent,
        Global,
        MCP,
        McpAuth,
        Skill,
        Provider,
      }
    })()
  }
  return opencodeModulesPromise
}

export async function loadAgentRuntimeModules() {
  return loadOpencodeModules()
}

export function buildWorkroomSessionPermission(): PermissionRule[] {
  return [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "question", pattern: "*", action: "allow" },
    { permission: "plan_enter", pattern: "*", action: "allow" },
    { permission: "plan_exit", pattern: "*", action: "allow" },
  ]
}

async function syncAgentUserSettings(userID: string) {
  const { AppRuntime, Auth, Config } = await loadOpencodeModules()
  const runWithTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = 3000): Promise<T> => {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error(`agent runtime timeout: ${label}`)), timeoutMs)
      }),
    ])
  }
  const settings = await ModelSettingsService.get(userID)
  const preferredAgentModel = await ModelSettingsService.resolveModel({
    userID,
    capability: "agent_chat",
  })
  const syncedByProvider = new Map<string, { providerID: string; apiKey: string; baseURL?: string }>()

  for (const account of settings.providerAccounts) {
    if (!account.apiKey.trim()) continue
    if (syncedByProvider.has(account.providerID)) continue
    syncedByProvider.set(account.providerID, {
      providerID: account.providerID,
      apiKey: account.apiKey,
      baseURL: account.baseURL,
    })
  }

  if (preferredAgentModel) {
    const preferredAccount = settings.providerAccounts.find((account) => account.providerID === preferredAgentModel.providerID)
    if (preferredAccount?.apiKey.trim()) {
      syncedByProvider.set(preferredAccount.providerID, {
        providerID: preferredAccount.providerID,
        apiKey: preferredAccount.apiKey,
        baseURL: preferredAccount.baseURL,
      })
    }
  }

  const accounts = [...syncedByProvider.values()]
  const configuredProviders = new Set(accounts.map((item) => item.providerID))
  const current = (await runWithTimeout(
    AppRuntime.runPromise(Auth.Service.use((auth: any) => auth.all())),
    "auth.all",
  ).catch((error) => {
    logger.warn("agent auth sync skipped current auth scan due to timeout", {
      user_id: userID,
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  })) as Record<string, { type?: string }>

  for (const [providerID, info] of Object.entries(current)) {
    if (info.type !== "api") continue
    if (configuredProviders.has(providerID)) continue
    await runWithTimeout(AppRuntime.runPromise(Auth.Service.use((auth: any) => auth.remove(providerID))), `auth.remove:${providerID}`).catch(
      (error) => {
        logger.warn("agent auth remove timed out", {
          user_id: userID,
          provider_id: providerID,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }

  for (const account of accounts) {
    const providerCatalog = await getLocalCatalogProvider(account.providerID)
    logger.info("agent provider sync resolved adapter", {
      provider_id: account.providerID,
      resolved_npm: providerCatalog?.npm,
      resolved_api: providerCatalog?.api,
      adapter_kind: classifyCatalogProviderAdapter(providerCatalog?.npm),
      default_base_url: resolveCatalogProviderDefaultBaseURL(account.providerID, providerCatalog),
      account_base_url: account.baseURL,
      set_cache_key: Boolean(account.baseURL),
    })
    await runWithTimeout(
      AppRuntime.runPromise(
        Auth.Service.use((auth: any) =>
          auth.set(
            account.providerID,
            new Auth.Api({
              type: "api",
              key: account.apiKey,
            }),
          ),
        ),
      ),
      `auth.set:${account.providerID}`,
    ).catch((error) => {
      logger.warn("agent auth set timed out", {
        user_id: userID,
        provider_id: account.providerID,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const globalConfig = await AppRuntime.runPromise(Config.Service.use((config: any) => config.getGlobal()))
  const existingProviders =
    globalConfig?.provider && typeof globalConfig.provider === "object"
      ? (globalConfig.provider as Record<string, Record<string, unknown>>)
      : {}

  await AppRuntime.runPromise(
    Config.Service.use((config: any) =>
      config.updateGlobal({
        model: preferredAgentModel ? `${preferredAgentModel.providerID}/${preferredAgentModel.modelID}` : undefined,
        provider: Object.fromEntries(
          accounts
            .map((account) => [
              account.providerID,
              (() => {
                const existingProvider =
                  existingProviders[account.providerID] && typeof existingProviders[account.providerID] === "object"
                    ? existingProviders[account.providerID]
                    : {}
                const existingOptions =
                  existingProvider.options && typeof existingProvider.options === "object"
                    ? (existingProvider.options as Record<string, unknown>)
                    : {}
                const nextOptions: Record<string, unknown> = {
                  ...existingOptions,
                  ...(account.baseURL ? { baseURL: account.baseURL } : {}),
                }

                if (account.baseURL && nextOptions.setCacheKey === undefined) {
                  nextOptions.setCacheKey = true
                }

                return {
                  ...existingProvider,
                  options: nextOptions,
                }
              })(),
            ])
            .filter((entry) => {
              const provider = entry[1] as Record<string, unknown>
              if (Object.keys(provider).length === 0) return false
              const options = provider.options
              return !options || (typeof options === "object" && Object.keys(options as Record<string, unknown>).length > 0)
            }),
        ),
      }),
    ),
  )
}

async function resolveWorkroom(userID: string, workroomID: string) {
  const workroom = await WorkroomService.getByUser(userID, workroomID)
  if (!workroom) throw new Error(`Workroom not found: ${workroomID}`)
  return workroom
}

function resolveBackendBaseURL() {
  const configured = process.env.AGENT_BRIDGE_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, "")
  const port = Number(process.env.PORT ?? 3000)
  return `http://127.0.0.1:${Number.isFinite(port) ? port : 3000}`
}

async function materializeAgentCommandBridges(input: {
  rootDirectory: string
  bridgeBaseURL: string
  bridgeToken: string
  userID: string
  workroomID: string
}) {
  const relativeWrapperPath = path.join("wiki", ".agent", "bin", "studio-question-cards.ts")
  const wrapperPath = path.join(input.rootDirectory, relativeWrapperPath)
  await fs.mkdir(path.dirname(wrapperPath), { recursive: true })
  const wrapper = buildAgentBridgeWrapper({
    bridgeBaseURL: input.bridgeBaseURL,
    bridgeToken: input.bridgeToken,
    userID: input.userID,
    workroomID: input.workroomID,
    cliImportPath: studioQuestionCardsCliPath,
    entrypoint: "runStudioQuestionCardsCli",
  })
  const current = await fs.readFile(wrapperPath, "utf8").catch(() => null)
  if (current === wrapper) return
  await fs.writeFile(wrapperPath, wrapper, "utf8")

  const lectureWrapperPath = path.join(input.rootDirectory, "wiki", ".agent", "bin", "lecture.ts")
  await fs.mkdir(path.dirname(lectureWrapperPath), { recursive: true })
  const lectureWrapper = buildAgentBridgeWrapper({
    bridgeBaseURL: input.bridgeBaseURL,
    bridgeToken: input.bridgeToken,
    userID: input.userID,
    workroomID: input.workroomID,
    cliImportPath: lectureCliPath,
    entrypoint: "runLectureCli",
  })
  const currentLecture = await fs.readFile(lectureWrapperPath, "utf8").catch(() => null)
  if (currentLecture !== lectureWrapper) {
    await fs.writeFile(lectureWrapperPath, lectureWrapper, "utf8")
  }
}

export function buildStudioQuestionCardsCommandGuide(input: {
  userID: string
  workroomID: string
  workroomRootDirectory: string
}) {
  const commandPath = "wiki/.agent/bin/studio-question-cards.ts"
  return [
    `[guide-version:${STUDIO_QUESTION_CARDS_BRIDGE_GUIDE_VERSION}]`,
    `Bridge scope is already fixed to userID=${JSON.stringify(input.userID)} and workroomID=${JSON.stringify(input.workroomID)} in agent runtime. Do not invent studioDocumentID, sourceDocumentID, anchorCardID, cardID, or other internal IDs.`,
    `Available question-card commands: bun ${commandPath} q-search --query <text> [--limit <n>] ; bun ${commandPath} q-get --card-id <id> | --question-number <n> ; bun ${commandPath} q-create ... ; bun ${commandPath} q-insert ... ; bun ${commandPath} q-similar ...`,
    "Question commands call the backend question API directly.",
    "q-search returns only compact card summaries. q-get returns a launch-ready detail view by default: cardID, question number, original question text, answer, explanation, grading-AI question recommendation, suggested difficulty, and the latest wrong-reason summary.",
    "After q-get --question-number <n>, use the returned cardID directly. Do not search again for the card ID.",
    "Debugging must go to backend logs or request dumps, not back into agent tool context.",
    "Pass the full question body with --text whenever you create or insert a card. Use --stem only as a compatibility fallback.",
    "Optional answer, explanation, and metadata are allowed. Options are only a compatibility input and must not replace the full question text.",
    "Do not use any list-style command to enumerate all cards. Use q-search only when fuzzy lookup is needed.",
    "Do not base64-encode question text. Do not write temporary files.",
    "Use q-create for append. Use q-insert for insertion around a 1-based question number. Use q-similar for one-shot generate-and-insert around a 1-based question number.",
  ].join("\n")
}

export function buildLectureCommandGuide(input: {
  sessionID: string
  studioDocumentID?: string | null
}) {
  const commandPath = "wiki/.agent/bin/lecture.ts"
  return [
    "[guide-version:lecture-bridge@v2]",
    "If the user asks to explain a question, teach a question, walk through a question like a teacher, or requests 讲解/讲题/像老师一样讲, do not answer with a full explanation directly in the chat sidebar.",
    "For explanation intent, you must enter lecture flow first: resolve the target card with studio-question-cards q-get or q-search, then run lecture launch.",
    "When the user references a numbered question such as 第一题/第1题/question 1, resolve it with q-get --question-number <n> before launching lecture. Do not fabricate card IDs.",
    "lecture launch only creates or recovers the lecture container. The actual teaching must come from a native opencode child task delegated by the parent agent.",
    "Do not use lecture append-block, answer, render-html, complete, or any other lecture bridge command from the parent session.",
    "After launch succeeds, immediately delegate a native task subagent of type lecture. Do not answer the question in the parent chat sidebar.",
    "Use the launch result JSON fields taskDescription and taskPrompt verbatim for the delegated lecture child task. Do not rewrite them in the parent chat.",
    "The delegated task prompt must carry the launch result JSON fields you just received, especially question text and available highlight targets.",
    "Use a short task description that names the lecture topic or question without embedding internal session ids.",
    `Use bun ${commandPath} launch --card-id <cardID> --origin-agent-session-id ${JSON.stringify(input.sessionID)} to create or recover a lecture session.`,
    input.studioDocumentID
      ? `Current studioDocumentID is ${JSON.stringify(input.studioDocumentID)}. Pass --studio-document-id ${JSON.stringify(input.studioDocumentID)} whenever you already know the target card is in the current题卡集.`
      : "If studioDocumentID is unknown, launch can infer it from cardID.",
    "Do not fabricate lectureSessionID, cardID, studioDocumentID, or target ids. Use the q-get output cardID and the launch result JSON; do not search again for card IDs.",
    "For the lecture child task, do not pass --session-id to lecture bridge commands. The bridge resolves the current lecture container automatically.",
    "When the lecture child writes text that contains LaTeX, it must preserve literal `$...$` / `$$...$$` delimiters. Use UTF-8 temp files or single-quoted here-strings in PowerShell; do not write lecture text through double-quoted PowerShell strings.",
    "When the lecture child appends or answers with source highlights, it must pass `--highlight-spans-env <ENV>` and provide a JSON array of exact quotes from the current source blocks. Do not leave highlight spans empty when quoting the question stem or options.",
  ].join("\n")
}

export function analyzeLectureIntentPrompt(promptText: string) {
  const normalized = promptText.trim()
  const isLectureIntent =
    /讲解|讲题|像老师一样讲|带我做|带我分析|引导我|一步一步讲|walk through|teach me|explain (this|the) question|socratic/i.test(
      normalized,
    )
  const numbered =
    normalized.match(/第\s*(\d+)\s*题/) ??
    normalized.match(/\bquestion\s*(\d+)\b/i) ??
    normalized.match(/\bq\s*(\d+)\b/i)
  return {
    isLectureIntent,
    questionNumber: numbered ? Number(numbered[1]) : null,
  }
}

export function buildLectureIntentDirective(input: {
  questionNumber?: number | null
}) {
  return [
    "[lecture-intent:confirmed]",
    "This turn is confirmed lecture intent.",
    "You must complete lecture entry in this turn instead of answering directly in the parent chat sidebar.",
    input.questionNumber != null
      ? `Resolve the target card with q-get --question-number ${input.questionNumber} unless the user already supplied a concrete card id.`
      : "Resolve the target card with q-get or q-search before launching lecture.",
    "After launch succeeds, immediately delegate the lecture child subagent with the launch result taskDescription and taskPrompt.",
    "The parent chat may only tell the user that the lecture entrance is ready. The actual teaching must happen in the delegated lecture child session.",
  ]
    .filter(Boolean)
    .join("\n")
}

export async function withAgentScope<T>(
  input: { userID: string; workroomID: string; syncUserSettings?: boolean },
  fn: (scope: AgentWorkroomScope) => Promise<T>,
  options?: AgentScopeOptions,
): Promise<T> {
  const { AppRuntime, InstanceBootstrap, Instance, Project, ProjectID } = await loadOpencodeModules()
  const workroom = await resolveWorkroom(input.userID, input.workroomID)
  const scopeOptions: Required<AgentScopeOptions> = {
    syncUserSettings: input.syncUserSettings !== false,
    bootstrap: options?.bootstrap === true,
  }

  const rootDirectory = AppFileSystem.resolve(workroom.rootDirectory)
  logger.info("agent scope enter", {
    user_id: input.userID,
    workroom_id: input.workroomID,
    root_directory: rootDirectory,
    sync_user_settings: scopeOptions.syncUserSettings,
    bootstrap: scopeOptions.bootstrap,
  })
  const project: AgentProjectInfo = {
    id: ProjectID.make(workroom.id),
    worktree: rootDirectory,
    name: workroom.name,
    time: {
      created: Date.parse(workroom.createdAt) || Date.now(),
      updated: Date.parse(workroom.updatedAt) || Date.now(),
    },
    sandboxes: [],
  }
  logger.info("agent scope project context prepared", {
    workroom_id: input.workroomID,
    root_directory: rootDirectory,
    project_id: project.id,
  })
  const disabledSkillNames = await getDisabledSkillNames(input.userID)
  logger.info("agent scope disabled skills loaded", {
    workroom_id: input.workroomID,
    disabled_skills_count: disabledSkillNames.length,
  })

  const ensureInstanceBootstrapped = async () => {
    let pending = instanceBootstrapByDirectory.get(rootDirectory)
    if (!pending) {
      logger.info("agent scope bootstrap start", {
        workroom_id: input.workroomID,
        root_directory: rootDirectory,
      })
      const createdPromise = AppRuntime.runPromise(InstanceBootstrap).catch((error: unknown) => {
        if (instanceBootstrapByDirectory.get(rootDirectory) === createdPromise) {
          instanceBootstrapByDirectory.delete(rootDirectory)
        }
        logger.error("agent scope bootstrap failed", {
          workroom_id: input.workroomID,
          root_directory: rootDirectory,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        throw error
      })
      createdPromise.then(() => {
        logger.info("agent scope bootstrap completed", {
          workroom_id: input.workroomID,
          root_directory: rootDirectory,
        })
      }).catch(() => {})
      instanceBootstrapByDirectory.set(rootDirectory, createdPromise)
      pending = createdPromise
    }
    await pending
  }

  return Instance.provide({
    directory: rootDirectory,
    worktree: rootDirectory,
    project,
    disabledSkills: disabledSkillNames,
    fn: async () => {
      logger.info("agent scope instance entered", {
        workroom_id: input.workroomID,
        root_directory: rootDirectory,
        project_id: project.id,
        project_worktree: project.worktree,
      })
      if (scopeOptions.bootstrap) {
        await ensureInstanceBootstrapped()
      }
      const bridgeToken = await StudioBridgeTokenRepository.issue({
        userID: input.userID,
        workroomID: input.workroomID,
      })
      await materializeAgentCommandBridges({
        rootDirectory,
        bridgeBaseURL: resolveBackendBaseURL(),
        bridgeToken: bridgeToken.token,
        userID: input.userID,
        workroomID: input.workroomID,
      })
      await AppRuntime.runPromise(
        Project.Service.use((svc: any) =>
          svc.ensureWorkspace({
            id: project.id,
            directory: rootDirectory,
            name: workroom.name,
          }),
        ),
      )
      if (scopeOptions.syncUserSettings) {
        logger.info("agent scope sync user settings start", {
          workroom_id: input.workroomID,
          root_directory: rootDirectory,
        })
        await syncAgentUserSettings(input.userID)
        logger.info("agent scope sync user settings completed", {
          workroom_id: input.workroomID,
          root_directory: rootDirectory,
        })
      }
      const result = await fn({ workroom })
      logger.info("agent scope fn completed", {
        workroom_id: input.workroomID,
        root_directory: rootDirectory,
      })
      return result
    },
  })
}

export async function resolveAgentModel(input: {
  userID: string
  model?: { providerID: string; modelID: string }
}) {
  return (
    input.model ??
    (await ModelSettingsService.resolveModel({
      userID: input.userID,
      capability: "agent_chat",
    }))
  )
}

export { syncAgentUserSettings }

export async function prewarmAgentRuntime() {
  await loadOpencodeModules()
}

export async function disposeAgent() {
  if (!opencodeModulesPromise) {
    initializePromise = undefined
    return
  }

  try {
    const modules = await opencodeModulesPromise
    const runtime = modules?.AppRuntime as { dispose?: () => Promise<void> | void } | undefined
    if (runtime?.dispose) {
      await runtime.dispose()
    }
  } catch {}

  opencodeModulesPromise = undefined
  initializePromise = undefined
}

export async function getDisabledSkillNames(userID: string) {
  const settings = await AgentSkillSettingsService.get(userID)
  return settings.disabledSkillNames
}
