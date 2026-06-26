/**
 * Tests for GET /operator/runs — authenticated operator run listing.
 *
 * Gate ordering:
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Operator rate limit (20/min, operator-keyed) — before binding enumeration
 *   3. Resolve OAuth token via session store
 *   4. listBindings() — all bound repos
 *   5. filterDeniedRecords() — drop denylisted repos BEFORE any authz call
 *   6. checkRepoAuthz() per surviving binding — keep only authorized repos
 *   7. For each authorized binding: listRunsForRepo() → project via toRunSummary()
 *   8. Flatten, sort newest-first, cap at MAX_RUNS_PER_LISTING; return 200 {runs:[]}
 *
 * Security invariants:
 *   - Denylisted repos are dropped before checkRepoAuthz is called (no oracle).
 *   - Unauthorized repos are silently omitted (no oracle).
 *   - Store errors return a coarse error; no partial list leaks.
 *   - Response carries only {runId, repo, status, createdAt, updatedAt?}.
 *   - Result is capped at MAX_RUNS_PER_LISTING (no pagination machinery).
 *   - Token is never logged.
 */

import type {RunState} from '@fro-bot/runtime'
import type {RepoBinding} from '../../bindings/types.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {RunsRouteDeps} from './runs-route.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {createRepoAuthzCache} from '../auth/repo-authz.js'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildRunsRoute, MAX_RUNS_PER_LISTING} from './runs-route.js'

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

function makeRunState(
  owner: string,
  repo: string,
  runId: string,
  startedAt: string,
  overrides: Partial<RunState> = {},
): RunState {
  return {
    run_id: runId,
    entity_ref: `${owner}/${repo}#1`,
    surface: 'discord' as const,
    phase: 'EXECUTING' as const,
    started_at: startedAt,
    last_heartbeat: '',
    thread_id: '',
    holder_id: '',
    details: {},
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
 * Build a minimal Hono app with the runs route registered.
 * Installs a stub guard that injects the given githubUserId and sessionId.
 */
function buildTestApp(
  deps: RunsRouteDeps,
  guardCtx: {githubUserId: number; sessionId: string} = {githubUserId: 1001, sessionId: 'sess-abc'},
): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => ({ok: true, ...guardCtx}))
  buildRunsRoute(app, deps)
  return app
}

function makeBaseDeps(
  overrides: Partial<RunsRouteDeps> = {},
  runsByRepo: Map<string, RunState[]> = new Map(),
): RunsRouteDeps {
  return {
    sessionStore: {
      getOperatorToken: vi.fn(() => 'tok-valid'),
    },
    listBindings: vi.fn(async () => ({success: true as const, data: [] as RepoBinding[]})),
    isRepoDenied: vi.fn(() => false),
    repoAuthzDeps: makeRepoAuthzDeps(new Set()),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    listRunsForRepo: vi.fn(async (repo: string) => runsByRepo.get(repo) ?? []),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Rate limit tests
// ---------------------------------------------------------------------------

describe('GET /operator/runs — operator-keyed rate limit', () => {
  it('returns 429 when the per-minute rate limit is exceeded', async () => {
    // #given — rate limiter that always denies
    const deps = makeBaseDeps({
      perMinRateLimiter: {allow: () => false},
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

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
    await app.fetch(new Request('http://localhost/operator/runs'))

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
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then — 429 and listBindings was never called
    expect(res.status).toBe(429)
    expect(listBindings).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /operator/runs — happy path', () => {
  it('returns 200 with runs only for authorized repos', async () => {
    // #given 2 bindings, operator authorized for both; each has 1 run
    const bindings = [makeBinding('acme', 'alpha'), makeBinding('acme', 'beta')]
    const authorizedRepos = new Set(['acme/alpha', 'acme/beta'])
    const runsByRepo = new Map<string, RunState[]>([
      ['acme/alpha', [makeRunState('acme', 'alpha', 'run-alpha-1', '2024-01-02T00:00:00Z')]],
      ['acme/beta', [makeRunState('acme', 'beta', 'run-beta-1', '2024-01-01T00:00:00Z')]],
    ])
    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
        repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: {runId: string; repo: string}[]}
    expect(body.runs).toHaveLength(2)
    const runIds = body.runs.map(r => r.runId)
    expect(runIds).toContain('run-alpha-1')
    expect(runIds).toContain('run-beta-1')
  })

  it('returns 200 with {runs: []} when there are no bound repos', async () => {
    // #given no bindings
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: [] as RepoBinding[]})),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: unknown[]}
    expect(body.runs).toEqual([])
  })

  it('returns 200 with {runs: []} when operator is authorized for none of the bound repos', async () => {
    // #given 3 bindings, operator authorized for none
    const bindings = [makeBinding('acme', 'alpha'), makeBinding('acme', 'beta'), makeBinding('acme', 'gamma')]
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      repoAuthzDeps: makeRepoAuthzDeps(new Set()),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: unknown[]}
    expect(body.runs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// R19 scope — per-repo authz gates out unauthorized repos
// ---------------------------------------------------------------------------

describe('GET /operator/runs — R19 scope', () => {
  it('omits runs for a bound repo the operator has no GitHub access to', async () => {
    // #given 2 bindings, operator only authorized for one
    const bindings = [makeBinding('acme', 'public-repo'), makeBinding('acme', 'private-repo')]
    const authorizedRepos = new Set(['acme/public-repo'])
    const runsByRepo = new Map<string, RunState[]>([
      ['acme/public-repo', [makeRunState('acme', 'public-repo', 'run-public-1', '2024-01-01T00:00:00Z')]],
      ['acme/private-repo', [makeRunState('acme', 'private-repo', 'run-private-1', '2024-01-01T00:00:00Z')]],
    ])
    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
        repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then private-repo's runs are omitted
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: {runId: string}[]}
    const runIds = body.runs.map(r => r.runId)
    expect(runIds).toContain('run-public-1')
    expect(runIds).not.toContain('run-private-1')
  })
})

// ---------------------------------------------------------------------------
// Redaction — denylist filter runs BEFORE checkRepoAuthz
// ---------------------------------------------------------------------------

describe('GET /operator/runs — denylist filter before authz', () => {
  it('drops a denylisted repo and never calls checkRepoAuthz or listRunsForRepo for it', async () => {
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

    const listRunsForRepo = vi.fn(async (repo: string) => {
      if (repo.includes('denied-repo')) {
        throw new Error('listRunsForRepo must not be called for a denylisted repo')
      }
      return [makeRunState('acme', 'allowed-repo', 'run-allowed-1', '2024-01-01T00:00:00Z')]
    })

    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      isRepoDenied,
      repoAuthzDeps: makeRepoAuthzDeps(new Set(['acme/allowed-repo']), {fetch: authzFetch}),
      listRunsForRepo,
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then denied-repo's runs are absent; allowed-repo's runs are present
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: {runId: string; repo: string}[]}
    const bodyStr = JSON.stringify(body)

    // denied-repo must not appear anywhere in the response
    expect(bodyStr).not.toContain('denied-repo')
    expect(bodyStr).not.toContain('run-denied')

    // allowed-repo's run is present
    const runIds = body.runs.map(r => r.runId)
    expect(runIds).toContain('run-allowed-1')

    // isRepoDenied was called for both bindings
    expect(isRepoDenied).toHaveBeenCalledTimes(2)

    // authzFetch was NOT called for denied-repo (would throw if it were)
    const authzCalls = (authzFetch as ReturnType<typeof vi.fn>).mock.calls as [string | URL | Request][]
    const calledUrls = authzCalls.map(([url]) => String(url))
    expect(calledUrls.some(u => u.includes('denied-repo'))).toBe(false)

    // listRunsForRepo was NOT called for denied-repo (would throw if it were)
    const listCalls = listRunsForRepo.mock.calls as [string][]
    expect(listCalls.some(([repo]) => repo.includes('denied-repo'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Error paths — coarse failures, no partial leak
// ---------------------------------------------------------------------------

describe('GET /operator/runs — error paths', () => {
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
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then coarse error, not a partial list
    expect(res.status).toBe(503)
    const body = (await res.json()) as {error?: string; runs?: unknown}
    expect(typeof body.error).toBe('string')
    // Must not be an array (no partial leak)
    expect(Array.isArray(body)).toBe(false)
    // Must not have a runs key
    expect('runs' in body).toBe(false)
  })

  it('returns a coarse error when the OAuth token is missing', async () => {
    // #given session has no token (re-auth needed)
    const deps = makeBaseDeps({
      sessionStore: {getOperatorToken: vi.fn(() => undefined)},
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then coarse error
    expect(res.status).toBe(401)
    const body = (await res.json()) as {error?: string}
    expect(typeof body.error).toBe('string')
  })

  it('skips a repo when listRunsForRepo throws — other repos still returned', async () => {
    // #given 2 authorized repos; listRunsForRepo throws for one
    const bindings = [makeBinding('acme', 'good-repo'), makeBinding('acme', 'bad-repo')]
    const authorizedRepos = new Set(['acme/good-repo', 'acme/bad-repo'])
    const listRunsForRepo = vi.fn(async (repo: string) => {
      if (repo === 'acme/bad-repo') {
        throw new Error('S3 timeout')
      }
      return [makeRunState('acme', 'good-repo', 'run-good-1', '2024-01-01T00:00:00Z')]
    })
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
      listRunsForRepo,
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then good-repo's runs are returned; no 500
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: {runId: string}[]}
    const runIds = body.runs.map(r => r.runId)
    expect(runIds).toContain('run-good-1')
    expect(runIds).not.toContain('run-bad')
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
    await app.fetch(new Request('http://localhost/operator/runs'))

    // #then warn was called with githubUserId but NOT the token
    expect(warnSpy).toHaveBeenCalled()
    const [ctx] = warnSpy.mock.calls[0] as [Record<string, unknown>]
    expect(ctx).toHaveProperty('githubUserId')
    expect('token' in ctx).toBe(false)
    expect('oauthToken' in ctx).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Security — entity_ref mismatch (corruption guard)
// ---------------------------------------------------------------------------

describe('GET /operator/runs — entity_ref consistency guard', () => {
  it('omits a run whose entity_ref repo does not match the binding', async () => {
    // #given a run scanned under acme/alpha but entity_ref points to acme/other
    const bindings = [makeBinding('acme', 'alpha')]
    const authorizedRepos = new Set(['acme/alpha'])
    const mismatchedRun = makeRunState('acme', 'alpha', 'run-mismatch-1', '2024-01-01T00:00:00Z', {
      entity_ref: 'acme/other#1', // mismatch!
    })
    const runsByRepo = new Map<string, RunState[]>([['acme/alpha', [mismatchedRun]]])
    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
        repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then mismatched run is omitted
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: {runId: string}[]}
    expect(body.runs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Ordering and cap
// ---------------------------------------------------------------------------

describe('GET /operator/runs — ordering and cap', () => {
  it('returns runs sorted newest-first by createdAt', async () => {
    // #given 1 authorized repo with 3 runs in non-chronological order
    const bindings = [makeBinding('acme', 'alpha')]
    const authorizedRepos = new Set(['acme/alpha'])
    const runsByRepo = new Map<string, RunState[]>([
      [
        'acme/alpha',
        [
          makeRunState('acme', 'alpha', 'run-old', '2024-01-01T00:00:00Z'),
          makeRunState('acme', 'alpha', 'run-newest', '2024-03-01T00:00:00Z'),
          makeRunState('acme', 'alpha', 'run-middle', '2024-02-01T00:00:00Z'),
        ],
      ],
    ])
    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
        repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then runs are sorted newest-first
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: {runId: string}[]}
    expect(body.runs).toHaveLength(3)
    expect(body.runs[0]?.runId).toBe('run-newest')
    expect(body.runs[1]?.runId).toBe('run-middle')
    expect(body.runs[2]?.runId).toBe('run-old')
  })

  it(`truncates results at MAX_RUNS_PER_LISTING (${MAX_RUNS_PER_LISTING}) and returns the newest`, async () => {
    // #given 1 authorized repo with more runs than the cap
    const count = MAX_RUNS_PER_LISTING + 10
    const bindings = [makeBinding('acme', 'alpha')]
    const authorizedRepos = new Set(['acme/alpha'])

    // Create runs with distinct timestamps using epoch-based ISO strings so all are valid.
    // Index 0 is oldest (epoch 0), index count-1 is newest (epoch count-1 seconds).
    const runs = Array.from({length: count}, (_, i) =>
      makeRunState('acme', 'alpha', `run-${i}`, new Date(i * 1000).toISOString()),
    )
    const runsByRepo = new Map<string, RunState[]>([['acme/alpha', runs]])
    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
        repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then result is capped at MAX_RUNS_PER_LISTING and contains the newest runs
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: {runId: string}[]}
    expect(body.runs).toHaveLength(MAX_RUNS_PER_LISTING)

    // The newest runs (highest index) should be present; oldest (run-0) should be truncated
    const runIds = body.runs.map(r => r.runId)
    expect(runIds).toContain(`run-${count - 1}`) // newest
    expect(runIds).not.toContain('run-0') // oldest, should be truncated
  })
})

// ---------------------------------------------------------------------------
// Security — response shape carries no internal fields
// ---------------------------------------------------------------------------

describe('GET /operator/runs — response shape security', () => {
  it('serialized response items contain only runId, repo, status, createdAt, and optional updatedAt', async () => {
    // #given 1 authorized binding with 1 run
    const binding = makeBinding('acme', 'widget', {
      channelId: 'chan-secret',
      channelName: 'widget-channel',
      workspacePath: '/secret/path',
      createdByDiscordId: '111222333',
      databaseId: 42,
      nodeId: 'R_kgDOsecret',
    })
    const run = makeRunState('acme', 'widget', 'run-widget-1', '2024-01-01T00:00:00Z', {
      last_heartbeat: '2024-01-01T01:00:00Z',
    })
    const runsByRepo = new Map<string, RunState[]>([['acme/widget', [run]]])
    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: [binding]})),
        repoAuthzDeps: makeRepoAuthzDeps(new Set(['acme/widget'])),
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: Record<string, unknown>[]}
    expect(body.runs).toHaveLength(1)
    const item = body.runs[0] ?? {}

    // #then only safe fields are present
    const allowedKeys = new Set(['runId', 'repo', 'status', 'createdAt', 'updatedAt'])
    const forbiddenKeys = Object.keys(item).filter(k => !allowedKeys.has(k))
    expect(forbiddenKeys).toEqual([])

    // Explicitly assert forbidden fields are absent
    expect('entityRef' in item).toBe(false)
    expect('entity_ref' in item).toBe(false)
    expect('phase' in item).toBe(false)
    expect('surface' in item).toBe(false)
    expect('channelId' in item).toBe(false)
    expect('workspacePath' in item).toBe(false)
    expect('databaseId' in item).toBe(false)
    expect('nodeId' in item).toBe(false)
    expect('holder_id' in item).toBe(false)
    expect('thread_id' in item).toBe(false)

    // Verify the safe fields are correct
    expect(item.runId).toBe('run-widget-1')
    expect(item.repo).toBe('acme/widget')
    expect(typeof item.status).toBe('string')
    expect(item.createdAt).toBe('2024-01-01T00:00:00Z')
    expect(item.updatedAt).toBe('2024-01-01T01:00:00Z')
  })

  it('updatedAt is omitted when last_heartbeat is empty', async () => {
    // #given a run with no heartbeat
    const binding = makeBinding('acme', 'widget')
    const run = makeRunState('acme', 'widget', 'run-widget-1', '2024-01-01T00:00:00Z', {
      last_heartbeat: '',
    })
    const runsByRepo = new Map<string, RunState[]>([['acme/widget', [run]]])
    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: [binding]})),
        repoAuthzDeps: makeRepoAuthzDeps(new Set(['acme/widget'])),
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: Record<string, unknown>[]}
    const item = body.runs[0] ?? {}

    // #then updatedAt is absent
    expect('updatedAt' in item).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Contract — Cache-Control header
// ---------------------------------------------------------------------------

describe('GET /operator/runs — contract', () => {
  it('response carries Cache-Control: no-store, private', async () => {
    // #given
    const deps = makeBaseDeps()
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then
    expect(res.headers.get('cache-control')).toBe('no-store, private')
  })

  it('response body is an object with a runs array key', async () => {
    // #given
    const deps = makeBaseDeps()
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // #then body is {runs: []} not a bare array
    expect(Array.isArray(body)).toBe(false)
    expect(Array.isArray(body.runs)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Auth context guard
// ---------------------------------------------------------------------------

describe('GET /operator/runs — auth context guard', () => {
  it('returns 401 when no auth context is set (guard not installed)', async () => {
    // #given app without a guard (no setOperatorRouteGuard)
    const app = new Hono()
    const deps = makeBaseDeps()
    buildRunsRoute(app, deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Fix 1 — dedup repos before run enumeration
// ---------------------------------------------------------------------------

describe('GET /operator/runs — dedup repos (Fix 1)', () => {
  it('calls listRunsForRepo exactly once when two bindings share the same owner/repo', async () => {
    // #given — two bindings with the SAME owner/repo but different channelIds
    const bindingA = makeBinding('acme', 'shared-repo', {channelId: 'chan-001'})
    const bindingB = makeBinding('acme', 'shared-repo', {channelId: 'chan-002'})
    const authorizedRepos = new Set(['acme/shared-repo'])
    const run = makeRunState('acme', 'shared-repo', 'run-shared-1', '2024-01-01T00:00:00Z')
    const runsByRepo = new Map<string, RunState[]>([['acme/shared-repo', [run]]])
    const listRunsForRepo = vi.fn(async (repo: string) => runsByRepo.get(repo) ?? [])

    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: [bindingA, bindingB]})),
      repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
      listRunsForRepo,
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then — listRunsForRepo called exactly once (dedup by owner/repo)
    expect(res.status).toBe(200)
    expect(listRunsForRepo).toHaveBeenCalledTimes(1)
    expect(listRunsForRepo).toHaveBeenCalledWith('acme/shared-repo')

    // Runs appear exactly once (no duplicates)
    const body = (await res.json()) as {runs: {runId: string}[]}
    const runIds = body.runs.map(r => r.runId)
    expect(runIds.filter(id => id === 'run-shared-1')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Fix 2 — entity_ref not logged on corruption warn path
// ---------------------------------------------------------------------------

describe('GET /operator/runs — entity_ref not logged on mismatch (Fix 2)', () => {
  it('warn-log for entity_ref mismatch does not include entityRef field', async () => {
    // #given — a run scanned under acme/alpha but entity_ref points to acme/other
    const bindings = [makeBinding('acme', 'alpha')]
    const authorizedRepos = new Set(['acme/alpha'])
    const mismatchedRun = makeRunState('acme', 'alpha', 'run-mismatch-1', '2024-01-01T00:00:00Z', {
      entity_ref: 'acme/other#1',
    })
    const runsByRepo = new Map<string, RunState[]>([['acme/alpha', [mismatchedRun]]])
    const warnSpy = vi.fn()
    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
        repoAuthzDeps: makeRepoAuthzDeps(authorizedRepos),
        logger: {debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn()},
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    await app.fetch(new Request('http://localhost/operator/runs'))

    // #then — warn was called for the mismatch but entityRef is NOT in the context
    const mismatchCall = warnSpy.mock.calls.find(
      (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('mismatch'),
    )
    expect(mismatchCall).toBeDefined()
    const ctx = mismatchCall?.[0] as Record<string, unknown>
    expect('entityRef' in ctx).toBe(false)
    expect('entity_ref' in ctx).toBe(false)
    // Safe fields are still present
    expect(ctx).toHaveProperty('repo')
    expect(ctx).toHaveProperty('runId')
    expect(ctx).toHaveProperty('githubUserId')
  })
})

// ---------------------------------------------------------------------------
// Fix 5 — additional error paths and authz fan-out cap
// ---------------------------------------------------------------------------

describe('GET /operator/runs — checkRepoAuthz throws (Fix 5)', () => {
  it('silently omits a repo when checkRepoAuthz throws — other repos still returned', async () => {
    // #given — 2 bindings; checkRepoAuthz throws for one, succeeds for the other
    const bindings = [makeBinding('acme', 'broken-authz'), makeBinding('acme', 'good-repo')]
    const run = makeRunState('acme', 'good-repo', 'run-good-1', '2024-01-01T00:00:00Z')
    const runsByRepo = new Map<string, RunState[]>([['acme/good-repo', [run]]])

    // authzFetch throws for broken-authz, returns 200 for good-repo
    const authzFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.includes('broken-authz')) {
        throw new Error('GitHub API timeout')
      }
      return new Response('{}', {status: 200})
    }) as typeof globalThis.fetch

    const deps = makeBaseDeps(
      {
        listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
        repoAuthzDeps: makeRepoAuthzDeps(new Set(['acme/good-repo']), {fetch: authzFetch}),
      },
      runsByRepo,
    )
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then — 200 (not 500); broken-authz omitted; good-repo's run present
    expect(res.status).toBe(200)
    const body = (await res.json()) as {runs: {runId: string}[]}
    const runIds = body.runs.map(r => r.runId)
    expect(runIds).toContain('run-good-1')
    expect(runIds.some(id => id.includes('broken'))).toBe(false)
  })
})

describe('GET /operator/runs — listBindings throws (Fix 5)', () => {
  it('returns coarse 503 when listBindings throws (not just success:false)', async () => {
    // #given — listBindings rejects (unexpected throw, not a Result failure)
    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => {
        throw new Error('unexpected network crash')
      }),
    })
    const app = buildTestApp(deps)

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/runs'))

    // #then — coarse 503; body is not an array
    expect(res.status).toBe(503)
    const body = (await res.json()) as {error?: string; runs?: unknown}
    expect(typeof body.error).toBe('string')
    expect(Array.isArray(body)).toBe(false)
    expect('runs' in body).toBe(false)
  })
})

describe('GET /operator/runs — authz fan-out cap (Fix 5)', () => {
  it('only first 100 non-denied bindings reach checkRepoAuthz (documents truncation)', async () => {
    // #given — 110 distinct bindings (all non-denied); cap is MAX_REPOS_AUTHZ_FANOUT = 100
    const count = 110
    const bindings = Array.from({length: count}, (_, i) => makeBinding('acme', `repo-${i}`))
    const authzFetch = vi.fn(async () => new Response('{}', {status: 200})) as typeof globalThis.fetch

    const deps = makeBaseDeps({
      listBindings: vi.fn(async () => ({success: true as const, data: bindings})),
      repoAuthzDeps: makeRepoAuthzDeps(new Set(bindings.map(b => `${b.owner}/${b.repo}`)), {fetch: authzFetch}),
    })
    const app = buildTestApp(deps)

    // #when
    await app.fetch(new Request('http://localhost/operator/runs'))

    // #then — authzFetch called at most 100 times (cap enforced before authz fan-out)
    // Each checkRepoAuthz call makes one fetch call to the GitHub API.
    const callCount = (authzFetch as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callCount).toBeLessThanOrEqual(100)
  })
})
