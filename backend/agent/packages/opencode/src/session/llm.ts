import * as Provider from "@/provider/provider"
import { Log } from "@/util"
import { Context, Effect, Layer, Record } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep, pipe } from "remeda"
import * as ProviderTransform from "@/provider/transform"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import * as Plugin from "@/plugin/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { EffectBridge } from "@/effect"
import { appendProviderParamsDump, writeInitialRequestDump } from "@/session/request-dump"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
  type Result = Awaited<ReturnType<typeof streamText>>

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    parentSessionID?: string
    model: Provider.Model
    agent: Agent.Info
    permission?: Permission.Ruleset
    system: string[]
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamRequest = StreamInput & {
    abort: AbortSignal
  }

  export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

  export interface Interface {
    readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

  const live: Layer.Layer<
    Service,
    never,
    Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const config = yield* Config.Service
      const provider = yield* Provider.Service
      const plugin = yield* Plugin.Service
      const perm = yield* Permission.Service

      const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
        const l = log
          .clone()
          .tag("providerID", input.model.providerID)
          .tag("modelID", input.model.id)
          .tag("sessionID", input.sessionID)
          .tag("small", (input.small ?? false).toString())
          .tag("agent", input.agent.name)
          .tag("mode", input.agent.mode)
        l.info("stream", {
          modelID: input.model.id,
          providerID: input.model.providerID,
        })

        const [language, cfg, item, info] = yield* Effect.all(
          [
            provider.getLanguage(input.model),
            config.get(),
            provider.getProvider(input.model.providerID),
            auth.get(input.model.providerID),
          ],
          { concurrency: "unbounded" },
        )

        // TODO: move this to a proper hook
        const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

        const system: string[] = []
        system.push(
          [
            // use agent prompt otherwise provider prompt
            ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
            // any custom prompt passed into this call
            ...input.system,
            // any custom prompt from last user message
            ...(input.user.system ? [input.user.system] : []),
          ]
            .filter((x) => x)
            .join("\n"),
        )

        const header = system[0]
        yield* plugin.trigger(
          "experimental.chat.system.transform",
          { sessionID: input.sessionID, model: input.model },
          { system },
        )
        // rejoin to maintain 2-part structure for caching if header unchanged
        if (system.length > 2 && system[0] === header) {
          const rest = system.slice(1)
          system.length = 0
          system.push(header, rest.join("\n"))
        }

        const variant =
          !input.small && input.model.variants && input.user.model.variant
            ? input.model.variants[input.user.model.variant]
            : {}
        const base = input.small
          ? ProviderTransform.smallOptions(input.model)
          : ProviderTransform.options({
              model: input.model,
              sessionID: input.sessionID,
              providerOptions: item.options,
            })
        const options: Record<string, any> = pipe(
          base,
          mergeDeep(input.model.options),
          mergeDeep(input.agent.options),
          mergeDeep(variant),
        )
        if (isOpenaiOauth) {
          options.instructions = system.join("\n")
        }

        const messages = isOpenaiOauth
          ? input.messages
          : [
              ...system.map(
                (x): ModelMessage => ({
                  role: "system",
                  content: x,
                }),
              ),
              ...input.messages,
            ]

        const params = yield* plugin.trigger(
          "chat.params",
          {
            sessionID: input.sessionID,
            agent: input.agent.name,
            model: input.model,
            provider: item,
            message: input.user,
          },
          {
            temperature: input.model.capabilities.temperature
              ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
              : undefined,
            topP: input.agent.topP ?? ProviderTransform.topP(input.model),
            topK: ProviderTransform.topK(input.model),
            maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
            options,
          },
        )

        const { headers } = yield* plugin.trigger(
          "chat.headers",
          {
            sessionID: input.sessionID,
            agent: input.agent.name,
            model: input.model,
            provider: item,
            message: input.user,
          },
          {
            headers: {},
          },
        )

        const tools = resolveTools(input)

        // LiteLLM and some Anthropic proxies require the tools parameter to be present
        // when message history contains tool calls, even if no tools are being used.
        // Add a dummy tool that is never called to satisfy this validation.
        // This is enabled for:
        // 1. Providers with "litellm" in their ID or API ID (auto-detected)
        // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
        const isLiteLLMProxy =
          item.options?.["litellmProxy"] === true ||
          input.model.providerID.toLowerCase().includes("litellm") ||
          input.model.api.id.toLowerCase().includes("litellm")

        // LiteLLM/Bedrock rejects requests where the message history contains tool
        // calls but no tools param is present. When there are no active tools (e.g.
        // during compaction), inject a stub tool to satisfy the validation requirement.
        // The stub description explicitly tells the model not to call it.
        if (
          (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
          Object.keys(tools).length === 0 &&
          hasToolCalls(input.messages)
        ) {
          tools["_noop"] = tool({
            description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
            inputSchema: jsonSchema({
              type: "object",
              properties: {
                reason: { type: "string", description: "Unused" },
              },
            }),
            execute: async () => ({ output: "", title: "", metadata: {} }),
          })
        }

        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined
        const dumpFilePath = yield* Effect.tryPromise(() =>
          writeInitialRequestDump({
            agent: input.agent.name,
            modelID: input.model.id,
            providerID: input.model.providerID,
            sessionID: input.sessionID,
            userMessageID: input.user.id,
            system,
            messages,
            tools,
            options,
            params: {
              temperature: params.temperature,
              topP: params.topP,
              topK: params.topK,
              maxOutputTokens: params.maxOutputTokens,
              toolChoice: input.toolChoice,
              activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
              headers: {
                ...(input.model.providerID.startsWith("opencode")
                  ? {
                      "x-opencode-project": Instance.project.id,
                      "x-opencode-session": input.sessionID,
                      "x-opencode-request": input.user.id,
                      "x-opencode-client": Flag.OPENCODE_CLIENT,
                    }
                  : {
                      "x-session-affinity": input.sessionID,
                      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                      "User-Agent": `opencode/${InstallationVersion}`,
                    }),
                ...input.model.headers,
                ...headers,
              },
              providerOptions: ProviderTransform.providerOptions(input.model, params.options),
            },
          }),
        ).pipe(
          Effect.tap((filePath) =>
            Effect.sync(() =>
              l.info("request dump written", {
                filePath,
              }),
            ),
          ),
          Effect.matchEffect({
            onSuccess: (filePath) => Effect.succeed(filePath),
            onFailure: (error) =>
              Effect.sync(() => {
                l.warn("request dump failed", {
                  error,
                })
                return ""
              }),
          }),
        )

        return streamText({
          onError(error) {
            l.error("stream error", {
              error,
            })
          },
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && tools[lower]) {
              l.info("repairing tool call", {
                tool: failed.toolCall.toolName,
                repaired: lower,
              })
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: params.temperature,
          topP: params.topP,
          topK: params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, params.options),
          activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
          tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: params.maxOutputTokens,
          abortSignal: input.abort,
          headers: {
            ...(input.model.providerID.startsWith("opencode")
              ? {
                  "x-opencode-project": Instance.project.id,
                  "x-opencode-session": input.sessionID,
                  "x-opencode-request": input.user.id,
                  "x-opencode-client": Flag.OPENCODE_CLIENT,
                }
              : {
                  "x-session-affinity": input.sessionID,
                  ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                  "User-Agent": `opencode/${InstallationVersion}`,
                }),
            ...input.model.headers,
            ...headers,
          },
          maxRetries: input.retries ?? 0,
          messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                  }
                  if (dumpFilePath) {
                    await appendProviderParamsDump({
                      filePath: dumpFilePath,
                      type: args.type,
                      params: args.params,
                    }).catch((error) => {
                      l.warn("provider params dump failed", {
                        error,
                        filePath: dumpFilePath,
                      })
                    })
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        })
      })

      const stream: Interface["stream"] = (input) =>
        Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              const ctrl = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (ctrl) => Effect.sync(() => ctrl.abort()),
              )

              const result = yield* run({ ...input, abort: ctrl.signal })

              return Stream.fromAsyncIterable(result.fullStream, (e) => (e instanceof Error ? e : new Error(String(e))))
            }),
          ),
        )

      return Service.of({ stream })
    }),
  )

  export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Auth.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
    ),
  )

  function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = Permission.disabled(
      Object.keys(input.tools),
      Permission.merge(input.agent.permission, input.permission ?? []),
    )
    return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
