/**
 * Loads the built plugin into a real OpenCode V2 binary. Skipped unless `FRO_BOT_OPENCODE_V2_BIN` points at one and
 * `dist/index.mjs` exists.
 */

import type {FakeProvider, OtlpSink, RunningServer, SandboxPaths} from './integration.fixture.js'

import {cpSync, existsSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {
  makeSandbox,
  removeSandbox,
  startFakeProvider,
  startOpenCodeServer,
  startOtlpSink,
} from './integration.fixture.js'
import {FRO_BOT_PLUGIN_ID} from './plugin-id.js'
import {TASK_REUSE_REJECTION} from './task-reuse-guard.js'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binary = process.env.FRO_BOT_OPENCODE_V2_BIN
const built = existsSync(path.join(packageDir, 'dist/index.mjs'))
const runnable = binary != null && binary.length > 0 && existsSync(binary) && built

const POLL_MS = 100
const STEP_TIMEOUT_MS = 30_000

async function waitFor<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : []
}

function dataOf(response: {readonly data: unknown}): unknown {
  return typeof response.data === 'object' && response.data !== null ? Reflect.get(response.data, 'data') : undefined
}

describe.skipIf(!runnable)('built plugin in a real opencode V2', () => {
  let provider: FakeProvider
  let server: RunningServer
  let sandbox: SandboxPaths

  const countIdle = async (sessionID: string): Promise<number> => {
    const response = await server.api('GET', `/api/session/${sessionID}/message`)
    return records(dataOf(response)).filter(message => message.type === 'idle').length
  }

  /** Sends a prompt and waits for the turn that follows `idleBefore` completed turns to go idle. */
  const prompt = async (sessionID: string, text: string, idleBefore: number): Promise<void> => {
    const sent = await server.api('POST', `/api/session/${sessionID}/prompt`, {body: {text}})
    expect(sent.status).toBe(200)
    await waitFor(`turn ${idleBefore + 1} of ${sessionID} to go idle`, async () =>
      (await countIdle(sessionID)) > idleBefore ? true : undefined,
    )
  }

  /** Tool results the model saw in the most recent request, keyed by tool name. */
  const lastToolResults = (): Map<string, string> => {
    const last = provider.requests.at(-1)
    const names = new Map<string, string>()
    for (const message of last?.messages ?? []) {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name)
    }
    const results = new Map<string, string>()
    for (const message of last?.messages ?? []) {
      if (message.role !== 'tool' || message.tool_call_id == null) continue
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      results.set(names.get(message.tool_call_id) ?? message.tool_call_id, content)
    }
    return results
  }

  beforeAll(async () => {
    sandbox = makeSandbox()
    provider = await startFakeProvider()
    server = await startOpenCodeServer({
      binary: binary ?? '',
      sandbox,
      pluginDir: packageDir,
      providerBaseURL: provider.baseURL,
    })
  }, 90_000)

  afterAll(async () => {
    await server?.stop()
    await provider?.stop()
    if (sandbox != null) removeSandbox(sandbox)
  }, 30_000)

  it('reports the plugin as loaded and active under its stable id', async () => {
    // #given the server has booted with the package directory in `plugins`
    // #when the plugin list settles
    const entry = await waitFor('the fro-bot plugin to be listed', async () => {
      const response = await server.api('GET', '/api/plugin')
      return records(dataOf(response)).find(plugin => plugin.id === FRO_BOT_PLUGIN_ID)
    })

    // #then it is a local plugin in the active state, not failed
    expect(entry.state).toEqual({status: 'active'})
    expect(entry.features).toEqual({server: true})
  }, 60_000)

  it('serves the four session tools and answers them from real session history', async () => {
    // #given a session with one finished turn that mentions a marker
    const created = await server.api('POST', '/api/session', {body: {location: {directory: sandbox.repo}}})
    const sessionID = String(Reflect.get(Reflect.get(created.data as object, 'data') as object, 'id'))
    provider.script([{all: ['MARKER_PROMPT'], text: 'noted the zebra marker'}])
    await prompt(sessionID, 'MARKER_PROMPT please remember the zebra marker', 0)

    // #when the model calls every session tool in one turn
    provider.script([
      {
        all: ['TOOLS_PROMPT'],
        none: ['"role":"tool"'],
        tools: [
          {name: 'session_list', args: {}},
          {name: 'session_search', args: {query: 'zebra marker'}},
          {name: 'session_read', args: {session_id: sessionID, include_transcript: true, include_todos: true}},
          {name: 'session_info', args: {session_id: sessionID}},
        ],
      },
      {all: ['TOOLS_PROMPT', '"role":"tool"'], text: 'tools answered'},
    ])
    await prompt(sessionID, 'TOOLS_PROMPT run the session tools', 1)

    // #then the model was offered all four as direct tools
    const offered = provider.requests.find(request => request.body.includes('TOOLS_PROMPT'))?.toolNames ?? []
    expect(offered).toEqual(expect.arrayContaining(['session_list', 'session_read', 'session_search', 'session_info']))

    // #and each answered from the real store
    const results = lastToolResults()
    expect(results.get('session_list')).toContain(sessionID)
    expect(results.get('session_search')).toContain(`Session ${sessionID}`)
    expect(results.get('session_search')).toContain('zebra marker')
    const read = results.get('session_read') ?? ''
    expect(read).toContain(`Session ${sessionID}`)
    expect(read).toContain('[user] MARKER_PROMPT please remember the zebra marker')
    expect(read).toContain('[assistant] noted the zebra marker')
    expect(read).toContain('Todos:\n  (none)')
    expect(results.get('session_info')).toMatch(/Messages: \d+/)
    for (const [name, text] of results) {
      expect({name, unavailable: text.includes('session store unavailable')}).toEqual({name, unavailable: false})
    }
  }, 90_000)

  it('rejects a subagent resume with the fixed text, then lets a fresh subagent run', async () => {
    // #given a parent session
    const created = await server.api('POST', '/api/session', {body: {location: {directory: sandbox.repo}}})
    const sessionID = String(Reflect.get(Reflect.get(created.data as object, 'data') as object, 'id'))

    // #when the model tries to resume a session, is refused, and then starts a fresh subagent
    provider.script([
      {
        all: ['GUARD_PROMPT'],
        none: ['"role":"tool"'],
        tools: [
          {
            name: 'subagent',
            args: {agent: 'general', description: 'resume', prompt: 'CHILD_PROMPT again', sessionID},
          },
        ],
      },
      {
        all: ['GUARD_PROMPT', 'Session reuse is disabled'],
        none: ['CHILD_DONE'],
        tools: [{name: 'subagent', args: {agent: 'general', description: 'fresh', prompt: 'CHILD_PROMPT fresh'}}],
      },
      {all: ['CHILD_PROMPT'], none: ['GUARD_PROMPT'], text: 'CHILD_DONE'},
      {all: ['GUARD_PROMPT', 'CHILD_DONE'], text: 'guard flow finished'},
    ])
    await prompt(sessionID, 'GUARD_PROMPT exercise the guard', 0)

    // #then the model-visible rejection is the fixed text: no session id, no arguments
    const afterReject = provider.requests.find(
      request => request.body.includes('GUARD_PROMPT') && request.body.includes('Session reuse is disabled'),
    )
    expect(afterReject).toBeDefined()
    const rejection = afterReject?.messages.find(
      message => message.role === 'tool' && JSON.stringify(message.content).includes('Session reuse is disabled'),
    )
    const rejectionText = JSON.stringify(rejection?.content)
    expect(rejectionText).toContain(TASK_REUSE_REJECTION)
    expect(rejectionText).not.toContain('ses_')
    expect(rejectionText).not.toContain('CHILD_PROMPT')

    // #and the fresh subagent was allowed through: it ran and the parent saw its result
    const finalRequest = provider.requests.find(
      request => request.body.includes('GUARD_PROMPT') && request.body.includes('CHILD_DONE'),
    )
    expect(finalRequest).toBeDefined()
    const children = await server.api('GET', `/api/session?parentID=${sessionID}`)
    expect(records(dataOf(children))).toHaveLength(1)
  }, 90_000)
})

const STUB_SWITCH = 'OPENCODE_FROBOT_TRACING_STUB_URL'
const SETTLE_MS = 1_500

/**
 * A throwaway copy of the built plugin, so a test can replace or remove the lazy tracing chunk without touching `dist/`.
 * `chunk: 'marker'` swaps the SDK chunk for one that writes `marker` when it is evaluated.
 */
function stagePlugin(sandbox: SandboxPaths, chunk: 'keep' | 'marker' | 'missing', marker: string): string {
  const dir = path.join(sandbox.root, `plugin-${chunk}`)
  cpSync(path.join(packageDir, 'package.json'), path.join(dir, 'package.json'))
  cpSync(path.join(packageDir, 'dist'), path.join(dir, 'dist'), {recursive: true})
  const name = readdirSync(path.join(dir, 'dist')).find(file => /^tracing-.*\.mjs$/.test(file))
  if (name == null) throw new Error('the build emitted no tracing chunk')
  if (chunk === 'missing') rmSync(path.join(dir, 'dist', name))
  if (chunk === 'marker') {
    writeFileSync(
      path.join(dir, 'dist', name),
      `import {writeFileSync} from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'evaluated')\nexport async function exportStubSpan() {}\n`,
    )
  }
  return dir
}

describe.skipIf(!runnable)('the lazy tracing chunk in a real opencode V2', () => {
  let provider: FakeProvider
  let sink: OtlpSink
  let sandbox: SandboxPaths
  const servers: RunningServer[] = []

  const start = async (pluginDir: string, env: Record<string, string>): Promise<RunningServer> => {
    const server = await startOpenCodeServer({
      binary: binary ?? '',
      sandbox,
      pluginDir,
      providerBaseURL: provider.baseURL,
      env,
    })
    servers.push(server)
    return server
  }

  const pluginState = async (server: RunningServer): Promise<unknown> => {
    const entry = await waitFor('the fro-bot plugin to be listed', async () => {
      const response = await server.api('GET', '/api/plugin')
      return records(dataOf(response)).find(plugin => plugin.id === FRO_BOT_PLUGIN_ID)
    })
    return entry.state
  }

  const settle = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, SETTLE_MS))

  beforeAll(async () => {
    sandbox = makeSandbox()
    provider = await startFakeProvider()
    sink = await startOtlpSink()
  }, 30_000)

  afterAll(async () => {
    for (const server of servers) await server.stop()
    await provider?.stop()
    await sink?.stop()
    if (sandbox != null) removeSandbox(sandbox)
  }, 60_000)

  it('exports one trace from the bundled SDK and leaves the plugin active', async () => {
    // #given the built plugin and the stub switch pointed at a loopback sink
    const before = sink.requests.length

    // #when the server loads it
    const server = await start(packageDir, {[STUB_SWITCH]: sink.url})
    const state = await pluginState(server)

    // #then the plugin is active and the sink received exactly one OTLP trace export
    expect(state).toEqual({status: 'active'})
    const received = await waitFor('an OTLP export', async () => (sink.requests.length > before ? true : undefined))
    expect(received).toBe(true)
    await settle()
    const exports = sink.requests.slice(before)
    expect(exports).toHaveLength(1)
    expect(exports[0]).toMatchObject({method: 'POST', path: '/v1/traces', contentType: 'application/json'})
    const spans = (
      exports[0]?.body as {resourceSpans: {scopeSpans: {spans: {name: string}[]}[]}[]}
    ).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
    expect(spans.map(span => span.name)).toEqual(['feasibility stub'])
    expect(server.stderr()).not.toContain('tracing could not start')
  }, 90_000)

  it('does not evaluate the chunk when the switch is off, and evaluates it from the install location when on', async () => {
    // #given a copy of the built plugin whose chunk records when it is evaluated
    const marker = path.join(sandbox.root, 'chunk-evaluated')
    const dir = stagePlugin(sandbox, 'marker', marker)

    // #when the server runs it with the switch off
    const off = await start(dir, {})
    expect(await pluginState(off)).toEqual({status: 'active'})
    await settle()

    // #then the chunk was never evaluated
    expect(existsSync(marker)).toBe(false)

    // #when it runs with the switch on
    const on = await start(dir, {[STUB_SWITCH]: sink.url})
    expect(await pluginState(on)).toEqual({status: 'active'})

    // #then the chunk was resolved next to the entry and evaluated
    await waitFor('the chunk to be evaluated', async () => (existsSync(marker) ? true : undefined))
  }, 90_000)

  it('keeps the plugin active and logs one line when the chunk file is missing', async () => {
    // #given a copy of the built plugin with the chunk file removed
    const dir = stagePlugin(sandbox, 'missing', '')
    const before = sink.requests.length

    // #when the server runs it with the switch on
    const server = await start(dir, {[STUB_SWITCH]: sink.url})
    const state = await pluginState(server)
    await settle()

    // #then the plugin is active, nothing was exported, and one line says tracing did not start
    expect(state).toEqual({status: 'active'})
    expect(sink.requests.length).toBe(before)
    const lines = server
      .stderr()
      .split('\n')
      .filter(line => line.includes('tracing could not start'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[fro-bot\/opencode-plugin\] tracing could not start \(\w+\)$/)
  }, 90_000)
})
