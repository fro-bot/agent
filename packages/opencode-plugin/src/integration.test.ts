/**
 * Loads the built plugin into a real OpenCode V2 binary. Skipped unless `FRO_BOT_OPENCODE_V2_BIN` points at one and
 * `dist/index.mjs` exists.
 */

import type {FakeProvider, FakeStep, OtlpSink, RunningServer, SandboxPaths} from './integration.fixture.js'

import {cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest'

import {
  makeSandbox,
  removeSandbox,
  startFakeProvider,
  startOpenCodeServer,
  startOtlpSink,
} from './integration.fixture.js'
import {FRO_BOT_PLUGIN_ID} from './plugin-id.js'
import {TASK_REUSE_REJECTION} from './task-reuse-guard.js'
import {TRACING_LAUNCHER_ENV, userSettingsFilePath} from './tracing/settings.js'

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

  it('with no launcher variable, rejects a subagent resume with the fixed text, then lets a fresh subagent run', async () => {
    // #given a server with no launcher variable, so no host the plugin admits a resume for, and a parent session
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
    // A subagent is a background job: its report reaches the parent after the fresh dispatch returns, so wait for it.
    const finalRequest = await waitFor('the parent to see the child result', async () =>
      provider.requests.find(request => request.body.includes('GUARD_PROMPT') && request.body.includes('CHILD_DONE')),
    )
    expect(finalRequest).toBeDefined()
    const children = await server.api('GET', `/api/session?parentID=${sessionID}`)
    expect(records(dataOf(children))).toHaveLength(1)
  }, 90_000)
})

const IDENTITY = {repository: 'fro-bot/agent', runId: '1', attempt: '1', job: 'it', trigger: 'workflow_dispatch'}

/** The launcher variable an Action run would set: tracing on, spans to `relay`. */
const launcherOn = (relay: string): Record<string, string> => ({
  [TRACING_LAUNCHER_ENV]: JSON.stringify({version: 1, host: 'action', tracing: 'on', relay, identity: IDENTITY}),
})
const launcherOff: Record<string, string> = {
  [TRACING_LAUNCHER_ENV]: JSON.stringify({version: 1, host: 'action', tracing: 'off'}),
}
const SETTLE_MS = 1_500

/**
 * A throwaway copy of the built plugin, so a test can replace or remove the lazy tracing chunk without touching `dist/`.
 * `chunk: 'marker'` swaps the SDK chunk for one that writes `marker` when it is evaluated.
 */
let stagedCopies = 0

function stagePlugin(sandbox: SandboxPaths, chunk: 'keep' | 'marker' | 'missing', marker: string): string {
  // A fresh directory per call: a still-running server may watch an earlier copy and reload it.
  stagedCopies += 1
  const dir = path.join(sandbox.root, `plugin-${chunk}-${stagedCopies}`)
  cpSync(path.join(packageDir, 'package.json'), path.join(dir, 'package.json'))
  cpSync(path.join(packageDir, 'dist'), path.join(dir, 'dist'), {recursive: true})
  const name = readdirSync(path.join(dir, 'dist')).find(file => /^tracing-.*\.mjs$/.test(file))
  if (name == null) throw new Error('the build emitted no tracing chunk')
  if (chunk === 'missing') rmSync(path.join(dir, 'dist', name))
  if (chunk === 'marker') {
    writeFileSync(
      path.join(dir, 'dist', name),
      `import {writeFileSync} from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'evaluated')\nexport async function startTracing() { return {stop: async () => {}} }\n`,
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

  // Stop each test's servers before the next starts: they share a HOME, and a live server reacts to file changes in it.
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop()
  }, 60_000)

  afterAll(async () => {
    await provider?.stop()
    await sink?.stop()
    if (sandbox != null) removeSandbox(sandbox)
  }, 60_000)

  it('does not evaluate the chunk when tracing is off, and evaluates it from the install location when on', async () => {
    // #given a copy of the built plugin whose chunk records when it is evaluated
    const marker = path.join(sandbox.root, 'chunk-evaluated')
    const dir = stagePlugin(sandbox, 'marker', marker)

    // #when the server runs it with no launcher variable (a headless host: off)
    const off = await start(dir, {})
    expect(await pluginState(off)).toEqual({status: 'active'})
    await settle()

    // #then the chunk was never evaluated
    expect(existsSync(marker)).toBe(false)

    // #when it runs with an Action launcher that says on
    const on = await start(dir, launcherOn(sink.url))
    expect(await pluginState(on)).toEqual({status: 'active'})

    // #then the chunk was resolved next to the entry and evaluated
    await waitFor('the chunk to be evaluated', async () => (existsSync(marker) ? true : undefined))
  }, 90_000)

  it('keeps the plugin active and logs one line when the chunk file is missing', async () => {
    // #given a copy of the built plugin with the chunk file removed
    const dir = stagePlugin(sandbox, 'missing', '')
    const before = sink.requests.length

    // #when the server runs it with an Action launcher that says on
    const server = await start(dir, launcherOn(sink.url))
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

  it('sends nothing and loads no chunk when only a user file names an endpoint, in any off mode', async () => {
    // #given a valid, safe user file in the server's config directory, and a chunk that records its evaluation
    const settingsFile = userSettingsFilePath({XDG_CONFIG_HOME: path.join(sandbox.home, 'config')})
    mkdirSync(path.dirname(settingsFile), {recursive: true})
    writeFileSync(settingsFile, JSON.stringify({version: 1, endpoint: sink.url, hosts: [os.hostname()]}), {mode: 0o600})
    const marker = path.join(sandbox.root, 'chunk-evaluated-file')
    const dir = stagePlugin(sandbox, 'marker', marker)
    const before = sink.requests.length

    // #when servers run with no launcher variable (headless) and with a launcher that says off
    const headless = await start(dir, {})
    const declaredOff = await start(dir, launcherOff)
    const states = [await pluginState(headless), await pluginState(declaredOff)]
    await settle()

    // #then both plugins are active, nothing reached the sink, and the chunk was never evaluated
    expect(states).toEqual([{status: 'active'}, {status: 'active'}])
    expect(sink.requests.length).toBe(before)
    expect(existsSync(marker)).toBe(false)
  }, 90_000)
})

const launcherWorkspace: Record<string, string> = {
  [TRACING_LAUNCHER_ENV]: JSON.stringify({version: 1, host: 'workspace', tracing: 'off'}),
}

/** An id that is well formed but names no session. */
const UNKNOWN_SESSION_ID = 'ses_unknownchild000000000000'

/** How long B's first reply waits for the test to install the parent's resume script. */
const GATE_TIMEOUT_MS = 30_000

/** The host's report text that rejected a resume. */
const REFUSAL_MARKER = 'Session reuse is disabled'

describe.skipIf(!runnable)('same-run subagent resume in a real opencode V2', () => {
  interface Rig {
    readonly provider: FakeProvider
    readonly server: RunningServer
    readonly sandbox: SandboxPaths
  }

  const rigs: Rig[] = []

  /** A server with its own sandbox and provider, so one test's sessions never reach another's. */
  const launch = async (env: Record<string, string>): Promise<Rig> => {
    const sandbox = makeSandbox()
    const provider = await startFakeProvider()
    const rig: Rig = {
      provider,
      sandbox,
      server: await startOpenCodeServer({
        binary: binary ?? '',
        sandbox,
        pluginDir: packageDir,
        providerBaseURL: provider.baseURL,
        env,
      }),
    }
    rigs.push(rig)
    return rig
  }

  afterEach(async () => {
    for (const rig of rigs.splice(0)) {
      await rig.server.stop()
      await rig.provider.stop()
      removeSandbox(rig.sandbox)
    }
  }, 60_000)

  const createSession = async (rig: Rig): Promise<string> => {
    const created = await rig.server.api('POST', '/api/session', {body: {location: {directory: rig.sandbox.repo}}})
    return String(Reflect.get(Reflect.get(created.data as object, 'data') as object, 'id'))
  }

  const childrenOf = async (rig: Rig, parentID: string): Promise<Record<string, unknown>[]> =>
    records(dataOf(await rig.server.api('GET', `/api/session?parentID=${parentID}`)))

  /**
   * Sends the parent's first prompt. The model dispatches child B (`CHILD_ALPHA`). B's reply is held at a gate until
   * `scriptResume(childID)` has been installed, so the parent's next request never races the script that answers it. The
   * gate is bounded: if nothing releases it in `GATE_TIMEOUT_MS`, B's request fails with a message that names the gate.
   */
  const dispatchChild = async (
    rig: Rig,
    marker: string,
    scriptResume: (childID: string) => readonly FakeStep[],
  ): Promise<{parentID: string; childID: string}> => {
    const parentID = await createSession(rig)
    let release!: () => void
    let abandon!: (error: Error) => void
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve
      abandon = reject
    })
    // The provider reads the rejection; this handler keeps an unread one from surfacing as an unhandled rejection.
    gate.catch(() => {})
    const timer = setTimeout(() => {
      abandon(new Error(`B's reply gate was not released within ${String(GATE_TIMEOUT_MS)}ms`))
    }, GATE_TIMEOUT_MS)
    try {
      rig.provider.script([
        {
          all: [marker],
          none: ['"role":"tool"'],
          tools: [
            {name: 'subagent', args: {agent: 'general', description: 'first', prompt: 'CHILD_ALPHA first question'}},
          ],
        },
        {all: ['CHILD_ALPHA'], none: [marker, 'CHILD_BETA'], text: 'CHILD_ALPHA_REPLY', gate},
      ])
      const sent = await rig.server.api('POST', `/api/session/${parentID}/prompt`, {body: {text: `${marker} start`}})
      expect(sent.status).toBe(200)
      const child = await waitFor('child B to exist', async () => (await childrenOf(rig, parentID))[0])
      const childID = String(child.id)
      rig.provider.script(scriptResume(childID))
      release()
      return {parentID, childID}
    } catch (error) {
      abandon(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  const parentRequest = async (rig: Rig, ...needles: string[]) =>
    waitFor(`a parent request containing ${needles.join(' and ')}`, async () =>
      rig.provider.requests.find(request => needles.every(needle => request.body.includes(needle))),
    )

  /** Requests no parent sent: they carry `needle` but not the parent's marker, so a session other than the parent got it. */
  const requestsToOthers = (rig: Rig, marker: string, needle: string) =>
    rig.provider.requests.filter(request => request.body.includes(needle) && !request.body.includes(marker))

  const settle = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, SETTLE_MS))

  it('on the Action host, lets the parent resume its own finished child and receives the second reply', async () => {
    // #given an Action-hosted server and a parent whose child B has been dispatched
    const rig = await launch(launcherOff)
    const marker = 'RESUME_OWN'
    // #when B reports, the parent resumes B by its actual id, and B answers a second time
    const {parentID, childID} = await dispatchChild(rig, marker, id => [
      {
        all: [marker, 'CHILD_ALPHA_REPLY'],
        none: ['CHILD_BETA_REPLY'],
        tools: [
          {
            name: 'subagent',
            args: {agent: 'general', description: 'again', prompt: 'CHILD_BETA second question', sessionID: id},
          },
        ],
      },
      {all: ['CHILD_BETA'], none: [marker], text: 'CHILD_BETA_REPLY'},
      {all: [marker, 'CHILD_BETA_REPLY'], text: 'resume flow finished'},
    ])

    // #then B's second reply reached the parent as a report
    const finalRequest = await parentRequest(rig, marker, 'CHILD_BETA_REPLY')
    expect(finalRequest.body).toContain('CHILD_ALPHA_REPLY')

    // #and the resume was admitted: B itself was prompted, and nothing was refused
    expect(requestsToOthers(rig, marker, 'CHILD_BETA').length).toBeGreaterThan(0)
    expect(rig.provider.requests.filter(request => request.body.includes(REFUSAL_MARKER))).toEqual([])

    // #and there is still exactly one child session, with the id the parent resumed
    await settle()
    const children = await childrenOf(rig, parentID)
    expect(children.map(child => child.id)).toEqual([childID])
  }, 120_000)

  it('on the Action host, refuses a foreign and an unknown id with the fixed text and prompts no session', async () => {
    // #given an Action-hosted server, a parent, and a second top-level session the parent did not dispatch
    const rig = await launch(launcherOff)
    const marker = 'RESUME_FOREIGN'
    const parentID = await createSession(rig)
    const foreignID = await createSession(rig)

    // #when the model tries to resume each, in one turn
    rig.provider.script([
      {
        all: [marker],
        none: ['"role":"tool"'],
        tools: [
          {
            name: 'subagent',
            args: {agent: 'general', description: 'foreign', prompt: 'FOREIGN_GAMMA question', sessionID: foreignID},
          },
          {
            name: 'subagent',
            args: {
              agent: 'general',
              description: 'unknown',
              prompt: 'FOREIGN_GAMMA question',
              sessionID: UNKNOWN_SESSION_ID,
            },
          },
        ],
      },
      {all: [marker, REFUSAL_MARKER], text: 'foreign flow finished'},
    ])
    const sent = await rig.server.api('POST', `/api/session/${parentID}/prompt`, {body: {text: `${marker} start`}})
    expect(sent.status).toBe(200)

    // #then both calls got the fixed refusal, which carries no id and no argument
    const afterRefusal = await parentRequest(rig, marker, REFUSAL_MARKER)
    const refusals = afterRefusal.messages.filter(
      message => message.role === 'tool' && JSON.stringify(message.content).includes(REFUSAL_MARKER),
    )
    expect(refusals).toHaveLength(2)
    for (const refusal of refusals) {
      const text = JSON.stringify(refusal.content)
      expect(text).toContain(TASK_REUSE_REJECTION)
      expect(text).not.toContain('ses_')
      expect(text).not.toContain('FOREIGN_GAMMA')
    }

    // #and no prompt reached any session: the foreign session has no messages, the parent has no child, and no
    // provider request came from a session other than the parent
    await settle()
    const foreignMessages = records(dataOf(await rig.server.api('GET', `/api/session/${foreignID}/message`)))
    expect(foreignMessages).toEqual([])
    expect(await childrenOf(rig, parentID)).toEqual([])
    expect(requestsToOthers(rig, marker, 'FOREIGN_GAMMA')).toEqual([])
  }, 120_000)

  it('on the workspace host, dispatches a child and then refuses to resume it', async () => {
    // #given a workspace-hosted server and a parent whose child B has been dispatched
    const rig = await launch(launcherWorkspace)
    const marker = 'RESUME_WORKSPACE'
    // #when B reports and the parent tries to resume B by its actual id
    const {parentID, childID} = await dispatchChild(rig, marker, id => [
      {
        all: [marker, 'CHILD_ALPHA_REPLY'],
        none: [REFUSAL_MARKER],
        tools: [
          {
            name: 'subagent',
            args: {agent: 'general', description: 'again', prompt: 'CHILD_BETA second question', sessionID: id},
          },
        ],
      },
      {all: [marker, REFUSAL_MARKER], text: 'workspace flow finished'},
    ])

    // #then the fixed refusal came back
    const afterRefusal = await parentRequest(rig, marker, REFUSAL_MARKER)
    const refusal = afterRefusal.messages.find(
      message => message.role === 'tool' && JSON.stringify(message.content).includes(REFUSAL_MARKER),
    )
    const text = JSON.stringify(refusal?.content)
    expect(text).toContain(TASK_REUSE_REJECTION)
    expect(text).not.toContain('ses_')
    expect(text).not.toContain('CHILD_BETA')

    // #and B was never prompted again, and there is still exactly one child
    await settle()
    expect(requestsToOthers(rig, marker, 'CHILD_BETA')).toEqual([])
    const children = await childrenOf(rig, parentID)
    expect(children.map(child => child.id)).toEqual([childID])
  }, 120_000)
})
