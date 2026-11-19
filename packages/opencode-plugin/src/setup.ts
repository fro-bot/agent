/** Plugin setup: registers the subagent session-reuse guard, then the four session tools. */

import type {Plugin} from '@opencode/plugin'
import type {PluginSessionApi} from './session-client.js'
import type {ToolCallBefore} from './task-reuse-guard.js'
import process from 'node:process'
import {logPluginLine} from './log.js'
import {createPluginSessionClient} from './session-client.js'
import {createSessionTools} from './session-tools.js'
import {rejectSubagentReuse} from './task-reuse-guard.js'

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

/** Feasibility-stage switch: a traces URL turns the tracing stub on. Replaced by real settings resolution. */
const TRACING_STUB_URL_ENV = 'OPENCODE_FROBOT_TRACING_STUB_URL'

/**
 * The only way into the tracing chunk. With the switch off the `import()` never runs, so the chunk and the SDK inside it
 * are never evaluated. Any failure leaves the plugin exactly as it was.
 */
async function runTracingStub(url: string): Promise<void> {
  try {
    const tracing = await import('./tracing/index.js')
    await tracing.exportStubSpan({url})
  } catch (error) {
    // Tracing must never fail the plugin. The line names the failure class only: an error message can carry a path or URL.
    logPluginLine(`tracing could not start (${error instanceof Error ? error.name : 'unknown error'})`)
  }
}

export async function setupFroBotPlugin(host: HostSurface): Promise<void> {
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
  const stubUrl = process.env[TRACING_STUB_URL_ENV]
  if (stubUrl != null && stubUrl.length > 0) await runTracingStub(stubUrl)
}
