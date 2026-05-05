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

const rt = ManagedRuntime.make(Layer.mergeAll(Npm.defaultLayer,AppFileSystem.defaultLayer,Bus.defaultLayer,Auth.defaultLayer,Config.defaultLayer,Git.defaultLayer,Ripgrep.defaultLayer,File.defaultLayer,FileWatcher.defaultLayer,Storage.defaultLayer,Snapshot.defaultLayer,Plugin.defaultLayer,Provider.defaultLayer,ProviderAuth.defaultLayer,Agent.defaultLayer))
const t=Date.now()
const res = await Promise.race([
  rt.runPromise(Effect.succeed('ok')).then(()=> 'OK').catch((e)=> 'ERR:'+String(e)),
  new Promise<string>((r)=>setTimeout(()=>r('TIMEOUT'),30000))
])
console.log(res,Date.now()-t)
await rt.dispose().catch(()=>{})
