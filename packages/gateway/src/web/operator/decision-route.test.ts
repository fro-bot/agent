/**
 * Tests for the authenticated decision route:
 * POST /operator/runs/:runId/approvals/:requestId/decision
 *
 * All tests go through the REAL HTTP route (with auth guard, denylist, middleware)
 * — not a registry-only call. This is the documented bootstrap-wiring failure mode.
 *
 * Load-bearing tests:
 *   1. REPO-ACCESS GATE: a bound, non-denylisted repo settles; unbound / unavailable / malformed is denied.
 *   2. SCOPE BINDING: handleDecision is called with approvalScopeId == run.run_id (server-side).
 *   3. NO-ORACLE DENIAL: every gate failure returns the identical notFoundResponse shape.
 *   4. IDEMPOTENCY: already-settled requestID → no second settlement.
 *   5. CROSS-SCOPE: requestID from a different run → channel-mismatch, no side effects.
 */

import type {ApprovalRegistry, DecisionOutcome} from '../../approvals/registry.js'
import type {RunLocation} from '../../execute/run-index.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {AuditLogger} from '../audit.js'
import type {DecisionRouteDeps} from './decision-route.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildDecisionRoute} from './decision-route.js'

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeSessionStore(overrides?: Partial<DecisionRouteDeps['sessionStore']>): DecisionRouteDeps['sessionStore'] {
  return {
    get: vi.fn((_sessionId: string, _nowMs: number) => ({
      githubUserId: 1001,
      login: 'alice',
      issuedAt: 0,
      lastAccessedAt: 0,
      revoked: false,
    })),
    ...overrides,
  }
}

function makeRunIndex(location?: RunLocation): DecisionRouteDeps['runIndex'] {
  return {
    lookup: vi.fn(async (_runId: string) => location ?? {repo: 'acme/widget', surface: 'web' as const}),
  }
}

function makeDenylistCache(denied = false): DecisionRouteDeps['denylistCache'] {
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

function makeRegistry(outcome: DecisionOutcome = 'ok'): Pick<ApprovalRegistry, 'handleDecision'> {
  return {
    handleDecision: vi.fn(async () => outcome),
  }
}

function makeAuditLogger(): AuditLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  }
}

function makeDeps(overrides?: Partial<DecisionRouteDeps>): DecisionRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    runIndex: makeRunIndex(),
    denylistCache: makeDenylistCache(),
    bindingsLookup: makeBindingsLookup(),
    registry: makeRegistry(),
    auditLogger: makeAuditLogger(),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// App builder helpers
// ---------------------------------------------------------------------------

function buildApp(deps: DecisionRouteDeps, guardUserId = 1001, guardSessionId = 'sess-abc'): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async (_c, _method, _path) => ({
    ok: true as const,
    githubUserId: guardUserId,
    sessionId: guardSessionId,
  }))
  buildDecisionRoute(app, deps)
  return app
}

function buildAppWithGuardResult(
  guardResult: {ok: true; githubUserId: number; sessionId: string} | {ok: false; response: Response},
  deps: DecisionRouteDeps,
): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => guardResult)
  buildDecisionRoute(app, deps)
  return app
}

async function postDecision(
  app: Hono,
  runId: string,
  requestId: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/operator/runs/${runId}/approvals/${requestId}/decision`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: body === undefined ? JSON.stringify({decision: 'once'}) : JSON.stringify(body),
    }),
  )
}

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 1: REPO-ACCESS GATE (bindings-only; no GitHub call)
// ---------------------------------------------------------------------------

describe('POST decision — REPO-ACCESS GATE (load-bearing)', () => {
  it('bound, non-denylisted repo → 200 with state:claimed; no token accessor in the session deps', async () => {
    const deps = makeDeps({registry: makeRegistry('ok')})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {state: string}
    expect(body.state).toBe('claimed')
    expect(Object.keys(deps.sessionStore)).toEqual(['get'])
  })

  it('reads the binding exactly once for the settlement', async () => {
    const bindingsLookup = makeBindingsLookup()
    const deps = makeDeps({bindingsLookup})

    await postDecision(buildApp(deps), 'run-abc', 'req-123')

    expect(bindingsLookup.getBindingByRepo).toHaveBeenCalledTimes(1)
    expect(bindingsLookup.getBindingByRepo).toHaveBeenCalledWith('acme', 'widget')
  })

  it('unbound repo → 404 no-oracle denial, NO settlement', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({bindingsLookup: makeBindingsLookup({success: true, data: null}), registry})

    const response = await postDecision(buildApp(deps), 'run-abc', 'req-123')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: 'not-found'})
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })

  it('binding store error or throw → 404 no-oracle denial, NO settlement', async () => {
    const registry = makeRegistry('ok')
    const failing = makeDeps({
      bindingsLookup: makeBindingsLookup({success: false, error: new Error('s3 down')}),
      registry,
    })
    const throwing = makeDeps({
      bindingsLookup: {
        getBindingByRepo: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
      registry,
    })

    for (const deps of [failing, throwing]) {
      const response = await postDecision(buildApp(deps), 'run-abc', 'req-123')
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({error: 'not-found'})
    }
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })

  it('malformed owner/repo from the run index → 404 with zero binding reads', async () => {
    const registry = makeRegistry('ok')
    const bindingsLookup = makeBindingsLookup()
    const deps = makeDeps({runIndex: makeRunIndex({repo: 'acme/a b', surface: 'web'}), bindingsLookup, registry})

    const response = await postDecision(buildApp(deps), 'run-abc', 'req-123')

    expect(response.status).toBe(404)
    expect(bindingsLookup.getBindingByRepo).not.toHaveBeenCalled()
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })

  it('every repo-level denial is byte-identical to a runIndex miss', async () => {
    const miss = await postDecision(
      buildApp(makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})),
      'run-abc',
      'r',
    )
    const missText = await miss.text()
    const variants = [
      makeDeps({denylistCache: makeDenylistCache(true)}),
      makeDeps({bindingsLookup: makeBindingsLookup({success: true, data: null})}),
      makeDeps({bindingsLookup: makeBindingsLookup({success: false, error: new Error('s3 down')})}),
      makeDeps({runIndex: makeRunIndex({repo: 'acme/..', surface: 'web'})}),
    ]

    for (const deps of variants) {
      const response = await postDecision(buildApp(deps), 'run-abc', 'r')
      expect(response.status).toBe(miss.status)
      expect(await response.text()).toBe(missText)
    }
  })

  it('repo-level denial emits no audit event; logs share one label and carry no owner/repo/runId', async () => {
    const auditLogger = makeAuditLogger()
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const denied = makeDeps({auditLogger, logger, denylistCache: makeDenylistCache(true)})
    const unbound = makeDeps({auditLogger, logger, bindingsLookup: makeBindingsLookup({success: true, data: null})})

    await postDecision(buildApp(denied), 'run-abc', 'req-123')
    await postDecision(buildApp(unbound), 'run-abc', 'req-123')

    expect(auditLogger.info).not.toHaveBeenCalled()
    expect(auditLogger.warn).not.toHaveBeenCalled()
    expect(logger.warn.mock.calls.map(call => call[0] as unknown)).toEqual([
      {githubUserId: 1001, gate: 'repo-denied'},
      {githubUserId: 1001, gate: 'repo-denied'},
    ])
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 2: SCOPE BINDING
// ---------------------------------------------------------------------------

describe('POST decision — SCOPE BINDING (load-bearing)', () => {
  it('handleDecision is called with approvalScopeId == run.run_id (server-side, not client)', async () => {
    const registry = makeRegistry('ok')
    const runIndex = makeRunIndex({repo: 'acme/widget', surface: 'web' as const})
    const deps = makeDeps({registry, runIndex})
    const app = buildApp(deps)

    await postDecision(app, 'run-server-id', 'req-123')

    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalScopeId: 'run-server-id',
        requestID: 'req-123',
      }),
    )
  })

  it('handleDecision is called with the typed WebOperatorActor (R9)', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps, 1001, 'sess-abc')

    await postDecision(app, 'run-abc', 'req-123')

    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: {
          kind: 'web-operator',
          githubUserId: 1001,
          login: 'alice',
          sessionCorrelationId: 'sess-abc',
        },
      }),
    )
  })

  it('once decision is passed through to handleDecision', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    await postDecision(app, 'run-abc', 'req-123', {decision: 'once'})

    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledWith(expect.objectContaining({decision: 'once'}))
  })

  it('always decision is passed through to handleDecision (R12)', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    await postDecision(app, 'run-abc', 'req-123', {decision: 'always'})

    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledWith(expect.objectContaining({decision: 'always'}))
  })

  it('reject decision is passed through to handleDecision', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    await postDecision(app, 'run-abc', 'req-123', {decision: 'reject'})

    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledWith(expect.objectContaining({decision: 'reject'}))
  })

  it('always settles and audits distinctly from once (R12)', async () => {
    const auditLogger = makeAuditLogger()
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry, auditLogger})
    const app = buildApp(deps)

    await postDecision(app, 'run-abc', 'req-123', {decision: 'always'})

    const auditInfoCalls = vi.mocked(auditLogger.info).mock.calls
    const decisionAudit = auditInfoCalls.find(
      ([ctx]) => typeof ctx === 'object' && ctx !== null && ctx.kind === 'approval.decision',
    )
    expect(decisionAudit).toBeDefined()
    const auditCtx = decisionAudit?.[0] as Record<string, unknown>
    expect(auditCtx.decision).toBe('always')
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 3: NO-ORACLE DENIAL
// ---------------------------------------------------------------------------

describe('POST decision — NO-ORACLE DENIAL (load-bearing)', () => {
  it('runIndex miss → 404 not-found (no oracle)', async () => {
    const deps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})
    const app = buildApp(deps)

    const response = await postDecision(app, 'unknown-run', 'req-123')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('denylisted repo → 404 not-found with no settlement', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({denylistCache: makeDenylistCache(true), registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })

  it('denylisted repo denial is indistinguishable from runIndex miss (same shape)', async () => {
    const denylistDeps = makeDeps({denylistCache: makeDenylistCache(true)})
    const missDeps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})

    const denylistApp = buildApp(denylistDeps)
    const missApp = buildApp(missDeps)

    const denylistResponse = await postDecision(denylistApp, 'run-abc', 'req-123')
    const missResponse = await postDecision(missApp, 'run-abc', 'req-123')

    expect(denylistResponse.status).toBe(missResponse.status)
    const denylistBody = (await denylistResponse.json()) as {error: string}
    const missBody = (await missResponse.json()) as {error: string}
    expect(denylistBody.error).toBe(missBody.error)
  })

  it('guard failure → 404 not-found (guard-rejected response)', async () => {
    const deps = makeDeps()
    const app = buildAppWithGuardResult(
      {ok: false, response: new Response(JSON.stringify({error: 'not-found'}), {status: 404})},
      deps,
    )

    const response = await postDecision(app, 'run-abc', 'req-123')

    expect(response.status).toBe(404)
  })

  it('gate throw (runIndex throws) → 404 not-found, not a 500', async () => {
    const throwingRunIndex = {
      lookup: vi.fn(async () => {
        throw new Error('unexpected runIndex failure')
      }),
    }
    const deps = makeDeps({runIndex: throwingRunIndex})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('gate throw (denylist throws) → 404 not-found, not a 500', async () => {
    const deps = makeDeps({
      denylistCache: {
        getDenylistState: vi.fn(async () => {
          throw new Error('denylist unavailable')
        }),
        isRepoDenied: vi.fn(() => false),
      },
    })
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123')

    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 4: IDEMPOTENCY (R11)
// ---------------------------------------------------------------------------

describe('POST decision — IDEMPOTENCY (R11, load-bearing)', () => {
  it('already-settled requestID → already_claimed state, no second settlement', async () => {
    const registry = makeRegistry('already-claimed')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-already-settled')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {state: string}
    expect(body.state).toBe('already_claimed')
    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledTimes(1)
  })

  it('not-found requestID → unavailable state (already settled/deleted)', async () => {
    const registry = makeRegistry('not-found')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-gone')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {state: string}
    expect(body.state).toBe('unavailable')
  })
})

// ---------------------------------------------------------------------------
// LOAD-BEARING TEST 5: CROSS-SCOPE (R10)
// ---------------------------------------------------------------------------

describe('POST decision — CROSS-SCOPE (R10, load-bearing)', () => {
  it('requestID from a different run → channel-mismatch → scope_mismatch, no side effects', async () => {
    const registry = makeRegistry('channel-mismatch')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-from-other-run')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {state: string}
    expect(body.state).toBe('scope_mismatch')
    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledTimes(1)
  })

  it('reply-failed outcome → failed_to_settle state', async () => {
    const registry = makeRegistry('reply-failed')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {state: string}
    expect(body.state).toBe('failed_to_settle')
  })
})

// ---------------------------------------------------------------------------
// Decision validation
// ---------------------------------------------------------------------------

describe('POST decision — decision validation', () => {
  it('invalid decision value → 400 bad request (does not leak requestId existence)', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123', {decision: 'approve'})

    expect(response.status).toBe(400)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('bad request')
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })

  it('missing decision field → 400 bad request', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123', {})

    expect(response.status).toBe(400)
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })

  it('numeric decision value → 400 bad request', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123', {decision: 1})

    expect(response.status).toBe(400)
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })

  it('invalid JSON body → 400 bad request', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    const response = await app.fetch(
      new Request('http://localhost/operator/runs/run-abc/approvals/req-123/decision', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: 'not-json',
      }),
    )

    expect(response.status).toBe(400)
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Oracle test 5: post-authz gate throw → uniform notFoundResponse (not 500)
// ---------------------------------------------------------------------------

describe('POST decision — post-authz gate throw (Oracle test 5)', () => {
  it('handleDecision throwing → 404 not-found, not a 500 (gates 8-11 try/catch)', async () => {
    // #given — handleDecision throws unexpectedly (simulates a bug in gates 8-11)
    const throwingRegistry = makeRegistry('ok')
    vi.mocked(throwingRegistry.handleDecision).mockRejectedValue(new Error('unexpected registry failure'))
    const deps = makeDeps({registry: throwingRegistry})
    const app = buildApp(deps)

    // #when
    const response = await postDecision(app, 'run-abc', 'req-123')

    // #then — 404 not-found (no-oracle), NOT a 500
    expect(response.status).toBe(404)
    const body = (await response.json()) as {error: string}
    expect(body.error).toBe('not-found')
  })

  it('post-authz throw is indistinguishable from a runIndex miss (same shape)', async () => {
    // #given — handleDecision throws (post-authz) vs runIndex miss (pre-authz)
    const throwingRegistry = makeRegistry('ok')
    vi.mocked(throwingRegistry.handleDecision).mockRejectedValue(new Error('unexpected registry failure'))
    const postAuthzDeps = makeDeps({registry: throwingRegistry})
    const missDeps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})

    const postAuthzApp = buildApp(postAuthzDeps)
    const missApp = buildApp(missDeps)

    const postAuthzResponse = await postDecision(postAuthzApp, 'run-abc', 'req-123')
    const missResponse = await postDecision(missApp, 'run-abc', 'req-123')

    // #then — both return the same status and body (no oracle)
    expect(postAuthzResponse.status).toBe(missResponse.status)
    const postAuthzBody = (await postAuthzResponse.json()) as {error: string}
    const missBody = (await missResponse.json()) as {error: string}
    expect(postAuthzBody.error).toBe(missBody.error)
  })
})

// ---------------------------------------------------------------------------
// Byte-identical denial assertions (testing reviewer finding)
// ---------------------------------------------------------------------------

describe('POST decision — byte-identical denial assertions', () => {
  it('guard failure denial is byte-identical to runIndex miss denial', async () => {
    const guardFailDeps = makeDeps()
    const missDeps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})

    const guardFailApp = buildAppWithGuardResult(
      {ok: false, response: new Response(JSON.stringify({error: 'not-found'}), {status: 404})},
      guardFailDeps,
    )
    const missApp = buildApp(missDeps)

    const guardFailResponse = await postDecision(guardFailApp, 'run-abc', 'req-123')
    const missResponse = await postDecision(missApp, 'run-abc', 'req-123')

    expect(guardFailResponse.status).toBe(missResponse.status)
    const guardFailText = await guardFailResponse.text()
    const missText = await missResponse.text()
    expect(guardFailText).toBe(missText)
  })

  it('missing session denial is byte-identical to runIndex miss denial', async () => {
    const noSessionDeps = makeDeps({sessionStore: makeSessionStore({get: vi.fn(() => undefined)})})
    const missDeps = makeDeps({runIndex: {lookup: vi.fn(async () => undefined)}})

    const noSessionResponse = await postDecision(buildApp(noSessionDeps), 'run-abc', 'req-123')
    const missResponse = await postDecision(buildApp(missDeps), 'run-abc', 'req-123')

    expect(noSessionResponse.status).toBe(missResponse.status)
    expect(await noSessionResponse.text()).toBe(await missResponse.text())
  })
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('POST decision — audit', () => {
  it('emits approval.decision audit event on successful settlement', async () => {
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger, registry: makeRegistry('ok')})
    const app = buildApp(deps)

    await postDecision(app, 'run-abc', 'req-123', {decision: 'once'})

    const auditInfoCalls = vi.mocked(auditLogger.info).mock.calls
    const decisionAudit = auditInfoCalls.find(
      ([ctx]) => typeof ctx === 'object' && ctx !== null && ctx.kind === 'approval.decision',
    )
    expect(decisionAudit).toBeDefined()
    const auditCtx = decisionAudit?.[0] as Record<string, unknown>
    expect(auditCtx.decision).toBe('once')
    expect(auditCtx.githubUserId).toBe(1001)
  })

  it('emits approval.rejected (not approval.decision) for non-ok outcomes (already-claimed)', async () => {
    // FIX 4: non-ok outcomes emit approval.rejected with the mapped reason,
    // not approval.decision. This preserves the rejection cause in the audit log.
    // Note: already_claimed is a benign reason → logs at INFO (not WARN) per FIX A.
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger, registry: makeRegistry('already-claimed')})
    const app = buildApp(deps)

    await postDecision(app, 'run-abc', 'req-123', {decision: 'always'})

    // approval.decision must NOT be emitted for non-ok outcomes
    const auditInfoCalls = vi.mocked(auditLogger.info).mock.calls
    const decisionAudit = auditInfoCalls.find(
      ([ctx]) => typeof ctx === 'object' && ctx !== null && ctx.kind === 'approval.decision',
    )
    expect(decisionAudit).toBeUndefined()

    // approval.rejected IS emitted with the mapped reason — at INFO (benign reason)
    const rejectedAudit = auditInfoCalls.find(
      ([ctx]) => typeof ctx === 'object' && ctx !== null && ctx.kind === 'approval.rejected',
    )
    expect(rejectedAudit).toBeDefined()
    const rejectedCtx = rejectedAudit?.[0] as Record<string, unknown>
    expect(rejectedCtx.reason).toBe('already_claimed')
  })

  it('always decision with outcome ok records decision:"always" in approval.decision audit (FIX C)', async () => {
    // #given — 'always' is the higher-blast-radius grant; must be audited distinctly from 'once'/'reject'
    const auditLogger = makeAuditLogger()
    const registry = makeRegistry('ok')
    const deps = makeDeps({auditLogger, registry})
    const app = buildApp(deps)

    // #when
    await postDecision(app, 'run-abc', 'req-always-fidelity', {decision: 'always'})

    // #then — approval.decision emitted with decision:'always', not 'once' or 'reject'
    const auditInfoCalls = vi.mocked(auditLogger.info).mock.calls
    const decisionAudit = auditInfoCalls.find(
      ([ctx]) => typeof ctx === 'object' && ctx !== null && ctx.kind === 'approval.decision',
    )
    expect(decisionAudit).toBeDefined()
    const auditCtx = decisionAudit?.[0] as Record<string, unknown>
    expect(auditCtx.decision).toBe('always')
    expect(auditCtx.decision).not.toBe('once')
    expect(auditCtx.decision).not.toBe('reject')
  })

  it('maps each DecisionOutcome to the correct ApprovalRejectedReason (FIX 4 taxonomy)', async () => {
    // Verify the full mapping: DecisionOutcome → ApprovalRejectedReason.
    // Per FIX A, benign reasons (already_claimed, not_found) log at INFO;
    // anomalous reasons (scope_mismatch, unknown) log at WARN.
    const cases: {outcome: DecisionOutcome; expectedReason: string; expectedLevel: 'info' | 'warn'}[] = [
      {outcome: 'already-claimed', expectedReason: 'already_claimed', expectedLevel: 'info'},
      {outcome: 'not-found', expectedReason: 'not_found', expectedLevel: 'info'},
      {outcome: 'channel-mismatch', expectedReason: 'scope_mismatch', expectedLevel: 'warn'},
      {outcome: 'reply-failed', expectedReason: 'unknown', expectedLevel: 'warn'},
    ]

    for (const {outcome, expectedReason, expectedLevel} of cases) {
      const auditLogger = makeAuditLogger()
      const deps = makeDeps({auditLogger, registry: makeRegistry(outcome)})
      const app = buildApp(deps)

      await postDecision(app, 'run-abc', `req-${outcome}`, {decision: 'once'})

      const calls = vi.mocked(auditLogger[expectedLevel]).mock.calls
      const rejectedAudit = calls.find(
        ([ctx]) => typeof ctx === 'object' && ctx !== null && ctx.kind === 'approval.rejected',
      )
      expect(rejectedAudit).toBeDefined()
      const rejectedCtx = rejectedAudit?.[0] as Record<string, unknown>
      expect(rejectedCtx.reason).toBe(expectedReason)
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: real route wiring (not registry-only)
// ---------------------------------------------------------------------------

describe('POST decision — integration (real route wiring)', () => {
  it('dispatches through the real repo-access gate (not registry-only)', async () => {
    const bindingsLookup = makeBindingsLookup()
    const denylistCache = makeDenylistCache()
    const registry = makeRegistry('ok')
    const deps = makeDeps({bindingsLookup, denylistCache, registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123')

    expect(response.status).toBe(200)
    // The binding was read and the denylist primed and consulted with the binding's keys.
    expect(bindingsLookup.getBindingByRepo).toHaveBeenCalledWith('acme', 'widget')
    expect(denylistCache.getDenylistState).toHaveBeenCalledTimes(1)
    expect(denylistCache.isRepoDenied).toHaveBeenCalledWith({databaseId: 42, nodeId: 'R_node_42'})
    // Verify handleDecision was called with the correct scope
    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalScopeId: 'run-abc',
        requestID: 'req-123',
        decision: 'once',
      }),
    )
  })

  it('a denied repo never reaches the registry', async () => {
    const registry = makeRegistry('ok')
    const deps = makeDeps({denylistCache: makeDenylistCache(true), registry})
    const app = buildApp(deps)

    const response = await postDecision(app, 'run-abc', 'req-123')

    expect(response.status).toBe(404)
    expect(vi.mocked(registry.handleDecision)).not.toHaveBeenCalled()
  })

  it('handleDecision is the ONLY settlement path (no direct registry bypass)', async () => {
    // Verify that the route calls handleDecision exactly once per request
    const registry = makeRegistry('ok')
    const deps = makeDeps({registry})
    const app = buildApp(deps)

    await postDecision(app, 'run-abc', 'req-123')

    expect(vi.mocked(registry.handleDecision)).toHaveBeenCalledTimes(1)
  })

  it('all five DecisionOutcome variants map to distinct OperatorDecisionState values', async () => {
    const outcomes: DecisionOutcome[] = ['ok', 'channel-mismatch', 'already-claimed', 'reply-failed', 'not-found']
    const expectedStates = ['claimed', 'scope_mismatch', 'already_claimed', 'failed_to_settle', 'unavailable']

    for (const [i, outcome] of outcomes.entries()) {
      const expectedState = expectedStates[i]
      const registry = makeRegistry(outcome)
      const deps = makeDeps({registry})
      const app = buildApp(deps)

      const response = await postDecision(app, 'run-abc', `req-${i}`)

      expect(response.status).toBe(200)
      const body = (await response.json()) as {state: string}
      expect(body.state).toBe(expectedState)
    }
  })
})
