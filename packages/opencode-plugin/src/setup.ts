/** Plugin setup: registers the subagent session-reuse guard, then the four session tools. */

import type {Plugin} from '@opencode/plugin'
import type {PluginSessionApi} from './session-client.js'
import type {ToolCallBefore} from './task-reuse-guard.js'
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
}
