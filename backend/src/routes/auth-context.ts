import type { Context } from "hono"
import { AuthService } from "../domains/auth/service"

export async function requireAuth(c: Context) {
  const authorization = c.req.header("authorization")?.trim()
  if (!authorization) throw new Error("Missing authorization header")
  if (!authorization.startsWith("Bearer ")) throw new Error("Authorization header must use Bearer token")
  return AuthService.resolveSession(authorization.slice("Bearer ".length))
}

export function requireUserID() {
  throw new Error("requireUserID is deprecated, use await requireAuth(c)")
}