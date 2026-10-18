/**
 * Tests for GET /operator/repos — authenticated operator repo listing.
 *
 * Gate ordering:
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Operator rate limit (20/min, operator-keyed) — before binding enumeration
 *   3. listBindings() — all bound repos
 *   4. filterDeniedRecords() — drop denylisted repos
 *   5. Dedup by owner/repo, then cap
 *   6. Map to RepoSummary[]; return 200
 *
 * Security invariants:
 *   - Denylisted repos are silently omitted (no oracle).
 *   - Store errors return a coarse error; no partial list leaks.
 *   - Response carries no deny-keys, workspacePath, channelId, or internal IDs.
 *   - Result is capped at MAX_REPOS_PER_LISTING (no pagination machinery).
 *   - One listBindings read; no per-repo store call and no GitHub call.
 */

import type {RepoBinding} from '../../bindings/types.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {ReposRouteDeps} from './repos-route.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildReposRoute, MAX_REPOS_PER_LISTING} from './repos-route.js'

// ---------------------------------------------------------------------------
// Rate limit tests (FIX-3)
// ---------------------------------------------------------------------------

describe('GET /operator/repos — operator-keyed rate limit', () => {
  it('returns 429 when the per-minute rate limit is exceeded', async () => {
    // #given — rate limiter that always denies
    const deps = makeBaseDeps({
      perMinRateLimiter: {allow: () => false},
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.status).toBe(429)
  })

  it('rate limit is operator-keyed (keyed on githubUserId, not socket)', async () => {
    // #given — rate limiter that records keys
    const seenKeys: string[] = []
    const perMinRateLimiter = {
      allow: (key: string) => {
        seenKeys.push(key)
        return true
      },
    }
    const deps = makeBaseDeps({perMinRateLimiter})
    const app = buildTestApp(deps, {githubUserId: 9999, sessionId: 'sess-xyz'})

    // #when
    await app.fetch(new Request('http://localhost/operator/repos'))

    // #then — key is the operator's githubUserId as a string
    expect(seenKeys.length).toBeGreaterThan(0)
    expect(seenKeys[0]).toBe('9999')
  })

  it('rate limit is checked AFTER auth context and BEFORE binding enumeration', async () => {
    // #given — rate limiter denies; listBindings should NOT be called
    const listBindings = vi.fn(async () => ({success: true as const, data: [] as RepoBinding[]}))
    const deps = makeBaseDeps({
      perMinRateLimiter: {allow: () => false},
      listBindings,
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then — 429 and listBindings was never called
    expect(res.status).toBe(429)
    expect(listBindings).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBinding(owner: string, repo: string, overrides: Partial<RepoBinding> = {}): RepoBinding {
  return {
    owner,
    repo,
    channelId: `chan-${owner}-${repo}`,
    channelName: `${repo}-channel`,
    workspacePath: `/workspace/${owner}/${repo}`,
    createdAt: '2024-01-01T00:00:00Z',
    createdByDiscordId: '999888777',
    databaseId: Math.floor(Math.random() * 100_000),
    nodeId: `R_kgDO${owner}${repo}`,
    ...overrides,
  }
}

/**
 * Build a minimal Hono app with the repos route registered.
 * Installs a stub guard that injects the given githubUserId and sessionId.
 */
function buildTestApp(
  deps: ReposRouteDeps,
  guardCtx: {githubUserId: number; sessionId: string} = {githubUserId: 1001, sessionId: 'sess-abc'},
): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => ({ok: true, ...guardCtx}))
  buildReposRoute(app, deps)
  return app
}

function makeBaseDeps(overrides: Partial<ReposRouteDeps> = {}): ReposRouteDeps {
  return {
    listBindings: vi.fn(async () => ({success: true as const, data: [] as RepoBinding[]})),
    isRepoDenied: vi.fn(() => false),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /operator/repos — happy path', () => {
  it('returns 200 with every bound, non-denylisted repo', async () => {
    // #given 4 bindings, two of them denylisted
    const bindings = [
      makeBinding('acme', 'alpha', {databaseId: 1}),
      makeBinding('acme', 'beta', {databaseId: 2}),
      makeBinding('acme', 'gamma', {databaseId: 3}),
      makeBinding('acme', 'delta', {databaseId: 4}),
    ]
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      isRepoDenied: vi.fn((key: RepoKey) => key.databaseId === 2 || key.databaseId === 4),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.status).toBe(200)
    const body = (await res.json()) as {owner: string; repo: string}[]
    expect(body.map(r => r.repo)).toEqual(['alpha', 'gamma'])
    expect(body.every(r => r.owner === 'acme')).toBe(true)
  })

  it('returns 200 with [] when there are no bound repos', async () => {
    // #given no bindings
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: [] as RepoBinding[]})),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('returns 200 with [] when every bound repo is denylisted', async () => {
    // #given 3 bindings, all denylisted
    const bindings = [makeBinding('acme', 'alpha'), makeBinding('acme', 'beta'), makeBinding('acme', 'gamma')]
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      isRepoDenied: vi.fn(() => true),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Bindings-only — one store read, no per-repo calls
// ---------------------------------------------------------------------------

describe('GET /operator/repos — bindings-only access', () => {
  it('makes exactly one listBindings read and no GitHub call, whatever the binding count', async () => {
    // #given 5 bindings and a global fetch spy
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const bindings = Array.from({length: 5}, (_, i) => makeBinding('acme', `repo-${i}`))
    const listBindings = vi.fn(async () => ({success: true as const, data: bindings}))
    const app = buildTestApp(makeBaseDeps({listBindings}))

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.status).toBe(200)
    expect(listBindings).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Redaction — denylist filter
// ---------------------------------------------------------------------------

describe('GET /operator/repos — denylist filter', () => {
  it('drops a denylisted repo', async () => {
    // #given 2 bindings; one is denylisted
    const deniedBinding = makeBinding('acme', 'denied-repo', {databaseId: 999, nodeId: 'R_denied'})
    const allowedBinding = makeBinding('acme', 'allowed-repo', {databaseId: 1, nodeId: 'R_allowed'})
    const bindings = [deniedBinding, allowedBinding]

    // isRepoDenied returns true only for the denied binding's keys
    const isRepoDenied = vi.fn((key: RepoKey) => key.databaseId === 999)

    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      isRepoDenied,
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then denied-repo is absent; allowed-repo is present
    expect(res.status).toBe(200)
    const body = (await res.json()) as {repo: string}[]
    expect(body.map(r => r.repo)).toEqual(['allowed-repo'])

    // isRepoDenied was called for both bindings
    expect(isRepoDenied).toHaveBeenCalledTimes(2)
  })

  it('a binding with no deny keys is dropped by the fail-closed predicate', async () => {
    // #given a legacy binding without databaseId/nodeId
    const keyless = makeBinding('acme', 'legacy', {databaseId: undefined, nodeId: undefined})
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: [keyless]})),
      isRepoDenied: vi.fn((key: RepoKey) => key.databaseId === null && key.nodeId === null),
    })

    // #when
    const res = await buildTestApp(deps).fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Error paths — coarse failures, no partial leak
// ---------------------------------------------------------------------------

describe('GET /operator/repos — error paths', () => {
  it('returns a coarse error when listBindings fails — no partial list leaks', async () => {
    // #given listBindings returns an error
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({
        success: false as const,
        error: Object.assign(new Error('store unavailable'), {code: 'BINDING_STORE_ERROR' as const}),
      })),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then coarse error, not a partial list
    expect(res.status).not.toBe(200)
    const body = (await res.json()) as {error?: string}
    expect(typeof body.error).toBe('string')
    // Must not be an array (no partial leak)
    expect(Array.isArray(body)).toBe(false)
  })

  it('returns coarse 503 when listBindings throws (not just success:false)', async () => {
    // #given — listBindings rejects (unexpected throw, not a Result failure)
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => {
        throw new Error('unexpected network crash')
      }),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then — coarse 503; body is not an array
    expect(res.status).toBe(503)
    const body = (await res.json()) as {error?: string}
    expect(typeof body.error).toBe('string')
    expect(Array.isArray(body)).toBe(false)
  })

  it('logs the store error without including the token', async () => {
    // #given listBindings fails
    const warnSpy = vi.fn()
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({
        success: false as const,
        error: Object.assign(new Error('store unavailable'), {code: 'BINDING_STORE_ERROR' as const}),
      })),
      logger: {debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn()},
    })
    const app = buildTestApp(deps)

    // #when
    await app.fetch(new Request('http://localhost/operator/repos'))

    // #then warn was called with githubUserId but NOT the token
    expect(warnSpy).toHaveBeenCalled()
    const [ctx] = warnSpy.mock.calls[0] as [Record<string, unknown>]
    expect(ctx).toHaveProperty('githubUserId')
    expect('token' in ctx).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Security — response shape carries no internal fields
// ---------------------------------------------------------------------------

describe('GET /operator/repos — response shape security', () => {
  it('serialized response items contain only owner, repo, and optional channelName', async () => {
    // #given 1 bound binding with all internal fields populated
    const binding = makeBinding('acme', 'widget', {
      channelId: 'chan-secret',
      channelName: 'widget-channel',
      workspacePath: '/secret/path',
      createdByDiscordId: '111222333',
      databaseId: 42,
      nodeId: 'R_kgDOsecret',
    })
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: [binding]})),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>[]
    expect(body).toHaveLength(1)
    const item = body[0] ?? {}

    // #then only safe fields are present
    const allowedKeys = new Set(['owner', 'repo', 'channelName'])
    const forbiddenKeys = Object.keys(item).filter(k => !allowedKeys.has(k))
    expect(forbiddenKeys).toEqual([])

    // Explicitly assert forbidden fields are absent
    expect('databaseId' in item).toBe(false)
    expect('nodeId' in item).toBe(false)
    expect('channelId' in item).toBe(false)
    expect('workspacePath' in item).toBe(false)
    expect('createdByDiscordId' in item).toBe(false)
    expect('createdAt' in item).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cap — result is truncated at MAX_REPOS_PER_LISTING
// ---------------------------------------------------------------------------

describe('GET /operator/repos — hard cap', () => {
  it(`truncates results at MAX_REPOS_PER_LISTING (${MAX_REPOS_PER_LISTING})`, async () => {
    // #given more bindings than the cap, none denylisted
    const count = MAX_REPOS_PER_LISTING + 10
    const bindings = Array.from({length: count}, (_, i) => makeBinding('acme', `repo-${i}`))
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then result is capped
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(body).toHaveLength(MAX_REPOS_PER_LISTING)
  })
})

// ---------------------------------------------------------------------------
// Contract — response items match RepoSummary shape
// ---------------------------------------------------------------------------

describe('GET /operator/repos — contract', () => {
  it('response items have owner (string) and repo (string)', async () => {
    // #given 1 bound binding
    const binding = makeBinding('myorg', 'myrepo')
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: [binding]})),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {owner: string; repo: string}[]

    // #then
    expect(body[0]?.owner).toBe('myorg')
    expect(body[0]?.repo).toBe('myrepo')
  })

  it('response carries Cache-Control: no-store, private', async () => {
    // #given
    const deps = makeBaseDeps()
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.headers.get('cache-control')).toBe('no-store, private')
  })
})

// ---------------------------------------------------------------------------
// Dedup bindings by owner/repo BEFORE the cap
// ---------------------------------------------------------------------------

describe('GET /operator/repos — dedup before cap', () => {
  it('reaches the 101st binding when two earlier bindings share the same owner/repo', async () => {
    // #given — 101 bindings: 2 share acme/shared (different channelIds), 98 distinct repos,
    // plus acme/last-unique. After dedup: 100 distinct repos, all within the cap of 100.
    // Without dedup-before-cap, last-unique (index 100) would be dropped by the cap.
    const sharedBindingA = makeBinding('acme', 'shared', {channelId: 'chan-shared-A'})
    const sharedBindingB = makeBinding('acme', 'shared', {channelId: 'chan-shared-B'})
    const distinctBindings = Array.from({length: 98}, (_, i) =>
      makeBinding('acme', `repo-${i + 2}`, {channelId: `chan-repo-${i + 2}`}),
    )
    const lastUniqueBinding = makeBinding('acme', 'last-unique', {channelId: 'chan-last-unique'})
    const bindings = [sharedBindingA, sharedBindingB, ...distinctBindings, lastUniqueBinding]

    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then — response includes last-unique, and acme/shared exactly once
    expect(res.status).toBe(200)
    const body = (await res.json()) as {owner: string; repo: string}[]
    expect(body.map(r => r.repo)).toContain('last-unique')
    expect(body.filter(r => r.owner === 'acme' && r.repo === 'shared')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Auth context guard
// ---------------------------------------------------------------------------

describe('GET /operator/repos — auth context guard', () => {
  it('returns 401 when no auth context is set (guard not installed)', async () => {
    // #given app without a guard (no setOperatorRouteGuard)
    const app = new Hono()
    const deps = makeBaseDeps()
    buildReposRoute(app, deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.status).toBe(401)
  })
})
