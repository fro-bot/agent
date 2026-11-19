import type {HostSurface} from './setup.js'
import type {ToolCallBefore} from './task-reuse-guard.js'

import {afterEach, describe, expect, it, vi} from 'vitest'

import plugin, {FRO_BOT_PLUGIN_ID} from './index.js'
import {SESSION_TOOL_NAMES} from './session-tools.js'
import {setupFroBotPlugin} from './setup.js'
import {TASK_REUSE_REJECTION} from './task-reuse-guard.js'
import {TRACING_LAUNCHER_ENV} from './tracing/settings.js'

type Added = Parameters<Parameters<HostSurface['tool']['transform']>[0]>[0] extends {add: (tool: infer T) => void}
  ? T
  : never
type BeforeCallback = (event: ToolCallBefore) => Promise<void> | void

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
    hook: vi.fn(async () => ({dispose: async () => {}})),
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
      hook: async (name: string, callback: (event: never) => unknown) => {
        order.push(`hook:${name}`)
        if (name === 'execute.before') before = callback as BeforeCallback
        return {dispose: async () => {}}
      },
    },
    event: {subscribe: () => (async function* () {})()},
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

/** Loads a fresh `setup.ts` so a per-test `vi.doMock` of the tracing module takes effect. */
async function freshSetup() {
  vi.resetModules()
  return import('./setup.js')
}

const RELAY = 'http://127.0.0.1:43211/v1/traces'
const ON = JSON.stringify({
  version: 1,
  host: 'action',
  tracing: 'on',
  relay: RELAY,
  identity: {repository: 'fro-bot/agent', runId: '1', attempt: '1', job: 'j', trigger: 'push'},
})
/** An environment with no launcher variable, no headless marker and no user file anywhere. */
const LOCAL_WITHOUT_FILE = {HOME: '/nonexistent/fro-bot-home', XDG_CONFIG_HOME: '/nonexistent/fro-bot-xdg'}

describe('the lazy tracing entry', () => {
  afterEach(() => {
    vi.doUnmock('./tracing/index.js')
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it.each([
    ['no launcher and no user file', LOCAL_WITHOUT_FILE],
    [
      'a launcher that says off',
      {[TRACING_LAUNCHER_ENV]: JSON.stringify({version: 1, host: 'action', tracing: 'off'})},
    ],
    ['a headless host with no launcher', {OPENCODE_PASSWORD: 'x', OPENCODE_CONFIG_CONTENT: '{}'}],
  ])('never evaluates the tracing module with %s', async (_label, env) => {
    // #given a tracing module that counts its evaluations
    const evaluated = vi.fn()
    vi.doMock('./tracing/index.js', () => {
      evaluated()
      return {startTracing: vi.fn()}
    })
    const {setupFroBotPlugin: setup} = await freshSetup()
    const {host, order} = fakeHost()

    // #when the plugin sets up
    await setup(host, {env, log: () => {}})

    // #then the plugin is registered as usual and the tracing module was never loaded
    expect(order).toEqual(['hook:execute.before', 'tools'])
    expect(evaluated).not.toHaveBeenCalled()
  })

  it('ignores plugin options that carry an endpoint, in every mode', async () => {
    // #given a host whose plugin options name a collector, in a local session, a headless one and an Action one that says off
    const evaluated = vi.fn()
    vi.doMock('./tracing/index.js', () => {
      evaluated()
      return {startTracing: vi.fn()}
    })
    const {setupFroBotPlugin: setup} = await freshSetup()
    const options = {
      tracing: {endpoint: 'https://evil.example/v1/traces', headers: {authorization: 'x'}},
      endpoint: 'https://evil.example',
    }

    // #when the plugin sets up in each mode
    for (const env of [
      LOCAL_WITHOUT_FILE,
      {OPENCODE_PASSWORD: 'x', OPENCODE_CONFIG_CONTENT: '{}'},
      {[TRACING_LAUNCHER_ENV]: JSON.stringify({version: 1, host: 'action', tracing: 'off'})},
    ]) {
      const {host} = fakeHost()
      await setup({...host, options} as typeof host, {env, log: () => {}})
    }

    // #then none of them turned tracing on
    expect(evaluated).not.toHaveBeenCalled()
  })

  it('loads the tracing module once and hands it the settings the launcher carried', async () => {
    // #given a tracing module and an Action launcher variable
    const stop = vi.fn(async () => {})
    const startTracing = vi.fn(
      async (_host: Pick<HostSurface, 'session' | 'event' | 'tool'>, _settings: unknown, _deps: unknown) => ({stop}),
    )
    vi.doMock('./tracing/index.js', () => ({startTracing}))
    const {setupFroBotPlugin: setup} = await freshSetup()
    const {host} = fakeHost()
    const env = {[TRACING_LAUNCHER_ENV]: ON}
    const log = () => {}

    // #when the plugin sets up
    const cleanup = await setup(host, {env, log})

    // #then tracing started once with the relay address and identity, and no headers: the credential never reaches it
    expect(startTracing).toHaveBeenCalledOnce()
    const [handed, settings, deps] = startTracing.mock.calls[0] as Parameters<typeof startTracing>
    expect(handed.session).toBe(host.session)
    expect(handed.event).toBe(host.event)
    expect(typeof handed.tool.hook).toBe('function')
    expect(settings).toEqual({
      mode: 'on',
      host: 'action',
      endpoint: RELAY,
      identity: {repository: 'fro-bot/agent', runId: '1', attempt: '1', job: 'j', trigger: 'push'},
    })
    expect(deps).toEqual({env, log})

    // #and the host gets a cleanup that stops tracing
    await cleanup?.()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('routes the observer hooks to the host, by name', async () => {
    // #given a tracing module that registers both tool hooks through the handed host
    const names: string[] = []
    vi.doMock('./tracing/index.js', () => ({
      startTracing: async (handed: {tool: {hook: (name: string, callback: () => void) => Promise<unknown>}}) => {
        await handed.tool.hook('execute.before', () => {})
        await handed.tool.hook('execute.after', () => {})
        return {stop: async () => {}}
      },
    }))
    const {setupFroBotPlugin: setup} = await freshSetup()
    const {host, order} = fakeHost()
    host.tool.hook = async (name: string) => {
      names.push(name)
      return {dispose: async () => {}}
    }

    // #when
    await setup(host, {env: {[TRACING_LAUNCHER_ENV]: ON}, log: () => {}})

    // #then the guard and both observer hooks reached the host's own hook function
    expect(names).toEqual(['execute.before', 'execute.before', 'execute.after'])
    expect(order).toContain('tools')
  })

  it('wraps the cleanup: a stop that throws leaves one fixed line and no rejection', async () => {
    // #given a tracing handle whose stop throws with a secret-looking message
    const lines: string[] = []
    vi.doMock('./tracing/index.js', () => ({
      startTracing: async () => ({
        stop: async () => {
          throw new TypeError('https://user:hunter2@collector.example/v1/traces')
        },
      }),
    }))
    const {setupFroBotPlugin: setup} = await freshSetup()
    const {host} = fakeHost()
    const cleanup = await setup(host, {env: {[TRACING_LAUNCHER_ENV]: ON}, log: line => lines.push(line)})

    // #when the host runs the cleanup
    await expect(cleanup?.()).resolves.toBeUndefined()

    // #then
    expect(lines).toEqual(['tracing cleanup failed (TypeError)'])
  })

  it('returns no cleanup when tracing is off', async () => {
    // #given / #when
    const {setupFroBotPlugin: setup} = await freshSetup()
    const {host} = fakeHost()

    // #then
    await expect(setup(host, {env: LOCAL_WITHOUT_FILE, log: () => {}})).resolves.toBeUndefined()
  })

  it('ignores plugin options and the project config: they cannot turn tracing on', async () => {
    // #given a host whose plugin options name an endpoint, and a tracing module that counts evaluations
    const evaluated = vi.fn()
    vi.doMock('./tracing/index.js', () => {
      evaluated()
      return {startTracing: vi.fn()}
    })
    const {setupFroBotPlugin: setup} = await freshSetup()
    const {host} = fakeHost()
    const withOptions = {...host, options: {endpoint: 'https://evil.example/v1/traces', tracing: true}}

    // #when the plugin sets up in a local session with no user file
    await setup(withOptions, {env: LOCAL_WITHOUT_FILE, log: () => {}})

    // #then tracing stayed off
    expect(evaluated).not.toHaveBeenCalled()
  })

  it('logs one fixed line for a refused launcher and still registers everything', async () => {
    // #given a launcher naming a public relay
    const lines: string[] = []
    vi.doMock('./tracing/index.js', () => ({startTracing: vi.fn()}))
    const {setupFroBotPlugin: setup} = await freshSetup()
    const {host, order} = fakeHost()
    const refused = JSON.stringify({...JSON.parse(ON), relay: 'http://203.0.113.9:4318/v1/traces'})

    // #when the plugin sets up
    await setup(host, {env: {[TRACING_LAUNCHER_ENV]: refused}, log: line => lines.push(line)})

    // #then
    expect(order).toEqual(['hook:execute.before', 'tools'])
    expect(lines).toEqual(['tracing off (launcher-relay-invalid)'])
  })

  it.each([
    ['the module fails to load', 'import'],
    ['the SDK fails to construct', 'run'],
  ] as const)('keeps the plugin intact and logs one fixed line when %s', async (_label, failure) => {
    // #given a tracing module that fails at import or at run time, with a secret-looking message
    const secret = 'https://user:hunter2@collector.example/v1/traces'
    if (failure === 'import') {
      vi.doMock('./tracing/index.js', () => {
        throw new TypeError(secret)
      })
    } else {
      vi.doMock('./tracing/index.js', () => ({
        startTracing: async () => {
          throw new RangeError(secret)
        },
      }))
    }
    const lines: string[] = []
    const {setupFroBotPlugin: setup} = await freshSetup()
    const {host, added, order, before} = fakeHost()

    // #when the plugin sets up
    await expect(
      setup(host, {env: {[TRACING_LAUNCHER_ENV]: ON}, log: line => lines.push(line)}),
    ).resolves.toBeUndefined()

    // #then the guard and the tools are registered exactly as without tracing
    expect(order).toEqual(['hook:execute.before', 'tools'])
    expect(added.map(tool => tool.name)).toEqual(Object.values(SESSION_TOOL_NAMES))
    await expect(Promise.resolve(before()?.({tool: 'subagent', input: {sessionID: 'ses_abc'}}))).rejects.toThrow(
      TASK_REUSE_REJECTION,
    )

    // #and one line names the failure class and carries nothing from the error message
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^tracing could not start \(\w+\)$/)
    expect(lines.join('')).not.toContain('hunter2')
  })
})
