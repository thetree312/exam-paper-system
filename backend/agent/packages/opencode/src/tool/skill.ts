import path from "path"
import { pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Ripgrep } from "../file/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "The name of the skill from available_skills",
  }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    const description = [
      "Load a specialized skill that provides domain-specific instructions and workflows.",
      "",
      "Use this tool when the current task matches one of the skills exposed by the runtime.",
      "",
      'Tool output includes a `<skill_content name=\"...\">` block with the loaded content.',
    ].join("\n")

    return () =>
      Effect.gen(function* () {
        return {
          description,
          parameters: Parameters,
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const info = yield* skill.get(params.name)
              if (!info) {
                const currentAgent = yield* agent.get(ctx.agent)
                const availableSkills = yield* skill.available(currentAgent)
                const available = availableSkills.map((item) => item.name).join(", ")
                throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
              }

              const currentAgent = yield* agent.get(ctx.agent)
              const availableSkills = yield* skill.available(currentAgent)
              if (!availableSkills.some((item) => item.name === info.name)) {
                const available = availableSkills.map((item) => item.name).join(", ")
                throw new Error(`Skill "${params.name}" is not available. Available skills: ${available || "none"}`)
              }

              yield* ctx.ask({
                permission: "skill",
                patterns: [params.name],
                always: [params.name],
                metadata: {},
              })

              const dir = path.dirname(info.location)
              const base = pathToFileURL(dir).href
              const limit = 10
              const files = yield* rg.files({ cwd: dir, follow: false, hidden: true, signal: ctx.abort }).pipe(
                Stream.filter((file) => !file.includes("SKILL.md")),
                Stream.map((file) => path.resolve(dir, file)),
                Stream.take(limit),
                Stream.runCollect,
                Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
              )

              return {
                title: `Loaded skill: ${info.name}`,
                output: [
                  `<skill_content name="${info.name}">`,
                  `# Skill: ${info.name}`,
                  "",
                  info.content.trim(),
                  "",
                  `Base directory for this skill: ${base}`,
                  "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
                  "Note: file list is sampled.",
                  "",
                  "<skill_files>",
                  files,
                  "</skill_files>",
                  "</skill_content>",
                ].join("\n"),
                metadata: {
                  name: info.name,
                  dir,
                },
              }
            }).pipe(Effect.orDie),
        }
      })
  }),
)
