/** Tests for the authenticated workflow-dispatch route: POST /operator/dispatch. */

import type {RepoBinding} from '../../bindings/types.js'
import type {DispatchOutcome, DispatchWorkflow} from '../../github/dispatch.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {AuditLogger} from '../audit.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {DispatchRouteDeps} from './dispatch-route.js'
import type {LaunchRouteBindingsLookup, LaunchRouteSessionStore} from './launch-route.js'
import {Hono} from 'hono'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildDispatchRoute} from './dispatch-route.js'
import {createIdempotencyGuard} from './idempotency.js'

function makeBinding(overrides?: Partial<RepoBinding>): RepoBinding {
  return {
    owner: 'acme',
    repo: 'widget',
    channelId: 'channel-1',
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
    getOperatorToken: vi.fn(() => 'oauth-token'),
    get: vi.fn(() => ({githubUserId: 1001, login: 'alice'})),
    ...overrides,
  }
}

function makeBindingsLookup(binding: RepoBinding | null = makeBinding()): LaunchRouteBindingsLookup {
  return {
    getBindingByRepo: vi.fn(async () => ({success: true as const, data: binding})),
  }
}

function makeRepoAuthzDeps(overrides?: Partial<RepoAuthzDeps>): RepoAuthzDeps {
  return {
    allowlist: {isAuthorized: vi.fn(() => true), size: 1},
    fetch: vi.fn(async () => new Response('{"permission":"admin"}', {status: 200})),
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
      tokenIdentityFor: vi.fn(() => 'opaque-token-id'),
    },
    ...overrides,
  }
}

function makeAuditLogger(): AuditLogger {
  return {info: vi.fn(), warn: vi.fn()}
}

function makeDeps(overrides?: Partial<DispatchRouteDeps>): DispatchRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    bindingsLookup: makeBindingsLookup(),
    isRepoDenied: vi.fn((_key: RepoKey) => false),
    repoAuthzDeps: makeRepoAuthzDeps(),
    dispatchWorkflow: vi.fn(async () => ({outcome: 'accepted' as const, owner: 'acme', repo: 'widget'})),
    idempotencyGuard: createIdempotencyGuard(),
    auditLogger: makeAuditLogger(),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    perMinRateLimiter: {allow: () => true},
    perHrRateLimiter: {allow: () => true},
    ...overrides,
  }
}

function buildApp(deps: DispatchRouteDeps): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => ({ok: true as const, githubUserId: 1001, sessionId: 'session-1'}))
  buildDispatchRoute(app, deps)
  return app
}

function buildAppWithGuardResult(
  guardResult:
    | {readonly ok: true; readonly githubUserId: number; readonly sessionId: string}
    | {readonly ok: false; readonly response: Response},
  deps: DispatchRouteDeps,
): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => guardResult)
  buildDispatchRoute(app, deps)
  return app
}

async function postDispatch(app: Hono, body?: unknown): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/operator/dispatch', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('POST /operator/dispatch — accepted outcome and audit', () => {
  it('returns the complete accepted outcome and emits a discriminant-only audit event', async () => {
    // #given
    const outcome: DispatchOutcome = {
      outcome: 'accepted',
      owner: 'acme',
      repo: 'widget',
      runId: 123,
      runUrl: 'https://github.com/acme/widget/actions/runs/123',
    }
    const dispatchWorkflow: DispatchWorkflow = vi.fn(async () => outcome)
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({dispatchWorkflow, auditLogger})
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task: 'secret task'})

    // #then
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({outcome})
    expect(dispatchWorkflow).toHaveBeenCalledWith('acme', 'widget', 'secret task')
    expect(auditLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'dispatch.completed',
        githubUserId: 1001,
        repoFullName: 'acme/widget',
        outcome: 'accepted',
        runId: 123,
      }),
      'audit: dispatch.completed',
    )
    const auditContext = vi.mocked(auditLogger.info).mock.calls[0]?.[0]
    if (auditContext === undefined) throw new Error('dispatch audit event was not emitted')
    expect(auditContext.correlationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(auditContext.correlationId).not.toBe('session-1')
  })

  it('returns accepted without run details and omits runId from the audit event', async () => {
    // #given — GitHub accepted the dispatch but returned no workflow run details
    const outcome: DispatchOutcome = {outcome: 'accepted', owner: 'acme', repo: 'widget'}
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({dispatchWorkflow: vi.fn(async () => outcome), auditLogger})
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task: 'do work'})

    // #then — the no-run-details contract is a successful structured response
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({outcome})
    const auditContext = vi.mocked(auditLogger.info).mock.calls[0]?.[0]
    if (auditContext === undefined) throw new Error('dispatch audit event was not emitted')
    expect(auditContext).toMatchObject({kind: 'dispatch.completed', outcome: 'accepted'})
    expect(auditContext).not.toHaveProperty('runId')
  })
})

describe('POST /operator/dispatch — all structured outcomes', () => {
  const outcomes: readonly DispatchOutcome[] = [
    {outcome: 'accepted', owner: 'acme', repo: 'widget', runId: 1, runUrl: 'https://example.test/run/1'},
    {outcome: 'invalid-task'},
    {
      outcome: 'app-not-installed',
      owner: 'acme',
      repo: 'widget',
      installUrl: 'https://github.com/apps/fro-bot/install',
    },
    {outcome: 'missing-actions-permission', owner: 'acme', repo: 'widget', installUrl: 'https://example.test/install'},
    {
      outcome: 'missing-permissions',
      owner: 'acme',
      repo: 'widget',
      missingPermissions: ['actions:write'],
      installUrl: 'https://example.test/install',
    },
    {outcome: 'repo-not-found', owner: 'acme', repo: 'widget'},
    {outcome: 'workflow-not-found', owner: 'acme', repo: 'widget'},
    {outcome: 'dispatch-rejected', owner: 'acme', repo: 'widget'},
    {outcome: 'github-unavailable', owner: 'acme', repo: 'widget'},
  ]

  it.each(outcomes)('$outcome returns 200 with every outcome field preserved', async outcome => {
    // #given
    const dispatchWorkflow: DispatchWorkflow = vi.fn(async () => outcome)
    const deps = makeDeps({dispatchWorkflow})
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task: 'do work'})

    // #then
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({outcome})
  })
})

describe('POST /operator/dispatch — gate ordering and errors', () => {
  it('returns the guard response before touching route dependencies', async () => {
    // #given
    const sessionStore = makeSessionStore()
    const bindingsLookup = makeBindingsLookup()
    const dispatchWorkflow: DispatchWorkflow = vi.fn()
    const deps = makeDeps({sessionStore, bindingsLookup, dispatchWorkflow})
    const app = buildAppWithGuardResult(
      {ok: false, response: new Response(JSON.stringify({error: 'forbidden'}), {status: 403})},
      deps,
    )

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task: 'do work'})

    // #then
    expect(response.status).toBe(403)
    expect(sessionStore.getOperatorToken).not.toHaveBeenCalled()
    expect(bindingsLookup.getBindingByRepo).not.toHaveBeenCalled()
    expect(dispatchWorkflow).not.toHaveBeenCalled()
  })

  it('returns coarse 404 when there is no authenticated operator context', async () => {
    // #given — route helper is intentionally mounted without a guard
    const deps = makeDeps()
    const app = new Hono()
    buildDispatchRoute(app, deps)

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task: 'do work'})

    // #then
    expect(response.status).toBe(404)
  })

  it('returns 404 for a denylisted binding, without authz or dispatch', async () => {
    // #given
    const isRepoDenied = vi.fn(() => true)
    const repoAuthzDeps = makeRepoAuthzDeps()
    const dispatchWorkflow: DispatchWorkflow = vi.fn()
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({isRepoDenied, repoAuthzDeps, dispatchWorkflow, auditLogger})
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task: 'do work'})

    // #then — denylist is checked before the authz GitHub fetch and dispatcher
    expect(response.status).toBe(404)
    expect(isRepoDenied).toHaveBeenCalledOnce()
    expect(repoAuthzDeps.fetch).not.toHaveBeenCalled()
    expect(dispatchWorkflow).not.toHaveBeenCalled()
    expect(auditLogger.info).not.toHaveBeenCalled()
    expect(auditLogger.warn).not.toHaveBeenCalled()
    expect(vi.mocked(repoAuthzDeps.auditLogger.info)).not.toHaveBeenCalled()
    expect(vi.mocked(repoAuthzDeps.auditLogger.warn)).not.toHaveBeenCalled()
  })

  it('same operator and idempotency key twice dispatches only once and replays the outcome', async () => {
    // #given
    const dispatchWorkflow: DispatchWorkflow = vi.fn(async () => ({
      outcome: 'accepted' as const,
      owner: 'acme',
      repo: 'widget',
      runId: 456,
      runUrl: 'https://github.com/acme/widget/actions/runs/456',
    }))
    const deps = makeDeps({dispatchWorkflow})
    const app = buildApp(deps)

    // #when — retry the same network request with the same idempotency key
    const response1 = await postDispatch(app, {repo: 'acme/widget', task: 'do work', idempotencyKey: 'retry-key'})
    const response2 = await postDispatch(app, {repo: 'acme/widget', task: 'do work', idempotencyKey: 'retry-key'})

    // #then — one GitHub dispatch, with the same structured outcome replayed
    expect(response1.status).toBe(200)
    expect(response2.status).toBe(200)
    expect(await response2.json()).toEqual(await response1.clone().json())
    expect(dispatchWorkflow).toHaveBeenCalledOnce()
  })

  it('returns 404 when the session token is unavailable', async () => {
    // #given
    const sessionStore = makeSessionStore({getOperatorToken: vi.fn(() => undefined)})
    const deps = makeDeps({sessionStore})
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task: 'do work'})

    // #then
    expect(response.status).toBe(404)
  })

  it('returns 429 when the per-minute operator limit is exceeded', async () => {
    // #given
    const sessionStore = makeSessionStore()
    const deps = makeDeps({sessionStore, perMinRateLimiter: {allow: () => false}})
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task: 'do work'})

    // #then
    expect(response.status).toBe(429)
    expect(sessionStore.getOperatorToken).not.toHaveBeenCalled()
  })
})

describe('POST /operator/dispatch — malformed bodies', () => {
  it.each([null, [], {task: 'do work'}, {repo: 'acme/widget', task: ''}])('returns 400 for %j', async body => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, body)

    // #then
    expect(response.status).toBe(400)
  })

  it('returns 400 for a malformed repo name', async () => {
    // #given
    const deps = makeDeps()
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, {repo: 'not-a-repo', task: 'do work'})

    // #then
    expect(response.status).toBe(400)
  })
})

describe('POST /operator/dispatch — security projections', () => {
  it('does not echo task text in the response or audit record', async () => {
    // #given
    const task = 'PROMPT_CONTENT secret operator task'
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger})
    const app = buildApp(deps)

    // #when
    const response = await postDispatch(app, {repo: 'acme/widget', task})
    const responseText = await response.text()
    const auditText = JSON.stringify(vi.mocked(auditLogger.info).mock.calls)

    // #then — task text and install URL are absent from the audit projection
    expect(responseText).not.toContain(task)
    expect(auditText).not.toContain(task)
    expect(auditText).not.toContain('installUrl')
    expect(auditText).not.toContain('PROMPT_CONTENT')
  })
})
