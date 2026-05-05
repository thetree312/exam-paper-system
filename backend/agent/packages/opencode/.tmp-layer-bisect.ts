import { Layer, ManagedRuntime, Effect } from 'effect'
import { Npm } from '@opencode-ai/shared/npm'
import { AppFileSystem } from '@opencode-ai/shared/filesystem'
import { Bus } from '@/bus'
import { Auth } from '@/auth'
import { Config } from '@/config'
import { Git } from '@/git'
import { Ripgrep } from '@/file/ripgrep'
import { File } from '@/file'
import { FileWatcher } from '@/file/watcher'
import { Storage } from '@/storage'
import { Snapshot } from '@/snapshot'
import { Plugin } from '@/plugin'
import { Provider } from '@/provider/provider'
import { ProviderAuth } from '@/provider/auth'
import { Agent } from '@/agent/agent'
import { Skill } from '@/skill'
import { Discovery } from '@/skill/discovery'
import { Question } from '@/question'
import { Permission } from '@/permission'
import { Todo } from '@/session/todo'
import { Session } from '@/session'
import { SessionStatus } from '@/session/status'
import { SessionRunState } from '@/session/run-state'
import { SessionProcessor } from '@/session/processor'
import { SessionCompaction } from '@/session/compaction'
import { SessionRevert } from '@/session/revert'
import { SessionSummary } from '@/session/summary'
import { SessionPrompt } from '@/session/prompt'
import { SessionShare } from '@/share'
import { Instruction } from '@/session/instruction'
import { LLM } from '@/session/llm'
import { LSP } from '@/lsp'
import { MCP } from '@/mcp'
import { McpAuth } from '@/mcp/auth'
import { Command } from '@/command'
import { Truncate } from '@/tool'
import { ToolRegistry } from '@/tool'
import { Format } from '@/format'
import { Project } from '@/project'
import { Vcs } from '@/project'
import { Worktree } from '@/worktree'
import { Pty } from '@/pty'
import { Installation } from '@/installation'

const groups = [
  ['base', [Npm.defaultLayer,AppFileSystem.defaultLayer,Bus.defaultLayer,Auth.defaultLayer,Config.defaultLayer,Git.defaultLayer,Ripgrep.defaultLayer,File.defaultLayer,FileWatcher.defaultLayer,Storage.defaultLayer,Snapshot.defaultLayer]],
  ['plugin-provider', [Plugin.defaultLayer,Provider.defaultLayer,ProviderAuth.defaultLayer]],
  ['agent-skill', [Agent.defaultLayer,Skill.defaultLayer,Discovery.defaultLayer]],
  ['session-a', [Question.defaultLayer,Permission.defaultLayer,Todo.defaultLayer,Session.defaultLayer,SessionStatus.defaultLayer,SessionRunState.defaultLayer]],
  ['session-b', [SessionProcessor.defaultLayer,SessionCompaction.defaultLayer,SessionRevert.defaultLayer,SessionSummary.defaultLayer,SessionPrompt.defaultLayer,SessionShare.defaultLayer]],
  ['rest', [Instruction.defaultLayer,LLM.defaultLayer,LSP.defaultLayer,MCP.defaultLayer,McpAuth.defaultLayer,Command.defaultLayer,Truncate.defaultLayer,ToolRegistry.defaultLayer,Format.defaultLayer,Project.defaultLayer,Vcs.defaultLayer,Worktree.defaultLayer,Pty.defaultLayer,Installation.defaultLayer]],
]
let layers:any[]=[]
for (const [name, adds] of groups) {
  layers = layers.concat(adds as any[])
  const layer = Layer.mergeAll(...layers)
  const rt = ManagedRuntime.make(layer)
  const t = Date.now()
  const ok = await Promise.race([
    rt.runPromise(Effect.succeed('ok')).then(()=>true).catch((e)=>{console.error('err',name,e); return false}),
    new Promise<boolean>((resolve)=>setTimeout(()=>resolve(false),5000)),
  ])
  console.log(name, ok ? 'OK':'TIMEOUT', Date.now()-t)
  await rt.dispose().catch(()=>{})
  if (!ok) break
}
process.exit(0)
