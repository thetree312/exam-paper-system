import { loadBackendEnv } from "./lib/load-env"

loadBackendEnv()

import { Hono } from "hono"
import { cors } from "hono/cors"
import { randomUUID } from "node:crypto"
import { createLogger } from "./lib/logger"
import { runWithLogContext } from "./lib/logger"
import { agentRoutes } from "./routes/agent"
import { authRoutes } from "./routes/auth"
import { documentRoutes } from "./routes/documents"
import { exportRoutes } from "./routes/export"
import { favoritesRoutes } from "./routes/favorites"
import { learningArtifactsRoutes } from "./routes/learning-artifacts"
import { modelSettingsRoutes } from "./routes/model-settings"
import { questionsRoutes } from "./routes/questions"
import { problemCardsRoutes } from "./routes/problem-cards"
import { studioRoutes } from "./routes/studio"
import { taxonomiesRoutes } from "./routes/taxonomies"
import { translationRoutes } from "./routes/translation"
import { wikiRoutes } from "./routes/wiki"
import { workroomRoutes } from "./routes/workrooms"

function getAllowedOrigins() {
  const configured =
    process.env.ALLOWED_ORIGINS ??
    process.env.FRONTEND_URL ??
    "http://localhost:5173,http://127.0.0.1:5173"

  return configured
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolveCorsOrigin(origin: string | undefined, allowedOrigins: Set<string>) {
  if (!origin) return "*"
  return allowedOrigins.has(origin) ? origin : null
}

export function createApp() {
  const app = new Hono()
  const allowedOrigins = new Set(getAllowedOrigins())
  const logger = createLogger({ domain: "backend" })

  app.use(
    "/api/*",
    cors({
      origin: (origin) => resolveCorsOrigin(origin, allowedOrigins),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["Content-Length", "Content-Type"],
      credentials: true,
    }),
  )

  app.use("/api/*", async (c, next) => {
    const startedAt = Date.now()
    const requestID = randomUUID()
    const method = c.req.method
    const path = c.req.path

    await runWithLogContext({ request_id: requestID }, async () => {
      logger.info("request started", {
        method,
        path,
      })

      await next()

      logger.info("request completed", {
        method,
        path,
        status_code: c.res.status,
        duration_ms: Date.now() - startedAt,
      })
    })
  })

  app.onError((error, c) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? ((error as { statusCode: number }).statusCode ?? 400)
        : 400

    logger.error("request failed", {
      status_code: statusCode,
      method: c.req.method,
      path: c.req.path,
      error: error.message,
      stack: error.stack,
    })

    const origin = resolveCorsOrigin(c.req.header("origin"), allowedOrigins)
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
    })
    if (origin) {
      headers.set("access-control-allow-origin", origin)
      headers.set("vary", "Origin")
      headers.set("access-control-allow-credentials", "true")
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status: statusCode,
      headers,
    })
  })

  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      agent: "ready",
    }),
  )

  app.route("/api/auth", authRoutes)
  app.route("/api/workrooms", workroomRoutes)
  app.route("/api/model-settings", modelSettingsRoutes)
  app.route("/api/agent", agentRoutes)
  app.route("/api/wiki", wikiRoutes)
  app.route("/api/questions", questionsRoutes)
  app.route("/api/problem-cards", problemCardsRoutes)
  app.route("/api/studio", studioRoutes)
  app.route("/api/favorites", favoritesRoutes)
  app.route("/api/learning-artifacts", learningArtifactsRoutes)
  app.route("/api/documents", documentRoutes)
  app.route("/api/taxonomies", taxonomiesRoutes)
  app.route("/api/translation", translationRoutes)
  app.route("/api/export", exportRoutes)

  return app
}

export const app = createApp()
