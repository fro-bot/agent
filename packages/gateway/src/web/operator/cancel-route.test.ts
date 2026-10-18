/**
 * Tests for the authenticated cancel route: POST /operator/runs/:runId/cancel
 *
 * All tests go through the REAL HTTP route (with auth guard, denylist, middleware)
 * — not a direct cancelRun call. The execute/cancel.js module is mocked so route
 * tests don't need real S3/registry/queue instances; cancel.ts's own orchestrator
 * behavior is covered by cancel.test.ts.
 *
 * Load-bearing tests:
 *   1. Happy path: authorized operator cancels own-repo run → 200 with phase.
 *   2. NO-ORACLE DENIAL: every pre-acceptance gate failure returns the identical
 *      notFoundResponse shape, with zero cancelRun invocation.
 *   3. IDEMPOTENT: already-terminal outcome → 200 carrying the terminal phase.
 *   4. NOT-FOUND: cancelRun's own not-found outcome → notFoundResponse.
 *   5. RETRY: rendezvous-exhausted outcome → coarse transient response.
 *   6. RATE LIMIT: exceeded → limited; unauthorized requests don't consume budget.
 *   7. DTO: response never carries cancelledBy/thread_id.
 */

import type {CancelOutcome} from '../../execute/cancel.js'
import type {RunLocation} from '../../execute/run-index.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {AuditLogger} from '../audit.js'
import type {CancelRouteDeps} from './cancel-route.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildCancelRoute} from './cancel-route.js'

// ---------------------------------------------------------------------------
// Mock execute/cancel.js — route tests exercise gate wiring, not orchestrator logic.
// ---------------------------------------------------------------------------

const {cancelRunMock} = vi.hoisted(() => ({cancelRunMock: vi.fn()}))

vi.mock('../../execute/cancel.js', () => ({
  cancelRun: cancelRunMock,
}))

// ---------------------------------------------------------------------------
// Stub factories (mirrors decision-route.test.ts)
// ---------------------------------------------------------------------------

function makeSessionStore(overrides?: Partial<CancelRouteDeps['sessionStore']>): CancelRouteDeps['sessionStore'] {
  return {
    get: vi.fn((_sessionId: string) => ({
      githubUserId: 1001,
      login: 'alice',
      issuedAt: 0,
    })),
    ...overrides,
  }
}

function makeRunIndex(location?: RunLocation): CancelRouteDeps['runIndex'] {
  return {
    lookup: vi.fn(async (_runId: string) => location ?? {repo: 'acme/widget', surface: 'web' as const}),
  }
}

function makeDenylistCache(denied = false): CancelRouteDeps['denylistCache'] {
  return {
    getDenylistState: vi.fn(async () => undefined),
    isRepoDenied: vi.fn((_keys: RepoKey) => denied),
  }
}

const WIDGET_BINDING = {
  owner: 'acme',
  repo: 'widget',
  channelId: 'ch-123',
  channelName: 'widget-dev',
  workspacePath: '/workspace/acme/widget',
  createdAt: '2026-01-01T00:00:00Z',
  createdByDiscordId: 'discord-user-1',
  databaseId: 42,
  nodeId: 'R_node_42',
}

function makeBindingsLookup(
  result:
    | {readonly success: true; readonly data: typeof WIDGET_BINDING | null}
    | {readonly success: false; readonly error: Error} = {success: true, data: WIDGET_BINDING},
) {
  return {getBindingByRepo: vi.fn(async (_owner: string, _repo: string) => result)}
}

function makeAuditLogger(): AuditLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  }
}

function makeDeps(overrides?: Partial<CancelRouteDeps>): CancelRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    runIndex: makeRunIndex(),
    denylistCache: makeDenylistCache(),
    bindingsLookup: makeBindingsLookup(),
    cancelRunDeps: {} as CancelRouteDeps['cancelRunDeps'],
    auditLogger: makeAuditLogger(),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// App builder helpers
// ---------------------------------------------------------------------------

function buildApp(deps: CancelRouteDeps, guardUserId = 1001, guardSessionId = 'sess-abc'): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async (_c, _method, _path) => ({
    ok: true as const,
    githubUserId: guardUserId,
    sessionId: guardSessionId,
  }))
  buildCancelRoute(app, deps)
  return app
}

function buildAppWithGuardResult(
  guardResult: {ok: true; githubUserId: number; sessionId: string} | {ok: false; response: Response},
  deps: CancelRouteDeps,
): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => guardResult)
  buildCancelRoute(app, deps)
  return app
}

async function postCancel(app: Hono, runId: string): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/operator/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
    }),
  )
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST cancel — happy path', () => {
  it('authorized operator cancels own-repo run → 200 with phase; audit emitted; actor built server-side', async () => {
    const outcome: CancelOutcome = {outcome: 'cancelled', wasQueued: false}
    cancelRunMock.mockReset().mockResolvedValue(outcome)
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger})
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {ok: boolean; runId: string; phase: string}
    expect(body).toEqual({ok: true, runId: 'run-abc', phase: 'CANCELLED'})

    expect(cancelRunMock).toHaveBeenCalledTimes(1)
    const call = cancelRunMock.mock.calls[0] as unknown as [
      {runId: string; actor: {githubUserId: number; login: string; sessionCorrelationId: string}},
      unknown,
    ]
    expect(call[0].runId).toBe('run-abc')
    expect(call[0].actor).toEqual({githubUserId: 1001, login: 'alice', sessionCorrelationId: 'sess-abc'})

    expect(vi.mocked(auditLogger.info)).toHaveBeenCalledWith(
      expect.objectContaining({githubUserId: 1001, runId: 'run-abc', phase: 'CANCELLED'}),
      'audit: run.cancel.requested',
    )
  })
})

// ---------------------------------------------------------------------------
// No-oracle denials
// ---------------------------------------------------------------------------

describe('POST cancel — no-oracle denials (load-bearing)', () => {
  it('no session (guard rejects) → identical notFoundResponse, zero cancelRun calls', async () => {
    cancelRunMock.mockReset()
    const deps = makeDeps()
    const app = buildAppWithGuardResult(
      {ok: false, response: new Response(JSON.stringify({error: 'not-found'}), {status: 404})},
      deps,
    )

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('runIndex miss → notFoundResponse, zero cancelRun calls', async () => {
    cancelRunMock.mockReset()
    const deps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('denylisted repo → notFoundResponse, zero cancelRun calls', async () => {
    cancelRunMock.mockReset()
    const deps = makeDeps({denylistCache: makeDenylistCache(true)})
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(404)
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('unbound repo → notFoundResponse, zero cancelRun calls', async () => {
    cancelRunMock.mockReset()
    const deps = makeDeps({bindingsLookup: makeBindingsLookup({success: true, data: null})})
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: 'not-found'})
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('binding store error or throw → notFoundResponse, zero cancelRun calls', async () => {
    cancelRunMock.mockReset()
    const failing = makeDeps({bindingsLookup: makeBindingsLookup({success: false, error: new Error('s3 down')})})
    const throwing = makeDeps({
      bindingsLookup: {
        getBindingByRepo: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
    })

    for (const deps of [failing, throwing]) {
      const response = await postCancel(buildApp(deps), 'run-abc')
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({error: 'not-found'})
    }
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('malformed owner/repo from the run index → notFoundResponse with zero binding reads', async () => {
    cancelRunMock.mockReset()
    const bindingsLookup = makeBindingsLookup()
    const deps = makeDeps({runIndex: makeRunIndex({repo: 'acme/..', surface: 'web'}), bindingsLookup})
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(404)
    expect(bindingsLookup.getBindingByRepo).not.toHaveBeenCalled()
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('repo-level denial emits no audit event and logs carry no owner/repo/runId', async () => {
    cancelRunMock.mockReset()
    const auditLogger = makeAuditLogger()
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const denied = makeDeps({auditLogger, logger, denylistCache: makeDenylistCache(true)})
    const unbound = makeDeps({
      auditLogger,
      logger,
      bindingsLookup: makeBindingsLookup({success: true, data: null}),
    })

    await postCancel(buildApp(denied), 'run-abc')
    await postCancel(buildApp(unbound), 'run-abc')

    expect(auditLogger.info).not.toHaveBeenCalled()
    expect(auditLogger.warn).not.toHaveBeenCalled()
    // Unbound and denylisted share one denial label (no existence oracle in the log).
    const warnContexts = logger.warn.mock.calls.map(call => call[0] as unknown)
    expect(warnContexts).toEqual([
      {githubUserId: 1001, gate: 'repo-denied'},
      {githubUserId: 1001, gate: 'repo-denied'},
    ])
  })

  it('gate throw → identical notFoundResponse (no-oracle), zero cancelRun calls', async () => {
    cancelRunMock.mockReset()
    const deps = makeDeps({
      runIndex: {
        lookup: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
    })
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('all denial shapes are identical (same status + body)', async () => {
    const missDeps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})
    const deniedDeps = makeDeps({denylistCache: makeDenylistCache(true)})
    const unboundDeps = makeDeps({bindingsLookup: makeBindingsLookup({success: true, data: null})})
    const unavailableDeps = makeDeps({
      bindingsLookup: makeBindingsLookup({success: false, error: new Error('s3 down')}),
    })
    const malformedDeps = makeDeps({runIndex: makeRunIndex({repo: 'acme/..', surface: 'web'})})

    cancelRunMock.mockReset()
    const responses = await Promise.all(
      [missDeps, deniedDeps, unboundDeps, unavailableDeps, malformedDeps].map(async deps =>
        postCancel(buildApp(deps), 'run-abc'),
      ),
    )

    for (const response of responses) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({error: 'not-found'})
    }
    expect(cancelRunMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

describe('POST cancel — CancelOutcome mapping', () => {
  it('already-terminal → 200 carrying the terminal phase (idempotent, not an error)', async () => {
    const outcome: CancelOutcome = {outcome: 'already-terminal', phase: 'COMPLETED'}
    cancelRunMock.mockReset().mockResolvedValue(outcome)
    const deps = makeDeps()
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {ok: boolean; runId: string; phase: string}
    expect(body).toEqual({ok: true, runId: 'run-abc', phase: 'COMPLETED'})
  })

  it('not-found (from cancelRun itself) → notFoundResponse', async () => {
    const outcome: CancelOutcome = {outcome: 'not-found'}
    cancelRunMock.mockReset().mockResolvedValue(outcome)
    const deps = makeDeps()
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('retry (rendezvous exhausted) → coarse transient response, not success or a distinguishable error', async () => {
    const outcome: CancelOutcome = {outcome: 'retry'}
    cancelRunMock.mockReset().mockResolvedValue(outcome)
    const deps = makeDeps()
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')

    expect(response.status).toBe(503)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('unavailable')
    expect(response.headers.get('Retry-After')).toBe('2')
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('POST cancel — rate limiting', () => {
  it('exceeded → limited response; unauthorized requests do not consume budget', async () => {
    const outcome: CancelOutcome = {outcome: 'cancelled', wasQueued: false}
    cancelRunMock.mockReset().mockResolvedValue(outcome)

    // Limiter of 1/window shared across both apps to prove unauthorized requests
    // (which fail before the limiter is consulted) don't eat the budget.
    let allowCount = 0
    const rateLimiter = {
      allow: vi.fn(() => {
        allowCount += 1
        return allowCount <= 1
      }),
    }

    const deniedDeps = makeDeps({denylistCache: makeDenylistCache(true), rateLimiter})
    const deniedApp = buildApp(deniedDeps)
    // Denied at gate 4 (repo access) — before rate limiting — must not consume budget.
    const deniedResponse = await postCancel(deniedApp, 'run-abc')
    expect(deniedResponse.status).toBe(404)
    expect(rateLimiter.allow).not.toHaveBeenCalled()

    const okDeps = makeDeps({rateLimiter})
    const okApp = buildApp(okDeps)
    const firstResponse = await postCancel(okApp, 'run-abc')
    expect(firstResponse.status).toBe(200)

    const secondResponse = await postCancel(okApp, 'run-abc')
    expect(secondResponse.status).toBe(429)
    const body = (await secondResponse.json()) as {error: string}
    expect(body.error).toBe('rate limited')
  })
})

// ---------------------------------------------------------------------------
// DTO leak check
// ---------------------------------------------------------------------------

describe('POST cancel — DTO leak check', () => {
  it('success response never carries cancelledBy or thread_id', async () => {
    const outcome: CancelOutcome = {outcome: 'cancelled', wasQueued: false}
    cancelRunMock.mockReset().mockResolvedValue(outcome)
    const deps = makeDeps()
    const app = buildApp(deps)

    const response = await postCancel(app, 'run-abc')
    const body = (await response.json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(['ok', 'phase', 'runId'])
    expect(JSON.stringify(body)).not.toContain('cancelledBy')
    expect(JSON.stringify(body)).not.toContain('thread_id')
  })
})
