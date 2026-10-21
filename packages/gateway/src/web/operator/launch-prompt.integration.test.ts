/**
 * Integration: the operator launch prompt, end to end over a REAL (in-memory) object store.
 *
 * Real pieces: the launch route, `launchWork`, `createRun`, the heartbeat controller, `transitionRun`,
 * `parseRunState`, the run index (`listRunsForRepo`), `GET /operator/runs`, the run-observation manager
 * and the status projection. Faked: the object-store adapter (a Map), the Discord/web sinks' network.
 *
 * Scenarios (contract 1.12.0):
 *   - launch → createRun JSON → heartbeat tick → FAILED → summary carries the prompt, status never does
 *   - the prompt survives a "restart" (a fresh run index over the same store)
 *   - denylisting or unbinding the repo after launch hides the run and never reads its records
 *   - a sentinel prompt appears in no log call, no SSE frame, no push-dispatcher argument
 *   - the same holds with an injected createRun failure, an injected FAILED-transition failure, and a
 *     truncated prompt-bearing record read back through parseRunState and listRunsForRepo
 */

import type {CoordinationConfig, RunState} from '@fro-bot/runtime'
import type {RepoBinding} from '../../bindings/types.js'
import type {GatewayLogger} from '../../discord/client.js'
import type {RunMentionDeps} from '../../execute/run.js'
import type {OperatorRunStatus, RunSummary} from '../../operator-contract/index.js'
import type {ObservationFrame} from '../sse/manager.js'

import {acquireLock, createHeartbeatController, transitionRun} from '@fro-bot/runtime'
import {Hono} from 'hono'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createRunIndex} from '../../execute/run-index.js'
import {toOperatorRunStatus, toRunSummary} from '../../operator-contract/index.js'
import {projectRunStatusWithKey} from '../../redaction/surface-gate.js'
import {setOperatorRouteGuard} from '../operator-route.js'
import {createRunObservationManager} from '../sse/manager.js'
import {createIdempotencyGuard} from './idempotency.js'
import {buildLaunchRoute} from './launch-route.js'
import {buildRunsRoute} from './runs-route.js'

const SENTINEL = 'SENTINEL-PROMPT-4f9c1e7a'
const IDENTITY = 'gateway-identity'
const OWNER = 'acme'
const REPO = 'widget'
const BINDING: RepoBinding = {
  owner: OWNER,
  repo: REPO,
  channelId: 'ch-1',
  channelName: 'widget-dev',
  workspacePath: '/workspace/acme/widget',
  createdAt: '2026-01-01T00:00:00Z',
  createdByDiscordId: 'discord-1',
  databaseId: 42,
  nodeId: 'R_node_42',
}

// ---------------------------------------------------------------------------
// In-memory object store (real conditional-write semantics)
// ---------------------------------------------------------------------------

interface Store {
  readonly config: CoordinationConfig
  readonly objects: Map<string, {data: string; etag: string}>
  readonly failNextPut: {error: Error | undefined; matching: ((data: string) => boolean) | undefined}
}

function makeStore(): Store {
  const objects = new Map<string, {data: string; etag: string}>()
  const failNextPut: Store['failNextPut'] = {error: undefined, matching: undefined}
  let counter = 0
  const config = {
    storeAdapter: {
      upload: vi.fn(async () => ({success: true as const, data: undefined})),
      download: vi.fn(async () => ({success: true as const, data: undefined})),
      list: vi.fn(async (prefix: string) => ({
        success: true as const,
        data: [...objects.keys()].filter(key => key.startsWith(prefix)),
      })),
      getObject: vi.fn(async (key: string) => {
        const found = objects.get(key)
        return found === undefined
          ? {success: false as const, error: new Error('NoSuchKey')}
          : {success: true as const, data: {...found}}
      }),
      conditionalPut: vi.fn(async (key: string, data: string, options: {ifMatch?: string; ifNoneMatch?: string}) => {
        if (failNextPut.error !== undefined && (failNextPut.matching?.(data) ?? true)) {
          const error = failNextPut.error
          failNextPut.error = undefined
          return {success: false as const, error}
        }
        const existing = objects.get(key)
        if (options.ifNoneMatch === '*' && existing !== undefined) {
          return {success: false as const, error: new Error('412 exists')}
        }
        if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch) {
          return {success: false as const, error: new Error('412 etag mismatch')}
        }
        counter += 1
        const etag = `etag-${counter}`
        objects.set(key, {data, etag})
        return {success: true as const, data: {etag}}
      }),
    },
    storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  } as unknown as CoordinationConfig
  return {config, objects, failNextPut}
}

// ---------------------------------------------------------------------------
// Capture: every logger call, SSE frame and push argument is scanned for the sentinel
// ---------------------------------------------------------------------------

interface Capture {
  readonly logger: GatewayLogger
  readonly pushCalls: unknown[][]
  readonly frames: ObservationFrame[]
  text: () => string
}

function makeCapture(): Capture {
  const logger: GatewayLogger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const pushCalls: unknown[][] = []
  const frames: ObservationFrame[] = []
  return {
    logger,
    pushCalls,
    frames,
    text: () =>
      [
        ...[logger.debug, logger.info, logger.warn, logger.error].flatMap(fn =>
          vi.mocked(fn).mock.calls.map(call => JSON.stringify(call)),
        ),
        ...pushCalls.map(call => JSON.stringify(call)),
        ...frames.map(frame => JSON.stringify(frame)),
      ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Harness: the real launch + runs routes over one store
// ---------------------------------------------------------------------------

interface Harness {
  readonly app: Hono
  readonly store: Store
  readonly capture: Capture
  readonly manager: ReturnType<typeof createRunObservationManager>
  readonly runIndex: ReturnType<typeof createRunIndex>
  readonly listRunsForRepoSpy: ReturnType<typeof vi.fn>
  readonly denylist: {denied: boolean}
  readonly bindings: {bound: boolean}
  readonly launchDeps: RunMentionDeps
}

function makeHarness(store: Store = makeStore()): Harness {
  const capture = makeCapture()
  const denylist = {denied: false}
  const bindings = {bound: true}
  const runIndex = createRunIndex({
    bindingsStore: {} as never,
    coordinationConfig: store.config,
    identity: IDENTITY,
    logger: capture.logger,
  })
  const listRunsForRepoSpy = vi.fn(async (repo: string, limit?: number) => runIndex.listRunsForRepo(repo, limit))

  const projectBase = async (state: RunState) =>
    projectRunStatusWithKey(state, {
      nowMs: Date.now(),
      staleThresholdMs: 60_000,
      bindingsLookup: {getBindingByRepo: async () => ({success: true, data: BINDING})},
      isRepoDenied: () => false,
    })
  const manager = createRunObservationManager({
    projectBase,
    waiting: {hasPendingApproval: () => false, hasPendingQuestion: () => false},
    isRepoDenied: () => false,
    logger: capture.logger,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: Date.now,
  })

  const launchDeps = {
    coordinationConfig: store.config,
    identity: IDENTITY,
    checkRepoQuiescence: vi.fn(),
    // Always "busy": every launch is admitted and queued, so the record stays PENDING without an engine.
    concurrency: {tryAcquire: vi.fn(() => 'busy' as const), release: vi.fn(), activeCount: vi.fn(() => 0), max: 3},
    queue: {
      enqueue: vi.fn(() => 'queued' as const),
      takeNext: vi.fn(() => undefined),
      pendingCount: vi.fn(() => 0),
      clear: vi.fn(() => 0),
      removeBy: vi.fn(() => undefined),
    },
    attachUrl: 'http://localhost:3000',
    attachToken: 'attach-token',
    runTimeoutMs: 600_000,
    runInactivityTimeoutMs: 300_000,
    botUserId: 'bot-1',
    persona: null,
    logger: capture.logger,
    approvalRegistry: {} as never,
    approvalMode: 'approval-required',
    statusMode: 'live-status',
    ensureClone: vi.fn(),
    readyz: vi.fn(),
    update: vi.fn(),
    runIndex,
    runObserver: manager,
    operatorPushDispatcher: {
      dispatchApprovalPending: vi.fn(async (...args: unknown[]) => {
        capture.pushCalls.push(args)
      }),
      dispatchRunFailed: vi.fn(async (...args: unknown[]) => {
        capture.pushCalls.push(args)
      }),
    },
  } as unknown as RunMentionDeps

  const app = new Hono()
  setOperatorRouteGuard(app, async () => ({ok: true as const, githubUserId: 1001, sessionId: 'sess-1'}))
  buildLaunchRoute(app, {
    sessionStore: {get: () => ({githubUserId: 1001, login: 'alice', issuedAt: 0})},
    bindingsLookup: {getBindingByRepo: async () => ({success: true as const, data: bindings.bound ? BINDING : null})},
    denylistCache: {getDenylistState: async () => undefined, isRepoDenied: () => denylist.denied},
    idempotencyGuard: createIdempotencyGuard(),
    launchWorkDeps: launchDeps,
    logger: capture.logger,
    now: () => 0,
    perMinRateLimiter: {allow: () => true},
    perHrRateLimiter: {allow: () => true},
  })
  buildRunsRoute(app, {
    listBindings: async () => ({success: true as const, data: bindings.bound ? [BINDING] : []}),
    isRepoDenied: () => denylist.denied,
    logger: capture.logger,
    now: () => Date.now(),
    listRunsForRepo: listRunsForRepoSpy,
    approvalRegistry: {hasPendingForScope: () => false},
    questionRegistry: {hasPendingForScope: () => false},
    perMinRateLimiter: {allow: () => true},
  })

  return {app, store, capture, manager, runIndex, listRunsForRepoSpy, denylist, bindings, launchDeps}
}

async function launch(h: Harness, body: Record<string, unknown>): Promise<Response> {
  return h.app.fetch(
    new Request('http://localhost/operator/runs', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({repo: `${OWNER}/${REPO}`, ...body}),
    }),
  )
}

async function listRuns(h: Harness): Promise<RunSummary[]> {
  const res = await h.app.fetch(new Request('http://localhost/operator/runs'))
  expect(res.status).toBe(200)
  return ((await res.json()) as {runs: RunSummary[]}).runs
}

function storedState(h: Harness, runId: string): RunState {
  const entry = [...h.store.objects.entries()].find(([key]) => key.endsWith(`${runId}.json`))
  expect(entry).toBeDefined()
  return JSON.parse(entry?.[1].data ?? '{}') as RunState
}

const noopLogger = {
  debug: () => {},
  info: () => {},
}

afterEach(() => {
  vi.useRealTimers()
})

describe('launch prompt — real-store round trip (contract 1.12.0)', () => {
  it('launch → createRun JSON → heartbeat tick → FAILED: the summary keeps the prompt, the status never has it', async () => {
    // #given — a prompt with meaningful whitespace and unicode
    const h = makeHarness()
    const prompt = `  ${SENTINEL}: fix the flaky test 😀\n`

    // #when — launched through the real route (queued, so the record is PENDING)
    const res = await launch(h, {prompt})
    expect(res.status).toBe(202)
    const {runId} = (await res.json()) as {runId: string}

    // #then — the createRun JSON holds the operator's text as submitted, not the built prompt
    const created = storedState(h, runId)
    expect(created.surface).toBe('web')
    expect(created.details.operatorPrompt).toBe(prompt)
    expect(JSON.stringify(created.details)).not.toContain('Repository: ')

    // #when — a real heartbeat tick rewrites the whole record
    vi.useFakeTimers()
    const lock = await acquireLock(h.store.config, `${OWNER}/${REPO}`, IDENTITY, 'web', runId, noopLogger)
    expect(lock.success).toBe(true)
    const lockEtag = lock.success === true && 'etag' in lock.data ? String(lock.data.etag) : ''
    const heartbeat = createHeartbeatController(
      h.store.config,
      IDENTITY,
      `${OWNER}/${REPO}`,
      runId,
      lockEtag,
      'run-etag-0',
      noopLogger,
    )
    heartbeat.start()
    await vi.advanceTimersByTimeAsync(h.store.config.heartbeatIntervalMs + 1)
    const stopped = await heartbeat.stop()
    vi.useRealTimers()
    expect(stopped.success).toBe(true)

    // #then — the prompt survives the heartbeat rewrite
    expect(storedState(h, runId).details.operatorPrompt).toBe(prompt)

    // #when — the run fails (provider failure), via the real transition
    const failed = await transitionRun(
      h.store.config,
      IDENTITY,
      `${OWNER}/${REPO}`,
      runId,
      'FAILED',
      stopped.success === true ? stopped.data.runEtag : '',
      noopLogger,
      {detailsPatch: {failureKind: 'session-error', providerFailureReason: 'unclassified'}},
    )
    expect(failed.success).toBe(true)
    const final = storedState(h, runId)

    // #then — summary carries prompt and reason; status carries the reason but never the prompt
    const summary = toRunSummary(final, {owner: OWNER, repo: REPO})
    expect(summary).toMatchObject({runId, status: 'failed', prompt, providerFailureReason: 'unclassified'})
    const status = toOperatorRunStatus(final, {
      nowMs: Date.now(),
      staleThresholdMs: 60_000,
      repoKey: {databaseId: 42, nodeId: 'R_node_42'},
      isRepoDenylisted: () => false,
    }) as OperatorRunStatus
    expect(status.providerFailureReason).toBe('unclassified')
    expect(status).not.toHaveProperty('prompt')
    expect(JSON.stringify(status)).not.toContain(SENTINEL)
  })

  it('gET /operator/runs returns the exact prompt, and still does from a fresh run index (restart)', async () => {
    // #given
    const h = makeHarness()
    const prompt = `${SENTINEL} run the migration`
    const {runId} = (await (await launch(h, {prompt})).json()) as {runId: string}

    // #when — listed live, then through a brand new harness (new index, new manager) over the same store
    const live = await listRuns(h)
    const restarted = await listRuns(makeHarness(h.store))

    // #then
    expect(live.find(run => run.runId === runId)?.prompt).toBe(prompt)
    expect(restarted.find(run => run.runId === runId)?.prompt).toBe(prompt)
  })

  it('a Discord-surface run in the same repo has no prompt on its summary', async () => {
    // #given — a record written by the Discord path (no operatorPrompt) next to a web launch
    const h = makeHarness()
    await launch(h, {prompt: 'web prompt'})
    const key = [...h.store.objects.keys()][0] ?? ''
    const discordRun: RunState = {
      run_id: 'discord-run',
      surface: 'discord',
      thread_id: 'th',
      entity_ref: `${OWNER}/${REPO}`,
      phase: 'EXECUTING',
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      holder_id: IDENTITY,
      details: {},
    }
    h.store.objects.set(key.replace(/[^/]+\.json$/, 'discord-run.json'), {data: JSON.stringify(discordRun), etag: 'd1'})

    // #when
    const runs = await listRuns(h)

    // #then
    expect(runs.find(run => run.runId === 'discord-run')).toBeDefined()
    expect(runs.find(run => run.runId === 'discord-run')).not.toHaveProperty('prompt')
    expect(runs.filter(run => run.prompt !== undefined)).toHaveLength(1)
  })

  it('denylisting or unbinding the repo after launch hides the run, and its records are never read', async () => {
    // #given a launched run that is visible
    const h = makeHarness()
    await launch(h, {prompt: `${SENTINEL} visible`})
    expect(await listRuns(h)).toHaveLength(1)
    h.listRunsForRepoSpy.mockClear()

    // #when the repo is denylisted
    h.denylist.denied = true
    const whileDenied = await listRuns(h)

    // #then — omitted, and listRunsForRepo was never called for it
    expect(whileDenied).toEqual([])
    expect(h.listRunsForRepoSpy).not.toHaveBeenCalled()

    // #when it is un-denylisted but unbound
    h.denylist.denied = false
    h.bindings.bound = false
    const whileUnbound = await listRuns(h)

    // #then
    expect(whileUnbound).toEqual([])
    expect(h.listRunsForRepoSpy).not.toHaveBeenCalled()
  })

  it('a repeated idempotency key with a different prompt keeps the first prompt on the record', async () => {
    // #given
    const h = makeHarness()
    const first = (await (await launch(h, {prompt: 'FIRST prompt', idempotencyKey: 'k-1'})).json()) as {runId: string}

    // #when
    const second = (await (await launch(h, {prompt: 'SECOND prompt', idempotencyKey: 'k-1'})).json()) as {runId: string}

    // #then — the same run, a single record, and it holds the first prompt
    expect(second.runId).toBe(first.runId)
    expect(h.store.objects.size).toBe(1)
    expect(storedState(h, first.runId).details.operatorPrompt).toBe('FIRST prompt')
  })

  it('a zero-width-only prompt is stored exactly as sent (current behavior, pinned)', async () => {
    // #given
    const h = makeHarness()

    // #when
    const res = await launch(h, {prompt: '\u200B'})
    const {runId} = (await res.json()) as {runId: string}

    // #then
    expect(res.status).toBe(202)
    expect(storedState(h, runId).details.operatorPrompt).toBe('\u200B')
  })
})

describe('launch prompt — sentinel leak scan (contract 1.12.0)', () => {
  it('the prompt appears in no log call, SSE frame or push argument across launch, heartbeat and FAILED', async () => {
    // #given an SSE subscriber on the real manager
    const h = makeHarness()
    const prompt = `${SENTINEL} do something sensitive`
    const res = await launch(h, {prompt})
    const {runId} = (await res.json()) as {runId: string}
    h.manager.subscribe(runId, {
      onEvent: frame => {
        h.capture.frames.push(frame)
      },
      onClose: () => {},
    })

    // #when the record is observed in PENDING and again as a failed provider run
    await h.manager.observe(storedState(h, runId))
    await h.manager.observe({
      ...storedState(h, runId),
      phase: 'FAILED',
      details: {
        ...storedState(h, runId).details,
        failureKind: 'session-error',
        providerFailureReason: 'model-not-available',
      },
    })
    await new Promise<void>(resolve => {
      setImmediate(resolve)
    })
    await listRuns(h)

    // #then — frames were delivered (the scan is not vacuous) and none contains the prompt
    expect(h.capture.frames.some(frame => frame.type === 'status')).toBe(true)
    expect(h.capture.text()).not.toContain(SENTINEL)
    h.manager.shutdown()
  })

  it('an injected createRun failure returns 500 and leaks nothing', async () => {
    // #given the very first conditional write (createRun) fails
    const h = makeHarness()
    h.store.failNextPut.error = new Error('S3 503 SlowDown')

    // #when
    const res = await launch(h, {prompt: `${SENTINEL} will not be stored`})

    // #then — a coarse error, no record, and the sentinel is in no log call
    expect(res.status).toBe(500)
    expect(h.store.objects.size).toBe(0)
    expect(h.capture.text()).not.toContain(SENTINEL)
  })

  it('an injected FAILED-transition failure leaks nothing and keeps the stored prompt readable', async () => {
    // #given a launched run whose FAILED write then fails
    const h = makeHarness()
    const prompt = `${SENTINEL} keep me`
    const {runId} = (await (await launch(h, {prompt})).json()) as {runId: string}
    const etag = [...h.store.objects.entries()].find(([key]) => key.endsWith(`${runId}.json`))?.[1].etag ?? ''
    h.store.failNextPut.error = new Error('S3 500 InternalError')

    // #when
    // A capturing logger is passed on purpose: with a no-op logger the leak scan below could never fail.
    // `transitionRun` takes a `(message, context)` logger while the harness logger is pino-style
    // `(context, message)`, so adapt it onto the harness logger that `h.capture.text()` scans.
    const transitionLogger = {
      debug: (message: string, context?: Record<string, unknown>) => h.capture.logger.debug({...context}, message),
    }
    const logCallsBefore = vi.mocked(h.capture.logger.debug).mock.calls.length
    const failed = await transitionRun(
      h.store.config,
      IDENTITY,
      `${OWNER}/${REPO}`,
      runId,
      'FAILED',
      etag,
      transitionLogger,
    )

    // #then the failing path really ran and logged: `transitionRun` reads the record (which holds the prompt),
    // logs the pending transition, then the injected write failure surfaces
    expect(failed.success).toBe(false)
    const transitionLogs = vi
      .mocked(h.capture.logger.debug)
      .mock.calls.slice(logCallsBefore)
      .filter(call => call[1] === 'Transitioning run-state')
    expect(transitionLogs).toHaveLength(1)
    expect(transitionLogs[0]?.[0]).toMatchObject({repo: `${OWNER}/${REPO}`, runId, to: 'FAILED'})

    // #then neither the logs nor any sink carries the prompt, and the stored record keeps it
    expect(h.capture.text()).not.toContain(SENTINEL)
    expect(storedState(h, runId).details.operatorPrompt).toBe(prompt)
  })

  it('a corrupt record that begins with prompt text is skipped by listRunsForRepo without quoting it', async () => {
    // #given an object whose body is raw operator text (V8 JSON.parse errors quote this prefix)
    const h = makeHarness()
    const {runId} = (await (await launch(h, {prompt: `${SENTINEL} some words`})).json()) as {runId: string}
    const entry = [...h.store.objects.entries()].find(([key]) => key.endsWith(`${runId}.json`))
    h.store.objects.set(entry?.[0] ?? '', {data: `${SENTINEL} some words`, etag: 'corrupt'})

    // #when
    const runs = await h.runIndex.listRunsForRepo(`${OWNER}/${REPO}`)

    // #then
    expect(runs).toEqual([])
    // V8 quotes only a short prefix of the payload, so look for a fragment of the marker, not all of it
    expect(h.capture.text()).not.toContain('SENTINEL')
  })

  it('a truncated prompt-bearing record read through listRunsForRepo is skipped and logs nothing quoted', async () => {
    // #given a record cut off in the middle of the prompt
    const h = makeHarness()
    const {runId} = (await (await launch(h, {prompt: `${SENTINEL} some trailing words here`})).json()) as {
      runId: string
    }
    const entry = [...h.store.objects.entries()].find(([key]) => key.endsWith(`${runId}.json`))
    const full = entry?.[1].data ?? ''
    h.store.objects.set(entry?.[0] ?? '', {data: full.slice(0, full.indexOf('trailing words') + 8), etag: 'torn'})

    // #when
    const runs = await h.runIndex.listRunsForRepo(`${OWNER}/${REPO}`)

    // #then — the torn row is skipped, and what the index logged names no part of the payload
    expect(runs).toEqual([])
    expect(
      vi.mocked(h.capture.logger.debug).mock.calls.some(call => JSON.stringify(call).includes('parseRunState')),
    ).toBe(true)
    expect(h.capture.text()).not.toContain(SENTINEL)
    expect(h.capture.text()).not.toContain('trailing')
  })
})
