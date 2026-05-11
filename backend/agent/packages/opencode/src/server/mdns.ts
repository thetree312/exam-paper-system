import { Log } from "@/util"

const log = Log.create({ service: "mdns" })

export namespace MDNS {
  let currentPort: number | undefined

  export function publish(port: number, domain?: string) {
    if (currentPort === port) return
    currentPort = port
    log.info("mDNS publish skipped", {
      port,
      domain: domain ?? "opencode.local",
    })
  }

  export function unpublish() {
    if (currentPort !== undefined) {
      currentPort = undefined
      log.info("mDNS unpublish skipped")
    }
  }
}
