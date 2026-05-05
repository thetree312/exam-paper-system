import z from "zod"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { loadTextAsset } from "../util/text-asset"
const DESCRIPTION_WRITE = loadTextAsset(import.meta.url, "./todowrite.txt")
import { Todo } from "../session/todo"
import { ZodOverride } from "@/util/effect-zod"

const parametersZod = z.object({
  todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
})
const parameters = Schema.declare<unknown>((u): u is unknown => parametersZod.safeParse(u).success).annotate({
  [ZodOverride]: parametersZod,
})

type Metadata = {
  todos: Todo.Info[]
}

export const TodoWriteTool = Tool.define<typeof parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters,
      execute: (params: z.infer<typeof parametersZod>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          yield* todo.update({
            sessionID: ctx.sessionID,
            todos: params.todos,
          })

          return {
            title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
            output: JSON.stringify(params.todos, null, 2),
            metadata: {
              todos: params.todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
