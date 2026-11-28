/** Plugin setup: registers the subagent session-reuse guard (two hooks), then the four session tools. */

import type {Plugin} from '@opencode/plugin'
import type {PluginSessionApi} from './session-client.js'
import type {ToolCallBefore} from './task-reuse-guard.js'
import type {ObserverHost} from './tracing/record-observations.js'
import process from 'node:process'
import {logPluginLine} from './log.js'
import {createPluginSessionClient} from './session-client.js'
import {createSessionTools} from './session-tools.js'
import {createSubagentResumeGuard} from './task-reuse-guard.js'
import {readLauncherHost, resolveTracingSettings, type TracingSettings} from './tracing/settings.js'

type ToolEditor = Parameters<Parameters<Plugin.Context['tool']['transform']>[0]>[0]
type ToolInfo = Parameters<ToolEditor['add']>[0]

/**
 * The slice of `Plugin.Context` this plugin uses: the session tools, the reuse guard and, when tracing is on, the
 * observer hooks and the event stream. Structural, so a fake host can stand in and the real context still fits.
 */
export interface HostSurface {
  readonly location: {readonly directory: string}
  /** The host application (`Plugin.Context.app`). Only its version is read, for the trace resource. */
  readonly app?: {readonly version?: string | undefined} | undefined
  readonly session: PluginSessionApi & ObserverHost['session']
  readonly tool: {
    transform: (callback: (editor: Pick<ToolEditor, 'add'>) => void) => Promise<unknown>
    hook: {
      (name: 'execute.before', callback: (event: ToolCallBefore) => Promise<void> | void): Promise<unknown>
      (name: 'execute.after', callback: (event: unknown) => void): Promise<unknown>
    }
  }
  readonly event: ObserverHost['event']
}

/** Cleanup the host runs when the location shuts down. */
export type PluginCleanup = () => Promise<void>

/**
 * The only way into the tracing chunk. Called only when settings resolved to on, so with tracing off the dynamic import never
 * runs and the chunk and the SDK inside it are never evaluated. Every step (the import, SDK construction, hook
 * registration, and later the cleanup) is wrapped: a failure leaves the plugin exactly as it was, and the one log line
 * names the failure class only, since an error message can carry a path or URL.
 */
async function startTracing(
  host: HostSurface,
  settings: Extract<TracingSettings, {mode: 'on'}>,
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): Promise<PluginCleanup | undefined> {
  try {
    const tracing = await import('./tracing/index.js')
    const handle = await tracing.startTracing(
      {
        session: host.session,
        tool: {
          hook: async (name, callback) =>
            name === 'execute.before' ? host.tool.hook(name, callback) : host.tool.hook(name, callback),
        },
        event: host.event,
      },
      settings,
      {env, log, ...(typeof host.app?.version === 'string' ? {opencodeVersion: host.app.version} : {})},
    )
    return async () => {
      try {
        await handle.stop()
      } catch (error) {
        log(`tracing cleanup failed (${error instanceof Error ? error.name : 'unknown error'})`)
      }
    }
  } catch (error) {
    log(`tracing could not start (${error instanceof Error ? error.name : 'unknown error'})`)
    return undefined
  }
}

/** What `setupFroBotPlugin` reads from outside the host: injected so tests need no real environment. */
export interface SetupOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly log?: (line: string) => void
}

export async function setupFroBotPlugin(
  host: HostSurface,
  options: SetupOptions = {},
): Promise<PluginCleanup | undefined> {
  // The guard goes first: if it cannot be registered the plugin fails before exposing any tool. Its record of dispatched
  // children lives in this closure, so a reload starts empty and refuses every resume until a new dispatch is seen.
  const env = options.env ?? process.env
  const guard = createSubagentResumeGuard({actionHost: readLauncherHost(env) === 'action'})
  await host.tool.hook('execute.before', async event => {
    guard.before(event)
  })
  await host.tool.hook('execute.after', event => {
    guard.after(event)
  })

  const tools = createSessionTools({
    client: createPluginSessionClient(host.session),
    directory: host.location.directory,
  })
  await host.tool.transform(editor => {
    for (const spec of [tools.list, tools.read, tools.search, tools.info]) {
      const tool: ToolInfo = {
        name: spec.name,
        // Direct tools: the prompt names them, so they stay out of the Code Mode catalog.
        options: {codemode: false},
        description: spec.description,
        input: spec.input,
        execute: async (input: Readonly<Record<string, unknown>>) => ({content: await spec.run(input)}),
      }
      editor.add(tool)
    }
  })

  // Last, and never able to fail the registrations above. The settings decision lives outside the lazy chunk.
  const log = options.log ?? logPluginLine
  const settings = resolveTracingSettings({
    env,
    directory: host.location.directory,
    log,
  })
  if (settings.mode !== 'on') return undefined
  return startTracing(host, settings, env, log)
}
