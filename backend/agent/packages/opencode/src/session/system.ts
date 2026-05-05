import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"
import { loadTextAsset } from "../util/text-asset"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

const PROMPT_ANTHROPIC = loadTextAsset(import.meta.url, "./prompt/anthropic.txt")
const PROMPT_DEFAULT = loadTextAsset(import.meta.url, "./prompt/default.txt")
const PROMPT_BEAST = loadTextAsset(import.meta.url, "./prompt/beast.txt")
const PROMPT_GEMINI = loadTextAsset(import.meta.url, "./prompt/gemini.txt")
const PROMPT_GPT = loadTextAsset(import.meta.url, "./prompt/gpt.txt")
const PROMPT_KIMI = loadTextAsset(import.meta.url, "./prompt/kimi.txt")
const PROMPT_CODEX = loadTextAsset(import.meta.url, "./prompt/codex.txt")
const PROMPT_TRINITY = loadTextAsset(import.meta.url, "./prompt/trinity.txt")

export namespace SystemPrompt {
  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) {
      if (model.api.id.includes("codex")) {
        return [PROMPT_CODEX]
      }
      return [PROMPT_GPT]
    }
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
    return [PROMPT_DEFAULT]
  }

  export interface Interface {
    readonly environment: (model: Provider.Model) => string[]
    readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const skill = yield* Skill.Service

      return Service.of({
        environment(model) {
          const project = Instance.project
          return [
            [
              `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
              `Here is some useful information about the environment you are running in:`,
              `<env>`,
              `  Working directory: ${Instance.directory}`,
              `  Workspace root folder: ${Instance.worktree}`,
              `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
              `  Platform: ${process.platform}`,
              `  Today's date: ${new Date().toDateString()}`,
              `</env>`,
            ].join("\n"),
          ]
        },

        skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
          if (Permission.disabled(["skill"], agent.permission).has("skill")) return

          const list = yield* skill.available(agent)

          return [
            "Skills provide specialized instructions and workflows for specific tasks.",
            "Use the skill tool to load a skill when a task matches its description.",
            // the agents seem to ingest the information about skills a bit better if we present a more verbose
            // version of them here and a less verbose version in tool description, rather than vice versa.
            Skill.fmt(list, { verbose: true }),
          ].join("\n")
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))
}
