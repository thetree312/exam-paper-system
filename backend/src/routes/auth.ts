import { Hono } from "hono"
import { z } from "zod"
import { AuthService } from "../domains/auth/service"
import { requireAuth } from "./auth-context"

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).optional(),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

export const authRoutes = new Hono()

authRoutes.post("/register", async (c) => {
  const body = registerSchema.parse(await c.req.json())
  return c.json(await AuthService.register(body), 403)
})

authRoutes.post("/login", async (c) => {
  const body = loginSchema.parse(await c.req.json())
  return c.json(await AuthService.login(body))
})

authRoutes.get("/me", async (c) => {
  const auth = await requireAuth(c)
  return c.json({
    user: auth.user,
    sessionID: auth.session.id,
  })
})

authRoutes.post("/logout", async (c) => {
  const auth = await requireAuth(c)
  await AuthService.logout(auth.session.token)
  return c.json({
    sessionID: auth.session.id,
    status: "logged_out",
  })
})
