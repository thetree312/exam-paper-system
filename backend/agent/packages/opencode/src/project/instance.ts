import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { iife } from "@/util/iife"
import { Log } from "@/util"
import { LocalContext } from "../util"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
  disabledSkills: string[]
}

const context = LocalContext.create<InstanceContext>("instance")
const cache = new Map<string, Promise<InstanceContext>>()

const disposal = {
  all: undefined as Promise<void> | undefined,
}

async function resolveProject(input: { directory: string; worktree?: string; project?: Project.Info }) {
  if (input.project && input.worktree) {
    return {
      directory: input.directory,
      worktree: input.worktree,
      project: input.project,
      disabledSkills: [] as string[],
    }
  }

  const ProjectModule = await import("./project")
  const { Layer, ManagedRuntime } = await import("effect")
  const runtime = ManagedRuntime.make(Layer.provideMerge(ProjectModule.defaultLayer, Layer.empty))
  const { project, sandbox } = await runtime.runPromise(ProjectModule.Service.use((svc) => svc.fromDirectory(input.directory)))
  return {
    directory: input.directory,
    worktree: sandbox,
    project,
    disabledSkills: [] as string[],
  }
}

function boot(input: { directory: string; init?: () => Promise<any>; worktree?: string; project?: Project.Info }) {
  return iife(async () => {
    const ctx = await resolveProject(input)
    await context.provide(ctx, async () => {
      await input.init?.()
    })
    return ctx
  })
}

function track(directory: string, next: Promise<InstanceContext>) {
  const task = next.catch((error) => {
    if (cache.get(directory) === task) cache.delete(directory)
    throw error
  })
  cache.set(directory, task)
  return task
}

export const Instance = {
  async provide<R>(input: {
    directory: string
    init?: () => Promise<any>
    fn: () => R
    worktree?: string
    project?: Project.Info
    disabledSkills?: string[]
  }): Promise<R> {
    const directory = AppFileSystem.resolve(input.directory)
    let existing = cache.get(directory)
    if (existing) {
      const cached = await existing
      const expectedWorktree = input.worktree ? AppFileSystem.resolve(input.worktree) : undefined
      const expectedProjectID = input.project?.id
      const projectMismatch =
        (expectedProjectID !== undefined && cached.project.id !== expectedProjectID) ||
        (expectedWorktree !== undefined && cached.worktree !== expectedWorktree)

      if (projectMismatch) {
        Log.Default.info("reloading instance due to project context mismatch", {
          directory,
          cached_project_id: cached.project.id,
          expected_project_id: expectedProjectID,
          cached_worktree: cached.worktree,
          expected_worktree: expectedWorktree,
        })
        cache.delete(directory)
        existing = undefined
      }
    }

    if (!existing) {
      Log.Default.info("creating instance", { directory })
      existing = track(
        directory,
        boot({
          directory,
          init: input.init,
          worktree: input.worktree,
          project: input.project,
        }),
      )
    }
    const ctx = await existing
    return context.provide(
      {
        ...ctx,
        disabledSkills: [...new Set((input.disabledSkills ?? []).map((item) => item.trim()).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b),
        ),
      },
      async () => input.fn(),
    )
  },
  get current() {
    return context.use()
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  containsPath(filepath: string, ctx?: InstanceContext) {
    const instance = ctx ?? Instance.current
    if (AppFileSystem.contains(instance.directory, filepath)) return true
    if (instance.worktree === "/") return false
    return AppFileSystem.contains(instance.worktree, filepath)
  },
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  restore<R>(ctx: InstanceContext, fn: () => R): R {
    return context.provide(ctx, fn)
  },
  async reload(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
    const directory = AppFileSystem.resolve(input.directory)
    Log.Default.info("reloading instance", { directory })
    cache.delete(directory)
    return await track(directory, boot({ ...input, directory }))
  },
  async dispose() {
    const directory = Instance.directory
    Log.Default.info("disposing instance", { directory })
    cache.delete(directory)
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      cache.clear()
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
