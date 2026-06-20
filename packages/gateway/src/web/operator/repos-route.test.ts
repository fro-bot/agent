/**
 * Tests for GET /operator/repos — authenticated operator repo listing.
 *
 * Gate ordering:
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Operator rate limit (20/min, operator-keyed) — before binding enumeration
 *   3. Resolve OAuth token via session store
 *   4. listBindings() — all bound repos
 *   5. filterDeniedRecords() — drop denylisted repos BEFORE any authz call
 *   6. checkRepoAuthz() per surviving binding — keep only authorized repos
 *   7. Cap at MAX_REPOS_PER_LISTING; map to RepoSummary[]; return 200
 *
 * Security invariants:
 *   - Denylisted repos are dropped before checkRepoAuthz is called (no oracle).
 *   - Unauthorized repos are silently omitted (no oracle).
 *   - Store errors return a coarse error; no partial list leaks.
 *   - Response carries no deny-keys, workspacePath, channelId, or internal IDs.
 *   - Result is capped at MAX_REPOS_PER_LISTING (no pagination machinery).
 */

import type {RepoBinding} from '../../bindings/types.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {ReposRouteDeps} from './repos-route.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {createRepoAuthzCache} from '../auth/repo-authz.js'
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

function makeRepoAuthzDeps(authorizedRepos: Set<string>, overrides: Partial<RepoAuthzDeps> = {}): RepoAuthzDeps {
  return {
    allowlist: {isAuthorized: () => true, size: 1},
    fetch: vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url)
      const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(urlStr)
      if (match !== null) {
        const key = `${match[1]}/${match[2]}`
        const status = authorizedRepos.has(key) ? 200 : 404
        return new Response('{}', {status})
      }
      return new Response('{}', {status: 404})
    }),
    clock: () => Date.now(),
    random: () => 0,
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    cache: createRepoAuthzCache(),
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
    sessionStore: {
      getOperatorToken: vi.fn(() => 'tok-valid'),
    },
    listBindings: vi.fn(async () => ({success: true as const, data: [] as RepoBinding[]})),
    isRepoDenied: vi.fn(() => false),
    repoAuthzDeps: makeRepoAuthzDeps(new Set()),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /operator/repos — happy path', () => {
  it('returns 200 with only the repos the operator is authorized for', async () => {
    // #given 4 bindings, operator authorized for 2
    const bindings = [
      makeBinding('acme', 'alpha'),
      makeBinding('acme', 'beta'),
      makeBinding('acme', 'gamma'),
      makeBinding('acme', 'delta'),
    ]
    const authorizedRepos = new Set(['acme/alpha', 'acme/gamma'])
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(body).toHaveLength(2)
    const owners = (body as {owner: string}[]).map(r => r.owner)
    const repos = (body as {repo: string}[]).map(r => r.repo)
    expect(owners).toContain('acme')
    expect(repos).toContain('alpha')
    expect(repos).toContain('gamma')
    expect(repos).not.toContain('beta')
    expect(repos).not.toContain('delta')
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

  it('returns 200 with [] when operator is authorized for none of the bound repos', async () => {
    // #given 3 bindings, operator authorized for none
    const bindings = [makeBinding('acme', 'alpha'), makeBinding('acme', 'beta'), makeBinding('acme', 'gamma')]
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      repoAuthzDeps: makeRepoAuthzDeps(new Set()),
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
// R19 scope — per-repo authz gates out unauthorized repos
// ---------------------------------------------------------------------------

describe('GET /operator/repos — R19 scope', () => {
  it('omits a bound repo the operator has no GitHub access to', async () => {
    // #given 2 bindings, operator only authorized for one
    const bindings = [makeBinding('acme', 'public-repo'), makeBinding('acme', 'private-repo')]
    const authorizedRepos = new Set(['acme/public-repo'])
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then private-repo is omitted
    expect(res.status).toBe(200)
    const body = (await res.json()) as {repo: string}[]
    expect(body.map(r => r.repo)).toEqual(['public-repo'])
  })
})

// ---------------------------------------------------------------------------
// Redaction — denylist filter runs BEFORE checkRepoAuthz
// ---------------------------------------------------------------------------

describe('GET /operator/repos — denylist filter before authz', () => {
  it('drops a denylisted repo and never calls checkRepoAuthz for it', async () => {
    // #given 2 bindings; one is denylisted
    const deniedBinding = makeBinding('acme', 'denied-repo', {databaseId: 999, nodeId: 'R_denied'})
    const allowedBinding = makeBinding('acme', 'allowed-repo', {databaseId: 1, nodeId: 'R_allowed'})
    const bindings = [deniedBinding, allowedBinding]

    // isRepoDenied returns true only for the denied binding's keys
    const isRepoDenied = vi.fn((key: RepoKey) => key.databaseId === 999)

    // checkRepoAuthz spy — should NOT be called for the denied binding
    const authzFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url)
      // If called for denied-repo, that is a test failure
      if (urlStr.includes('denied-repo')) {
        throw new Error('checkRepoAuthz must not be called for a denylisted repo')
      }
      return new Response('{}', {status: 200})
    }) as typeof globalThis.fetch

    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      isRepoDenied,
      repoAuthzDeps: makeRepoAuthzDeps(new Set(['acme/allowed-repo']), {fetch: authzFetch}),
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

    // authzFetch was NOT called for denied-repo (would throw if it were)
    const authzCalls = (authzFetch as ReturnType<typeof vi.fn>).mock.calls as [string | URL | Request][]
    const calledUrls = authzCalls.map(([url]) => String(url))
    expect(calledUrls.some(u => u.includes('denied-repo'))).toBe(false)
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
    expect('oauthToken' in ctx).toBe(false)
  })

  it('returns a coarse error when the OAuth token is missing', async () => {
    // #given session has no token (re-auth needed)
    const deps = makeBaseDeps({
      sessionStore: {getOperatorToken: vi.fn(() => undefined)},
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/repos'))

    // #then coarse error
    expect(res.status).not.toBe(200)
    const body = (await res.json()) as {error?: string}
    expect(typeof body.error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Security — response shape carries no internal fields
// ---------------------------------------------------------------------------

describe('GET /operator/repos — response shape security', () => {
  it('serialized response items contain only owner, repo, and optional channelName', async () => {
    // #given 1 authorized binding with all internal fields populated
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
      repoAuthzDeps: makeRepoAuthzDeps(new Set(['acme/widget'])),
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
    // #given more bindings than the cap, all authorized
    const count = MAX_REPOS_PER_LISTING + 10
    const bindings = Array.from({length: count}, (_, i) => makeBinding('acme', `repo-${i}`))
    const authorizedRepos = new Set(bindings.map(b => `${b.owner}/${b.repo}`))
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
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
    // #given 1 authorized binding
    const binding = makeBinding('myorg', 'myrepo')
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: [binding]})),
      repoAuthzDeps: makeRepoAuthzDeps(new Set(['myorg/myrepo'])),
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
