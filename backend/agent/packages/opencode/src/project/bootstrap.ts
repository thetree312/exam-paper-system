import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util"
import { FileWatcher } from "@/file/watcher"
import * as Effect from "effect/Effect"

export const InstanceBootstrap = Effect.gen(function* () {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  Log.Default.info("bootstrap step start", {
    directory: Instance.directory,
    step: "plugin.init",
  })
  yield* Plugin.Service.use((svc) => svc.init())
  Log.Default.info("bootstrap step completed", {
    directory: Instance.directory,
    step: "plugin.init",
  })
  Log.Default.info("bootstrap step start", {
    directory: Instance.directory,
    step: "background.init",
    services: ["lsp", "format", "file", "file_watcher", "vcs", "snapshot"],
  })
  yield* Effect.all(
    [
      LSP.Service,
      Format.Service,
      File.Service,
      FileWatcher.Service,
      Vcs.Service,
      Snapshot.Service,
    ].map((s) => Effect.forkDetach(s.use((i) => i.init()))),
  ).pipe(Effect.withSpan("InstanceBootstrap.init"))
  Log.Default.info("bootstrap step completed", {
    directory: Instance.directory,
    step: "background.init",
  })

  Log.Default.info("bootstrap step start", {
    directory: Instance.directory,
    step: "command.executed.subscribe",
  })
  yield* Bus.Service.use((svc) =>
    svc.subscribeCallback(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        Project.setInitialized(Instance.project.id)
      }
    }),
  )
  Log.Default.info("bootstrap step completed", {
    directory: Instance.directory,
    step: "command.executed.subscribe",
  })
}).pipe(Effect.withSpan("InstanceBootstrap"))
