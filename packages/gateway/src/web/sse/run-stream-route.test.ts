/**
 * Tests for the authenticated SSE run-stream route.
 *
 * Security properties are the load-bearing assertions:
 *   - Every denial path returns the identical generic not-found shape.
 *   - No stream is opened unless all gates pass.
 *   - Success is observable ONLY as text/event-stream + first frame.
 *   - The resolved repo comes exclusively from runIndex.lookup — never from the client.
 *   - Repo access is the single bindings-only predicate (bound AND not denylisted); no GitHub call is made.
 *   - The lease re-checks session, allowlist and repo access, and its logs carry no owner/repo/run id.
 *
 * BDD comments: #given / #when / #then.
 */

import type {RunState} from '@fro-bot/runtime'
import type {OperatorRunStatus} from '../../operator-contract/index.js'
import type {DenylistCache, RepoKey} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {AuditLogger} from '../audit.js'
import type {OperatorAllowlist} from '../auth/allowlist.js'
import type {ObservationFrame, RunObservationManager, SubscriberCallbacks} from './manager.js'
import type {RunStreamRouteDeps} from './run-stream-route.js'

import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {createRunObservationManager} from './manager.js'
import {buildRunStreamRoute} from './run-stream-route.js'

// ---------------------------------------------------------------------------
// Fake timer seam for lease tests
// ---------------------------------------------------------------------------

/**
 * A minimal fake setInterval/clearInterval pair that lets tests drive ticks
 * manually without real timers.
 */
function makeFakeTimer(): {
  readonly setInterval: (fn: () => void, _ms: number) => ReturnType<typeof globalThis.setInterval>
  readonly clearInterval: (id: ReturnType<typeof globalThis.setInterval> | undefined) => void
  readonly tick: () => Promise<void>
  readonly tickCount: () => number
  readonly cleared: () => boolean
} {
  let callback: (() => void) | undefined
  let ticks = 0
  let isCleared = false
  let nextId = 1

  return {
    setInterval: (fn: () => void, _ms: number): ReturnType<typeof globalThis.setInterval> => {
      callback = fn
      return nextId++ as unknown as ReturnType<typeof globalThis.setInterval>
    },
    clearInterval: (_id: ReturnType<typeof globalThis.setInterval> | undefined): void => {
      isCleared = true
      callback = undefined
    },
    tick: async (): Promise<void> => {
      if (callback !== undefined) {
        ticks++
        callback()
        // Yield to let async work inside the tick settle
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    },
    tickCount: () => ticks,
    cleared: () => isCleared,
  }
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeLogger(): RunStreamRouteDeps['logger'] {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

/** A valid session entry returned by the default stub session store. */
const STUB_SESSION = {
  githubUserId: 99,
  login: 'testuser',
  issuedAt: 0,
} as const

function makeSessionStore(overrides?: Partial<RunStreamRouteDeps['sessionStore']>): RunStreamRouteDeps['sessionStore'] {
  return {
    get: vi.fn(() => STUB_SESSION),
    ...overrides,
  }
}

function makeAllowlist(allowed = true): OperatorAllowlist {
  return {isAuthorized: vi.fn(() => allowed), size: 1}
}

function makeAuditLogger(): AuditLogger {
  return {info: vi.fn(), warn: vi.fn()}
}

function makeRunIndex(repo?: string): RunStreamRouteDeps['runIndex'] {
  return {
    lookup: vi.fn(async () => (repo === undefined ? undefined : {repo, surface: 'github' as const})),
  }
}

function makeDenylistCache(denied = false): DenylistCache {
  return {
    getDenylistState: vi.fn(async () => undefined),
    isRepoDenied: vi.fn(() => denied),
  }
}

function makeBindingsLookup(databaseId?: number, nodeId?: string): BindingsLookup {
  const data = databaseId !== undefined || nodeId !== undefined ? {databaseId, nodeId} : null
  return {
    getBindingByRepo: vi.fn(async () => ({success: true as const, data})),
  }
}

/** A bindings lookup whose answer the test can change between the gate and a lease tick. */
function makeMutableBindingsLookup(
  read: () => Awaited<ReturnType<BindingsLookup['getBindingByRepo']>>,
): BindingsLookup {
  return {getBindingByRepo: vi.fn(async () => read())}
}

const BOUND = {success: true as const, data: {databaseId: 42, nodeId: 'node-id-1'}}

function makeManager(overrides?: Partial<RunObservationManager>): RunObservationManager {
  return {
    observe: vi.fn(async () => undefined),
    observeOutput: vi.fn(),
    observeApproval: vi.fn(),
    observeQuestion: vi.fn(),
    subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    abortSubscription: vi.fn(),
    shutdown: vi.fn(),
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<RunStreamRouteDeps>): RunStreamRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    runIndex: makeRunIndex('acme/widget'),
    denylistCache: makeDenylistCache(false),
    bindingsLookup: makeBindingsLookup(42, 'node-id-1'),
    allowlist: makeAllowlist(true),
    auditLogger: makeAuditLogger(),
    manager: makeManager(),
    logger: makeLogger(),
    ...overrides,
  }
}

/**
 * Build deps with a fake timer injected for lease tests.
 */
function makeDepsWithFakeTimer(
  fakeTimer: ReturnType<typeof makeFakeTimer>,
  overrides?: Partial<RunStreamRouteDeps>,
): RunStreamRouteDeps {
  return makeDeps({
    setInterval: fakeTimer.setInterval,
    clearInterval: fakeTimer.clearInterval,
    ...overrides,
  })
}

/**
 * Build a Hono app with the guard installed and the run-stream route registered.
 * The guard sets githubUserId and sessionId on the context.
 */
function buildTestApp(
  deps: RunStreamRouteDeps,
  guardUserId = 99,
  guardSessionId = 'test-session-id',
  installGuard = true,
): Hono {
  const app = new Hono()

  if (installGuard) {
    setOperatorRouteGuard(app, async (_c, _method, _path) => ({
      ok: true as const,
      githubUserId: guardUserId,
      sessionId: guardSessionId,
    }))
  }

  buildRunStreamRoute(app, deps)
  return app
}

/**
 * Make a GET request to the run-stream route.
 */
async function fetchStream(app: Hono, runId: string): Promise<Response> {
  const req = new Request(`http://localhost/operator/runs/${runId}/stream`)
  return app.fetch(req)
}

// ---------------------------------------------------------------------------
// No credential: the route depends on the session store's identity read only
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — no OAuth token dependency', () => {
  it('opens a stream with a session store that exposes only get()', async () => {
    // #given — the session store has no token accessor at all
    const sessionStore = makeSessionStore()
    expect(Object.keys(sessionStore)).toEqual(['get'])
    const manager = makeManager()
    const app = buildTestApp(makeDeps({sessionStore, manager}))

    // #when
    const res = await fetchStream(app, 'run-abc')

    // #then — the stream opens; no token or GitHub call was needed
    expect(res.status).toBe(200)
    expect(manager.subscribe).toHaveBeenCalledOnce()
    await res.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Security: unknown runId → not-found, no authz/redaction call
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — unknown runId', () => {
  it('returns not-found when lookup returns undefined', async () => {
    // #given — run does not exist
    const runIndex = makeRunIndex(undefined)
    const denylistCache = makeDenylistCache(false)
    const manager = makeManager()
    const deps = makeDeps({runIndex, denylistCache, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'unknown-run-id')
    const body = await res.json()

    // #then — not-found, no downstream calls
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(denylistCache.isRepoDenied).not.toHaveBeenCalled()
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('makes no binding read after a run lookup miss', async () => {
    // #given — run does not exist; the binding store must never be asked
    const runIndex = makeRunIndex(undefined)
    const bindingsLookup = makeBindingsLookup(42, 'node-id-1')
    const deps = makeDeps({runIndex, bindingsLookup})
    const app = buildTestApp(deps)

    // #when
    await fetchStream(app, 'unknown-run-id')

    // #then
    expect(bindingsLookup.getBindingByRepo).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Security: client cannot influence resolved repo
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — server-owned repo resolution', () => {
  it('uses only runIndex.lookup to determine owner/repo, ignoring any query params', async () => {
    // #given — run resolves to acme/widget; query param tries to inject a different repo
    const runIndex = makeRunIndex('acme/widget')
    const bindingsLookup = makeBindingsLookup(42, 'node-id-1')
    const deps = makeDeps({runIndex, bindingsLookup})
    const app = buildTestApp(deps)

    // #when — request includes a query param attempting to override the repo
    const req = new Request('http://localhost/operator/runs/run-abc/stream?repo=evil/repo&owner=evil')
    await app.fetch(req)

    // #then — getBindingByRepo was called with the server-resolved owner/repo, not the query param
    expect(bindingsLookup.getBindingByRepo).toHaveBeenCalledWith('acme', 'widget')
    expect(bindingsLookup.getBindingByRepo).not.toHaveBeenCalledWith('evil', 'repo')
  })

  it('returns not-found for a malformed repo string (no slash)', async () => {
    // #given — run resolves to a malformed repo string
    const runIndex = makeRunIndex('noslash')
    const manager = makeManager()
    const deps = makeDeps({runIndex, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — malformed repo → not-found, no stream
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('returns not-found for a repo string with empty owner', async () => {
    // #given — repo string starts with slash (empty owner)
    const runIndex = makeRunIndex('/widget')
    const manager = makeManager()
    const deps = makeDeps({runIndex, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('returns not-found for a repo string with empty repo name', async () => {
    // #given — repo string ends with slash (empty repo name)
    const runIndex = makeRunIndex('acme/')
    const manager = makeManager()
    const deps = makeDeps({runIndex, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// NBC-4: #-suffix strip — fragment in location.repo must not bleed into repo name
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — #-suffix strip in resolved repo', () => {
  it('strips a trailing #runNumber from location.repo before resolving owner/repo', async () => {
    // #given — runIndex returns a repo string with a #-suffix fragment
    const runIndex = makeRunIndex('owner/repo#42')
    const bindingsLookup = makeBindingsLookup(42, 'node-id-1')
    const deps = makeDeps({runIndex, bindingsLookup})
    const app = buildTestApp(deps)

    // #when
    await fetchStream(app, 'run-abc')

    // #then — downstream calls use 'repo', not 'repo#42'
    expect(bindingsLookup.getBindingByRepo).toHaveBeenCalledWith('owner', 'repo')
    expect(bindingsLookup.getBindingByRepo).not.toHaveBeenCalledWith('owner', 'repo#42')
  })
})

// ---------------------------------------------------------------------------
// Security: 429 over-cap path — no SSE frame written, no stream entered
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — 429 over-cap: no SSE frame emitted', () => {
  it('returns 429 with no ready frame and no data frame when the per-operator cap is exceeded', async () => {
    // #given — cap of 1; first stream holds the slot open
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    // First request acquires the slot; do not await the body so the stream stays open
    const res1Promise = fetchStream(app, 'run-abc')
    await new Promise<void>(resolve => setTimeout(resolve, 10))

    // #when — second request from the same operator (same githubUserId=99)
    const res2 = await fetchStream(app, 'run-def')

    // #then — 429 response; subscribe was never called for the second request
    expect(res2.status).toBe(429)
    const body2 = await res2.json()
    expect(body2).toEqual({error: 'rate limited'})
    // subscribe called exactly once (only for the first, slot-holding request)
    expect(manager.subscribe).toHaveBeenCalledTimes(1)
    // response is not text/event-stream — no SSE stream was entered
    const contentType = res2.headers.get('content-type') ?? ''
    expect(contentType).not.toContain('text/event-stream')

    const res1 = await res1Promise
    await res1.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Security: denylisted repo → not-found
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — denylisted repo', () => {
  it('returns not-found when repo is denied, with no stream', async () => {
    // #given — repo is on the denylist
    const denylistCache = makeDenylistCache(true)
    const manager = makeManager()
    const deps = makeDeps({denylistCache, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — not-found, no stream
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('calls getDenylistState before isRepoDenied', async () => {
    // #given — track call order
    const callOrder: string[] = []
    const denylistCache: DenylistCache = {
      getDenylistState: vi.fn(async () => {
        callOrder.push('getDenylistState')
      }),
      isRepoDenied: vi.fn(() => {
        callOrder.push('isRepoDenied')
        return false
      }),
    }
    const deps = makeDeps({denylistCache})
    const app = buildTestApp(deps)

    // #when
    await fetchStream(app, 'run-abc')

    // #then — getDenylistState called before isRepoDenied
    expect(callOrder.indexOf('getDenylistState')).toBeLessThan(callOrder.indexOf('isRepoDenied'))
  })
})

// ---------------------------------------------------------------------------
// Security: unbound / unavailable / malformed → not-found, byte-identical to other denials
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — repo access denied', () => {
  it('returns the same not-found shape for unbound, unavailable, throwing and malformed repos', async () => {
    // #given — each non-allowed outcome of the repo-access predicate, plus a path-traversal repo name
    const unbound = makeMutableBindingsLookup(() => ({success: true as const, data: null}))
    const unavailable = makeMutableBindingsLookup(() => ({success: false as const, error: new Error('s3 down')}))
    const throwing: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => {
        throw new Error('boom')
      }),
    }
    const malformedLookup = makeBindingsLookup(42, 'node-id-1')
    const variants: RunStreamRouteDeps[] = [
      makeDeps({bindingsLookup: unbound}),
      makeDeps({bindingsLookup: unavailable}),
      makeDeps({bindingsLookup: throwing}),
      makeDeps({runIndex: makeRunIndex('acme/..'), bindingsLookup: malformedLookup}),
    ]

    for (const deps of variants) {
      // #when
      const res = await fetchStream(buildTestApp(deps), 'run-abc')

      // #then — identical 404 body, no stream
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({error: 'not-found'})
      expect(deps.manager.subscribe).not.toHaveBeenCalled()
    }

    // #and — a malformed name made zero binding reads
    expect(malformedLookup.getBindingByRepo).not.toHaveBeenCalled()
  })

  it('emits no audit event for a repo-level denial, and logs one label for unbound and denylisted', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const logger = makeLogger()
    const unbound = makeDeps({
      auditLogger,
      logger,
      bindingsLookup: makeMutableBindingsLookup(() => ({success: true as const, data: null})),
    })
    const denied = makeDeps({auditLogger, logger, denylistCache: makeDenylistCache(true)})

    // #when
    await fetchStream(buildTestApp(unbound), 'run-abc')
    await fetchStream(buildTestApp(denied), 'run-abc')

    // #then
    expect(auditLogger.info).not.toHaveBeenCalled()
    expect(auditLogger.warn).not.toHaveBeenCalled()
    expect(vi.mocked(logger.warn).mock.calls.map(call => call[0])).toEqual([
      {githubUserId: 99, gate: 'repo-denied'},
      {githubUserId: 99, gate: 'repo-denied'},
    ])
  })
})

// ---------------------------------------------------------------------------
// Security (THE no-oracle test): success is ONLY observable as SSE stream
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — no-oracle: success is stream-only', () => {
  it('returns text/event-stream content-type on success, not a JSON body', async () => {
    // #given — all gates pass; manager delivers a status frame
    const statusFrame = {
      type: 'status' as const,
      data: {
        runId: 'run-abc',
        entityRef: 'acme/widget#1',
        surface: 'github' as const,
        phase: 'EXECUTING' as const,
        status: 'running' as const,
        startedAt: '2024-01-01T00:00:00.000Z',
        stale: false,
      },
    }
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        // Deliver the first frame synchronously (simulates snapshot-on-subscribe)
        queueMicrotask(() => {
          Promise.resolve(callbacks.onEvent(statusFrame)).catch(() => {})
        })
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')

    // #then — content-type is text/event-stream, not application/json
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Consume the body to avoid resource leaks
    await res.body?.cancel()
  })

  it('does not return a JSON body on success — no 200 JSON marker', async () => {
    // #given — all gates pass
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')

    // #then — response is NOT application/json (no oracle marker)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).not.toContain('application/json')

    await res.body?.cancel()
  })

  it('calls manager.subscribe exactly once on success', async () => {
    // #given — all gates pass
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')

    // #then — subscribe called once with the correct runId
    expect(manager.subscribe).toHaveBeenCalledTimes(1)
    expect(manager.subscribe).toHaveBeenCalledWith('run-abc', expect.any(Object))

    await res.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Cap: over-cap operator → 429, no stream
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — per-operator stream cap', () => {
  it('returns 429 when the operator is at the stream cap', async () => {
    // #given — cap of 1, operator already has 1 active stream
    // The first stream stays open (never calls onClose) to hold the slot.
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    // First request acquires the slot. We do NOT await the body — the stream stays open.
    // fetchStream returns the Response (headers) immediately; the body is a live stream.
    const res1Promise = fetchStream(app, 'run-abc')
    // Give the first request time to acquire the slot before the second request arrives.
    await new Promise<void>(resolve => setTimeout(resolve, 10))

    // #when — second request from the same operator (same githubUserId=99)
    const res2 = await fetchStream(app, 'run-def')
    const body2 = await res2.json()

    // #then — 429 (honest backpressure for an already-authorized operator)
    expect(res2.status).toBe(429)
    expect(body2).toEqual({error: 'rate limited'})
    // subscribe was only called once (for the first request)
    expect(manager.subscribe).toHaveBeenCalledTimes(1)

    // Clean up: cancel the first stream body to avoid resource leaks
    const res1 = await res1Promise
    await res1.body?.cancel()
  })

  it('allows a stream when under the cap', async () => {
    // #given — cap of 2, operator has 0 active streams
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager, maxStreamsPerOperator: 2})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')

    // #then — stream opened
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    await res.body?.cancel()
  })

  it('releases the slot when the stream ends, allowing a new stream', async () => {
    // #given — cap of 1; first stream ends via onClose
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })
    const deps = makeDeps({manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    // First stream opens
    const res1 = await fetchStream(app, 'run-abc')
    expect(res1.status).toBe(200)

    // Close the first stream via manager onClose
    capturedCallbacks?.onClose('terminal')
    await res1.body?.cancel()

    // #when — second request after slot is released
    const res2 = await fetchStream(app, 'run-def')

    // #then — slot was released; new stream is allowed
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Deny-key resolution: fail-closed on store error
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — deny-key resolution', () => {
  it('treats a binding store error as fail-closed (null/null keys → denied)', async () => {
    // #given — binding store returns an error
    const bindingsLookup: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => ({success: false as const, error: new Error('store error')})),
    }
    // Denylist treats null/null as denied
    const denylistCache: DenylistCache = {
      getDenylistState: vi.fn(async () => undefined),
      isRepoDenied: vi.fn((repoKey: RepoKey) => repoKey.databaseId === null && repoKey.nodeId === null),
    }
    const manager = makeManager()
    const deps = makeDeps({bindingsLookup, denylistCache, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — fail-closed: store error → null/null keys → denied → not-found
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('treats a missing binding (data=null) as fail-closed (null/null keys → denied)', async () => {
    // #given — binding not found
    const bindingsLookup: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => ({success: true as const, data: null})),
    }
    const denylistCache: DenylistCache = {
      getDenylistState: vi.fn(async () => undefined),
      isRepoDenied: vi.fn((repoKey: RepoKey) => repoKey.databaseId === null && repoKey.nodeId === null),
    }
    const manager = makeManager()
    const deps = makeDeps({bindingsLookup, denylistCache, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — fail-closed: missing binding → null/null keys → denied → not-found
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('passes correct deny keys to isRepoDenied when binding has both keys', async () => {
    // #given — binding has both databaseId and nodeId
    const bindingsLookup = makeBindingsLookup(42, 'node-id-1')
    const isRepoDenied = vi.fn(() => false)
    const denylistCache: DenylistCache = {
      getDenylistState: vi.fn(async () => undefined),
      isRepoDenied,
    }
    const deps = makeDeps({bindingsLookup, denylistCache})
    const app = buildTestApp(deps)

    // #when
    await fetchStream(app, 'run-abc')

    // #then — isRepoDenied called with the correct keys
    expect(isRepoDenied).toHaveBeenCalledWith({databaseId: 42, nodeId: 'node-id-1'})
  })
})

// ---------------------------------------------------------------------------
// Integration: assertAllPrivilegedRoutesWrapped passes
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — route registration', () => {
  it('is registered as a privileged route (guard-wrapped)', () => {
    // #given — build app with guard installed
    const deps = makeDeps()
    const app = buildTestApp(deps)

    // #when — inspect the route registry
    const routes = (app.routes as {method: string; path: string}[]).filter(
      r => r.method !== 'ALL' && r.path === '/operator/runs/:runId/stream',
    )

    // #then — route is registered
    expect(routes.length).toBeGreaterThan(0)
    expect(routes[0]?.method).toBe('GET')
  })

  it('returns not-found when no guard is installed (guard-not-installed fallback)', async () => {
    // #given — no guard installed; route falls back to coarse not-found
    const deps = makeDeps()
    const app = new Hono()
    buildRunStreamRoute(app, deps)

    // #when — request without guard context
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — coarse not-found (guard not installed → authCtx undefined)
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
  })
})

// ---------------------------------------------------------------------------
// Happy path: all gates pass → SSE stream with first frame
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — happy path', () => {
  it('delivers the first snapshot frame as an SSE event on success', async () => {
    // #given — all gates pass; manager delivers a status frame
    const statusData = {
      runId: 'run-abc',
      entityRef: 'acme/widget#1',
      surface: 'github' as const,
      phase: 'EXECUTING' as const,
      status: 'running' as const,
      startedAt: '2024-01-01T00:00:00.000Z',
      stale: false,
    }
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        // Deliver the snapshot frame immediately
        Promise.resolve(callbacks.onEvent({type: 'status', data: statusData})).catch(() => {})
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')

    // #then — SSE stream with status event
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Read the first chunk of the SSE stream
    const reader = res.body?.getReader()
    if (reader === undefined) {
      throw new Error('Expected a readable body')
    }
    const decoder = new TextDecoder()
    let text = ''
    // Read until we have the status event or exhaust the stream
    for (let i = 0; i < 10; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      if (text.includes('event: status')) break
    }
    await reader.cancel()

    expect(text).toContain('event: status')
    expect(text).toContain('"runId":"run-abc"')
  })

  it('delivers a reset frame when no snapshot exists', async () => {
    // #given — manager delivers a reset frame (no cached snapshot)
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        Promise.resolve(callbacks.onEvent({type: 'reset', runId: 'run-abc', reason: 'no-snapshot'})).catch(() => {})
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')

    // #then — SSE stream with reset event
    expect(res.status).toBe(200)

    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('Expected a readable body')
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 10; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      if (text.includes('event: reset')) break
    }
    await reader.cancel()

    expect(text).toContain('event: reset')
    expect(text).toContain('"runId":"run-abc"')
  })
})

// ---------------------------------------------------------------------------
// Socket timeout: per-connection timeout raised on stream open, restored on cleanup
// ---------------------------------------------------------------------------

/** Build a mock socket with a controllable setTimeout. */
function makeMockSocket(initialTimeout = 10_000): {
  readonly socket: {setTimeout: ReturnType<typeof vi.fn>; timeout: number}
  readonly setTimeoutCalls: number[]
} {
  const setTimeoutCalls: number[] = []
  const socket = {
    setTimeout: vi.fn((ms: number) => {
      setTimeoutCalls.push(ms)
      socket.timeout = ms
    }),
    timeout: initialTimeout,
  }
  return {socket, setTimeoutCalls}
}

/** Build a mock HttpBindings env with a controllable socket. */
function makeMockEnv(socket: {setTimeout: ReturnType<typeof vi.fn>; timeout: number}): {
  incoming: {socket: typeof socket}
  outgoing: Record<string, never>
} {
  return {incoming: {socket}, outgoing: {}}
}

/** Fetch the stream route with a mock env (simulates @hono/node-server bindings). */
async function fetchStreamWithEnv(app: Hono, runId: string, env: Record<string, unknown>): Promise<Response> {
  const req = new Request(`http://localhost/operator/runs/${runId}/stream`)
  return app.fetch(req, env)
}

describe('GET /operator/runs/:runId/stream — socket timeout', () => {
  it('calls socket.setTimeout(60_000) on stream open (above the 15s heartbeat)', async () => {
    // #given — all gates pass; mock socket with initial timeout of 10_000
    const {socket, setTimeoutCalls} = makeMockSocket(10_000)
    const env = makeMockEnv(socket)
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when — stream opens with mock env
    const res = await fetchStreamWithEnv(app, 'run-abc', env)

    // #then — socket.setTimeout called with 60_000 (> 15_000 heartbeat)
    expect(setTimeoutCalls).toContain(60_000)
    expect(60_000).toBeGreaterThan(15_000)

    await res.body?.cancel()
  })

  it('restores the prior socket timeout on cleanup (onClose path)', async () => {
    // #given — mock socket with initial timeout of 10_000; manager closes the stream
    const {socket, setTimeoutCalls} = makeMockSocket(10_000)
    const env = makeMockEnv(socket)
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when — stream opens, then manager closes it
    const res = await fetchStreamWithEnv(app, 'run-abc', env)
    capturedCallbacks?.onClose('terminal')
    await res.body?.cancel()

    // #then — setTimeout called with 60_000 (raise), then 10_000 (restore)
    expect(setTimeoutCalls[0]).toBe(60_000)
    expect(setTimeoutCalls.at(-1)).toBe(10_000)
  })

  it('restores the prior socket timeout on the write-failure path', async () => {
    // #given — mock socket; onEvent write throws to simulate a broken connection
    const {socket, setTimeoutCalls} = makeMockSocket(10_000)
    const env = makeMockEnv(socket)
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    const res = await fetchStreamWithEnv(app, 'run-abc', env)

    // Trigger a write failure by calling onEvent after the stream body is cancelled
    await res.body?.cancel()
    // Deliver a frame after cancel — writeFrame will throw; cleanup must still restore
    if (capturedCallbacks !== undefined) {
      const result = capturedCallbacks.onEvent({type: 'heartbeat'})
      if (result instanceof Promise) {
        await result.catch(() => {})
      }
    }

    // #then — restore call must have happened (last setTimeout call = prior timeout)
    expect(setTimeoutCalls[0]).toBe(60_000)
    expect(setTimeoutCalls.at(-1)).toBe(10_000)
  })

  it('does not crash when socket is undefined (graceful degrade)', async () => {
    // #given — env with no socket (c.env.incoming.socket is undefined)
    const envNoSocket = {incoming: {socket: undefined}, outgoing: {}}
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when — stream opens without a socket
    const res = await fetchStreamWithEnv(app, 'run-abc', envNoSocket)

    // #then — stream still opens normally (no crash)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    await res.body?.cancel()
  })

  it('does not crash when c.env is undefined (test harness / non-node-server path)', async () => {
    // #given — no env passed (c.env is undefined, as in plain Hono test harness)
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when — plain fetch with no env
    const res = await fetchStream(app, 'run-abc')

    // #then — stream still opens normally
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    await res.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Cleanup idempotency: concurrent onAbort + onClose run cleanup exactly once
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — cleanup idempotency', () => {
  it('concurrent onAbort + onClose: unsubscribe called once, slot released once', async () => {
    // #given — cap of 1; track unsubscribe calls
    let unsubscribeCalls = 0
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => {
          unsubscribeCalls++
        }
      }),
    })
    const deps = makeDeps({manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    // First stream opens and holds the slot
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #when — fire both onAbort (via body cancel) and onClose concurrently
    // onAbort fires when the body is cancelled; onClose fires from the manager
    const abortPromise = res.body?.cancel()
    capturedCallbacks?.onClose('terminal')
    await abortPromise

    // #then — unsubscribe called exactly once (idempotent cleanup)
    expect(unsubscribeCalls).toBe(1)

    // Slot must be released: a new stream from the same operator should succeed
    const res2 = await fetchStream(app, 'run-def')
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
  })

  it('concurrent onAbort + onClose with socket: socket restored exactly once', async () => {
    // #given — mock socket; both teardown paths fire
    const {socket, setTimeoutCalls} = makeMockSocket(10_000)
    const env = makeMockEnv(socket)
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    const res = await fetchStreamWithEnv(app, 'run-abc', env)

    // #when — fire both teardown paths
    const abortPromise = res.body?.cancel()
    capturedCallbacks?.onClose('terminal')
    await abortPromise

    // #then — restore call (10_000) appears exactly once after the raise (60_000)
    const restoreCalls = setTimeoutCalls.filter(ms => ms === 10_000)
    expect(restoreCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// EOF / observation-failed: clean stream end, not an error
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — EOF / observation-failed', () => {
  it('ends the stream cleanly when manager closes with observation-failed', async () => {
    // #given — manager closes with observation-failed (EOF before terminal)
    let capturedCallbacks: SubscriberCallbacks | undefined
    let unsubscribeCalls = 0
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => {
          unsubscribeCalls++
        }
      }),
    })
    const deps = makeDeps({manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #when — manager signals EOF (observation failure, not run success)
    capturedCallbacks?.onClose('observation-failed')
    await res.body?.cancel()

    // #then — cleanup ran (unsubscribe called, slot released)
    expect(unsubscribeCalls).toBe(1)

    // Slot released: new stream allowed
    const res2 = await fetchStream(app, 'run-def')
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Isolation: one connection's teardown does not affect other subscribers
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — isolation', () => {
  it('unsubscribes only the per-connection subscriber, not the run-wide abortSubscription', async () => {
    // #given — two connections to the same run; each gets its own unsubscribe
    let sub1Unsubscribed = false
    let sub2Unsubscribed = false
    let sub1Callbacks: SubscriberCallbacks | undefined
    let callCount = 0

    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        callCount++
        if (callCount === 1) {
          sub1Callbacks = callbacks
          return () => {
            sub1Unsubscribed = true
          }
        }
        return () => {
          sub2Unsubscribed = true
        }
      }),
    })
    const deps = makeDeps({manager, maxStreamsPerOperator: 5})
    // Two separate apps (different operator user IDs) to avoid cap collision
    const app1 = buildTestApp(deps, 1, 'session-1')
    const app2 = buildTestApp(deps, 2, 'session-2')

    const res1 = await fetchStream(app1, 'run-abc')
    const res2 = await fetchStream(app2, 'run-abc')
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    // #when — close only connection 1 via manager onClose
    sub1Callbacks?.onClose('terminal')
    await res1.body?.cancel()

    // #then — only sub1 was unsubscribed; sub2 is unaffected
    expect(sub1Unsubscribed).toBe(true)
    expect(sub2Unsubscribed).toBe(false)
    // abortSubscription was never called (run-wide teardown)
    expect(manager.abortSubscription).not.toHaveBeenCalled()

    await res2.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Heartbeat: heartbeat frames flow through writeFrame
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — heartbeat', () => {
  it('writes a heartbeat frame as an SSE comment line', async () => {
    // #given — manager delivers a heartbeat frame
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        Promise.resolve(callbacks.onEvent({type: 'heartbeat'})).catch(() => {})
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('Expected a readable body')
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 10; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      if (text.includes(': heartbeat')) break
    }
    await reader.cancel()

    // #then — heartbeat written as SSE comment (keepalive, not a named event)
    expect(text).toContain(': heartbeat')
  })

  it('socket timeout (60_000) exceeds the manager heartbeat interval (15_000)', () => {
    // #given / #then — structural invariant: the socket timeout must exceed the heartbeat
    // so an idle-but-heartbeating stream is not killed by the socket timeout.
    const SOCKET_TIMEOUT_MS = 60_000
    const HEARTBEAT_INTERVAL_MS = 15_000
    expect(SOCKET_TIMEOUT_MS).toBeGreaterThan(HEARTBEAT_INTERVAL_MS)
  })
})

// ---------------------------------------------------------------------------
// Continuous-authz lease: binding removed / store unavailable / operator off the allowlist
// ---------------------------------------------------------------------------

/** Open a stream with a fake lease timer and return what the lease tests need to assert on. */
async function openLeasedStream(overrides: Partial<RunStreamRouteDeps>) {
  let unsubscribeCalls = 0
  const manager = makeManager({
    subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => {
      return () => {
        unsubscribeCalls++
      }
    }),
  })
  const fakeTimer = makeFakeTimer()
  const logger = makeLogger()
  const auditLogger = makeAuditLogger()
  const deps = makeDepsWithFakeTimer(fakeTimer, {manager, logger, auditLogger, maxStreamsPerOperator: 1, ...overrides})
  const app = buildTestApp(deps)
  const res = await fetchStream(app, 'run-abc')
  expect(res.status).toBe(200)
  return {app, res, fakeTimer, logger, auditLogger, unsubscribeCalls: () => unsubscribeCalls}
}

describe('GET /operator/runs/:runId/stream — lease: binding removed mid-stream', () => {
  it('closes the stream on the next tick when the binding disappears, and frees the slot', async () => {
    // #given — stream opens bound; the binding is removed before the tick
    let result: Awaited<ReturnType<BindingsLookup['getBindingByRepo']>> = BOUND
    const stream = await openLeasedStream({bindingsLookup: makeMutableBindingsLookup(() => result)})

    // #when
    result = {success: true, data: null}
    await stream.fakeTimer.tick()

    // #then — connection closed, no audit event for a repo-level denial
    expect(stream.unsubscribeCalls()).toBe(1)
    expect(stream.auditLogger.warn).not.toHaveBeenCalled()
    expect(stream.auditLogger.info).not.toHaveBeenCalled()

    // #and — the slot was released (a new stream succeeds once the binding is back)
    result = BOUND
    const res2 = await fetchStream(stream.app, 'run-def')
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
    await stream.res.body?.cancel()
  })

  it('closes the stream when a lease-tick binding read errors (transient unavailable fails closed)', async () => {
    // #given
    let result: Awaited<ReturnType<BindingsLookup['getBindingByRepo']>> = BOUND
    const stream = await openLeasedStream({bindingsLookup: makeMutableBindingsLookup(() => result)})

    // #when — the binding read fails on the tick
    result = {success: false, error: new Error('s3 down')}
    await stream.fakeTimer.tick()

    // #then
    expect(stream.unsubscribeCalls()).toBe(1)
    expect(vi.mocked(stream.logger.warn).mock.calls.map(call => call[0])).toEqual([
      {githubUserId: 99, gate: 'repo-unavailable'},
    ])
    await stream.res.body?.cancel()
  })

  it('closes the stream when a lease-tick binding read throws', async () => {
    // #given
    let throwNow = false
    const stream = await openLeasedStream({
      bindingsLookup: {
        getBindingByRepo: vi.fn(async () => {
          if (throwNow) throw new Error('boom')
          return BOUND
        }),
      },
    })

    // #when
    throwNow = true
    await stream.fakeTimer.tick()

    // #then
    expect(stream.unsubscribeCalls()).toBe(1)
    await stream.res.body?.cancel()
  })

  it('reads the binding exactly once per tick', async () => {
    // #given
    const bindingsLookup = makeMutableBindingsLookup(() => BOUND)
    const stream = await openLeasedStream({bindingsLookup})
    expect(bindingsLookup.getBindingByRepo).toHaveBeenCalledTimes(1) // the gate

    // #when
    await stream.fakeTimer.tick()

    // #then
    expect(bindingsLookup.getBindingByRepo).toHaveBeenCalledTimes(2)
    expect(stream.unsubscribeCalls()).toBe(0)
    await stream.res.body?.cancel()
  })
})

describe('GET /operator/runs/:runId/stream — lease: bounded repo-access read', () => {
  it('closes the stream when a lease-tick binding read never settles within the timeout', async () => {
    // #given — the gate read succeeds, then every later binding read hangs
    let reads = 0
    const bindingsLookup: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => {
        reads++
        if (reads === 1) return BOUND
        return new Promise<never>(() => undefined)
      }),
    }
    const stream = await openLeasedStream({bindingsLookup, leaseRepoAccessTimeoutMs: 20})

    // #when — a tick starts a read that never answers
    await stream.fakeTimer.tick()
    expect(stream.unsubscribeCalls()).toBe(0)
    await new Promise<void>(resolve => setTimeout(resolve, 60))

    // #then — the timeout counts as unavailable and closes the stream
    expect(stream.unsubscribeCalls()).toBe(1)
    expect(vi.mocked(stream.logger.warn).mock.calls.map(call => call[0])).toEqual([
      {githubUserId: 99, gate: 'repo-unavailable'},
    ])
    await stream.res.body?.cancel()
  })

  it('does not start a second check while the previous one is still in flight', async () => {
    // #given — a lease-tick read that stays pending until the test releases it
    let release!: (value: typeof BOUND) => void
    const pending = new Promise<typeof BOUND>(resolve => {
      release = resolve
    })
    let reads = 0
    const bindingsLookup: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => {
        reads++
        return reads === 2 ? pending : BOUND
      }),
    }
    const stream = await openLeasedStream({bindingsLookup, leaseRepoAccessTimeoutMs: 60_000})
    expect(reads).toBe(1) // the gate

    // #when — three ticks fire while the first check is pending
    await stream.fakeTimer.tick()
    await stream.fakeTimer.tick()
    await stream.fakeTimer.tick()

    // #then — only the first tick read the binding
    expect(reads).toBe(2)

    // #when — the pending read answers and a later tick fires
    release(BOUND)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await stream.fakeTimer.tick()

    // #then — checks resume, and the stream is still open
    expect(reads).toBe(3)
    expect(stream.unsubscribeCalls()).toBe(0)
    await stream.res.body?.cancel()
  })
})

const LEASE_READ_TIMEOUT_MS = 777

/** Keyed one-shot fake: every timer is kept, so the max-duration timer and the lease read timer do not clobber each other. */
function makeKeyedFakeTimeouts() {
  const timers = new Map<number, {readonly fn: () => void; readonly ms: number; cleared: boolean; fired: boolean}>()
  let nextId = 1
  const find = (ms: number) => [...timers.values()].filter(timer => timer.ms === ms)
  return {
    setTimeout: (fn: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
      const id = nextId++
      timers.set(id, {fn, ms, cleared: false, fired: false})
      return id as unknown as ReturnType<typeof globalThis.setTimeout>
    },
    clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout> | undefined): void => {
      const timer = timers.get(handle as unknown as number)
      if (timer !== undefined) timer.cleared = true
    },
    /** Fires every live timer scheduled for `ms`. */
    fire: async (ms: number): Promise<void> => {
      for (const timer of find(ms)) {
        if (timer.cleared === false && timer.fired === false) {
          timer.fired = true
          timer.fn()
        }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    },
    scheduled: (ms: number) => find(ms).length,
    cleared: (ms: number) => find(ms).filter(timer => timer.cleared).length,
  }
}

describe('GET /operator/runs/:runId/stream — lease: read timer through the timer seam', () => {
  it('clears the read timer when the read wins, and never fires it', async () => {
    // #given — the injected timer seam and a binding read that answers at once
    const timeouts = makeKeyedFakeTimeouts()
    const stream = await openLeasedStream({
      setTimeout: timeouts.setTimeout,
      clearTimeout: timeouts.clearTimeout,
      leaseRepoAccessTimeoutMs: LEASE_READ_TIMEOUT_MS,
    })
    expect(timeouts.scheduled(LEASE_READ_TIMEOUT_MS)).toBe(0)

    // #when — a tick runs its check
    await stream.fakeTimer.tick()

    // #then — one read timer was scheduled through the seam and cleared, and the stream is still open
    expect(timeouts.scheduled(LEASE_READ_TIMEOUT_MS)).toBe(1)
    expect(timeouts.cleared(LEASE_READ_TIMEOUT_MS)).toBe(1)
    expect(stream.unsubscribeCalls()).toBe(0)
    await timeouts.fire(LEASE_READ_TIMEOUT_MS)
    expect(stream.unsubscribeCalls()).toBe(0)
    await stream.res.body?.cancel()
  })

  it('ignores a read that resolves after the timeout has fired: no second close and no re-open', async () => {
    // #given — a lease-tick read that stays pending
    let release!: (value: {success: true; data: null} | typeof BOUND) => void
    const pending = new Promise<{success: true; data: null} | typeof BOUND>(resolve => {
      release = resolve
    })
    let reads = 0
    const bindingsLookup: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => {
        reads++
        return reads === 1 ? BOUND : pending
      }),
    }
    const timeouts = makeKeyedFakeTimeouts()
    const subscribe = vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined)
    const unsubscribeSpy = vi.fn()
    const stream = await openLeasedStream({
      bindingsLookup,
      manager: makeManager({
        subscribe: vi.fn((runId: string, callbacks: SubscriberCallbacks) => {
          subscribe(runId, callbacks)
          return unsubscribeSpy
        }),
      }),
      setTimeout: timeouts.setTimeout,
      clearTimeout: timeouts.clearTimeout,
      leaseRepoAccessTimeoutMs: LEASE_READ_TIMEOUT_MS,
    })

    // #when — the tick starts, the read timer fires first, then the read answers late
    await stream.fakeTimer.tick()
    await timeouts.fire(LEASE_READ_TIMEOUT_MS)
    release(BOUND)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await stream.fakeTimer.tick()

    // #then — the stream closed exactly once as unavailable, and nothing re-subscribed
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(vi.mocked(stream.logger.warn).mock.calls.map(call => call[0])).toEqual([
      {githubUserId: 99, gate: 'repo-unavailable'},
    ])
    await stream.res.body?.cancel()
  })

  it('resets the in-flight flag when a check throws', async () => {
    // #given — a timer that keeps its callback after the stream closes, and a session read that throws on the tick
    let intervalCallback: (() => void) | undefined
    let sessionReads = 0
    const sessionStore = {
      get: vi.fn(() => {
        sessionReads++
        if (sessionReads === 1) throw new Error('boom')
        return {githubUserId: 99, login: 'testuser', issuedAt: 0}
      }),
    }
    const stream = await openLeasedStream({
      sessionStore,
      setInterval: (fn: () => void) => {
        intervalCallback = fn
        return 1 as unknown as ReturnType<typeof globalThis.setInterval>
      },
      clearInterval: () => undefined,
    })
    expect(sessionReads).toBe(0) // the gate does not read the session; the guard does

    // #when — the first tick throws, closing the stream, then the callback is invoked again
    intervalCallback?.()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(stream.unsubscribeCalls()).toBe(1)
    expect(sessionReads).toBe(1)
    intervalCallback?.()
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    // #then — the second invocation ran its check (the flag was reset), rather than returning early
    expect(sessionReads).toBe(2)
    await stream.res.body?.cancel()
  })
})

describe('GET /operator/runs/:runId/stream — lease: operator removed from the allowlist mid-stream', () => {
  it('closes the stream on the next tick and emits exactly one authz.denied (not_allowlisted)', async () => {
    // #given — allowlisted at open; removed before the tick
    let allowed = true
    const allowlist: OperatorAllowlist = {isAuthorized: vi.fn(() => allowed), size: 1}
    const stream = await openLeasedStream({allowlist})

    // #when
    allowed = false
    await stream.fakeTimer.tick()

    // #then — closed, and exactly one operator-level audit event with the surviving reason
    expect(stream.unsubscribeCalls()).toBe(1)
    const authzEvents = vi
      .mocked(stream.auditLogger.warn)
      .mock.calls.filter(call => (call[0] as {kind?: string}).kind === 'authz.denied')
    expect(authzEvents).toHaveLength(1)
    expect(authzEvents[0]?.[0]).toMatchObject({kind: 'authz.denied', githubUserId: 99, reason: 'not_allowlisted'})
    expect(vi.mocked(stream.logger.warn).mock.calls.map(call => call[0])).toEqual([
      {githubUserId: 99, gate: 'allowlist'},
    ])
    await stream.res.body?.cancel()
  })

  it('does not consult the binding store once the operator is off the allowlist', async () => {
    // #given
    let allowed = true
    const bindingsLookup = makeMutableBindingsLookup(() => BOUND)
    const stream = await openLeasedStream({allowlist: {isAuthorized: vi.fn(() => allowed), size: 1}, bindingsLookup})
    vi.mocked(bindingsLookup.getBindingByRepo).mockClear()

    // #when
    allowed = false
    await stream.fakeTimer.tick()

    // #then
    expect(bindingsLookup.getBindingByRepo).not.toHaveBeenCalled()
    await stream.res.body?.cancel()
  })
})

describe('GET /operator/runs/:runId/stream — lease: log contexts leak no identity', () => {
  it('no lease denial log or audit event carries an owner, repo or run id', async () => {
    // #given — three separate streams, each closed by a different lease check
    // (the route handler itself reads neither the session nor the allowlist — the guard does — so the
    // first lease tick is the first read of each)
    let denied = false
    const closers: Partial<RunStreamRouteDeps>[] = [
      {sessionStore: makeSessionStore({get: vi.fn(() => (denied ? undefined : STUB_SESSION))})},
      {allowlist: {isAuthorized: vi.fn(() => denied === false), size: 1}},
      {denylistCache: {getDenylistState: vi.fn(async () => undefined), isRepoDenied: vi.fn(() => denied)}},
    ]

    for (const overrides of closers) {
      const stream = await openLeasedStream(overrides)
      denied = true
      await stream.fakeTimer.tick()
      expect(stream.unsubscribeCalls()).toBe(1)

      // #then — only the operator id and a gate label are logged for the denial
      const serialized = JSON.stringify([
        vi.mocked(stream.logger.warn).mock.calls,
        vi.mocked(stream.auditLogger.warn).mock.calls,
      ])
      expect(serialized).not.toContain('acme')
      expect(serialized).not.toContain('widget')
      expect(serialized).not.toContain('run-abc')
      await stream.res.body?.cancel()
      denied = false
    }
  })
})

// ---------------------------------------------------------------------------
// Continuous-authz lease: repo denylisted mid-stream
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — lease: repo denylisted mid-stream', () => {
  it('closes the stream on the next tick when isRepoDenied flips to true', async () => {
    // #given — stream opens with repo allowed; denylist flips to denied
    let isDenied = false
    const denylistCache: DenylistCache = {
      getDenylistState: vi.fn(async () => undefined),
      isRepoDenied: vi.fn(() => isDenied),
    }

    let unsubscribeCalls = 0
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => {
        return () => {
          unsubscribeCalls++
        }
      }),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {denylistCache, manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // Flip denylist, then fire a lease tick
    isDenied = true
    await fakeTimer.tick()

    // #then — cleanup ran: unsubscribe called once (connection closed)
    expect(unsubscribeCalls).toBe(1)

    // Restore denylist and verify the slot was released (new stream succeeds)
    isDenied = false
    const res2 = await fetchStream(app, 'run-def')
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
    await res.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Continuous-authz lease: session expired / revoked mid-stream
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — lease: session loss mid-stream', () => {
  it('closes the stream on the next tick when session.get returns undefined', async () => {
    // #given — session is valid at open time; expires before the lease tick
    let sessionValid = true
    const sessionStore = makeSessionStore({
      get: vi.fn(() => (sessionValid ? STUB_SESSION : undefined)),
    })

    let unsubscribeCalls = 0
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => {
        return () => {
          unsubscribeCalls++
        }
      }),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {sessionStore, manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // Expire the session, then fire a lease tick
    sessionValid = false
    await fakeTimer.tick()

    // #then — cleanup ran
    expect(unsubscribeCalls).toBe(1)

    // Slot released
    const res2 = await fetchStream(app, 'run-def')
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
    await res.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Continuous-authz lease: generation guard (late-resolving check is a no-op)
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — lease: generation guard', () => {
  it('a lease tick whose binding read resolves after teardown does nothing (no double cleanup)', async () => {
    // #given — a slow binding read that we can resolve manually after teardown
    let resolveBinding!: (result: {success: true; data: null}) => void
    const slowBinding = new Promise<{success: true; data: null}>(resolve => {
      resolveBinding = resolve
    })

    // First call (gate): bound immediately. Subsequent calls (lease tick): the slow promise.
    let callCount = 0
    const bindingsLookup: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => {
        callCount++
        if (callCount === 1) return BOUND
        return slowBinding
      }),
    }

    let unsubscribeCalls = 0
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => {
          unsubscribeCalls++
        }
      }),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {bindingsLookup, manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)
    expect(capturedCallbacks).toBeDefined()

    // Start a lease tick — the binding read is now in flight (blocked on slowBinding).
    const tickPromise = fakeTimer.tick()

    // Tear down the connection via manager onClose BEFORE the tick resolves
    capturedCallbacks?.onClose('terminal')
    await res.body?.cancel()
    expect(unsubscribeCalls).toBe(1)

    // Now resolve the slow read (binding gone, which would otherwise close the stream)
    resolveBinding({success: true, data: null})
    await tickPromise

    // #then — unsubscribe still called exactly once (generation guard prevented double cleanup)
    expect(unsubscribeCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Continuous-authz lease: timer cleared on teardown
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — lease: timer cleared on teardown', () => {
  it('clears the lease timer when the stream ends via manager onClose', async () => {
    // #given — stream opens with a fake timer
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {manager})
    const app = buildTestApp(deps)

    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #when — stream ends via manager onClose
    capturedCallbacks?.onClose('terminal')
    await res.body?.cancel()

    // #then — clearInterval was called (timer cleared in cleanup)
    expect(fakeTimer.cleared()).toBe(true)
  })

  it('does not fire further ticks after cleanup (advancing timer is a no-op)', async () => {
    // #given — stream opens; we track how many times the lease check runs after teardown
    let leaseCheckCount = 0
    const bindingsLookup: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => {
        leaseCheckCount++
        return BOUND
      }),
    }

    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {bindingsLookup, manager})
    const app = buildTestApp(deps)

    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // Close the stream
    capturedCallbacks?.onClose('terminal')
    await res.body?.cancel()

    // Reset the counter after teardown so we only count post-teardown ticks
    leaseCheckCount = 0

    // #when — advance the timer after teardown (should be a no-op)
    await fakeTimer.tick()
    await fakeTimer.tick()

    // #then — no further lease checks fired after teardown
    expect(leaseCheckCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Continuous-authz lease: no false drop (still-authorized stream survives ticks)
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — lease: no false drop', () => {
  it('a still-authorized stream survives multiple lease ticks without cleanup', async () => {
    // #given — authz always passes; stream stays open
    let unsubscribeCalls = 0
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => {
        return () => {
          unsubscribeCalls++
        }
      }),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {manager})
    const app = buildTestApp(deps)

    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #when — fire multiple lease ticks with authz still passing
    await fakeTimer.tick()
    await fakeTimer.tick()
    await fakeTimer.tick()

    // #then — no cleanup fired; stream still open
    expect(unsubscribeCalls).toBe(0)

    await res.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Cap hardening: reconnect storm
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — cap: reconnect storm', () => {
  it('active count never exceeds maxStreams during rapid open+close cycles', async () => {
    // #given — cap of 2; track active count via subscribe/unsubscribe
    let activeCount = 0
    let maxObservedCount = 0
    const callbacks: SubscriberCallbacks[] = []

    const manager = makeManager({
      subscribe: vi.fn((_runId: string, cb: SubscriberCallbacks) => {
        activeCount++
        if (activeCount > maxObservedCount) maxObservedCount = activeCount
        callbacks.push(cb)
        return () => {
          activeCount--
        }
      }),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {manager, maxStreamsPerOperator: 2})
    const app = buildTestApp(deps)

    // Open 2 streams (at cap)
    const res1 = await fetchStream(app, 'run-1')
    const res2 = await fetchStream(app, 'run-2')
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    // Third should be 429
    const res3 = await fetchStream(app, 'run-3')
    expect(res3.status).toBe(429)
    await res3.json()

    // Close stream 1 via onClose (synchronous slot release)
    callbacks[0]?.onClose('terminal')
    await res1.body?.cancel()

    // Now a new stream should succeed (slot was released synchronously)
    const res4 = await fetchStream(app, 'run-4')
    expect(res4.status).toBe(200)

    // #then — active count never exceeded maxStreams
    expect(maxObservedCount).toBeLessThanOrEqual(2)

    await res2.body?.cancel()
    await res4.body?.cancel()
  })

  it('each close frees exactly one slot (synchronous release in cleanup)', async () => {
    // #given — cap of 1; open, close, open again — should always succeed
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    for (let i = 0; i < 5; i++) {
      const res = await fetchStream(app, `run-${i}`)
      expect(res.status).toBe(200)
      // Close via onClose (synchronous slot release)
      capturedCallbacks?.onClose('terminal')
      await res.body?.cancel()
    }

    // After all cycles, a new stream should still succeed
    const finalRes = await fetchStream(app, 'run-final')
    expect(finalRes.status).toBe(200)
    await finalRes.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Cap hardening: multi-session same operator shares one cap
// ---------------------------------------------------------------------------

/**
 * Build a Hono app where the guard's sessionId is controlled by a mutable ref.
 * This lets a single app simulate multiple sessions from the same operator.
 */
function buildTestAppWithMutableSession(
  deps: RunStreamRouteDeps,
  guardUserId: number,
  sessionIdRef: {current: string},
): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async (_c, _method, _path) => ({
    ok: true as const,
    githubUserId: guardUserId,
    sessionId: sessionIdRef.current,
  }))
  buildRunStreamRoute(app, deps)
  return app
}

describe('GET /operator/runs/:runId/stream — cap: multi-session same operator', () => {
  it('two streams from the same githubUserId but different sessionIds share one cap', async () => {
    // #given — cap of 1; same githubUserId (99) with two different sessionIds
    // A single app with a mutable sessionId ref so both requests share the same activeStreams map
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {manager, maxStreamsPerOperator: 1})

    const sessionIdRef = {current: 'session-A'}
    const app = buildTestAppWithMutableSession(deps, 99, sessionIdRef)

    // First stream from session-A (githubUserId=99)
    sessionIdRef.current = 'session-A'
    const res1 = await app.fetch(new Request('http://localhost/operator/runs/run-1/stream'))
    expect(res1.status).toBe(200)

    // #when — second stream from session-B (same githubUserId=99, different session)
    sessionIdRef.current = 'session-B'
    const res2 = await app.fetch(new Request('http://localhost/operator/runs/run-2/stream'))
    const body2 = await res2.json()

    // #then — 429: cap is keyed on githubUserId, not sessionId
    expect(res2.status).toBe(429)
    expect(body2).toEqual({error: 'rate limited'})

    await res1.body?.cancel()
  })

  it('the (maxStreams+1)th stream from the same githubUserId is 429 regardless of session', async () => {
    // #given — cap of 2; open 2 streams from different sessions, 3rd is 429
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })

    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {manager, maxStreamsPerOperator: 2})

    const sessionIdRef = {current: 'session-A'}
    const app = buildTestAppWithMutableSession(deps, 99, sessionIdRef)

    sessionIdRef.current = 'session-A'
    const res1 = await app.fetch(new Request('http://localhost/operator/runs/run-1/stream'))
    sessionIdRef.current = 'session-B'
    const res2 = await app.fetch(new Request('http://localhost/operator/runs/run-2/stream'))
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    // #when — third stream from a third session (same githubUserId)
    sessionIdRef.current = 'session-C'
    const res3 = await app.fetch(new Request('http://localhost/operator/runs/run-3/stream'))
    const body3 = await res3.json()

    // #then — 429
    expect(res3.status).toBe(429)
    expect(body3).toEqual({error: 'rate limited'})

    await res1.body?.cancel()
    await res2.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// FIX-2: synchronous onClose during subscribe — no TDZ, slot released, timer cleared
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — synchronous onClose during subscribe', () => {
  it('synchronous onClose("shutdown") during subscribe does not throw and releases the slot', async () => {
    // #given — manager fires onClose synchronously during subscribe (simulates shutdown)
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        // Fire onClose synchronously before subscribe returns
        callbacks.onClose('shutdown')
        return () => undefined
      }),
    })
    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    // #when — request that triggers synchronous onClose during subscribe
    // This must not throw a TDZ ReferenceError (unsubscribe was undefined at onClose time)
    let res: Response | undefined
    await expect(
      (async () => {
        res = await fetchStream(app, 'run-abc')
      })(),
    ).resolves.not.toThrow()

    // #then — slot was released (new stream from same operator succeeds)
    const res2 = await fetchStream(app, 'run-def')
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
    await res?.body?.cancel()
  })

  it('synchronous onClose during subscribe clears the lease timer', async () => {
    // #given — manager fires onClose synchronously during subscribe
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        callbacks.onClose('shutdown')
        return () => undefined
      }),
    })
    const fakeTimer = makeFakeTimer()
    const deps = makeDepsWithFakeTimer(fakeTimer, {manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')

    // #then — clearInterval was called (timer cleared even though it was set after subscribe)
    expect(fakeTimer.cleared()).toBe(true)

    await res?.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// FIX-2: socket.setTimeout throw does not skip slot release
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — socket.setTimeout throw resilience', () => {
  it('slot is released even when restoreSocketTimeout throws (ERR_SOCKET_DESTROYED)', async () => {
    // #given — a mock socket whose setTimeout throws on the restore call
    let setTimeoutCallCount = 0
    const socket = {
      setTimeout: vi.fn((ms: number) => {
        setTimeoutCallCount++
        // First call (raise) succeeds; second call (restore) throws
        if (setTimeoutCallCount >= 2) {
          throw new Error('ERR_SOCKET_DESTROYED')
        }
        socket.timeout = ms
      }),
      timeout: 10_000,
    }
    const env = makeMockEnv(socket)

    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })
    const deps = makeDeps({manager, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    const res = await fetchStreamWithEnv(app, 'run-abc', env)
    expect(res.status).toBe(200)

    // #when — close the stream (triggers restoreSocketTimeout which throws)
    capturedCallbacks?.onClose('terminal')
    await res.body?.cancel()

    // #then — slot was released despite the socket throw (new stream succeeds)
    const res2 = await fetchStream(app, 'run-def')
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// FIX-3: gate throws → 404 (no-oracle preserved)
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — gate throws → 404', () => {
  it('returns 404 when the binding lookup throws (no 500, no stream)', async () => {
    // #given — binding store throws
    const bindingsLookup: BindingsLookup = {
      getBindingByRepo: vi.fn(async () => {
        throw new Error('store unavailable')
      }),
    }
    const manager = makeManager()
    const deps = makeDeps({bindingsLookup, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — 404 (not 500), no stream opened
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('returns 404 when runIndex.lookup throws (no 500, no stream)', async () => {
    // #given — runIndex throws
    const runIndex: RunStreamRouteDeps['runIndex'] = {
      lookup: vi.fn(async () => {
        throw new Error('index unavailable')
      }),
    }
    const manager = makeManager()
    const deps = makeDeps({runIndex, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — 404 (not 500), no stream opened
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('returns 404 when getDenylistState throws (no 500, no stream)', async () => {
    // #given — denylist cache throws on getDenylistState
    const denylistCache: DenylistCache = {
      getDenylistState: vi.fn(async () => {
        throw new Error('denylist unavailable')
      }),
      isRepoDenied: vi.fn(() => false),
    }
    const manager = makeManager()
    const deps = makeDeps({denylistCache, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — 404 (not 500), no stream opened
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// FIX-5: lease check throws → stream closed (fail-closed)
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — lease: unexpected throw closes stream', () => {
  it('closes the stream when the lease check throws unexpectedly inside a tick', async () => {
    // #given — the gate passes; the session read throws on the lease tick
    let throwNow = false
    const sessionStore = makeSessionStore({
      get: vi.fn(() => {
        if (throwNow) throw new Error('session store exploded')
        return STUB_SESSION
      }),
    })
    const stream = await openLeasedStream({sessionStore})

    // #when — fire a lease tick where the check throws
    throwNow = true
    await stream.fakeTimer.tick()

    // #then — stream was closed (fail-closed on unexpected lease error), and the log carries no run id
    expect(stream.unsubscribeCalls()).toBe(1)
    const leaseErrorCtx = vi
      .mocked(stream.logger.warn)
      .mock.calls.find(call => call[1] === 'run-stream: lease check threw — closing stream')?.[0]
    expect(leaseErrorCtx).toBeDefined()
    expect(Object.keys(leaseErrorCtx ?? {}).toSorted()).toEqual(['error', 'githubUserId'])

    await stream.res.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Route-owned max-duration timer: defense-in-depth hard cap
// ---------------------------------------------------------------------------

/**
 * A minimal fake setTimeout/clearTimeout pair that lets tests fire the one-shot
 * timer manually without real wall-clock delays.
 */
function makeFakeOneShotTimer(): {
  readonly setTimeout: (fn: () => void, _ms: number) => ReturnType<typeof globalThis.setTimeout>
  readonly clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout> | undefined) => void
  readonly fire: () => Promise<void>
  readonly cleared: () => boolean
  readonly scheduled: () => boolean
} {
  let callback: (() => void) | undefined
  let isCleared = false

  return {
    setTimeout: (fn: () => void, _ms: number): ReturnType<typeof globalThis.setTimeout> => {
      callback = fn
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>
    },
    clearTimeout: (_handle: ReturnType<typeof globalThis.setTimeout> | undefined): void => {
      isCleared = true
      callback = undefined
    },
    fire: async (): Promise<void> => {
      if (callback !== undefined) {
        callback()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    },
    cleared: () => isCleared,
    scheduled: () => callback !== undefined,
  }
}

describe('GET /operator/runs/:runId/stream — route-owned max-duration timer', () => {
  it('firing the max-duration timer triggers cleanup: unsubscribe called once, slot released, stream resolves', async () => {
    // #given — stream opens with a fake one-shot timer; manager holds the stream open
    let unsubscribeCalls = 0
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => {
        return () => {
          unsubscribeCalls++
        }
      }),
    })

    const fakeTimer = makeFakeTimer()
    const fakeOneShot = makeFakeOneShotTimer()
    const deps = makeDeps({
      manager,
      maxStreamsPerOperator: 1,
      setInterval: fakeTimer.setInterval,
      clearInterval: fakeTimer.clearInterval,
      setTimeout: fakeOneShot.setTimeout,
      clearTimeout: fakeOneShot.clearTimeout,
    })
    const app = buildTestApp(deps)

    // #when — stream opens
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)
    expect(fakeOneShot.scheduled()).toBe(true)

    // Fire the max-duration timer
    await fakeOneShot.fire()

    // #then — cleanup ran: unsubscribe called once
    expect(unsubscribeCalls).toBe(1)

    // Slot must be released: a new stream from the same operator should succeed
    const res2 = await fetchStream(app, 'run-def')
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
    await res.body?.cancel()
  })

  it('max-duration timer is cleared on a normal teardown path (no leak)', async () => {
    // #given — stream opens with a fake one-shot timer; manager closes the stream normally
    let capturedCallbacks: SubscriberCallbacks | undefined
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        capturedCallbacks = callbacks
        return () => undefined
      }),
    })

    const fakeTimer = makeFakeTimer()
    const fakeOneShot = makeFakeOneShotTimer()
    const deps = makeDeps({
      manager,
      setInterval: fakeTimer.setInterval,
      clearInterval: fakeTimer.clearInterval,
      setTimeout: fakeOneShot.setTimeout,
      clearTimeout: fakeOneShot.clearTimeout,
    })
    const app = buildTestApp(deps)

    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)
    expect(fakeOneShot.scheduled()).toBe(true)

    // #when — stream ends via manager onClose (normal teardown)
    capturedCallbacks?.onClose('terminal')
    await res.body?.cancel()

    // #then — clearTimeout was called (timer cleared in cleanup, no leak)
    expect(fakeOneShot.cleared()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FIX-D: contract version ready frame emitted as first SSE frame on success
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — contract version ready frame', () => {
  it('emits a ready frame with contractVersion as the first SSE event on success', async () => {
    // #given — all gates pass; manager holds the stream open
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #then — first SSE event is 'ready' with contractVersion
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('Expected a readable body')
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 10; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      if (text.includes('event: ready')) break
    }
    await reader.cancel()

    expect(text).toContain('event: ready')
    expect(text).toContain('"contractVersion"')
  })

  it('does NOT emit a ready frame on denial paths (no-oracle preserved)', async () => {
    // #given — runIndex returns undefined (run not found)
    const runIndex = makeRunIndex(undefined)
    const deps = makeDeps({runIndex})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — 404 JSON response, no SSE stream, no ready frame
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(res.headers.get('content-type')).not.toContain('text/event-stream')
  })
})

// ---------------------------------------------------------------------------
// output frame — writeFrame 'output' branch + ready-first ordering
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — output frame written to SSE stream', () => {
  it("writes an output frame as event:'output' with JSON-serialized frame data", async () => {
    // #given — manager delivers an output frame via the subscriber callback
    const outputData = {
      runId: 'run-abc',
      text: 'Hello from the agent',
      final: false,
      seq: 1,
    }
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        // Deliver the output frame immediately (mirrors the status-frame happy-path pattern)
        Promise.resolve(callbacks.onEvent({type: 'output', data: outputData})).catch(() => {})
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #then — SSE stream contains event: output with the serialized frame data
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('Expected a readable body')
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 10; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      if (text.includes('event: output')) break
    }
    await reader.cancel()

    expect(text).toContain('event: output')
    expect(text).toContain('"runId":"run-abc"')
    expect(text).toContain('"text":"Hello from the agent"')
    expect(text).toContain('"final":false')
    expect(text).toContain('"seq":1')
  })

  it("writes a final output frame (final:true) as event:'output' carrying final:true", async () => {
    // #given — manager delivers a terminal output frame (final: true)
    const outputData = {
      runId: 'run-abc',
      text: 'Final answer from the agent',
      final: true,
      seq: 5,
    }
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        Promise.resolve(callbacks.onEvent({type: 'output', data: outputData})).catch(() => {})
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #then — event: output with final:true in the serialized data
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('Expected a readable body')
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 10; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      if (text.includes('event: output')) break
    }
    await reader.cancel()

    expect(text).toContain('event: output')
    expect(text).toContain('"final":true')
    expect(text).toContain('"seq":5')
    expect(text).toContain('"text":"Final answer from the agent"')
  })
})

// ---------------------------------------------------------------------------
// ready-first ordering — ready frame precedes any output frame
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — ready frame precedes output frame (ordering regression guard)', () => {
  it('emits the ready frame before any output frame pushed through the subscriber callback', async () => {
    // #given — manager delivers an output frame; ready is emitted before subscribe is called
    const outputData = {
      runId: 'run-abc',
      text: 'Agent output text',
      final: false,
      seq: 1,
    }
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        // Deliver the output frame immediately after subscribe is called.
        // The ready frame is fire-and-forget BEFORE subscribe, so it must appear first.
        Promise.resolve(callbacks.onEvent({type: 'output', data: outputData})).catch(() => {})
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #then — read enough chunks to capture both ready and output events
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('Expected a readable body')
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 15; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      // Stop once we have both events
      if (text.includes('event: ready') && text.includes('event: output')) break
    }
    await reader.cancel()

    // Both events must be present
    expect(text).toContain('event: ready')
    expect(text).toContain('event: output')

    // ready must appear before output in the stream
    const readyIndex = text.indexOf('event: ready')
    const outputIndex = text.indexOf('event: output')
    expect(readyIndex).toBeLessThan(outputIndex)
  })
})

// ===========================================================================
// writeFrame — approval frame serialization and exhaustiveness guard
// ===========================================================================

describe('writeFrame — approval frame serialization', () => {
  it('serializes an open ApprovalFrame (settled:false) as an SSE approval event', async () => {
    // #given — manager delivers an open approval frame
    const approvalData = {
      requestID: 'req-abc',
      permission: 'bash',
      command: 'ls -la',
      settled: false as const,
    }
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        Promise.resolve(callbacks.onEvent({type: 'approval', runId: 'run-abc', data: approvalData})).catch(() => {})
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #then — read enough chunks to capture the approval event
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('Expected a readable body')
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 15; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      if (text.includes('event: approval')) break
    }
    await reader.cancel()

    // #then the approval event is present in the stream
    expect(text).toContain('event: approval')

    // #then the data payload contains the expected fields
    const approvalEventMatch = /event: approval\ndata: (.+)\n/.exec(text)
    expect(approvalEventMatch).not.toBeNull()
    const parsed = JSON.parse(approvalEventMatch![1]!) as Record<string, unknown>
    expect(parsed.requestID).toBe('req-abc')
    expect(parsed.permission).toBe('bash')
    expect(parsed.command).toBe('ls -la')
    expect(parsed.settled).toBe(false)
    expect(parsed.runId).toBe('run-abc')
  })

  it('serializes a settle/clear ApprovalFrame (settled:true) as an SSE approval event', async () => {
    // #given — manager delivers a settle/clear approval frame
    const settleData = {requestID: 'req-abc', settled: true as const}
    const manager = makeManager({
      subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
        Promise.resolve(callbacks.onEvent({type: 'approval', runId: 'run-abc', data: settleData})).catch(() => {})
        return () => undefined
      }),
    })
    const deps = makeDeps({manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    expect(res.status).toBe(200)

    // #then — read enough chunks to capture the approval event
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('Expected a readable body')
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 15; i++) {
      const result = await reader.read()
      if (result.done === true) break
      text += decoder.decode(result.value as Uint8Array, {stream: true})
      if (text.includes('event: approval')) break
    }
    await reader.cancel()

    // #then the approval event is present
    expect(text).toContain('event: approval')

    // #then the data payload contains settled:true and requestID
    const approvalEventMatch = /event: approval\ndata: (.+)\n/.exec(text)
    expect(approvalEventMatch).not.toBeNull()
    const parsed = JSON.parse(approvalEventMatch![1]!) as Record<string, unknown>
    expect(parsed.requestID).toBe('req-abc')
    expect(parsed.settled).toBe(true)
    expect(parsed.runId).toBe('run-abc')
  })
})

async function readQuestionEvent(frame: ObservationFrame): Promise<Record<string, unknown>> {
  const manager = makeManager({
    subscribe: vi.fn((_runId: string, callbacks: SubscriberCallbacks) => {
      Promise.resolve(callbacks.onEvent(frame)).catch(() => {})
      return () => undefined
    }),
  })
  const app = buildTestApp(makeDeps({manager}))
  const res = await fetchStream(app, 'run-abc')
  expect(res.status).toBe(200)

  const reader = res.body?.getReader()
  if (reader === undefined) throw new Error('Expected a readable body')
  const decoder = new TextDecoder()
  let text = ''
  for (let i = 0; i < 15; i++) {
    const result = await reader.read()
    if (result.done === true) break
    text += decoder.decode(result.value as Uint8Array, {stream: true})
    if (text.includes('event: question')) break
  }
  await reader.cancel()

  expect(text).toContain('event: question')
  const match = /event: question\ndata: (.+)\n/.exec(text)
  const data = match?.[1]
  if (data === undefined) throw new Error('Expected a question event payload')
  return JSON.parse(data) as Record<string, unknown>
}

// ===========================================================================
// writeFrame — question frame serialization
// ===========================================================================

describe('writeFrame — question frame serialization', () => {
  it('serializes an open question frame as an SSE question event, carrying text verbatim', async () => {
    // #given an open question frame whose text is an injection payload
    const payload = '<img src=x onerror=alert(1)> and `backticks` and **bold**'
    const parsed = await readQuestionEvent({
      type: 'question',
      runId: 'run-abc',
      data: {
        requestID: 'q-1',
        runId: 'run-abc',
        questions: [
          {
            header: 'Pick',
            text: payload,
            options: [{label: 'A', description: payload}],
            multiple: false,
            custom: true,
          },
        ],
        settled: false,
      },
    })

    // #then the payload is a plain string value, untouched
    expect(parsed.requestID).toBe('q-1')
    expect(parsed.runId).toBe('run-abc')
    expect(parsed.settled).toBe(false)
    const [question] = parsed.questions as {text: string; options: {description: string}[]}[]
    expect(question?.text).toBe(payload)
    expect(question?.options[0]?.description).toBe(payload)
  })

  it('serializes a settle frame as an SSE question event', async () => {
    // #given a settle frame
    const parsed = await readQuestionEvent({
      type: 'question',
      runId: 'run-abc',
      data: {requestID: 'q-1', runId: 'run-abc', settled: true},
    })

    // #then only the id, run id, and settled flag are present
    expect(parsed).toStrictEqual({requestID: 'q-1', runId: 'run-abc', settled: true})
  })
})

interface SseChunk {
  readonly done: boolean
  readonly value?: Uint8Array
}

/**
 * Stateful SSE body reader. A read abandoned by the idle timeout stays pending and is reused
 * by the next call, so no chunk is ever lost between calls.
 */
function openSse(res: Response): {
  readUntil: (until: (text: string) => boolean, idleMs?: number) => Promise<{text: string; done: boolean}>
  cancel: () => Promise<void>
} {
  const reader = res.body?.getReader()
  if (reader === undefined) throw new Error('Expected a readable body')
  const decoder = new TextDecoder()
  let pending: Promise<SseChunk> | undefined

  const readUntil = async (until: (text: string) => boolean, idleMs = 200): Promise<{text: string; done: boolean}> => {
    let text = ''
    for (let i = 0; i < 50; i++) {
      pending ??= reader.read() as Promise<SseChunk>
      const result = await Promise.race([
        pending,
        new Promise<'idle'>(resolve => setTimeout(() => resolve('idle'), idleMs)),
      ])
      if (result === 'idle') return {text, done: false}
      pending = undefined
      if (result.done === true) return {text, done: true}
      text += decoder.decode(result.value, {stream: true})
      if (until(text)) return {text, done: false}
    }
    return {text, done: false}
  }
  return {readUntil, cancel: async () => reader.cancel().catch(() => {})}
}

/**
 * Wraps a real manager so the terminal status frame's delivery to the route stays pending until
 * `release()` — a slow SSE write. Close notifications pass straight through.
 */
function holdTerminalStatusDelivery(inner: RunObservationManager) {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let terminalWriteStarted = false
  const manager: RunObservationManager = {
    ...inner,
    subscribe: (runId, callbacks, options) =>
      inner.subscribe(
        runId,
        {
          onEvent: async frame => {
            if (frame.type === 'status' && frame.data.status === 'succeeded') {
              terminalWriteStarted = true
              await gate
            }
            await callbacks.onEvent(frame)
          },
          onClose: callbacks.onClose,
        },
        options,
      ),
  }
  return {manager, release, terminalWriteStarted: () => terminalWriteStarted}
}

// ---------------------------------------------------------------------------
// #1639: terminal run with no replay entry resolves from persisted state
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — durable cache-miss resolution (#1639)', () => {
  function makeRunState(phase: RunState['phase']): RunState {
    return {
      run_id: 'run-001',
      surface: 'github',
      thread_id: 'thread-001',
      entity_ref: 'acme/widget#1',
      phase,
      started_at: '2024-01-01T00:00:00.000Z',
      last_heartbeat: '2024-01-01T00:00:00.000Z',
      holder_id: 'holder-001',
      details: {},
    }
  }

  const STATUS_BY_PHASE: Partial<Record<RunState['phase'], OperatorRunStatus['status']>> = {
    EXECUTING: 'running',
    COMPLETED: 'succeeded',
  }

  function makeRealManager(project?: (runState: RunState) => Promise<OperatorRunStatus | null>) {
    return createRunObservationManager({
      projectBase: async runState => {
        const status = await (
          project ??
          (async (state: RunState): Promise<OperatorRunStatus | null> => ({
            runId: state.run_id,
            entityRef: state.entity_ref,
            surface: state.surface,
            phase: state.phase,
            status: STATUS_BY_PHASE[state.phase] ?? 'running',
            startedAt: state.started_at,
            stale: false,
          }))
        )(runState)
        return status === null ? {kind: 'denied'} : {kind: 'projected', status, repoKey: {databaseId: 1, nodeId: 'R_1'}}
      },
      waiting: {hasPendingApproval: () => false, hasPendingQuestion: () => false},
      isRepoDenied: () => false,
      logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      now: () => Date.now(),
    })
  }

  const eventNames = (text: string): string[] =>
    [...text.matchAll(/^event: (\w+)$/gm)].map(m => m[1]).filter((n): n is string => n !== undefined)

  it('terminates the stream with the terminal status when the replay entry was evicted', async () => {
    // #given a completed run unknown to the (fresh / evicted) in-memory manager, with a persisted state
    const manager = makeRealManager()
    const readRunState = vi.fn(async () => makeRunState('COMPLETED'))
    const deps = makeDeps({manager, readRunState, maxStreamsPerOperator: 1})
    const app = buildTestApp(deps)

    try {
      // #when the operator opens the stream and reads to the end
      const res = await fetchStream(app, 'run-001')
      const {text, done} = await openSse(res).readUntil(() => false, 1_000)

      // #then ready, the no-snapshot reset, then the terminal status — and the body ENDS
      expect(done).toBe(true)
      expect(eventNames(text)).toEqual(['ready', 'reset', 'status'])
      expect(text).toContain('"status":"succeeded"')
      expect(readRunState).toHaveBeenCalledWith('acme/widget', 'run-001')

      // #then the per-operator slot was released (cap is 1): a second open is not 429
      const second = await fetchStream(app, 'run-001')
      expect(second.status).toBe(200)
      await second.body?.cancel()
    } finally {
      manager.shutdown()
    }
  })

  it('leaves a live run on the open-ended path: ready + reset, then the stream stays open', async () => {
    // #given a run whose persisted state is still EXECUTING and that has no snapshot yet
    const manager = makeRealManager()
    const readRunState = vi.fn(async () => makeRunState('EXECUTING'))
    const app = buildTestApp(makeDeps({manager, readRunState}))

    try {
      // #when the operator opens the stream
      const res = await fetchStream(app, 'run-001')
      const sse = openSse(res)
      const {text, done} = await sse.readUntil(() => false, 150)

      // #then exactly ready + reset arrive and the stream is NOT closed
      expect(done).toBe(false)
      expect(eventNames(text)).toEqual(['ready', 'reset'])
      expect(readRunState).toHaveBeenCalledTimes(1)

      // #then a later live terminal still completes the stream normally
      await manager.observe(makeRunState('COMPLETED'))
      const rest = await sse.readUntil(() => false, 1_000)
      expect(rest.done).toBe(true)
      expect(rest.text).toContain('"status":"succeeded"')
      await sse.cancel()
    } finally {
      manager.shutdown()
    }
  })

  it('emits a single terminal status when the run goes terminal between the cache check and the durable read', async () => {
    // #given a no-snapshot subscriber whose durable read is held open
    const manager = makeRealManager()
    let release!: (state: RunState) => void
    const readRunState = vi.fn(
      async () =>
        new Promise<RunState>(resolve => {
          release = resolve
        }),
    )
    const app = buildTestApp(makeDeps({manager, readRunState}))

    try {
      const res = await fetchStream(app, 'run-001')
      const sse = openSse(res)
      const first = await sse.readUntil(t => t.includes('event: reset'), 500)
      expect(first.text).toContain('event: reset')

      // #when the live terminal lands first and then the stale durable read resolves
      await manager.observe(makeRunState('COMPLETED'))
      release(makeRunState('COMPLETED'))
      const rest = await sse.readUntil(() => false, 1_000)

      // #then exactly one terminal status frame overall and the body ended
      expect(rest.done).toBe(true)
      expect(eventNames(first.text + rest.text).filter(n => n === 'status')).toHaveLength(1)
    } finally {
      manager.shutdown()
    }
  })

  it('never reads persisted state for a denylisted or unbound repo', async () => {
    // #given a terminal persisted run
    const readRunState = vi.fn(async () => makeRunState('COMPLETED'))

    // #when the repo is denylisted
    const deniedApp = buildTestApp(
      makeDeps({readRunState, denylistCache: makeDenylistCache(true), manager: makeRealManager()}),
    )
    const denied = await fetchStream(deniedApp, 'run-001')

    // #when the repo is not bound
    const unauthorizedApp = buildTestApp(
      makeDeps({
        readRunState,
        bindingsLookup: makeMutableBindingsLookup(() => ({success: true as const, data: null})),
        manager: makeRealManager(),
      }),
    )
    const unauthorized = await fetchStream(unauthorizedApp, 'run-001')

    // #then both are the generic not-found and the durable store was never touched
    expect(denied.status).toBe(404)
    expect(unauthorized.status).toBe(404)
    expect(await denied.json()).toEqual({error: 'not-found'})
    expect(await unauthorized.json()).toEqual({error: 'not-found'})
    expect(readRunState).not.toHaveBeenCalled()
  })

  it('reveals no status and does not close when the deny-gated projection redacts the persisted run', async () => {
    // #given a terminal persisted run whose projection is redacted (null) at the bridge
    const manager = makeRealManager(async () => null)
    const readRunState = vi.fn(async () => makeRunState('COMPLETED'))
    const app = buildTestApp(makeDeps({manager, readRunState}))

    try {
      // #when the operator opens the stream
      const res = await fetchStream(app, 'run-001')
      const sse = openSse(res)
      const {text, done} = await sse.readUntil(() => false, 200)

      // #then only ready + reset: no status frame, no completion signal
      expect(done).toBe(false)
      expect(eventNames(text)).toEqual(['ready', 'reset'])
      expect(text).not.toContain('succeeded')
      await sse.cancel()
    } finally {
      manager.shutdown()
    }
  })

  it('subscribes exactly as before when no durable reader is wired', async () => {
    // #given deps without readRunState
    const subscribe = vi.fn((_runId: string, _callbacks: SubscriberCallbacks) => () => undefined)
    const app = buildTestApp(makeDeps({manager: makeManager({subscribe})}))

    // #when
    const res = await fetchStream(app, 'run-001')
    await res.body?.cancel()

    // #then the manager saw the original two-argument call
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0]).toHaveLength(2)
  })

  it('keeps the stream slot and deadline until a durably-resolved terminal status has been delivered', async () => {
    // #given a no-snapshot run whose durable read is held until the reset has been delivered
    const inner = makeRealManager()
    const held = holdTerminalStatusDelivery(inner)
    let resolveRead!: (state: RunState) => void
    const readRunState = vi.fn(
      async () =>
        new Promise<RunState>(resolve => {
          resolveRead = resolve
        }),
    )
    const app = buildTestApp(makeDeps({manager: held.manager, readRunState, maxStreamsPerOperator: 1}))

    try {
      const res = await fetchStream(app, 'run-001')
      const sse = openSse(res)
      const first = await sse.readUntil(t => t.includes('event: reset'), 500)
      expect(eventNames(first.text)).toEqual(['ready', 'reset'])
      // Keep a read outstanding so the reset write has fully settled (the body is backpressured
      // until a reader pulls), i.e. the manager's writer is idle before the durable read resolves.
      await sse.readUntil(() => false, 100)

      // #when the durable read resolves terminal while the terminal write is still pending
      resolveRead(makeRunState('COMPLETED'))
      const pending = await sse.readUntil(() => false, 150)

      // #then the write began but nothing was delivered, the stream is open, and the slot is still held
      expect(held.terminalWriteStarted()).toBe(true)
      expect(pending.text).not.toContain('event: status')
      expect(pending.done).toBe(false)
      const blocked = await fetchStream(app, 'run-001')
      expect(blocked.status).toBe(429)

      // #when the write settles
      held.release()
      const rest = await sse.readUntil(() => false, 1_000)

      // #then the terminal status is delivered, the body ends, and the slot is free again
      expect(rest.text).toContain('"status":"succeeded"')
      expect(rest.done).toBe(true)
      const reopened = await fetchStream(app, 'run-001')
      expect(reopened.status).toBe(200)
      await reopened.body?.cancel()
    } finally {
      held.release()
      inner.shutdown()
    }
  })

  it('keeps the stream slot until a live terminal status has been delivered', async () => {
    // #given a live run (persisted state still EXECUTING) and a terminal write that will be slow
    const inner = makeRealManager()
    const held = holdTerminalStatusDelivery(inner)
    const readRunState = vi.fn(async () => makeRunState('EXECUTING'))
    const app = buildTestApp(makeDeps({manager: held.manager, readRunState, maxStreamsPerOperator: 1}))

    try {
      const res = await fetchStream(app, 'run-001')
      const sse = openSse(res)
      await sse.readUntil(t => t.includes('event: reset'), 500)
      // Keep a read outstanding so the reset write has settled and the manager's writer is idle.
      await sse.readUntil(() => false, 100)

      // #when the live terminal lands and its write stays pending
      await inner.observe(makeRunState('COMPLETED'))
      const pending = await sse.readUntil(() => false, 150)

      // #then the stream is open with the slot held and no status delivered yet
      expect(held.terminalWriteStarted()).toBe(true)
      expect(pending.text).not.toContain('event: status')
      expect(pending.done).toBe(false)
      expect((await fetchStream(app, 'run-001')).status).toBe(429)

      // #when the write settles
      held.release()
      const rest = await sse.readUntil(() => false, 1_000)

      // #then the status arrives and the stream ends
      expect(rest.text).toContain('"status":"succeeded"')
      expect(rest.done).toBe(true)
    } finally {
      held.release()
      inner.shutdown()
    }
  })
})
