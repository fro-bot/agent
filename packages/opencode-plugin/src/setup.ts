/** Plugin setup: registers the subagent session-reuse guard, then the four session tools. */

import type {Plugin} from '@opencode/plugin'
import type {PluginSessionApi} from './session-client.js'
import type {ToolCallBefore} from './task-reuse-guard.js'
import process from 'node:process'
import {logPluginLine} from './log.js'
import {createPluginSessionClient} from './session-client.js'
import {createSessionTools} from './session-tools.js'
import {rejectSubagentReuse} from './task-reuse-guard.js'
import {resolveTracingSettings, type TracingSettings} from './tracing/settings.js'

type ToolEditor = Parameters<Parameters<Plugin.Context['tool']['transform']>[0]>[0]
type ToolInfo = Parameters<ToolEditor['add']>[0]

/** The slice of `Plugin.Context` this plugin uses. */
export interface HostSurface {
  readonly location: {readonly directory: string}
  readonly session: PluginSessionApi
  readonly tool: {
    transform: (callback: (editor: Pick<ToolEditor, 'add'>) => void) => Promise<unknown>
    hook: (name: 'execute.before', callback: (event: ToolCallBefore) => Promise<void> | void) => Promise<unknown>
  }
}

/**
 * The only way into the tracing chunk. Called only when settings resolved to on, so with tracing off the `import()` never
 * runs and the chunk and the SDK inside it are never evaluated. Any failure leaves the plugin exactly as it was.
 */
async function runTracingStub(
  settings: Extract<TracingSettings, {mode: 'on'}>,
  log: (line: string) => void,
): Promise<void> {
  try {
    const tracing = await import('./tracing/index.js')
    // Feasibility stub until the exporter is wired: one span to the resolved endpoint.
    await tracing.exportStubSpan({
      url: settings.endpoint,
      ...(settings.host === 'local' ? {headers: settings.headers} : {}),
    })
  } catch (error) {
    // Tracing must never fail the plugin. The line names the failure class only: an error message can carry a path or URL.
    log(`tracing could not start (${error instanceof Error ? error.name : 'unknown error'})`)
  }
}

/** What `setupFroBotPlugin` reads from outside the host: injected so tests need no real environment. */
export interface SetupOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly log?: (line: string) => void
}

export async function setupFroBotPlugin(host: HostSurface, options: SetupOptions = {}): Promise<void> {
  // The guard goes first: if it cannot be registered the plugin fails before exposing any tool.
  await host.tool.hook('execute.before', async event => {
    rejectSubagentReuse(event)
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
    env: options.env ?? process.env,
    directory: host.location.directory,
    log,
  })
  if (settings.mode === 'on') await runTracingStub(settings, log)
}
