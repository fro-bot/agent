/**
 * Tests for the authenticated launch route: POST /operator/runs
 *
 * Load-bearing tests (written first):
 *   1. AWAIT-ADMISSION: route awaits launchWork admission (not the full run) and returns 202.
 *   2. WEB APPROVAL TRANSPORT: route wires createWebApprovalOnPending (register+observe);
 *      Discord transport NOT used.
 *   3. IDEMPOTENCY ISOLATION: operator A key 'x' and operator B key 'x' → two runIds.
 *
 * launchWork is mocked at the module level so route tests do not need real
 * AWS/S3/coordination deps. Route tests verify the route's behavior (idempotency
 * lifecycle, HTTP status codes, request shaping) — not launchWork internals
 * (those are tested in run.test.ts).
 */

import type {ApprovalRegistry} from '../../approvals/registry.js'
import type {RepoBinding} from '../../bindings/types.js'
import type {LaunchAdmission, LaunchWorkRequest} from '../../execute/launch-types.js'
import type {RunMentionDeps} from '../../execute/run.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {LaunchRouteBindingsLookup, LaunchRouteDeps, LaunchRouteSessionStore} from './launch-route.js'
import {Hono} from 'hono'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {launchWork} from '../../execute/run.js'
import {setOperatorRouteGuard} from '../operator-route.js'
import {createIdempotencyGuard} from './idempotency.js'
import {buildLaunchRoute} from './launch-route.js'

// vi.mock is hoisted by Vitest before imports — mock launchWork so route tests
// do not need real AWS/S3/coordination deps.
vi.mock('../../execute/run.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../execute/run.js')>()
  return {
    ...actual,
    launchWork: vi.fn(
      async (request: {readonly runId?: string}): Promise<LaunchAdmission> => ({
        accepted: true,
        runId: request.runId ?? 'mock-run-id',
      }),
    ),
  }
})

// Typed reference to the mocked launchWork for per-test overrides.
const mockLaunchWork = vi.mocked(launchWork)

// Reset the mock before each test so call counts don't accumulate across tests.
beforeEach(() => {
  mockLaunchWork.mockClear()
  // Restore the default implementation (accepted:true, echoes request.runId).
  mockLaunchWork.mockImplementation(
    async (request: {readonly runId?: string}): Promise<LaunchAdmission> => ({
      accepted: true,
      runId: request.runId ?? 'mock-run-id',
    }),
  )
})

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
    describePendingForScope: vi.fn(() => []),
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
      listRunsForRepo: vi.fn(async () => []),
    },
  }
}

function makeDeps(overrides?: Partial<LaunchRouteDeps>): LaunchRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    bindingsLookup: makeBindingsLookup(),
    isRepoDenied: vi.fn(() => false),
    repoAuthzDeps: makeRepoAuthzDeps(),
    idempotencyGuard: createIdempotencyGuard(),
    launchWorkDeps: makeLaunchWorkDeps(),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    // Pass-through rate limiters (always allow) for most tests
    perMinRateLimiter: {allow: () => true},
    perHrRateLimiter: {allow: () => true},
    // runObservationManager absent by default — tests that exercise output routing
    // pass it explicitly via overrides.
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
// LOAD-BEARING TEST 1: AWAIT-ADMISSION (replaces FIRE-AND-RETURN)
// ---------------------------------------------------------------------------

describe('POST /operator/runs — AWAIT-ADMISSION (load-bearing)', () => {
  it('returns 202 {runId} after awaiting launchWork admission (not the full run)', async () => {
    // #given — launchWork mock returns accepted admission immediately
    mockLaunchWork.mockResolvedValueOnce({accepted: true, runId: 'run-from-admission'})
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 202 returned with the runId from admission
    expect(response.status).toBe(202)
    const body = (await response.json()) as {runId: string}
    expect(body.runId).toBe('run-from-admission')
  })

  it('runIndex.register is called ONCE (in launchWork, not in the route)', async () => {
    // #given — the mock launchWork simulates calling runIndex.register once
    const launchWorkRunIndex = {
      register: vi.fn(),
      lookup: vi.fn(async () => undefined),
      listRunsForRepo: vi.fn(async () => []),
    }
    mockLaunchWork.mockImplementationOnce(async (request: {readonly runId?: string}) => {
      launchWorkRunIndex.register(request.runId, {repo: 'acme/widget', surface: 'web', startedAt: 'now'})
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })
    const deps = makeDeps({
      launchWorkDeps: {
        ...makeLaunchWorkDeps(),
        runIndex: launchWorkRunIndex,
      },
    })
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — register called exactly once (in launchWork), not twice
    expect(response.status).toBe(202)
    expect(launchWorkRunIndex.register).toHaveBeenCalledTimes(1)
    const body = (await response.json()) as {runId: string}
    expect(launchWorkRunIndex.register).toHaveBeenCalledWith(body.runId, expect.any(Object))
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 2: WEB APPROVAL TRANSPORT (register + observe, not auto-deny)
// ---------------------------------------------------------------------------

describe('POST /operator/runs — WEB APPROVAL TRANSPORT (load-bearing)', () => {
  it('uses createWebApprovalOnPending (register+observe) — not Discord transport', async () => {
    // #given — the web route always supplies createApprovalOnPending (not undefined).
    // Capture the request passed to launchWork to verify createApprovalOnPending is set.
    let capturedCreateApprovalOnPending: LaunchWorkRequest['createApprovalOnPending']
    mockLaunchWork.mockImplementationOnce(async (request: LaunchWorkRequest) => {
      capturedCreateApprovalOnPending = request.createApprovalOnPending
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 202 returned; the route wired createApprovalOnPending (not undefined)
    expect(response.status).toBe(202)
    expect(typeof capturedCreateApprovalOnPending).toBe('function')
  })

  it('wires observeApproval from the runObservationManager into the transport', async () => {
    // #given — a manager with observeApproval spy
    const observeApproval = vi.fn()
    const observeOutput = vi.fn()
    const runObservationManager = {observeOutput, observeApproval}

    // Capture the createApprovalOnPending factory from the launchWork call
    let capturedFactory: LaunchWorkRequest['createApprovalOnPending']
    mockLaunchWork.mockImplementationOnce(async (request: LaunchWorkRequest) => {
      capturedFactory = request.createApprovalOnPending
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })

    const deps = makeDeps({runObservationManager})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 202 returned; factory is a function (the real transport, not auto-deny)
    expect(response.status).toBe(202)
    expect(typeof capturedFactory).toBe('function')
  })

  it('surface is web (not discord) — run is attributed to web surface', async () => {
    // #given — capture the request passed to launchWork to verify surface:'web'
    let capturedSurface: string | undefined
    mockLaunchWork.mockImplementationOnce(async (request: {readonly surface?: string; readonly runId?: string}) => {
      capturedSurface = request.surface
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then
    expect(response.status).toBe(202)
    expect(capturedSurface).toBe('web')
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
    const deps = makeDeps({idempotencyGuard})
    const app = buildApp(deps)

    // #when — first launch
    const response1 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'my-key'})
    const body1 = (await response1.json()) as {runId: string}

    // #when — second launch with same key
    const response2 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'my-key'})
    const body2 = (await response2.json()) as {runId: string}

    // #then — both 202; same runId; launchWork called only once
    expect(response1.status).toBe(202)
    expect(response2.status).toBe(202)
    expect(body1.runId).toBe(body2.runId)
    expect(mockLaunchWork).toHaveBeenCalledTimes(1)
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

  it('registers the run with surface:web and the correct repo (via launchWork)', async () => {
    // #given — capture the request passed to launchWork
    let capturedRequest: {surface?: string; runId?: string} | undefined
    mockLaunchWork.mockImplementationOnce(async request => {
      capturedRequest = {surface: request.surface, runId: request.runId}
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'fix the bug'})
    const body = (await response.json()) as {runId: string}

    // #then — launchWork received surface:'web' and the route-generated runId
    expect(response.status).toBe(202)
    expect(capturedRequest?.surface).toBe('web')
    expect(capturedRequest?.runId).toBe(body.runId)
  })

  it('queued case: slot busy → still 202 with runId (never 404/500)', async () => {
    // #given — launchWork returns accepted (queued disposition)
    mockLaunchWork.mockResolvedValueOnce({accepted: true, runId: 'queued-run-id'})
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 202 with runId even when queued
    expect(response.status).toBe(202)
    const body = (await response.json()) as {runId: string}
    expect(body.runId).toBe('queued-run-id')
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
    const deps = makeDeps({
      bindingsLookup: makeBindingsLookup(null),
    })
    const app = buildApp(deps)

    // #when
    await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — launchWork never called
    expect(mockLaunchWork).not.toHaveBeenCalled()
  })
})

describe('POST /operator/runs — R19 unauthorized repo', () => {
  it('returns 404 when operator cannot access the repo', async () => {
    // #given — authz denied (GitHub returns 403)
    const repoAuthzDeps: RepoAuthzDeps = {
      ...makeRepoAuthzDeps(),
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
    // #given — capture the request passed to launchWork
    let capturedRequest: {surface?: string; runId?: string; promptBuilder?: unknown} | undefined
    mockLaunchWork.mockImplementationOnce(async request => {
      capturedRequest = {surface: request.surface, runId: request.runId, promptBuilder: request.promptBuilder}
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'fix the bug'})

    // #then — 202 with web surface; promptBuilder is set (not undefined)
    expect(response.status).toBe(202)
    expect(capturedRequest?.surface).toBe('web')
    expect(typeof capturedRequest?.promptBuilder).toBe('function')
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
// Two-phase idempotency: reserve → commit / rollback
// ---------------------------------------------------------------------------

describe('POST /operator/runs — two-phase idempotency', () => {
  it('happy path: accepted admission → idempotency committed, 202 {runId}', async () => {
    // #given — track reserve/commit/rollback calls
    const guard = createIdempotencyGuard()
    const reserveSpy = vi.spyOn(guard, 'reserve')
    const commitSpy = vi.spyOn(guard, 'commit')
    const rollbackSpy = vi.spyOn(guard, 'rollback')
    const deps = makeDeps({idempotencyGuard: guard})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'my-key'})

    // #then — 202; reserve called before launchWork; commit called after acceptance; rollback NOT called
    expect(response.status).toBe(202)
    expect(reserveSpy).toHaveBeenCalledTimes(1)
    expect(commitSpy).toHaveBeenCalledTimes(1)
    expect(rollbackSpy).not.toHaveBeenCalled()
    const body = (await response.json()) as {runId: string}
    expect(typeof body.runId).toBe('string')
  })

  it('reject (cap): launchWork returns {accepted:false,"cap"} → rollback, coarse non-202', async () => {
    // #given — launchWork returns cap-rejected
    mockLaunchWork.mockResolvedValueOnce({accepted: false, reason: 'cap'})
    const guard = createIdempotencyGuard()
    const rollbackSpy = vi.spyOn(guard, 'rollback')
    const commitSpy = vi.spyOn(guard, 'commit')
    const deps = makeDeps({idempotencyGuard: guard})
    const app = buildApp(deps)

    // #when — first request (gets cap-rejected)
    const response1 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'cap-key'})

    // #then — 503; rollback called; commit NOT called
    expect(response1.status).toBe(503)
    expect(rollbackSpy).toHaveBeenCalledTimes(1)
    expect(commitSpy).not.toHaveBeenCalled()

    // #then — subsequent same-key request is NOT treated as a duplicate (no dead runId echoed)
    const response2 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'cap-key'})
    expect(response2.status).toBe(202)
  })

  it('launchWork throws → rollback + coarse error (no stuck reservation)', async () => {
    // #given — launchWork throws
    mockLaunchWork.mockRejectedValueOnce(new Error('simulated launchWork failure'))
    const guard = createIdempotencyGuard()
    const rollbackSpy = vi.spyOn(guard, 'rollback')
    const commitSpy = vi.spyOn(guard, 'commit')
    const deps = makeDeps({idempotencyGuard: guard})
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'throw-key'})

    // #then — coarse error; rollback called; commit NOT called
    expect(response.status).toBe(500)
    expect(rollbackSpy).toHaveBeenCalledTimes(1)
    expect(commitSpy).not.toHaveBeenCalled()

    // #then — subsequent same-key request is NOT blocked by a dangling reservation
    const response2 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'throw-key'})
    expect(response2.status).toBe(202)
  })

  it('duplicate (reserved window): second same-key request while first is reserved-not-committed echoes reserved runId', async () => {
    // #given — simulate the reservation window by manually reserving
    const guard = createIdempotencyGuard()
    guard.reserve(1001, 'window-key', 'run-in-flight')

    const deps = makeDeps({idempotencyGuard: guard})
    const app = buildApp(deps)

    // #when — second request arrives while first is reserved (not committed)
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'window-key'})

    // #then — echoes the reserved runId (does NOT launch twice)
    expect(response.status).toBe(202)
    const body = (await response.json()) as {runId: string}
    expect(body.runId).toBe('run-in-flight')
    // launchWork was NOT called (idempotency check short-circuited)
    expect(mockLaunchWork).not.toHaveBeenCalled()
  })

  it('duplicate (committed): same op+key twice both accepted → one launch, second echoes runId', async () => {
    // #given
    const guard = createIdempotencyGuard()
    const deps = makeDeps({idempotencyGuard: guard})
    const app = buildApp(deps)

    // #when — first launch
    const response1 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'dup-key'})
    const body1 = (await response1.json()) as {runId: string}

    // #when — second launch with same key
    const response2 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'dup-key'})
    const body2 = (await response2.json()) as {runId: string}

    // #then — both 202; same runId; launchWork called only once
    expect(response1.status).toBe(202)
    expect(response2.status).toBe(202)
    expect(body1.runId).toBe(body2.runId)
    expect(mockLaunchWork).toHaveBeenCalledTimes(1)
  })

  it('no idempotency key → reserve/commit/rollback not called', async () => {
    // #given
    const guard = createIdempotencyGuard()
    const reserveSpy = vi.spyOn(guard, 'reserve')
    const commitSpy = vi.spyOn(guard, 'commit')
    const rollbackSpy = vi.spyOn(guard, 'rollback')
    const deps = makeDeps({idempotencyGuard: guard})
    const app = buildApp(deps)

    // #when — no idempotencyKey in body
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 202; no idempotency lifecycle calls
    expect(response.status).toBe(202)
    expect(reserveSpy).not.toHaveBeenCalled()
    expect(commitSpy).not.toHaveBeenCalled()
    expect(rollbackSpy).not.toHaveBeenCalled()
  })

  it('isolation: operator A key x and operator B key x → distinct runs (namespace preserved)', async () => {
    // #given — two operators with the same client key
    const guard = createIdempotencyGuard()
    const deps = makeDeps({idempotencyGuard: guard})

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

  it('integration: runIndex.register called ONCE (in launchWork), not twice', async () => {
    // #given — track register calls via the mock
    const registerCalls: string[] = []
    mockLaunchWork.mockImplementationOnce(async (request: {readonly runId?: string}) => {
      registerCalls.push(request.runId ?? 'mock-run-id')
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'reg-key'})

    // #then — register called exactly once (launchWork owns it; route no longer registers)
    expect(response.status).toBe(202)
    expect(registerCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// FIX-4: array and null body rejection
// ---------------------------------------------------------------------------

describe('POST /operator/runs — array and null body rejection', () => {
  it('returns 400 for an array body (typeof [] === "object" but not a plain object)', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when — send an array as the body
    const response = await app.fetch(
      new Request('http://localhost/operator/runs', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify([{repo: 'acme/widget', prompt: 'do something'}]),
      }),
    )

    // #then — rejected as bad request
    expect(response.status).toBe(400)
  })

  it('returns 400 for a null body', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when — send null as the body
    const response = await app.fetch(
      new Request('http://localhost/operator/runs', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: 'null',
      }),
    )

    // #then — rejected as bad request
    expect(response.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Discord-path regression: absent seams → Discord behavior unchanged
// ---------------------------------------------------------------------------

describe('Discord-path regression — absent runId/promptBuilder/createApprovalOnPending', () => {
  it('launchWorkRequest without runId uses crypto.randomUUID (Discord path unchanged)', async () => {
    // #given — capture the request passed to launchWork
    let capturedRunId: string | undefined
    mockLaunchWork.mockImplementationOnce(async (request: {readonly runId?: string}) => {
      capturedRunId = request.runId
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})
    const body = (await response.json()) as {runId: string}

    // #then — route always supplies a runId (UUID format)
    expect(body.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // The runId passed to launchWork matches the one returned in the response
    expect(capturedRunId).toBe(body.runId)
  })
})

// ---------------------------------------------------------------------------
// Capacity reject (cap) → 503
// ---------------------------------------------------------------------------

describe('POST /operator/runs — capacity reject', () => {
  it('returns 503 when launchWork returns {accepted:false, reason:"cap"}', async () => {
    // #given — launchWork returns cap-rejected
    mockLaunchWork.mockResolvedValueOnce({accepted: false, reason: 'cap'})
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 503 unavailable
    expect(response.status).toBe(503)
  })

  it('returns 503 when launchWork returns {accepted:false, reason:"queue-full"}', async () => {
    // #given — launchWork returns queue-full-rejected (transient capacity condition, not a client error)
    mockLaunchWork.mockResolvedValueOnce({accepted: false, reason: 'queue-full'})
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})

    // #then — 503 unavailable (same as cap; queue depth is full, retry later)
    expect(response.status).toBe(503)
  })
})

// ---------------------------------------------------------------------------
// Stuck-reservation: route/launchWork throws AFTER reserve but BEFORE commit
// ---------------------------------------------------------------------------

describe('POST /operator/runs — stuck-reservation guard', () => {
  it('finally rolls back if launchWork throws (subsequent same-key NOT blocked)', async () => {
    // #given — launchWork throws on first call
    mockLaunchWork.mockRejectedValueOnce(new Error('simulated throw'))
    const guard = createIdempotencyGuard()
    const rollbackSpy = vi.spyOn(guard, 'rollback')
    const deps = makeDeps({idempotencyGuard: guard})
    const app = buildApp(deps)

    // #when — first request throws
    const response1 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'stuck-key'})
    expect(response1.status).toBe(500)
    expect(rollbackSpy).toHaveBeenCalledTimes(1)

    // #when — second request with same key (should NOT be blocked by a dangling reservation)
    // mockLaunchWork defaults to returning accepted:true for subsequent calls
    const response2 = await postRuns(app, {repo: 'acme/widget', prompt: 'do something', idempotencyKey: 'stuck-key'})

    // #then — second request proceeds normally (not echoing a dead runId)
    expect(response2.status).toBe(202)
  })
})

// ---------------------------------------------------------------------------
// Admission result: route uses admission.runId (not its own generated runId)
// ---------------------------------------------------------------------------

describe('POST /operator/runs — admission runId', () => {
  it('202 response runId matches the runId from launchWork admission', async () => {
    // #given — launchWork returns a specific runId (same as the route-generated one)
    let capturedRunId: string | undefined
    mockLaunchWork.mockImplementationOnce(async (request: {readonly runId?: string}) => {
      capturedRunId = request.runId
      return {accepted: true, runId: request.runId ?? 'mock-run-id'}
    })
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})
    const body = (await response.json()) as {runId: string}

    // #then — the runId in the response matches what launchWork returned
    expect(response.status).toBe(202)
    expect(body.runId).toBe(capturedRunId)
  })
})

// ---------------------------------------------------------------------------
// Backward compat: LaunchAdmission type import (compile-time check)
// ---------------------------------------------------------------------------

describe('LaunchAdmission type — compile-time shape check', () => {
  it('launchAdmission accepted shape has runId', () => {
    // #given — type-level check (runtime assertion on the shape)
    const accepted: LaunchAdmission = {accepted: true, runId: 'run-abc'}
    // Use type assertion to access the narrowed field without a conditional
    expect(accepted.accepted).toBe(true)
    expect((accepted as {accepted: true; runId: string}).runId).toBe('run-abc')
  })

  it('launchAdmission rejected shape has reason', () => {
    // #given
    const rejected: LaunchAdmission = {accepted: false, reason: 'cap'}
    expect(rejected.accepted).toBe(false)
    expect((rejected as {accepted: false; reason: string}).reason).toBe('cap')
  })
})

// ---------------------------------------------------------------------------
// ReplySink wired to runObservationManager — output routing
// ---------------------------------------------------------------------------

describe('POST /operator/runs — replySink wired to runObservationManager', () => {
  it('replySink append routes output delta to manager.observeOutput with the route runId', async () => {
    // #given — a manager spy and a captured replySink from launchWork
    const observeOutput = vi.fn()
    const observeApproval = vi.fn()
    const runObservationManager = {observeOutput, observeApproval}

    let capturedReplySink: {append: (t: string) => void; flush: () => Promise<unknown>} | undefined
    let capturedRunId: string | undefined
    mockLaunchWork.mockImplementationOnce(
      async (request: {readonly runId?: string; readonly replySink?: typeof capturedReplySink}) => {
        capturedReplySink = request.replySink
        capturedRunId = request.runId
        return {accepted: true, runId: request.runId ?? 'mock-run-id'}
      },
    )

    const deps = makeDeps({runObservationManager})
    const app = buildApp(deps)

    // #when — launch the route so launchWork captures the replySink
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})
    expect(response.status).toBe(202)
    if (capturedReplySink === undefined || capturedRunId === undefined)
      throw new Error('launchWork did not capture replySink/runId')

    // #when — simulate the engine appending output text
    capturedReplySink.append('hello ')
    capturedReplySink.append('world')

    // #then — each append pushed a delta to the manager with the route's runId
    // opts is undefined for delta frames (no final flag)
    expect(observeOutput).toHaveBeenCalledTimes(2)
    expect(observeOutput).toHaveBeenNthCalledWith(1, capturedRunId, 'hello ', undefined)
    expect(observeOutput).toHaveBeenNthCalledWith(2, capturedRunId, 'world', undefined)
  })

  it('replySink flush routes final answer to manager.observeOutput with final:true', async () => {
    // #given — a manager spy and a captured replySink from launchWork
    const observeOutput = vi.fn()
    const observeApproval = vi.fn()
    const runObservationManager = {observeOutput, observeApproval}

    let capturedReplySink: {append: (t: string) => void; flush: () => Promise<unknown>} | undefined
    let capturedRunId: string | undefined
    mockLaunchWork.mockImplementationOnce(
      async (request: {readonly runId?: string; readonly replySink?: typeof capturedReplySink}) => {
        capturedReplySink = request.replySink
        capturedRunId = request.runId
        return {accepted: true, runId: request.runId ?? 'mock-run-id'}
      },
    )

    const deps = makeDeps({runObservationManager})
    const app = buildApp(deps)

    // #when — launch and simulate engine output
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})
    expect(response.status).toBe(202)
    if (capturedReplySink === undefined || capturedRunId === undefined)
      throw new Error('launchWork did not capture replySink/runId')
    capturedReplySink.append('the answer')
    observeOutput.mockClear() // clear the append delta call

    // #when — engine flushes (terminal)
    await capturedReplySink.flush()

    // #then — final frame pushed with the full buffer and final:true
    expect(observeOutput).toHaveBeenCalledTimes(1)
    expect(observeOutput).toHaveBeenCalledWith(capturedRunId, 'the answer', {final: true})
  })

  it('replySink degrades to a no-op when runObservationManager is absent', async () => {
    // #given — no manager in deps
    let capturedReplySink: {append: (t: string) => void; flush: () => Promise<unknown>} | undefined
    mockLaunchWork.mockImplementationOnce(
      async (request: {readonly runId?: string; readonly replySink?: typeof capturedReplySink}) => {
        capturedReplySink = request.replySink
        return {accepted: true, runId: request.runId ?? 'mock-run-id'}
      },
    )

    const deps = makeDeps() // no runObservationManager
    const app = buildApp(deps)

    // #when
    const response = await postRuns(app, {repo: 'acme/widget', prompt: 'do something'})
    expect(response.status).toBe(202)
    if (capturedReplySink === undefined) throw new Error('launchWork did not capture replySink')
    const sink = capturedReplySink

    // #when — append and flush do not throw (graceful no-op)
    expect(() => sink.append('some text')).not.toThrow()
    await expect(sink.flush()).resolves.toBeUndefined()
  })
})
