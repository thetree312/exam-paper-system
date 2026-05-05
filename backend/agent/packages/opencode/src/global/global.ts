import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"
import { Context, Effect, Layer } from "effect"
import * as Filesystem from "../util/filesystem"
import { Flock } from "@opencode-ai/shared/util/flock"

const app = "opencode"

const data = path.join(process.env.XDG_DATA_HOME ?? xdgData!, app)
const cache = path.join(process.env.XDG_CACHE_HOME ?? xdgCache!, app)
const config = path.join(process.env.XDG_CONFIG_HOME ?? xdgConfig!, app)
const state = path.join(process.env.XDG_STATE_HOME ?? xdgState!, app)

export const Path = {
  get home() {
    return process.env.OPENCODE_TEST_HOME || os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  cache,
  config,
  state,
}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly bin: string
  readonly log: string
  readonly cache: string
  readonly config: string
  readonly state: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    home: Path.home,
    data: Path.data,
    bin: Path.bin,
    log: Path.log,
    cache: Path.cache,
    config: Path.config,
    state: Path.state,
  }),
)

export const defaultLayer = layer

export const get = Effect.fn("Global.get")(function* () {
  return yield* Service
})

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
])

const CACHE_VERSION = "21"
const version = await Filesystem.readText(path.join(Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch {}
  await Filesystem.write(path.join(Path.cache, "version"), CACHE_VERSION)
}
