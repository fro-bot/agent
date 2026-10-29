import type {HostSurface} from './setup.js'

import {describe, expect, it, vi} from 'vitest'

import plugin, {FRO_BOT_PLUGIN_ID} from './index.js'
import {SESSION_TOOL_NAMES} from './session-tools.js'
import {setupFroBotPlugin} from './setup.js'
import {TASK_REUSE_REJECTION} from './task-reuse-guard.js'

type Added = Parameters<Parameters<HostSurface['tool']['transform']>[0]>[0] extends {add: (tool: infer T) => void}
  ? T
  : never
type BeforeCallback = Parameters<HostSurface['tool']['hook']>[1]

function fakeHost() {
  const added: Added[] = []
  const order: string[] = []
  let before: BeforeCallback | undefined
  const session = {
    list: vi.fn(async () => ({
      data: [
        {
          id: 'ses_1',
          projectID: 'proj',
          time: {created: 1, updated: 2},
          title: 'a session',
          location: {directory: '/work/repo'},
        },
      ],
    })),
    get: vi.fn(async () => null),
    context: vi.fn(async () => []),
  }
  const host: HostSurface = {
    location: {directory: '/work/repo'},
    session,
    tool: {
      async transform(callback) {
        order.push('tools')
        callback({
          add: tool => {
            added.push(tool)
          },
        })
        return {dispose: async () => {}}
      },
      async hook(name, callback) {
        order.push(`hook:${name}`)
        before = callback
        return {dispose: async () => {}}
      },
    },
  }
  return {host, session, added, order, before: () => before}
}

describe('plugin identity', () => {
  it('has a stable, explicit id and a setup function', () => {
    // #given the default export the host loads
    // #when / #then
    expect(FRO_BOT_PLUGIN_ID).toBe('fro-bot.opencode-plugin')
    expect(plugin.id).toBe(FRO_BOT_PLUGIN_ID)
    expect(typeof plugin.setup).toBe('function')
  })
})

describe('setupFroBotPlugin', () => {
  it('registers the reuse guard before the tools', async () => {
    // #given
    const {host, order} = fakeHost()

    // #when
    await setupFroBotPlugin(host)

    // #then a failure to register the guard must surface before anything else is exposed
    expect(order).toEqual(['hook:execute.before', 'tools'])
  })

  it('wires the guard hook to the subagent rule', async () => {
    // #given
    const {host, before} = fakeHost()
    await setupFroBotPlugin(host)

    // #when / #then
    const hook = before()
    expect(hook).toBeDefined()
    await expect(Promise.resolve(hook?.({tool: 'subagent', input: {sessionID: 'ses_abc'}}))).rejects.toThrow(
      TASK_REUSE_REJECTION,
    )
    await expect(Promise.resolve(hook?.({tool: 'subagent', input: {prompt: 'fresh'}}))).resolves.toBeUndefined()
  })

  it('exposes the four session tools as direct tools, outside Code Mode', async () => {
    // #given
    const {host, added} = fakeHost()

    // #when
    await setupFroBotPlugin(host)

    // #then
    expect(added.map(tool => tool.name)).toEqual(Object.values(SESSION_TOOL_NAMES))
    for (const tool of added) {
      expect(tool.options).toEqual({codemode: false})
      expect(tool.description.length).toBeGreaterThan(0)
    }
  })

  it('runs a tool against ctx.session and returns text content', async () => {
    // #given
    const {host, added, session} = fakeHost()
    await setupFroBotPlugin(host)
    const list = added.find(tool => tool.name === 'session_list')

    // #when
    // The tools ignore the call context; only the abort signal is real here.
    const context = {signal: new AbortController().signal} as Parameters<Added['execute']>[1]
    const result = await list?.execute({}, context)

    // #then the workspace directory is the plugin location, and the tool answers with plain text content
    expect(session.list).toHaveBeenCalledWith(expect.objectContaining({directory: '/work/repo'}))
    expect(result).toEqual({content: `ses_1  a session  updated ${new Date(2).toISOString()}`})
  })

  it('propagates a hook registration failure so the host marks the plugin failed', async () => {
    // #given a host that cannot register the guard
    const {host} = fakeHost()
    const broken: HostSurface = {
      ...host,
      tool: {
        transform: async callback => host.tool.transform(callback),
        hook: async () => {
          throw new Error('hook registration refused')
        },
      },
    }

    // #when / #then
    await expect(setupFroBotPlugin(broken)).rejects.toThrow('hook registration refused')
  })
})
