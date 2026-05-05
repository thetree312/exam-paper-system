import { Hono } from "hono"
import { z } from "zod"
import { ProblemCardService } from "../domains/problem-cards/service"
import { requireAuth } from "./auth-context"

const submitSchema = z.object({
  workroomID: z.string().min(1),
  user_answer: z.string().min(1),
  input_source: z.enum(["option", "text", "mixed"]),
})

const workroomBodySchema = z.object({
  workroomID: z.string().min(1),
})

export const problemCardsRoutes = new Hono()

problemCardsRoutes.post("/:problemCardID/answer-mode", async (c) => {
  const { user } = await requireAuth(c)
  const body = workroomBodySchema.parse(await c.req.json())
  return c.json(
    await ProblemCardService.enterAnswerMode({
      userID: user.id,
      workroomID: body.workroomID,
      problemCardID: c.req.param("problemCardID"),
    }),
  )
})

problemCardsRoutes.post("/:problemCardID/submit", async (c) => {
  const { user } = await requireAuth(c)
  const body = submitSchema.parse(await c.req.json())
  return c.json(
    await ProblemCardService.submit({
      userID: user.id,
      workroomID: body.workroomID,
      problemCardID: c.req.param("problemCardID"),
      userAnswer: body.user_answer,
      inputSource: body.input_source,
    }),
    201,
  )
})

problemCardsRoutes.post("/:problemCardID/studio", async (c) => {
  const { user } = await requireAuth(c)
  const body = workroomBodySchema.parse(await c.req.json())
  return c.json(
    await ProblemCardService.addToStudio({
      userID: user.id,
      workroomID: body.workroomID,
      problemCardID: c.req.param("problemCardID"),
    }),
  )
})

problemCardsRoutes.post("/:problemCardID/finish-review", async (c) => {
  const { user } = await requireAuth(c)
  const body = workroomBodySchema.parse(await c.req.json())
  return c.json(
    await ProblemCardService.finishReview({
      userID: user.id,
      workroomID: body.workroomID,
      problemCardID: c.req.param("problemCardID"),
    }),
  )
})

problemCardsRoutes.get("/:problemCardID/learning-detail", async (c) => {
  const { user } = await requireAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")
  return c.json(
    await ProblemCardService.getLearningDetail({
      userID: user.id,
      workroomID,
      problemCardID: c.req.param("problemCardID"),
    }),
  )
})

