type BunServeOptions = {
  fetch: (request: Request, server?: unknown) => Response | Promise<Response>
  port?: number
  idleTimeout?: number
}

type BunServer = {
  readonly port: number
  stop(closeActiveConnections?: boolean): void
}

declare const Bun: {
  serve(options: BunServeOptions): BunServer
}
