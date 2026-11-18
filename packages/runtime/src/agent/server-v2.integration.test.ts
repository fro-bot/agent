/**
 * Integration test against the real stock OpenCode V2 binary. Skipped unless `FRO_BOT_OPENCODE_V2_BIN` names an
 * executable. The binary must be the pinned stock release, verified against `shared/opencode-v2-pin.json`
 * before use (the test checks the version it reports; the digest check belongs to the download step):
 *
 *   curl -fsSL -o oc.zip https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-darwin-arm64.zip
 *   shasum -a 256 oc.zip   # must equal assets["opencode-darwin-arm64.zip"] in opencode-v2-pin.json
 *   unzip oc.zip && FRO_BOT_OPENCODE_V2_BIN=$PWD/opencode bun run test packages/runtime/src/agent/server-v2.integration
 *
 * It proves what the fixture-binary tests can only assume: spawn with a held stdin, the Basic-auth contract,
 * the `/api/agent` readiness gate, the `/api/plugin` gate, the pre-spawn claim clear on a real schema, and that
 * an interrupt before stdin close releases the claim a bare stdin close would leave behind (P11).
 */

import type {AddressInfo} from 'node:net'
import type {Logger} from '../shared/logger.js'
import type {OpenCodeV2ServerHandle, StartOpenCodeV2ServerOptions} from './server-v2.js'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {clearHeldClaims} from './held-claims-v2.js'
import {createRemoteOpenCodeV2Client} from './remote-client-v2.js'
import {startOpenCodeV2Server} from './server-v2.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const hasBinary = BINARY !== undefined && BINARY !== '' && existsSync(BINARY)
const PIN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../shared/opencode-v2-pin.json', import.meta.url)), 'utf8'),
) as {version: string}

const silent: Logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
const TIMEOUTS = {agentReadyTimeoutMs: 60_000, pluginGateTimeoutMs: 1500, exitTimeoutMs: 10_000}

interface Sandbox {
  readonly root: string
  readonly repo: string
  readonly env: NodeJS.ProcessEnv
  readonly dbPath: string
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), 'server-v2-it-'))
  const home = path.join(root, 'home')
  const dirs = ['config', 'data', 'cache', 'state', 'tmp'].map(name => {
    const dir = path.join(home, name)
    mkdirSync(dir, {recursive: true})
    return dir
  })
  const repo = path.join(root, 'repo')
  mkdirSync(repo, {recursive: true})
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x',
      },
    })
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  const [config, data, cache, state, tmp] = dirs
  return {
    root,
    repo,
    dbPath: path.join(data as string, 'opencode', 'opencode.db'),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
      TMPDIR: tmp,
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    },
  }
}

interface HeldProvider {
  readonly baseURL: string
  readonly requests: () => number
  readonly stop: () => Promise<void>
}

/** An OpenAI-compatible endpoint that answers every chat request with headers and then never finishes. */
async function startHeldProvider(): Promise<HeldProvider> {
  let requests = 0
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model', object: 'model'}]}))
      return
    }
    requests += 1
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
    res.write(
      `data: ${JSON.stringify({id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{index: 0, delta: {role: 'assistant', content: ''}, finish_reason: null}]})}\n\n`,
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function providerConfig(baseURL: string): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    provider: {
      fake: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fake',
        options: {baseURL, apiKey: 'fake-integration-key-not-a-credential'},
        models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
      },
    },
    model: 'fake/fixture-model',
  }
}

async function json(handle: OpenCodeV2ServerHandle, pathname: string, init: RequestInit = {}): Promise<unknown> {
  const response = await handle.fetch(pathname, {
    ...init,
    headers: {'content-type': 'application/json', ...init.headers},
  })
  return response.json()
}

interface SessionRow {
  readonly time_suspended: number | null
}

function readSessionClaim(dbPath: string, id: string): number | null | undefined {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('SELECT time_suspended FROM session_v2 WHERE id = ?').get(id) as SessionRow | undefined
    return row === undefined ? undefined : row.time_suspended
  } finally {
    db.close()
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return predicate()
}

const sandboxes: Sandbox[] = []
const handles: OpenCodeV2ServerHandle[] = []
const providers: HeldProvider[] = []
const openStreams: OpenStream[] = []

// File-scope teardown: it runs after every suite in this file, so it also covers the resources a later suite creates
// (a describe-level `afterAll` runs when that describe ends, before a sibling's `beforeAll`). Every resource registers
// itself in the arrays above the moment it exists, so a setup that fails part-way is cleaned up too. One failing step
// must not skip the rest, so each runs on its own and the first failure is rethrown at the end.
afterAll(async () => {
  const failures: unknown[] = []
  const attempt = async (step: () => unknown): Promise<void> => {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const stream of openStreams) await attempt(() => stream.abort.abort())
  for (const handle of handles) await attempt(async () => handle.shutdown())
  for (const provider of providers) await attempt(async () => provider.stop())
  for (const box of sandboxes) await attempt(() => rmSync(box.root, {recursive: true, force: true}))
  if (failures.length > 0) throw failures[0]
}, 60_000)

async function boot(sandbox: Sandbox, overrides: Partial<StartOpenCodeV2ServerOptions> = {}) {
  const result = await startOpenCodeV2Server(
    {
      binaryPath: BINARY as string,
      directory: sandbox.repo,
      expectedPluginIds: [],
      env: sandbox.env,
      timeouts: TIMEOUTS,
      ...overrides,
    },
    silent,
  )
  if (result.success) handles.push(result.data)
  return result
}

function sandbox(): Sandbox {
  const created = createSandbox()
  sandboxes.push(created)
  return created
}

interface HeldTurn {
  readonly handle: OpenCodeV2ServerHandle
  readonly sessionId: string
}

/** Starts a server whose provider holds the turn, prompts, and waits until the claim is written. */
async function startHeldTurn(box: Sandbox, overrides: Partial<StartOpenCodeV2ServerOptions> = {}): Promise<HeldTurn> {
  const provider = await startHeldProvider()
  providers.push(provider)
  const result = await boot(box, {config: providerConfig(provider.baseURL), ...overrides})
  if (!result.success) throw new Error(`start failed: ${result.error.kind}`)
  const created = (await json(result.data, '/api/session', {
    method: 'POST',
    body: JSON.stringify({location: {directory: box.repo}}),
  })) as {data: {id: string}}
  const sessionId = created.data.id
  const prompt = await result.data.fetch(`/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({text: 'go'}),
  })
  if (prompt.status >= 300) throw new Error(`prompt failed: HTTP ${prompt.status}`)
  // The turn is in flight once the provider has the request and the claim is written.
  if (!(await waitFor(() => provider.requests() > 0, 20_000))) throw new Error('provider never saw the turn')
  if (!(await waitFor(() => (readSessionClaim(box.dbPath, sessionId) ?? null) !== null, 10_000))) {
    throw new Error('the execution claim was never written')
  }
  return {handle: result.data, sessionId}
}

describe.skipIf(!hasBinary)('startOpenCodeV2Server against the real stock binary', () => {
  beforeAll(() => {
    assertPinnedBinary()
  })

  it('spawns, enforces Basic auth, passes readiness and the plugin gate with no expected plugins', async () => {
    // #given a sandboxed home
    const box = sandbox()

    // #when started with no expected plugins
    const result = await boot(box)

    // #then the handle works, and the server rejects requests without the generated credential
    expect(result.success).toBe(true)
    if (!result.success) return
    const authed = await result.data.fetch('/api/info')
    expect(authed.status).toBe(200)
    const anonymous = await fetch(`${result.data.url}/api/agent`)
    expect(anonymous.status).toBe(401)
    const wrong = await fetch(`${result.data.url}/api/agent`, {
      headers: {authorization: `Basic ${Buffer.from('opencode:wrong').toString('base64')}`},
    })
    expect(wrong.status).toBe(401)
    // #and the server stays up with stdin held
    await new Promise(resolve => setTimeout(resolve, 600))
    expect((await result.data.fetch('/api/info')).status).toBe(200)

    const shutdown = await result.data.shutdown()
    expect(shutdown.exit).toMatchObject({outcome: 'graceful', code: 0})
  })

  it('passes the plugin gate for a plugin the server lists active, and fails naming one it does not', async () => {
    // #given a running server and one of its own built-in plugin ids
    const box = sandbox()
    const first = await boot(box)
    expect(first.success).toBe(true)
    if (!first.success) return
    // (from 2.2.7 the list is empty until activation lands, so poll for it rather than reading once)
    let builtin: string | undefined
    for (let attempt = 0; attempt < 100 && builtin === undefined; attempt++) {
      const listing = (await json(first.data, '/api/plugin')) as {data: {id?: string; state: {status: string}}[]}
      builtin = listing.data.find(entry => entry.id !== undefined && entry.state.status === 'active')?.id
      if (builtin === undefined) await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(builtin).toBeDefined()
    await first.data.shutdown()

    // #when started again expecting that id
    const present = await boot(box, {
      expectedPluginIds: [builtin as string],
      timeouts: {...TIMEOUTS, pluginGateTimeoutMs: 30_000},
    })

    // #then it passes
    expect(present.success).toBe(true)
    if (present.success) await present.data.shutdown()

    // #when expecting an id that is not there
    const missing = await boot(box, {expectedPluginIds: [builtin as string, 'fro-bot.missing-plugin']})

    // #then startup fails, names only the missing plugin, and leaves no server behind
    expect(missing.success).toBe(false)
    if (missing.success) return
    expect(missing.error.kind).toBe('plugin-gate')
    expect(missing.error.plugins).toEqual([{id: 'fro-bot.missing-plugin', status: 'absent'}])
    expect(missing.error.cleanup).toBe('graceful')
  })

  it('clears a held claim and a background-job row on a database written by the real server', async () => {
    // #given a session created by the real server, then a claim and a job row set the way a killed run leaves them
    const box = sandbox()
    const first = await boot(box)
    expect(first.success).toBe(true)
    if (!first.success) return
    const created = (await json(first.data, '/api/session', {
      method: 'POST',
      body: JSON.stringify({location: {directory: box.repo}}),
    })) as {data: {id: string}}
    const sessionId = created.data.id
    await first.data.shutdown()
    expect(existsSync(box.dbPath)).toBe(true)
    const db = new DatabaseSync(box.dbPath)
    db.prepare('UPDATE session_v2 SET time_suspended = ?, resume_attempts = 2 WHERE id = ?').run(Date.now(), sessionId)
    db.prepare('INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)').run(
      'job.background/ntf_it',
      '{"status":"running"}',
      Date.now(),
      Date.now(),
    )
    db.close()
    expect(readSessionClaim(box.dbPath, sessionId)).not.toBeNull()

    // #when clearing
    const cleared = await clearHeldClaims(box.dbPath, silent)

    // #then
    expect(cleared).toMatchObject({success: true, data: {status: 'cleared', claims: 1, backgroundJobs: 1}})
    expect(readSessionClaim(box.dbPath, sessionId)).toBeNull()
    // #and the real server boots on the cleared database and still knows the session
    const second = await boot(box)
    expect(second.success).toBe(true)
    if (!second.success) return
    const got = await second.data.fetch(`/api/session/${sessionId}`)
    expect(got.status).toBe(200)
    await second.data.shutdown()
  })

  describe('shutdown with a turn in flight (P11)', () => {
    it('leaves no claim when owned sessions are interrupted before stdin closes', async () => {
      // #given a turn held at the provider, with its execution claim written
      const box = sandbox()
      const turn = await startHeldTurn(box)

      // #when shutting down with the session owned
      const shutdown = await turn.handle.shutdown({ownedSessionIds: [turn.sessionId]})

      // #then the stop is confirmed, the exit is clean, and the saved database holds no claim
      expect(shutdown.interrupts).toEqual({stopped: [turn.sessionId], notRunning: [], unconfirmed: []})
      expect(shutdown.exit).toMatchObject({outcome: 'graceful', code: 0})
      expect(readSessionClaim(box.dbPath, turn.sessionId)).toBeNull()
    })

    it('leaves no claim when the caller aborts first and shutdown follows', async () => {
      // #given a held turn on a server started with a caller signal, its session registered as owned
      const box = sandbox()
      const controller = new AbortController()
      const turn = await startHeldTurn(box, {signal: controller.signal})
      turn.handle.registerOwnedSession(turn.sessionId)

      // #when the caller aborts and shutdown is requested afterwards
      controller.abort()
      const shutdown = await turn.handle.shutdown()

      // #then the abort path interrupted the owned session before stdin closed, so no claim is left
      expect(shutdown.interrupts).toEqual({stopped: [turn.sessionId], notRunning: [], unconfirmed: []})
      expect(shutdown.exit).toMatchObject({outcome: 'graceful', code: 0})
      expect(readSessionClaim(box.dbPath, turn.sessionId)).toBeNull()
    })

    it('control: a bare stdin close leaves the claim, which is why the interrupt comes first', async () => {
      // #given the same held turn
      const box = sandbox()
      const turn = await startHeldTurn(box)

      // #when shutting down WITHOUT interrupting
      const shutdown = await turn.handle.shutdown()

      // #then the claim survives, and the pre-spawn clear is what removes it
      expect(shutdown.exit).toMatchObject({outcome: 'graceful'})
      expect(readSessionClaim(box.dbPath, turn.sessionId)).not.toBeNull()
      const cleared = await clearHeldClaims(box.dbPath, silent)
      expect(cleared).toMatchObject({success: true, data: {status: 'cleared', claims: 1}})
      expect(readSessionClaim(box.dbPath, turn.sessionId)).toBeNull()
    })
  })
})

// --- The event stream contract (fro-bot/agent#2191) ------------------------------------------------------------------
//
// What the Action's and the gateway's prompt loops assume about `GET /api/event`, pinned on the stock binary through the
// raw client they both use (`createRemoteOpenCodeV2Client`). No test here needs a model turn: a held provider keeps a turn
// open where one is needed, and a session create is the cheap event to publish.

interface WireFrame {
  readonly id?: string
  readonly type: string
  readonly location?: {readonly directory?: string}
  readonly data?: {readonly sessionID?: string}
}

function rawClient(handle: OpenCodeV2ServerHandle, extraHeaders: Readonly<Record<string, string>> = {}) {
  return createRemoteOpenCodeV2Client({
    baseUrl: handle.url,
    headers: {authorization: handle.authorizationHeader(), ...extraHeaders},
  })
}

interface OpenStream {
  readonly iterator: AsyncIterator<unknown>
  /** Frames read so far, in order. */
  readonly seen: WireFrame[]
  readonly abort: AbortController
}

/** Frames read from a stream until `done` accepts one; the frames read so far are in `seen` either way. */
async function readUntil(stream: OpenStream, done: (frame: WireFrame) => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const step = await Promise.race([
      stream.iterator.next(),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()))),
    ])
    if (step === 'timeout')
      throw new Error(`no matching frame in ${timeoutMs} ms; saw ${stream.seen.map(f => f.type).join(',')}`)
    if (step.done === true) throw new Error(`the stream ended; saw ${stream.seen.map(f => f.type).join(',')}`)
    const frame = step.value as WireFrame
    // The transport's stand-in for an SSE comment (heartbeat) has no id and no event; it is not a server frame.
    if (frame.type === 'server.heartbeat') continue
    stream.seen.push(frame)
    if (done(frame)) return
  }
}

async function createSessionAt(handle: OpenCodeV2ServerHandle, directory: string): Promise<string> {
  const created = (await json(handle, '/api/session', {
    method: 'POST',
    body: JSON.stringify({location: {directory}}),
  })) as {data: {id: string}}
  return created.data.id
}

const isCreated =
  (sessionId: string) =>
  (frame: WireFrame): boolean =>
    frame.type === 'session.created' && frame.data?.sessionID === sessionId

function assertPinnedBinary(): void {
  const reported = execFileSync(BINARY as string, ['--version'], {encoding: 'utf8'}).trim()
  if (!reported.includes(PIN.version)) {
    throw new Error(`FRO_BOT_OPENCODE_V2_BIN reports "${reported}", not the pinned ${PIN.version}`)
  }
}

describe.skipIf(!hasBinary)('GET /api/event against the real stock binary (fro-bot/agent#2191)', () => {
  let box: Sandbox
  let handle: OpenCodeV2ServerHandle
  let held: HeldProvider

  async function open(
    directory: string,
    client = rawClient(handle),
    signal = new AbortController(),
  ): Promise<OpenStream> {
    const subscribed = await client.subscribeEvents({directory, signal: signal.signal})
    if (!subscribed.success) throw new Error(`subscribeEvents failed: ${subscribed.error.kind}`)
    const stream = {iterator: subscribed.data[Symbol.asyncIterator](), seen: [] as WireFrame[], abort: signal}
    openStreams.push(stream)
    return stream
  }

  beforeAll(async () => {
    assertPinnedBinary()
    box = sandbox()
    held = await startHeldProvider()
    providers.push(held)
    const started = await boot(box, {config: providerConfig(held.baseURL)})
    if (!started.success) throw new Error(`start failed: ${started.error.kind}`)
    handle = started.data
  }, 120_000)

  it('a1: the first frame of every subscription is server.connected, also while a turn is running', async () => {
    // #given a turn held open on the server, so events are flowing while subscriptions open
    const turnBox = sandbox()
    const sessionId = await createSessionAt(handle, turnBox.repo)
    const prompt = await handle.fetch(`/api/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-opencode-directory': turnBox.repo},
      body: JSON.stringify({text: 'go'}),
    })
    expect(prompt.status).toBeLessThan(300)

    // #when ten subscriptions are opened one after another
    for (let attempt = 0; attempt < 10; attempt++) {
      const startedAt = performance.now()
      const stream = await open(box.repo)
      await readUntil(stream, () => true)

      // #then each one's first frame is the connect announcement, with an id and an empty payload, and it is prompt
      // (the loops wait 10 s for it)
      expect(stream.seen[0]).toMatchObject({type: 'server.connected', data: {}})
      expect(stream.seen[0]?.id).toMatch(/^evt_/)
      expect(performance.now() - startedAt).toBeLessThan(5000)
      stream.abort.abort()
    }
  })

  it('a1b: a second subscriber joining mid-run does not make the first one see a second server.connected', async () => {
    // #given one subscriber, then another that joins while the first is live
    const first = await open(box.repo)
    await readUntil(first, frame => frame.type === 'server.connected')
    const second = await open(box.repo)
    await readUntil(second, frame => frame.type === 'server.connected')

    // #when an event is published after both are connected, and both read up to it
    const sessionId = await createSessionAt(handle, box.repo)
    await readUntil(first, isCreated(sessionId))
    await readUntil(second, isCreated(sessionId))

    // #then each stream announced itself exactly once, as its first frame (a second one would be a replaced stream)
    for (const stream of [first, second]) {
      expect(stream.seen.filter(frame => frame.type === 'server.connected')).toHaveLength(1)
      expect(stream.seen[0]?.type).toBe('server.connected')
    }
    first.abort.abort()
    second.abort.abort()
  })

  it('a2: subscribeEvents returns after the server registered the subscription, before the iterator is read', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      // #given a subscription whose iterator nobody has read (`open` only calls subscribeEvents)
      const stream = await open(box.repo)

      // #when an event is published at once, with no frame read yet
      const sessionId = await createSessionAt(handle, box.repo)

      // #then reading afterwards still yields the announcement and then that event: nothing was missed while unread
      await readUntil(stream, isCreated(sessionId))
      expect(stream.seen[0]?.type).toBe('server.connected')
      stream.abort.abort()
    }
  })

  it('a3: a late or reconnecting subscriber gets no replay, with or without Last-Event-ID', async () => {
    for (const mode of ['plain', 'last-event-id'] as const) {
      // #given a subscriber that saw one event and went away, and another event published while nobody listened
      const before = await open(box.repo)
      const seenSession = await createSessionAt(handle, box.repo)
      await readUntil(before, isCreated(seenSession))
      const lastId = before.seen.at(-1)?.id as string
      before.abort.abort()
      const missedSession = await createSessionAt(handle, box.repo)

      // #when it reconnects (the header is the SSE resume mechanism; the server frames carry their id in the payload)
      const client = rawClient(handle, mode === 'last-event-id' ? {'last-event-id': lastId} : {})
      const after = await open(box.repo, client)
      const controlSession = await createSessionAt(handle, box.repo)
      await readUntil(after, isCreated(controlSession))

      // #then it got the announcement first and, of the session events, only the live one: neither the event it saw nor
      // the one it missed (other frames, such as a still-running turn's, are not what this pins)
      expect(after.seen[0]?.type).toBe('server.connected')
      expect(after.seen.filter(frame => frame.type === 'session.created').map(frame => frame.data?.sessionID)).toEqual([
        controlSession,
      ])
      expect(after.seen.map(frame => frame.id)).not.toContain(lastId)
      expect(JSON.stringify(after.seen)).not.toContain(seenSession)
      expect(JSON.stringify(after.seen)).not.toContain(missedSession)
      after.abort.abort()
    }
  })

  it('a4: once the prompt request has returned, the session is listed running, its wait stays pending and an interrupt takes effect', async () => {
    // What happens while the request is in flight is not pinned: on 2.3.0 a first prompt at a fresh location is not yet
    // listed for ~150 ms and an interrupt sent then finds nothing, but the stock binary offers no barrier to sample that
    // window against, so it is an observation (see `run-core-v2.ts`) and not an assertion. Only the state after the
    // request has returned is deterministic.
    for (let attempt = 0; attempt < 3; attempt++) {
      // #given a session at a location the server has not run a prompt in yet (the first-prompt path)
      const fresh = sandbox()
      const sessionId = await createSessionAt(handle, fresh.repo)

      // #when the prompt request has returned
      const prompt = await handle.fetch(`/api/session/${sessionId}/prompt`, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-opencode-directory': fresh.repo},
        body: JSON.stringify({text: 'go'}),
      })
      expect(prompt.status).toBeLessThan(300)

      // #then the session is listed running
      const active = ((await json(handle, '/api/session/active')) as {data: Record<string, {type: string}>}).data
      expect(active[sessionId]).toEqual({type: 'running'})
      // #and the session-wait route does not answer at once (an early 204 is what "not admitted yet" looked like)
      const waiting = new AbortController()
      const waitAnswer = handle
        .fetch(`/api/experimental/session/${sessionId}/wait`, {method: 'POST', signal: waiting.signal})
        .then(response => response.status)
        .catch(() => 'aborted' as const)
      expect(
        await Promise.race([waitAnswer, new Promise<'pending'>(resolve => setTimeout(resolve, 300, 'pending'))]),
      ).toBe('pending')
      waiting.abort()
      // #and an interrupt takes effect
      expect(await json(handle, `/api/session/${sessionId}/interrupt`, {method: 'POST'})).toEqual({interrupted: true})
    }
  })

  it('a7: the stream is not scoped by the directory it is opened with: a subscriber for A sees a session created in B', async () => {
    // #given a stream opened for directory A, and a second directory B on the same server
    const other = sandbox()
    const stream = await open(box.repo)

    // #when a session is created in B
    const otherSession = await createSessionAt(handle, other.repo)

    // #then A's stream carries B's `session.created`, tagged with B's location (consumers must filter by session ownership)
    await readUntil(stream, isCreated(otherSession))
    const frame = stream.seen.find(isCreated(otherSession))
    expect([other.repo, realpathSync(other.repo)]).toContain(frame?.location?.directory)
    expect(frame?.location?.directory).not.toBe(box.repo)
    stream.abort.abort()
  })
})
