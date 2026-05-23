import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
  freeText: ReadonlyArray<string | null>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const responses = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => {
              const response = responses[i]
              const answerText = response?.answers.length ? response.answers.join(", ") : "Unanswered"
              const freeText = response?.freeText?.trim()
              if (!freeText) return `"${q.question}"="${answerText}"`
              if (response?.answers.length === 1 && response.answers[0] === freeText) {
                return `"${q.question}"=free text "${freeText}"`
              }
              return `"${q.question}"="${answerText}" (free text: "${freeText}")`
            })
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers: responses.map((response) => response.answers),
              freeText: responses.map((response) => response.freeText),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
