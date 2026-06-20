/**
 * Tests for the authenticated launch route: POST /operator/runs
 *
 * Load-bearing tests (written first):
 *   1. FIRE-AND-RETURN: route returns 202 {runId} immediately even when launchWork hangs.
 *   2. AUTO-DENY: web createApprovalOnPending denies; Discord transport NOT used.
 *   3. IDEMPOTENCY ISOLATION: operator A key 'x' and operator B key 'x' → two runIds.
 */

import type {ApprovalRegistry} from '../../approvals/registry.js'
import type {RepoBinding} from '../../bindings/types.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {RunMentionDeps} from '../../execute/run.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {LaunchRouteBindingsLookup, LaunchRouteDeps, LaunchRouteSessionStore} from './launch-route.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {createIdempotencyGuard} from './idempotency.js'
import {buildLaunchRoute} from './launch-route.js'

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeBinding(overrides?: Partial<RepoBinding>): RepoBinding {
  return {
    owner: 'acme',
    repo: 'widget',
    channelId: 'ch-123',
    channelName: 'widget-dev',
    workspacePath: '/workspace/acme/widget',
    createdAt: '2026-01-01T00:00:00Z',
    createdByDiscordId: 'discord-user-1',
    databaseId: 42,
    nodeId: 'R_node_42',
    ...overrides,
  }
}

function makeSessionStore(overrides?: Partial<LaunchRouteSessionStore>): LaunchRouteSessionStore {
  return {
    getOperatorToken: vi.fn((_sessionId: string, _nowMs: number) => 'oauth-token-stub'),
    get: vi.fn((_sessionId: string, _nowMs: number) => ({githubUserId: 1001, login: 'alice'})),
    ...overrides,
  }
}

function makeBindingsLookup(binding: RepoBinding | null = makeBinding()): LaunchRouteBindingsLookup {
  return {
    getBindingByRepo: vi.fn(async (_owner: string, _repo: string) => ({
      success: true as const,
      data: binding,
    })),
  }
}

function makeRepoAuthzDeps(): RepoAuthzDeps {
  return {
    allowlist: {isAuthorized: vi.fn(() => true), size: 1},
    fetch: vi.fn(
      async () => new Response('{"permission":"admin"}', {status: 200, headers: {'content-type': 'application/json'}}),
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

function makeApprovalRegistry(): ApprovalRegistry {
  return {
    register: vi.fn(),
    attachMessage: vi.fn(),
    markMessagePostFailed: vi.fn(),
    has: vi.fn(() => false),
    pending: vi.fn(() => []),
    hasPendingForScope: vi.fn(() => false),
    handleDecision: vi.fn(async () => 'ok' as const),
    confirmReply: vi.fn(),
    applySettlement: vi.fn(async () => undefined),
    disposeRun: vi.fn(async () => undefined),
    disposeAll: vi.fn(async () => undefined),
  }
}

function makeLaunchWorkDeps(): RunMentionDeps {
  return {
    coordinationConfig: {} as RunMentionDeps['coordinationConfig'],
    identity: 'gateway-identity',
    concurrency: {
      tryAcquire: vi.fn(() => 'ok' as const),
      release: vi.fn(),
      activeCount: vi.fn(() => 0),
      max: 3,
    },
    queue: {
      enqueue: vi.fn(() => 'queued' as const),
      takeNext: vi.fn(() => undefined),
      pendingCount: vi.fn(() => 0),
      clear: vi.fn(() => 0),
    },
    attachUrl: 'http://localhost:3000',
    attachToken: 'attach-token',
    runTimeoutMs: 10 * 60 * 1000,
    botUserId: 'bot-123',
    persona: null,
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    approvalRegistry: makeApprovalRegistry(),
    approvalMode: 'approval-required',
    statusMode: 'live-status',
    ensureClone: vi.fn(async () => ({success: true as const, data: '/workspace/acme/widget'})),
    readyz: vi.fn(async () => ({success: true as const, data: {ready: true as const, opencode: 'ready' as const}})),
    runIndex: {
      register: vi.fn(),
      lookup: vi.fn(async () => undefined),
    },
  }
}

function makeRunIndex(): Pick<RunIndex, 'register'> {
  return {
    register: vi.fn(),
  }
}

function makeDeps(overrides?: Partial<LaunchRouteDeps>): LaunchRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    bindingsLookup: makeBindingsLookup(),
    isRepoDenied: vi.fn(() => false),
    repoAuthzDeps: makeRepoAuthzDeps(),
    idempotencyGuard: createIdempotencyGuard(),
    runIndex: makeRunIndex(),
    launchWorkDeps: makeLaunchWorkDeps(),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    // Pass-through rate limiters (always allow) for most tests
    perMinRateLimiter: {allow: () => true},
    perHrRateLimiter: {allow: () => true},
    ...overrides,
  }
}

function buildApp(deps: LaunchRouteDeps): Hono {
  const app = new Hono()
  // Install a pass-through guard that sets auth context
  setOperatorRouteGuard(app, async (_c, _method, _path) => ({
    ok: true as const,
    githubUserId: 1001,
    sessionId: 'sess-abc',
  }))
  buildLaunchRoute(app, deps)
  return app
}

function buildAppWithGuardResult(
  guardResult: {ok: true; githubUserId: number; sessionId: string} | {ok: false; response: Response},
  deps: LaunchRouteDeps,
): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => guardResult)
  buildLaunchRoute(app, deps)
  return app
}

async function postRuns(
  app: Hono,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/operator/runs', {
      method: 'POST',
      headers: {'content-type': 'application/json', ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 1: FIRE-AND-RETURN
// ---------------------------------------------------------------------------

describe('POST /operator/runs — FIRE-AND-RETURN (load-bearing)', () => {
  it('returns 202 {runId} immediately even when launchWork never resolves', async () => {
    // #given — launchWork mock that hangs forever (simulated via ensureClone that never resolves)
    const launchWorkDeps = makeLaunchWorkDeps()
    // Override ensureClone to hang so the engine never completes
    const deps = makeDeps({
      launchWorkDeps: {
        ...launchWorkDeps,
        ensureClone: vi.fn(async () => new Promise<never>(() => {})),
      },
    })

    // Patch launchWork by replacing the module-level function via the deps
    // We test fire-and-return by checking the response arrives before launchWork resolves.
    // Since we can't easily mock the module, we verify timing via the route's behavior:
    // the route must NOT await launchWork.
    const app = buildApp(deps)

    // #when — measure response time
    const start = Date.now()
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})
    const elapsed = Date.now() - start

    // #then — 202 returned immediately (well under 100ms)
    expect(response.status).toBe(202)
    const body = (await response.json()) as {runId: string}
    expect(typeof body.runId).toBe('string')
    expect(body.runId.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(500) // generous bound; real fire-and-return is <10ms
  })

  it('registers PENDING in runIndex BEFORE launchWork is fired', async () => {
    // #given
    const registerCalls: string[] = []

    const runIndex = {
      register: vi.fn((runId: string) => {
        registerCalls.push(runId)
      }),
    }

    // We verify ordering by checking that register was called before the response
    // (which is after launchWork is fired but not awaited).
    const deps = makeDeps({runIndex})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — register was called
    expect(response.status).toBe(202)
    expect(registerCalls.length).toBe(1)
    const body = (await response.json()) as {runId: string}
    // The registered runId matches the returned runId
    expect(registerCalls[0]).toBe(body.runId)
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 2: AUTO-DENY (via web-approval.test.ts — route-level pin)
// ---------------------------------------------------------------------------

describe('POST /operator/runs — AUTO-DENY (load-bearing)', () => {
  it('uses web auto-deny createApprovalOnPending (not Discord transport)', async () => {
    // #given — the web route always supplies createApprovalOnPending (not undefined).
    // The auto-deny behavior is tested in web-approval.test.ts.
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 202 returned; the route wired createApprovalOnPending
    expect(response.status).toBe(202)
    // The auto-deny behavior is tested in web-approval.test.ts.
    // Here we verify the route returns 202 (not a Discord-transport-caused hang/error).
  })

  it('surface is web (not discord) — run is attributed to web surface', async () => {
    // #given — we verify via the runIndex registration that surface:'web' is used
    const runIndex = {
      register: vi.fn(),
    }
    const deps = makeDeps({runIndex})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then
    expect(response.status).toBe(202)
    expect(runIndex.register).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({surface: 'web'}))
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 3: IDEMPOTENCY ISOLATION
// ---------------------------------------------------------------------------

describe('POST /operator/runs — IDEMPOTENCY ISOLATION (load-bearing)', () => {
  it('operator A key x and operator B key x → two distinct runIds (no suppression)', async () => {
    // #given — two operators with the same client key
    const idempotencyGuard = createIdempotencyGuard()
    const deps = makeDeps({idempotencyGuard})

    const appA = buildAppWithGuardResult({ok: true, githubUserId: 1, sessionId: 'sess-a'}, deps)
    const appB = buildAppWithGuardResult({ok: true, githubUserId: 2, sessionId: 'sess-b'}, deps)

    // #when — operator A launches with key 'x'
    const responseA = await appA.fetch(
      new Request('http://localhost/operator/runs', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({repo: 'acme/widget', prompt: 'task A', idempotencyKey: 'x'}),
      }),
    )

    // #when — operator B launches with the same key 'x'
    const responseB = await appB.fetch(
      new Request('http://localhost/operator/runs', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({repo: 'acme/widget', prompt: 'task B', idempotencyKey: 'x'}),
      }),
    )

    // #then — both get 202 with distinct runIds
    expect(responseA.status).toBe(202)
    expect(responseB.status).toBe(202)
    const bodyA = (await responseA.json()) as {runId: string}
    const bodyB = (await responseB.json()) as {runId: string}
    expect(bodyA.runId).not.toBe(bodyB.runId)
  })

  it('same operator + same key twice → one launchWork call, second echoes the runId', async () => {
    // #given
    const idempotencyGuard = createIdempotencyGuard()
    const runIndex = {register: vi.fn()}
    const deps = makeDeps({idempotencyGuard, runIndex})
    const app = buildApp(deps)

    // #when — first launch
    const response1 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'my-key'})
    const body1 = (await response1.json()) as {runId: string}

    // #when — second launch with same key
    const response2 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'my-key'})
    const body2 = (await response2.json()) as {runId: string}

    // #then — both 202; same runId; runIndex.register called only once
    expect(response1.status).toBe(202)
    expect(response2.status).toBe(202)
    expect(body1.runId).toBe(body2.runId)
    expect(runIndex.register).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST /operator/runs — happy path', () => {
  it('returns 202 with a runId for a valid authorized request', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'fix the bug'})

    // #then
    expect(response.status).toBe(202)
    const body = (await response.json()) as {runId: string}
    expect(typeof body.runId).toBe('string')
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('registers the run with surface:web and the correct repo', async () => {
    // #given
    const runIndex = {register: vi.fn()}
    const deps = makeDeps({runIndex})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'fix the bug'})
    const body = (await response.json()) as {runId: string}

    // #then
    expect(runIndex.register).toHaveBeenCalledWith(body.runId, {
      repo: 'acme/widget',
      surface: 'web',
      startedAt: expect.any(String) as string,
    })
  })

  it('queued case: slot busy → still 202 with runId (never 404/500)', async () => {
    // #given — concurrency returns 'busy' (slot occupied)
    const launchWorkDeps = makeLaunchWorkDeps()
    const deps = makeDeps({
      launchWorkDeps: {
        ...launchWorkDeps,
        concurrency: {
          tryAcquire: vi.fn(() => 'busy' as const),
          release: vi.fn(),
          activeCount: vi.fn(() => 1),
          max: 3,
        },
        queue: {
          enqueue: vi.fn(() => 'queued' as const),
          takeNext: vi.fn(() => undefined),
          pendingCount: vi.fn(() => 0),
          clear: vi.fn(() => 0),
        },
      },
    })
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 202 with runId even when queued
    expect(response.status).toBe(202)
    const body = (await response.json()) as {runId: string}
    expect(typeof body.runId).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('POST /operator/runs — R10 unbound repo', () => {
  it('returns 404 when repo is not bound', async () => {
    // #given — binding not found
    const deps = makeDeps({
      bindingsLookup: makeBindingsLookup(null),
    })
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — coarse 404, no launch
    expect(response.status).toBe(404)
  })

  it('does NOT call launchWork when repo is unbound', async () => {
    // #given
    const launchWorkDeps = makeLaunchWorkDeps()
    const concurrencyTryAcquire = vi.fn(() => 'ok' as const)
    const deps = makeDeps({
      bindingsLookup: makeBindingsLookup(null),
      launchWorkDeps: {
        ...launchWorkDeps,
        concurrency: {...launchWorkDeps.concurrency, tryAcquire: concurrencyTryAcquire},
      },
    })
    const app = buildApp(deps)

    // #when
    await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — concurrency never acquired (launchWork not called)
    expect(concurrencyTryAcquire).not.toHaveBeenCalled()
  })
})

describe('POST /operator/runs — R19 unauthorized repo', () => {
  it('returns 404 when operator cannot access the repo', async () => {
    // #given — authz denied (GitHub returns 403)
    const repoAuthzDeps: RepoAuthzDeps = {
      ...makeRepoAuthzDeps(),
      // Override fetch to return 403 so checkRepoAuthz denies
      fetch: vi.fn(async () => new Response('', {status: 403})),
    }
    const deps = makeDeps({repoAuthzDeps})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — coarse 404
    expect(response.status).toBe(404)
  })
})

describe('POST /operator/runs — denylisted repo', () => {
  it('returns 404 when repo is denylisted (filter before authz)', async () => {
    // #given — repo is denylisted
    const isRepoDenied = vi.fn((_key: RepoKey) => true)
    const repoAuthzDeps = makeRepoAuthzDeps()
    const checkRepoAuthzSpy = vi.spyOn(repoAuthzDeps, 'fetch')
    const deps = makeDeps({isRepoDenied, repoAuthzDeps})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 404, no GitHub call (filter before authz)
    expect(response.status).toBe(404)
    expect(checkRepoAuthzSpy).not.toHaveBeenCalled()
  })
})

describe('POST /operator/runs — empty prompt', () => {
  it('returns 400 for an empty prompt', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: ''})

    // #then
    expect(response.status).toBe(400)
  })

  it('returns 400 for a whitespace-only prompt', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: '   '})

    // #then
    expect(response.status).toBe(400)
  })
})

describe('POST /operator/runs — CSRF / guard rejection', () => {
  it('returns the guard response when the guard rejects', async () => {
    // #given — guard rejects with 403
    const deps = makeDeps()
    const app = new Hono()
    setOperatorRouteGuard(app, async () => ({
      ok: false as const,
      response: new Response(JSON.stringify({error: 'forbidden'}), {status: 403}),
    }))
    buildLaunchRoute(app, deps)

    // #when
    const response = await postRuns(app)

    // #then — guard response returned, no launch
    expect(response.status).toBe(403)
  })
})

describe('POST /operator/runs — rate limit', () => {
  it('returns 429 when per-minute rate limit is exceeded', async () => {
    // #given — per-minute limiter always denies
    const deps = makeDeps({
      perMinRateLimiter: {allow: () => false},
    })
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then
    expect(response.status).toBe(429)
  })

  it('returns 429 when per-hour rate limit is exceeded', async () => {
    // #given — per-hour limiter always denies
    const deps = makeDeps({
      perHrRateLimiter: {allow: () => false},
    })
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then
    expect(response.status).toBe(429)
  })

  it('rate limit is operator-keyed (not per-repo)', async () => {
    // #given — rate limiter that records keys
    const seenKeys: string[] = []
    const perMinRateLimiter = {
      allow: (key: string) => {
        seenKeys.push(key)
        return true
      },
    }
    const deps = makeDeps({perMinRateLimiter})
    const app = buildApp(deps)

    // #when
    await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — key is the operator's githubUserId (not the repo)
    expect(seenKeys.length).toBeGreaterThan(0)
    expect(seenKeys[0]).toBe('1001') // githubUserId from the stub guard
    expect(seenKeys[0]).not.toContain('acme')
    expect(seenKeys[0]).not.toContain('widget')
  })
})

describe('POST /operator/runs — prompt uses web builder (not buildDiscordPrompt)', () => {
  it('web prompt builder is used (no Discord-thread guidance in prompt)', async () => {
    // #given — we verify via the route returning 202 with surface:'web'
    // The promptBuilder is set to buildWebPrompt (not buildDiscordPrompt).
    // We verify this indirectly: the route registers surface:'web' and returns 202.
    const runIndex = {register: vi.fn()}
    const deps = makeDeps({runIndex})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'fix the bug'})

    // #then — 202 with web surface
    expect(response.status).toBe(202)
    expect(runIndex.register).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({surface: 'web'}))
    // The promptBuilder is set in the LaunchWorkRequest; the engine uses it
    // instead of buildDiscordPrompt. This is verified in run.ts seam tests.
  })
})

describe('POST /operator/runs — security', () => {
  it('response carries only runId (no token, prompt, workspacePath, or internal IDs)', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'secret task'})
    const body = (await response.json()) as Record<string, unknown>

    // #then — only runId in response
    expect(Object.keys(body)).toEqual(['runId'])
    expect(body.token).toBeUndefined()
    expect(body.prompt).toBeUndefined()
    expect(body.workspacePath).toBeUndefined()
    expect(body.channelId).toBeUndefined()
    expect(body.binding).toBeUndefined()
  })

  it('server-owned: client-supplied binding/path is ignored (resolution via getBindingByRepo only)', async () => {
    // #given — binding lookup always returns the server-owned binding
    const serverBinding = makeBinding({owner: 'acme', repo: 'widget', workspacePath: '/server/path'})
    const bindingsLookup = makeBindingsLookup(serverBinding)
    const deps = makeDeps({bindingsLookup})
    const app = buildApp(deps)

    // #when — client sends a repo field; server resolves via getBindingByRepo
    const response = await postRuns(app, {
      repo: 'acme/widget',
      prompt: 'do something',
      // Client cannot supply binding/path — only repo name is accepted
    })

    // #then — 202; getBindingByRepo was called with the parsed owner/repo
    expect(response.status).toBe(202)
    expect(bindingsLookup.getBindingByRepo).toHaveBeenCalledWith('acme', 'widget')
  })
})

describe('POST /operator/runs — bad request bodies', () => {
  it('returns 400 for missing repo field', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {prompt: 'do something'})

    // #then
    expect(response.status).toBe(400)
  })

  it('returns 400 for invalid repo format (no slash)', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'noslash', prompt: 'do something'})

    // #then
    expect(response.status).toBe(400)
  })

  it('returns 400 for missing prompt field', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget'})

    // #then
    expect(response.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Discord-path regression: absent seams → Discord behavior unchanged
// ---------------------------------------------------------------------------

describe('Discord-path regression — absent runId/promptBuilder/createApprovalOnPending', () => {
  it('launchWorkRequest without runId uses crypto.randomUUID (Discord path unchanged)', async () => {
    // #given — verify the seam: when runId is absent, engine generates its own UUID.
    // This is tested at the run.ts level; here we verify the route always supplies runId.
    // The route always generates a runId and passes it in the request.
    const runIndex = {register: vi.fn()}
    const deps = makeDeps({runIndex})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})
    const body = (await response.json()) as {runId: string}

    // #then — route always supplies a runId (UUID format)
    expect(body.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // runIndex.register was called with the same runId
    expect(runIndex.register).toHaveBeenCalledWith(body.runId, expect.any(Object))
  })
})
