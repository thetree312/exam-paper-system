import { app } from "./app"
import { createLogger } from "./lib/logger"
import { prewarmAgentRuntime } from "./domains/agent/service"

const port = Number(process.env.PORT ?? 3000)
const logger = createLogger({ domain: "backend", process: "main" })

process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", {
    error,
  })
})

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", {
    error: reason instanceof Error ? reason : String(reason),
  })
})

const server = Bun.serve({
  fetch: app.fetch,
  port,
  idleTimeout: 0,
})

logger.info(`backend listening on http://127.0.0.1:${server.port}`)

process.on("SIGINT", () => {
  server.stop(true)
})

process.on("SIGTERM", () => {
  server.stop(true)
})

void prewarmAgentRuntime().catch((error) => {
  logger.error("agent runtime prewarm failed", {
    error: error instanceof Error ? error.message : String(error),
  })
})
