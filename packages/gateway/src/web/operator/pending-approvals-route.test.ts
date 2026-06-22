/**
 * Tests for the authenticated pending-approvals route:
 * GET /operator/runs/:runId/approvals
 *
 * All tests go through the REAL HTTP route (with auth guard, denylist, middleware)
 * — not a registry-only call.
 *
 * Load-bearing tests:
 *   1. HAPPY PATH: read-authorized operator with open request → 200 with bounded DTO.
 *   2. HAPPY PATH: authorized operator with NO open requests → 200 empty list.
 *   3. NO-ORACLE DENIAL: every gate failure returns the identical notFoundResponse shape.
 *   4. RATE LIMIT: exceeding per-operator cap → 429.
 *   5. HARD CAP: over-cap results are bounded to PENDING_APPROVALS_MAX_RESULTS.
 *   6. GATE THROW: unexpected throw degrades to no-oracle denial (not 500).
 *   7. BYTE-IDENTICAL DENIALS: unauthorized operator response == runIndex miss response.
 */

import type {PendingApprovalDTO} from '../../approvals/registry.js'
import type {RunLocation} from '../../execute/run-index.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {PendingApprovalsRouteDeps} from './pending-approvals-route.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildPendingApprovalsRoute, PENDING_APPROVALS_MAX_RESULTS} from './pending-approvals-route.js'

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeSessionStore(overrides?: {
  getOperatorToken?: (sessionId: string, nowMs: number) => string | undefined
}): PendingApprovalsRouteDeps['sessionStore'] {
  return {
    getOperatorToken: vi.fn((_sessionId: string, _nowMs: number) => 'oauth-token-stub'),
    ...overrides,
  }
}

function makeRunIndex(location?: RunLocation): PendingApprovalsRouteDeps['runIndex'] {
  return {
    lookup: vi.fn(async (_runId: string) => location ?? {repo: 'acme/widget', surface: 'web' as const}),
  }
}

function makeDenylistCache(denied = false): PendingApprovalsRouteDeps['denylistCache'] {
  return {
    getDenylistState: vi.fn(async () => undefined),
    isRepoDenied: vi.fn((_keys: RepoKey) => denied),
  }
}

function makeBindingsLookup(): PendingApprovalsRouteDeps['bindingsLookup'] {
  return {
    getBindingByRepo: vi.fn(async (_owner: string, _repo: string) => ({
      success: true as const,
      data: {
        owner: 'acme',
        repo: 'widget',
        channelId: 'ch-123',
        channelName: 'widget-dev',
        workspacePath: '/workspace/acme/widget',
        createdAt: '2026-01-01T00:00:00Z',
        createdByDiscordId: 'discord-user-1',
        databaseId: 42,
        nodeId: 'R_node_42',
      },
    })),
  }
}

function makeReadRepoAuthzDeps(): RepoAuthzDeps {
  return {
    allowlist: {isAuthorized: vi.fn(() => true), size: 1},
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({id: 1}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    ),
    clock: () => 0,
    random: () => 0.5,
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    cache: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      getInFlight: vi.fn(() => undefined),
      setInFlight: vi.fn(),
      deleteInFlight: vi.fn(),
      tokenIdentityFor: vi.fn(() => 'stub-token-identity'),
    },
  }
}

function makeUnauthorizedRepoAuthzDeps(): RepoAuthzDeps {
  return {
    ...makeReadRepoAuthzDeps(),
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({message: 'Not Found'}), {
          status: 404,
          headers: {'content-type': 'application/json'},
        }),
    ),
  }
}

function makeRegistry(approvals: readonly PendingApprovalDTO[] = []): PendingApprovalsRouteDeps['registry'] {
  return {
    describePendingForScope: vi.fn((_scopeId: string) => approvals),
  }
}

function makeDeps(overrides?: Partial<PendingApprovalsRouteDeps>): PendingApprovalsRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    runIndex: makeRunIndex(),
    denylistCache: makeDenylistCache(),
    bindingsLookup: makeBindingsLookup(),
    repoAuthzDeps: makeReadRepoAuthzDeps(),
    registry: makeRegistry(),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// App builder helpers
// ---------------------------------------------------------------------------

function buildApp(deps: PendingApprovalsRouteDeps, guardUserId = 1001, guardSessionId = 'sess-abc'): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async (_c, _method, _path) => ({
    ok: true as const,
    githubUserId: guardUserId,
    sessionId: guardSessionId,
  }))
  buildPendingApprovalsRoute(app, deps)
  return app
}

function buildAppWithGuardResult(
  guardResult: {ok: true; githubUserId: number; sessionId: string} | {ok: false; response: Response},
  deps: PendingApprovalsRouteDeps,
): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => guardResult)
  buildPendingApprovalsRoute(app, deps)
  return app
}

async function getApprovals(app: Hono, runId: string): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/operator/runs/${runId}/approvals`, {
      method: 'GET',
    }),
  )
}

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 1: HAPPY PATH — open request
// ---------------------------------------------------------------------------

describe('GET pending-approvals — HAPPY PATH with open request', () => {
  it('read-authorized operator with an open request → 200 with bounded DTO', async () => {
    const approval: PendingApprovalDTO = {requestID: 'per_1', permission: 'bash', command: 'echo hello'}
    const deps = makeDeps({registry: makeRegistry([approval])})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {approvals: PendingApprovalDTO[]}
    expect(body.approvals).toHaveLength(1)
    expect(body.approvals[0]).toMatchObject({requestID: 'per_1', permission: 'bash', command: 'echo hello'})
  })

  it('returns requestID, permission, and command fields in the DTO', async () => {
    const approval: PendingApprovalDTO = {requestID: 'per_42', permission: 'bash', command: 'ls -la /tmp'}
    const deps = makeDeps({registry: makeRegistry([approval])})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {approvals: PendingApprovalDTO[]}
    expect(body.approvals[0]).toBeDefined()
    const dto = body.approvals[0] as PendingApprovalDTO
    expect(dto.requestID).toBe('per_42')
    expect(dto.permission).toBe('bash')
    expect(dto.command).toBe('ls -la /tmp')
  })

  it('returns filepath field for external_directory gates', async () => {
    const approval: PendingApprovalDTO = {requestID: 'per_7', permission: 'external_directory', filepath: '/tmp/foo'}
    const deps = makeDeps({registry: makeRegistry([approval])})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {approvals: PendingApprovalDTO[]}
    expect(body.approvals[0]).toBeDefined()
    const dto = body.approvals[0] as PendingApprovalDTO
    expect(dto.filepath).toBe('/tmp/foo')
    expect(dto.command).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 2: HAPPY PATH — no open requests
// ---------------------------------------------------------------------------

describe('GET pending-approvals — HAPPY PATH with no open requests', () => {
  it('authorized operator with NO open requests → 200 empty list', async () => {
    const deps = makeDeps({registry: makeRegistry([])})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {approvals: PendingApprovalDTO[]}
    expect(body.approvals).toEqual([])
  })

  it('empty list is not an oracle — authorized operator always gets 200', async () => {
    const deps = makeDeps({registry: makeRegistry([])})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 3: NO-ORACLE DENIAL
// ---------------------------------------------------------------------------

describe('GET pending-approvals — NO-ORACLE DENIAL (load-bearing)', () => {
  it('missing OAuth token → 404 no-oracle denial', async () => {
    const deps = makeDeps({
      sessionStore: makeSessionStore({getOperatorToken: () => undefined}),
    })
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('runIndex miss → 404 no-oracle denial', async () => {
    const deps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('denylisted repo → 404 no-oracle denial (before GitHub authz call)', async () => {
    const repoAuthzDeps = makeReadRepoAuthzDeps()
    const deps = makeDeps({
      denylistCache: makeDenylistCache(true),
      repoAuthzDeps,
    })
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
    expect(vi.mocked(repoAuthzDeps.fetch)).not.toHaveBeenCalled()
  })

  it('unauthorized operator (GitHub denied) → 404 no-oracle denial', async () => {
    const deps = makeDeps({repoAuthzDeps: makeUnauthorizedRepoAuthzDeps()})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('unauthorized operator response is byte-identical to a runIndex miss (no-oracle)', async () => {
    const unauthorizedDeps = makeDeps({repoAuthzDeps: makeUnauthorizedRepoAuthzDeps()})
    const missDeps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})

    const unauthorizedApp = buildApp(unauthorizedDeps)
    const missApp = buildApp(missDeps)

    const unauthorizedResponse = await getApprovals(unauthorizedApp, 'run-abc')
    const missResponse = await getApprovals(missApp, 'run-abc')

    expect(unauthorizedResponse.status).toBe(missResponse.status)
    const unauthorizedBody = (await unauthorizedResponse.json()) as {error: string}
    const missBody = (await missResponse.json()) as {error: string}
    expect(unauthorizedBody.error).toBe(missBody.error)
  })

  it('denylisted repo response is byte-identical to a runIndex miss (no-oracle)', async () => {
    const denylistDeps = makeDeps({denylistCache: makeDenylistCache(true)})
    const missDeps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})

    const denylistApp = buildApp(denylistDeps)
    const missApp = buildApp(missDeps)

    const denylistResponse = await getApprovals(denylistApp, 'run-abc')
    const missResponse = await getApprovals(missApp, 'run-abc')

    expect(denylistResponse.status).toBe(missResponse.status)
    const denylistBody = (await denylistResponse.json()) as {error: string}
    const missBody = (await missResponse.json()) as {error: string}
    expect(denylistBody.error).toBe(missBody.error)
  })

  it('guard rejection → guard response returned (not route handler)', async () => {
    const deps = makeDeps()
    const guardResponse = new Response(JSON.stringify({error: 'forbidden'}), {status: 403})
    const app = buildAppWithGuardResult({ok: false, response: guardResponse}, deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(403)
  })

  it('no-auth-ctx (guard absent) → 404 no-oracle denial', async () => {
    const deps = makeDeps()
    const app = buildAppWithGuardResult(
      {ok: false, response: new Response(JSON.stringify({error: 'not-found'}), {status: 404})},
      deps,
    )

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 4: RATE LIMIT
// ---------------------------------------------------------------------------

describe('GET pending-approvals — RATE LIMIT', () => {
  it('exceeding per-operator rate limit → 429 rate-limited response', async () => {
    const exhaustedLimiter = {allow: vi.fn(() => false)}
    const deps = makeDeps({rateLimiter: exhaustedLimiter})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(429)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('rate limited')
  })

  it('within rate limit → 200 (limiter allows)', async () => {
    const allowingLimiter = {allow: vi.fn(() => true)}
    const deps = makeDeps({rateLimiter: allowingLimiter})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
    expect(vi.mocked(allowingLimiter.allow)).toHaveBeenCalledWith('1001')
  })

  it('rate limit is keyed on operator identity (string githubUserId)', async () => {
    const limiter = {allow: vi.fn(() => true)}
    const deps = makeDeps({rateLimiter: limiter})
    const app = buildApp(deps, 9999, 'sess-xyz')

    await getApprovals(app, 'run-abc')

    expect(vi.mocked(limiter.allow)).toHaveBeenCalledWith('9999')
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 5: HARD CAP
// ---------------------------------------------------------------------------

describe('GET pending-approvals — HARD CAP', () => {
  it(`results are bounded to PENDING_APPROVALS_MAX_RESULTS (${PENDING_APPROVALS_MAX_RESULTS})`, async () => {
    const manyApprovals: PendingApprovalDTO[] = Array.from({length: PENDING_APPROVALS_MAX_RESULTS + 10}, (_, i) => ({
      requestID: `per_${i}`,
      permission: 'bash',
    }))
    const deps = makeDeps({registry: makeRegistry(manyApprovals)})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {approvals: PendingApprovalDTO[]}
    expect(body.approvals.length).toBe(PENDING_APPROVALS_MAX_RESULTS)
  })

  it('results at exactly the cap are returned in full', async () => {
    const exactApprovals: PendingApprovalDTO[] = Array.from({length: PENDING_APPROVALS_MAX_RESULTS}, (_, i) => ({
      requestID: `per_${i}`,
      permission: 'bash',
    }))
    const deps = makeDeps({registry: makeRegistry(exactApprovals)})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {approvals: PendingApprovalDTO[]}
    expect(body.approvals.length).toBe(PENDING_APPROVALS_MAX_RESULTS)
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 6: GATE THROW degrades to no-oracle denial
// ---------------------------------------------------------------------------

describe('GET pending-approvals — GATE THROW degrades to no-oracle denial', () => {
  it('runIndex.lookup throwing → 404 no-oracle denial (not 500)', async () => {
    const deps = makeDeps({
      runIndex: {
        lookup: vi.fn(async () => {
          throw new Error('unexpected db error')
        }),
      },
    })
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('denylistCache.getDenylistState throwing → 404 no-oracle denial (not 500)', async () => {
    const deps = makeDeps({
      denylistCache: {
        getDenylistState: vi.fn(async () => {
          throw new Error('cache error')
        }),
        isRepoDenied: vi.fn(() => false),
      },
    })
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('checkRepoAuthz throwing → 404 no-oracle denial (not 500)', async () => {
    const throwingAuthzDeps: RepoAuthzDeps = {
      ...makeReadRepoAuthzDeps(),
      fetch: vi.fn(async () => {
        throw new Error('network error')
      }),
    }
    const deps = makeDeps({repoAuthzDeps: throwingAuthzDeps})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 7: MULTIPLE CONCURRENT OPEN REQUESTS (R14)
// ---------------------------------------------------------------------------

describe('GET pending-approvals — multiple concurrent open requests (R14)', () => {
  it('returns all open requests for the run, each keyed by requestID', async () => {
    const approvals: PendingApprovalDTO[] = [
      {requestID: 'per_1', permission: 'bash', command: 'echo a'},
      {requestID: 'per_2', permission: 'external_directory', filepath: '/tmp/b'},
      {requestID: 'per_3', permission: 'edit'},
    ]
    const deps = makeDeps({registry: makeRegistry(approvals)})
    const app = buildApp(deps)

    const response = await getApprovals(app, 'run-abc')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {approvals: PendingApprovalDTO[]}
    expect(body.approvals).toHaveLength(3)
    const ids = body.approvals.map(a => a.requestID)
    expect(ids).toContain('per_1')
    expect(ids).toContain('per_2')
    expect(ids).toContain('per_3')
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 8: describePendingForScope is called with the server-side runId
// ---------------------------------------------------------------------------

describe('GET pending-approvals — registry called with server-side runId', () => {
  it('describePendingForScope is called with the runId from the URL (server-resolved)', async () => {
    const registry = makeRegistry([])
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    await getApprovals(app, 'run-server-id-xyz')

    expect(vi.mocked(registry.describePendingForScope)).toHaveBeenCalledWith('run-server-id-xyz')
  })
})
