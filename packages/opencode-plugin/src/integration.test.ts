/**
 * Loads the BUILT plugin into a real stock OpenCode v2.2.0 binary.
 *
 * Skipped unless both of these hold, so the default test run needs neither a download nor a build:
 * - `FRO_BOT_OPENCODE_V2_BIN` points at a v2.2.0 `opencode` executable, and
 * - `dist/index.mjs` exists (`bun run --filter @fro.bot/opencode-plugin build`).
 *
 * To run it locally, fetch the release asset for your platform, verify it against the release's `SHA256SUMS` (v2.2.0
 * `opencode-darwin-arm64.zip` is `c71b1cd96541539ad38e2a75377d2f43d2a27567289a14371a182e9a0800db3d`), unpack it into a
 * temp directory, and set the variable. Delete the download afterwards.
 */

import type {FakeProvider, RunningServer, SandboxPaths} from './integration.fixture.js'

import {existsSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {makeSandbox, removeSandbox, startFakeProvider, startOpenCodeServer} from './integration.fixture.js'
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

describe.skipIf(!runnable)('built plugin in a real opencode v2.2.0', () => {
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
