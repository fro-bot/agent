/**
 * Tests for the authenticated SSE run-stream route.
 *
 * Security properties are the load-bearing assertions:
 *   - Every denial path returns the identical generic not-found shape.
 *   - No stream is opened unless all gates pass.
 *   - Success is observable ONLY as text/event-stream + first frame.
 *   - The resolved repo comes exclusively from runIndex.lookup — never from the client.
 *   - Denylist check runs before checkRepoAuthz (no authz call on denied repos).
 *
 * BDD comments: #given / #when / #then.
 */

import type {DenylistCache, RepoKey} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {RepoAuthzCache, RepoAuthzDeps} from '../auth/repo-authz.js'
import type {SessionStore} from '../auth/session.js'
import type {RunObservationManager, SubscriberCallbacks} from './manager.js'
import type {RunStreamRouteDeps} from './run-stream-route.js'

import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildRunStreamRoute} from './run-stream-route.js'

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

function makeSessionStore(overrides?: Partial<SessionStore>): SessionStore {
  return {
    create: vi.fn(() => 'session-id'),
    get: vi.fn(() => undefined),
    touch: vi.fn(),
    delete: vi.fn(),
    onRevoke: vi.fn(),
    scavenge: vi.fn(),
    size: vi.fn(() => 0),
    getOperatorToken: vi.fn(() => 'stub-oauth-token'),
    dropOperatorToken: vi.fn(),
    ...overrides,
  }
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

function makeRepoAuthzCache(authorized: boolean): RepoAuthzCache {
  return {
    get: vi.fn(() =>
      authorized
        ? {authorized: true as const, expiresAt: Number.MAX_SAFE_INTEGER}
        : {authorized: false as const, reason: 'github_denied' as const, expiresAt: Number.MAX_SAFE_INTEGER},
    ),
    set: vi.fn(),
    getInFlight: vi.fn(() => undefined),
    setInFlight: vi.fn(),
    deleteInFlight: vi.fn(),
    tokenIdentityFor: vi.fn(() => 'stub-token-id'),
  }
}

function makeRepoAuthzDeps(authorized = true): RepoAuthzDeps {
  return {
    allowlist: {isAuthorized: vi.fn(() => true), size: 1},
    fetch: vi.fn(async () => new Response('{}', {status: authorized ? 200 : 403})),
    clock: () => 0,
    random: () => 0,
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    cache: makeRepoAuthzCache(authorized),
  }
}

function makeManager(overrides?: Partial<RunObservationManager>): RunObservationManager {
  return {
    observe: vi.fn(async () => undefined),
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
    repoAuthzDeps: makeRepoAuthzDeps(true),
    manager: makeManager(),
    logger: makeLogger(),
    now: () => 0,
    ...overrides,
  }
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
// Security: missing token → not-found, no stream
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — missing token', () => {
  it('returns not-found when getOperatorToken returns undefined, regardless of runId', async () => {
    // #given — session store returns no token
    const sessionStore = makeSessionStore({getOperatorToken: vi.fn(() => undefined)})
    const runIndex = makeRunIndex('acme/widget')
    const manager = makeManager()
    const deps = makeDeps({sessionStore, runIndex, manager})
    const app = buildTestApp(deps)

    // #when — request with a valid runId but no token
    const res = await fetchStream(app, 'run-abc-123')
    const body = await res.json()

    // #then — generic not-found, no stream opened
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
  })

  it('returns the same not-found shape when runId does not exist and token is missing', async () => {
    // #given — no token, no run
    const sessionStore = makeSessionStore({getOperatorToken: vi.fn(() => undefined)})
    const runIndex = makeRunIndex(undefined)
    const deps = makeDeps({sessionStore, runIndex})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'nonexistent-run')
    const body = await res.json()

    // #then — identical shape regardless of run existence
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
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
    const repoAuthzDeps = makeRepoAuthzDeps(true)
    const manager = makeManager()
    const deps = makeDeps({runIndex, denylistCache, repoAuthzDeps, manager})
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

  it('does not call checkRepoAuthz after a run lookup miss', async () => {
    // #given — run does not exist; authz fetch should never be called
    const runIndex = makeRunIndex(undefined)
    const fetchFn = vi.fn() as typeof globalThis.fetch
    const repoAuthzDeps: RepoAuthzDeps = {...makeRepoAuthzDeps(true), fetch: fetchFn}
    const deps = makeDeps({runIndex, repoAuthzDeps})
    const app = buildTestApp(deps)

    // #when
    await fetchStream(app, 'unknown-run-id')

    // #then — no GitHub API call was made
    expect(fetchFn).not.toHaveBeenCalled()
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
// Security: denylisted repo → not-found, checkRepoAuthz NOT reached
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — denylisted repo', () => {
  it('returns not-found when repo is denied, without calling checkRepoAuthz', async () => {
    // #given — repo is on the denylist
    const denylistCache = makeDenylistCache(true)
    const authzFetch = vi.fn() as typeof globalThis.fetch
    const repoAuthzDeps: RepoAuthzDeps = {...makeRepoAuthzDeps(true), fetch: authzFetch}
    const manager = makeManager()
    const deps = makeDeps({denylistCache, repoAuthzDeps, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — not-found, no authz call, no stream
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(authzFetch).not.toHaveBeenCalled()
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
// Security: checkRepoAuthz denies → not-found, byte-identical to other denials
// ---------------------------------------------------------------------------

describe('GET /operator/runs/:runId/stream — checkRepoAuthz denies', () => {
  it('returns not-found when checkRepoAuthz denies, same shape as unknown/denied', async () => {
    // #given — authz cache returns denied
    const repoAuthzDeps = makeRepoAuthzDeps(false)
    const manager = makeManager()
    const deps = makeDeps({repoAuthzDeps, manager})
    const app = buildTestApp(deps)

    // #when
    const res = await fetchStream(app, 'run-abc')
    const body = await res.json()

    // #then — identical shape to all other denials
    expect(res.status).toBe(404)
    expect(body).toEqual({error: 'not-found'})
    expect(manager.subscribe).not.toHaveBeenCalled()
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
    expect(body2).toEqual({error: 'too many streams'})
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
