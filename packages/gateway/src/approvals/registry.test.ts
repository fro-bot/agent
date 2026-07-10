/**
 * Tests for the program-scoped approval registry bridge.
 *
 * Convention: `vi.fn()` for all injected side-effects. No real Discord.js or
 * SDK imports here — pure unit tests. BDD `// #given/#when/#then` per repo convention.
 *
 * ### Core scenarios
 *
 * 1. register / has / pending — basic lifecycle
 * 2. handleDecision — unknown id (not-found)
 * 3. handleDecision — scope mismatch
 * 4. handleDecision — happy path (open→claimed→confirmed)
 * 5. handleDecision — claimed blocks second decision while in-flight (single-winner)
 * 6. handleDecision — reply-failed resets to open, retry works
 * 7. applySettlement — replied path (renderFn called; no second postReply)
 * 8. applySettlement — deadline/cascade path on open entry
 * 9. disposeRun — only settles entries for the matching sessionID
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'
import type {
  ApprovalActor,
  ApprovalSideEffects,
  DecisionOutcome,
  PendingApprovalDTO,
  RegisterParams,
  RenderFn,
} from './registry.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createApprovalRegistry} from './registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestID: 'per_1',
    sessionID: 'ses_1',
    permission: 'external_directory',
    patterns: ['/tmp/x/*'],
    title: 'Access outside workspace',
    ...overrides,
  }
}

function makeEffects(overrides: Partial<ApprovalSideEffects> = {}): ApprovalSideEffects {
  return {
    postReply: vi.fn().mockResolvedValue({ok: true}),
    ...overrides,
  }
}

function makeRenderFn(): RenderFn {
  return vi.fn().mockResolvedValue(undefined)
}

function makeActor(overrides: Partial<ApprovalActor> = {}): ApprovalActor {
  return {kind: 'discord-user', userId: 'user_A', ...overrides} as ApprovalActor
}

function makeParams(overrides: Partial<RegisterParams> = {}): RegisterParams {
  const request = overrides.request ?? makeRequest()
  return {
    requestID: request.requestID,
    sessionID: request.sessionID,
    approvalScopeId: 'chan_1',
    directory: '/workspace/proj',
    request,
    effects: makeEffects(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: register / has / pending — basic lifecycle
// ---------------------------------------------------------------------------

describe('register / has / pending', () => {
  it('registers an entry and reports it via has() and pending()', () => {
    // #given a fresh registry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const params = makeParams()

    // #when registered
    registry.register(params)

    // #then has() and pending() reflect the new entry
    expect(registry.has('per_1')).toBe(true)
    expect(registry.pending()).toContain('per_1')
  })

  it('has() returns false for unknown id', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    expect(registry.has('unknown')).toBe(false)
  })

  it('pending() returns empty array when nothing registered', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    expect(registry.pending()).toEqual([])
  })

  it('re-registering an existing id overwrites (re-ask scenario)', () => {
    // #given an entry is already registered
    const logger = makeLogger()
    const registry = createApprovalRegistry({logger})
    registry.register(makeParams())

    // #when re-registered with updated effects
    const newEffects = makeEffects()
    registry.register(makeParams({effects: newEffects}))

    // #then still one entry; warn was called; new effects are active
    expect(registry.pending()).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: handleDecision — unknown id
// ---------------------------------------------------------------------------

describe('handleDecision — unknown id', () => {
  it("returns 'not-found' and does NOT call postReply", async () => {
    // #given an empty registry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({effects}))

    // #when a decision arrives for an unknown requestID
    const outcome = await registry.handleDecision({
      requestID: 'per_UNKNOWN',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: makeActor(),
    })

    // #then not-found; no side effects
    expect(outcome).toBe<DecisionOutcome>('not-found')
    expect(effects.postReply).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: handleDecision — scope mismatch
// ---------------------------------------------------------------------------

describe('handleDecision — scope mismatch', () => {
  it("returns 'channel-mismatch' and does NOT call postReply", async () => {
    // #given a registry entry bound to chan_1
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({approvalScopeId: 'chan_1', effects}))

    // #when a decision arrives from a different scope
    const outcome = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_WRONG',
      decision: 'once',
      actor: makeActor(),
    })

    // #then channel-mismatch; no reply sent
    expect(outcome).toBe<DecisionOutcome>('channel-mismatch')
    expect(effects.postReply).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: handleDecision — happy path (open→claimed→confirmed)
// ---------------------------------------------------------------------------

describe('handleDecision — happy path', () => {
  it("returns 'ok', calls postReply once, state transitions to confirmed", async () => {
    // #given a registered entry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({approvalScopeId: 'chan_1', directory: '/workspace/proj', effects}))

    // #when a decision arrives with a valid scope
    const outcome = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: {kind: 'discord-user', userId: 'user_A'},
    })

    // #then ok; postReply called once with correct args; entry still exists (not yet settled)
    expect(outcome).toBe<DecisionOutcome>('ok')
    expect(effects.postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'once')
    expect(registry.has('per_1')).toBe(true)
  })

  it('confirmed entry does not call postReply on applySettlement(replied)', async () => {
    // #given a confirmed entry (decision submitted → postReply succeeded)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const renderFn = makeRenderFn()
    registry.register(makeParams({effects}))
    registry.attachMessage('per_1', renderFn)
    await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: makeActor(),
    })

    // #when settled with reason 'replied'
    await registry.applySettlement({requestID: 'per_1', decision: 'once', reason: 'replied'})

    // #then postReply still called only once (no second attempt)
    expect(effects.postReply).toHaveBeenCalledOnce()
    // renderFn was called (message was attached)
    expect(renderFn).toHaveBeenCalledOnce()
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: handleDecision — claimed blocks second decision (single-winner)
// ---------------------------------------------------------------------------

describe('handleDecision — already-claimed (single-winner)', () => {
  it("returns 'already-claimed' on second decision; postReply called only ONCE total", async () => {
    // #given first decision already submitted
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({effects}))
    await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: {kind: 'discord-user', userId: 'user_A'},
    })

    // #when a second decision arrives
    const outcome = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'always',
      actor: {kind: 'discord-user', userId: 'user_B'},
    })

    // #then already-claimed; no second postReply
    expect(outcome).toBe<DecisionOutcome>('already-claimed')
    expect(effects.postReply).toHaveBeenCalledOnce()
  })

  it("'claimed' state (postReply in-flight) blocks concurrent second decision", async () => {
    // #given postReply is slow (controllable via deferred promise)
    const registry = createApprovalRegistry({logger: makeLogger()})
    let resolveReply!: (v: {ok: boolean}) => void
    const replyPromise = new Promise<{ok: boolean}>(res => {
      resolveReply = res
    })
    const effects = makeEffects({postReply: vi.fn().mockReturnValue(replyPromise)})
    registry.register(makeParams({effects}))

    // Start first decision (in-flight, not yet resolved)
    const firstClickPromise = registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: {kind: 'discord-user', userId: 'user_A'},
    })

    // Second decision while first is in-flight
    const secondOutcome = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: {kind: 'discord-user', userId: 'user_B'},
    })

    // #then second decision is blocked immediately (claimed)
    expect(secondOutcome).toBe<DecisionOutcome>('already-claimed')

    // Resolve the in-flight reply
    resolveReply({ok: true})
    const firstOutcome = await firstClickPromise
    expect(firstOutcome).toBe<DecisionOutcome>('ok')
    expect(effects.postReply).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: handleDecision — reply-failed resets to open, retry works
// ---------------------------------------------------------------------------

describe('handleDecision — reply-failed', () => {
  it("returns 'reply-failed' and resets to open so a subsequent decision can retry", async () => {
    // #given postReply fails on first call, succeeds on retry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const postReply = vi.fn().mockResolvedValueOnce({ok: false, error: 'timeout'}).mockResolvedValueOnce({ok: true})
    const effects = makeEffects({postReply})
    registry.register(makeParams({effects}))

    // #when first decision fails
    const first = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: makeActor(),
    })

    // #then reply-failed; state reset to open
    expect(first).toBe<DecisionOutcome>('reply-failed')

    // #when retry decision
    const retry = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: makeActor(),
    })

    // #then retry succeeds; postReply called twice total
    expect(retry).toBe<DecisionOutcome>('ok')
    expect(postReply).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Scenario 7: applySettlement — 'replied' path (renderFn called; no second postReply)
// ---------------------------------------------------------------------------

describe("applySettlement — reason 'replied'", () => {
  it('calls renderFn with stashed actor; does NOT call postReply again; unregisters', async () => {
    // #given a confirmed entry (decision submitted → postReply succeeded)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const request = makeRequest()
    const renderFn = makeRenderFn()
    registry.register(makeParams({request, effects}))
    registry.attachMessage('per_1', renderFn)
    const actor: ApprovalActor = {kind: 'discord-user', userId: 'user_A'}
    await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor,
    })

    // #when the coordinator fires settlement with reason 'replied'
    await registry.applySettlement({requestID: 'per_1', decision: 'once', reason: 'replied'})

    // #then postReply NOT called again; renderFn called with correct args
    expect(effects.postReply).toHaveBeenCalledOnce()
    expect(renderFn).toHaveBeenCalledExactlyOnceWith(request, 'once', actor, 'replied')
    expect(registry.has('per_1')).toBe(false)
  })

  it('skips renderFn if no message was attached (embed post failed)', async () => {
    // #given entry where embed post failed (no attachMessage called)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({effects}))
    registry.markMessagePostFailed('per_1')
    await registry.handleDecision({requestID: 'per_1', approvalScopeId: 'chan_1', decision: 'once', actor: makeActor()})

    // #when settled
    await registry.applySettlement({requestID: 'per_1', decision: 'once', reason: 'replied'})

    // #then no renderFn called; entry still unregistered
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scenario 8: applySettlement — deadline/cascade on open entry
// ---------------------------------------------------------------------------

describe("applySettlement — reason 'deadline' (unclaimed)", () => {
  it('calls postReply(reject), renderFn(null actor, deadline), then unregisters', async () => {
    // #given an open entry with a message attached
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const request = makeRequest()
    const renderFn = makeRenderFn()
    registry.register(makeParams({request, effects}))
    registry.attachMessage('per_1', renderFn)

    // #when deadline fires
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'})

    // #then postReply called with reject; renderFn with actor=null
    expect(effects.postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'reject')
    expect(renderFn).toHaveBeenCalledExactlyOnceWith(request, 'reject', null, 'deadline')
    expect(registry.has('per_1')).toBe(false)
  })

  it('cascade: postReply failing does not prevent renderFn or unregister', async () => {
    // #given an unclaimed entry and a failing postReply
    const registry = createApprovalRegistry({logger: makeLogger()})
    const postReply = vi.fn().mockResolvedValue({ok: false, error: 'server gone'})
    const renderFn = makeRenderFn()
    const effects = makeEffects({postReply})
    registry.register(makeParams({effects}))
    registry.attachMessage('per_1', renderFn)

    // #when cascade settlement arrives
    await expect(
      registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'cascade'}),
    ).resolves.not.toThrow()

    // #then renderFn was still called and entry unregistered
    expect(renderFn).toHaveBeenCalledOnce()
    expect(registry.has('per_1')).toBe(false)
  })

  it('idempotent — second call after unregister is a no-op', async () => {
    // #given entry settled once
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const renderFn = makeRenderFn()
    registry.register(makeParams({effects}))
    registry.attachMessage('per_1', renderFn)
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'})

    // #when called again
    await expect(
      registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'}),
    ).resolves.not.toThrow()

    // #then no additional side effects
    expect(effects.postReply).toHaveBeenCalledOnce()
    expect(renderFn).toHaveBeenCalledOnce()
  })

  it('renderFn throwing still unregisters and does not propagate', async () => {
    // #given renderFn throws
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const renderFn = vi.fn().mockRejectedValue(new Error('Discord edit failed')) as RenderFn
    registry.register(makeParams({effects}))
    registry.attachMessage('per_1', renderFn)

    // #when settlement fires
    await expect(
      registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'}),
    ).resolves.not.toThrow()

    // #then entry was still removed
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scenario 9: disposeRun — only settles entries for the matching sessionID
// ---------------------------------------------------------------------------

describe('disposeRun', () => {
  it('only fail-closes entries with the matching sessionID, leaves others open', async () => {
    // #given two entries in different sessions
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects1 = makeEffects()
    const effects2 = makeEffects()
    const renderFn1 = makeRenderFn()
    const renderFn2 = makeRenderFn()
    registry.register(
      makeParams({
        requestID: 'per_1',
        sessionID: 'ses_1',
        request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'}),
        effects: effects1,
      }),
    )
    registry.attachMessage('per_1', renderFn1)
    registry.register(
      makeParams({
        requestID: 'per_2',
        sessionID: 'ses_2',
        request: makeRequest({requestID: 'per_2', sessionID: 'ses_2'}),
        effects: effects2,
      }),
    )
    registry.attachMessage('per_2', renderFn2)

    // #when disposeRun for ses_1 only
    await registry.disposeRun('ses_1', 'run ended')

    // #then ses_1 entry settled with rejected/disposed; ses_2 untouched
    expect(registry.has('per_1')).toBe(false)
    expect(renderFn1).toHaveBeenCalledOnce()
    expect(registry.has('per_2')).toBe(true)
    expect(renderFn2).not.toHaveBeenCalled()
  })

  it('no-ops if no entries match the sessionID', async () => {
    // #given an entry for ses_1
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(makeParams())

    // #when disposeRun for a different session
    await expect(registry.disposeRun('ses_UNKNOWN', 'run ended')).resolves.not.toThrow()

    // #then ses_1 entry untouched
    expect(registry.has('per_1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// disposeAll (shutdown path)
// ---------------------------------------------------------------------------

describe('disposeAll', () => {
  it('rejects all open entries, renders settled, empties pending()', async () => {
    // #given two open entries
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects1 = makeEffects()
    const effects2 = makeEffects()
    const renderFn1 = makeRenderFn()
    const renderFn2 = makeRenderFn()
    registry.register(
      makeParams({
        requestID: 'per_1',
        sessionID: 'ses_1',
        request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'}),
        effects: effects1,
      }),
    )
    registry.attachMessage('per_1', renderFn1)
    registry.register(
      makeParams({
        requestID: 'per_2',
        sessionID: 'ses_2',
        request: makeRequest({requestID: 'per_2', sessionID: 'ses_2'}),
        effects: effects2,
      }),
    )
    registry.attachMessage('per_2', renderFn2)

    // #when disposeAll is called
    await registry.disposeAll('shutdown')

    // #then both entries settled with reject/disposed; pending empty
    expect(renderFn1).toHaveBeenCalledOnce()
    expect(renderFn2).toHaveBeenCalledOnce()
    expect(registry.pending()).toHaveLength(0)
  })

  it('does not throw even if all effects fail', async () => {
    // #given entries whose effects all throw
    const registry = createApprovalRegistry({logger: makeLogger()})
    const renderFn = vi.fn().mockRejectedValue(new Error('boom')) as RenderFn
    const effects = makeEffects({
      postReply: vi.fn().mockRejectedValue(new Error('boom')),
    })
    registry.register(makeParams({effects}))
    registry.attachMessage('per_1', renderFn)

    // #when disposeAll
    await expect(registry.disposeAll('shutdown')).resolves.not.toThrow()

    // #then pending is empty
    expect(registry.pending()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// attachMessage / markMessagePostFailed
// ---------------------------------------------------------------------------

describe('attachMessage', () => {
  it('warns if requestID is not found (already settled)', () => {
    // #given settled entry
    const logger = makeLogger()
    const registry = createApprovalRegistry({logger})
    // no register — unknown id

    // #when attachMessage called
    registry.attachMessage('per_GONE', makeRenderFn())

    // #then warns; no throw
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('markMessagePostFailed', () => {
  it('warns if requestID is not found; does not throw', () => {
    const logger = makeLogger()
    const registry = createApprovalRegistry({logger})
    registry.markMessagePostFailed('per_GONE')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('entry without renderFn skips render on settlement', async () => {
    // #given entry with no message attached (markMessagePostFailed was called)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({effects}))
    registry.markMessagePostFailed('per_1')

    // #when deadline fires
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'})

    // #then postReply called (best-effort), entry removed, no render crash
    expect(effects.postReply).toHaveBeenCalledOnce()
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FIX 1: cascadeReject skips claimed siblings
// ---------------------------------------------------------------------------

describe('FIX 1 — cascadeReject skips claimed siblings', () => {
  it('cascade from A reject does NOT send reject POST to B when B is claimed (decision in-flight)', async () => {
    // #given two entries in the same session
    const registry = createApprovalRegistry({logger: makeLogger()})

    // Entry A: open
    const effectsA = makeEffects()
    const renderFnA = makeRenderFn()
    registry.register(
      makeParams({
        requestID: 'per_A',
        sessionID: 'ses_1',
        request: makeRequest({requestID: 'per_A', sessionID: 'ses_1'}),
        effects: effectsA,
      }),
    )
    registry.attachMessage('per_A', renderFnA)

    // Entry B: claimed (decision in-flight — postReply held pending)
    let resolveB!: (v: {ok: boolean}) => void
    const replyPromiseB = new Promise<{ok: boolean}>(res => {
      resolveB = res
    })
    const effectsB = makeEffects({postReply: vi.fn().mockReturnValue(replyPromiseB)})
    const renderFnB = makeRenderFn()
    registry.register(
      makeParams({
        requestID: 'per_B',
        sessionID: 'ses_1',
        request: makeRequest({requestID: 'per_B', sessionID: 'ses_1'}),
        effects: effectsB,
      }),
    )
    registry.attachMessage('per_B', renderFnB)

    // Claim B (decision in-flight, not yet resolved)
    const bClickPromise = registry.handleDecision({
      requestID: 'per_B',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: {kind: 'discord-user', userId: 'user_B'},
    })

    // #when A's confirmReply fires with reject (triggers cascade)
    registry.confirmReply({requestID: 'per_A', sessionID: 'ses_1', reply: 'reject'})

    // Allow the cascade async chain to settle
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then A is gone (settled via confirmReply)
    expect(registry.has('per_A')).toBe(false)

    // #then B is still present (claimed, not cascaded)
    expect(registry.has('per_B')).toBe(true)

    // #then effectsB.postReply was called ONCE (the decision), NOT a second time for cascade
    // (it's still pending — the promise hasn't resolved yet)
    expect(effectsB.postReply).toHaveBeenCalledOnce()

    // #when B's postReply resolves successfully
    resolveB({ok: true})
    const bOutcome = await bClickPromise
    expect(bOutcome).toBe<DecisionOutcome>('ok')

    // #when B's confirmReply arrives (echo of the decision)
    registry.confirmReply({requestID: 'per_B', sessionID: 'ses_1', reply: 'once'})
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then B is now settled (rendered approved once)
    expect(registry.has('per_B')).toBe(false)
    expect(renderFnB).toHaveBeenCalledOnce()
    // renderFn called with 'once' (the decision), not 'reject'
    const [, decision] = (renderFnB as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string, ...unknown[]]
    expect(decision).toBe('once')
  })
})

// ---------------------------------------------------------------------------
// FIX 2: deadlineExpired flag — fail-close on button postReply failure after deadline
// ---------------------------------------------------------------------------

describe('FIX 2 — deadlineExpired: fail-close when decision postReply fails after deadline fired', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ok:false path — entry is fail-closed (reject POST + render deadline + deleted), NOT left open', async () => {
    // #given an entry with a deadline
    const registry = createApprovalRegistry({logger: makeLogger()})

    let resolveButton!: (v: {ok: boolean}) => void
    const buttonPromise = new Promise<{ok: boolean}>(res => {
      resolveButton = res
    })
    const postReply = vi.fn().mockReturnValue(buttonPromise)
    const renderFn = makeRenderFn()
    const effects = makeEffects({postReply})
    registry.register(makeParams({effects, deadlineMs: 5_000}))
    registry.attachMessage('per_1', renderFn)

    // #when decision is submitted (entry transitions to claimed)
    const buttonClickPromise = registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: makeActor(),
    })

    // #when deadline fires while button is in-flight (no-op, sets deadlineExpired)
    vi.advanceTimersByTime(6_000)
    // Let the deadline callback run
    await Promise.resolve()

    // #then entry is still present (deadline was a no-op because claimed)
    expect(registry.has('per_1')).toBe(true)

    // #when button postReply resolves as ok:false
    resolveButton({ok: false})
    await buttonClickPromise

    // Allow failCloseNow async chain to settle
    await Promise.resolve()
    await Promise.resolve()

    // #then entry is fail-closed: reject POST sent (once for button attempt + once for failCloseNow)
    // The button attempt returned ok:false (1 call), then failCloseNow sends another reject (2nd call)
    expect(postReply).toHaveBeenCalledTimes(2)
    expect(postReply).toHaveBeenLastCalledWith('per_1', '/workspace/proj', 'reject')

    // #then renderFn called with 'deadline' reason
    expect(renderFn).toHaveBeenCalledOnce()
    const [, , , reason] = (renderFn as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown, unknown, string]
    expect(reason).toBe('deadline')

    // #then entry is deleted (not left open)
    expect(registry.has('per_1')).toBe(false)
  })

  it('throw path — entry is fail-closed when decision postReply throws after deadline fired', async () => {
    // #given an entry with a deadline
    const registry = createApprovalRegistry({logger: makeLogger()})

    let rejectButton!: (err: Error) => void
    const buttonPromise = new Promise<{ok: boolean}>((_, rej) => {
      rejectButton = rej
    })
    const postReply = vi.fn().mockReturnValue(buttonPromise)
    const renderFn = makeRenderFn()
    const effects = makeEffects({postReply})
    registry.register(makeParams({effects, deadlineMs: 5_000}))
    registry.attachMessage('per_1', renderFn)

    // #when decision is submitted
    const buttonClickPromise = registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: makeActor(),
    })

    // #when deadline fires while button is in-flight
    vi.advanceTimersByTime(6_000)
    await Promise.resolve()

    // #when button postReply throws
    rejectButton(new Error('network error'))
    const outcome = await buttonClickPromise

    // Allow failCloseNow async chain to settle
    await Promise.resolve()
    await Promise.resolve()

    // #then outcome is still 'reply-failed' (the button click did fail)
    expect(outcome).toBe<DecisionOutcome>('reply-failed')

    // #then entry is fail-closed: failCloseNow sent a reject POST
    // (postReply called once for button throw, once for failCloseNow)
    expect(postReply).toHaveBeenCalledTimes(2)
    expect(postReply).toHaveBeenLastCalledWith('per_1', '/workspace/proj', 'reject')

    // #then renderFn called with 'deadline' reason
    expect(renderFn).toHaveBeenCalledOnce()

    // #then entry is deleted
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FIX 3: stale timer on duplicate register
// ---------------------------------------------------------------------------

describe('FIX 3 — stale timer cleared on duplicate register', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('old deadline timer does NOT fire on the replacement entry after re-register', async () => {
    // #given an entry registered with a 5s deadline
    const registry = createApprovalRegistry({logger: makeLogger()})

    const postReply1 = vi.fn().mockResolvedValue({ok: true})
    registry.register(
      makeParams({
        requestID: 'per_1',
        effects: makeEffects({postReply: postReply1}),
        deadlineMs: 5_000,
      }),
    )

    // #when the same requestID is re-registered (new entry, new effects, new deadline)
    const postReply2 = vi.fn().mockResolvedValue({ok: true})
    registry.register(
      makeParams({
        requestID: 'per_1',
        effects: makeEffects({postReply: postReply2}),
        deadlineMs: 20_000,
      }),
    )

    // #when time advances past the FIRST deadline (5s) but not the second (20s)
    vi.advanceTimersByTime(6_000)
    // Allow any timer callbacks to run
    await Promise.resolve()
    await Promise.resolve()

    // #then the replacement entry was NOT settled by the stale timer
    expect(registry.has('per_1')).toBe(true)
    // postReply2 (the replacement entry's effects) was NOT called by the stale timer
    expect(postReply2).not.toHaveBeenCalled()
    // postReply1 (the old entry's effects) was also not called (timer was cleared)
    expect(postReply1).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// NBC4: superseded render on duplicate register
// ---------------------------------------------------------------------------

describe('NBC4 — duplicate register renders old entry as superseded', () => {
  it('calls old renderFn with reason superseded, clears old timer, new entry is active', async () => {
    // #given a registry with an entry that has a renderFn attached
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects1 = makeEffects()
    const renderFn1 = makeRenderFn()
    const request1 = makeRequest({requestID: 'per_1', sessionID: 'ses_1'})
    registry.register(makeParams({requestID: 'per_1', sessionID: 'ses_1', request: request1, effects: effects1}))
    registry.attachMessage('per_1', renderFn1)

    // #when the same requestID is re-registered (re-ask)
    const effects2 = makeEffects()
    const request2 = makeRequest({requestID: 'per_1', sessionID: 'ses_1'})
    registry.register(makeParams({requestID: 'per_1', sessionID: 'ses_1', request: request2, effects: effects2}))

    // Allow the best-effort superseded render to settle
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then old renderFn was called once with reason 'superseded'
    expect(renderFn1).toHaveBeenCalledOnce()
    const [, , , reason] = (renderFn1 as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown, unknown, string]
    expect(reason).toBe('superseded')

    // #and new entry is the active one (still pending)
    expect(registry.has('per_1')).toBe(true)
    expect(registry.pending()).toContain('per_1')
  })

  it('does not call old renderFn if no message was attached before re-register', async () => {
    // #given an entry with NO renderFn attached
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects1 = makeEffects()
    registry.register(makeParams({requestID: 'per_1', effects: effects1}))
    // No attachMessage call

    // #when re-registered
    const effects2 = makeEffects()
    registry.register(makeParams({requestID: 'per_1', effects: effects2}))
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then no crash; new entry is active
    expect(registry.has('per_1')).toBe(true)
    // effects1.postReply was NOT called (no superseded POST — render only)
    expect(effects1.postReply).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// P2 bonus: confirmReply sessionID mismatch guard
// ---------------------------------------------------------------------------

describe('P2 — confirmReply sessionID mismatch guard', () => {
  it('ignores confirmReply when event.sessionID does not match entry.sessionID', () => {
    // #given an entry registered for ses_1
    const logger = makeLogger()
    const registry = createApprovalRegistry({logger})
    const renderFn = makeRenderFn()
    registry.register(
      makeParams({
        approvalScopeId: 'chan_1',
        sessionID: 'ses_1',
        request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'}),
      }),
    )
    registry.attachMessage('per_1', renderFn)

    // #when confirmReply arrives with a different sessionID
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_WRONG', reply: 'once'})

    // #then entry is NOT settled (still present)
    expect(registry.has('per_1')).toBe(true)
    // renderFn was NOT called
    expect(renderFn).not.toHaveBeenCalled()
    // warn was logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({requestID: 'per_1', entrySessionID: 'ses_1', eventSessionID: 'ses_WRONG'}),
      expect.stringContaining('sessionID mismatch'),
    )
  })

  it('settles normally when event.sessionID matches entry.sessionID', async () => {
    // #given an entry registered for ses_1
    const registry = createApprovalRegistry({logger: makeLogger()})
    const renderFn = makeRenderFn()
    registry.register(makeParams({sessionID: 'ses_1', request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'})}))
    registry.attachMessage('per_1', renderFn)

    // #when confirmReply arrives with matching sessionID
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then entry is settled and deleted
    expect(registry.has('per_1')).toBe(false)
    expect(renderFn).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// hasPendingForScope
// ---------------------------------------------------------------------------

describe('hasPendingForScope', () => {
  // Happy: open entry for scope → true
  it('returns true when an open entry exists for the scope', () => {
    // #given a registry with one open entry for scope_A
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(makeParams({approvalScopeId: 'scope_A'}))

    // #when queried for scope_A
    const result = registry.hasPendingForScope('scope_A')

    // #then true (open entry matches)
    expect(result).toBe(true)
  })

  // Happy: claimed entry for scope → true
  it('returns true when a claimed entry exists for the scope', async () => {
    // #given a registry with an entry that is in-flight (claimed)
    const registry = createApprovalRegistry({logger: makeLogger()})
    let resolveReply!: (v: {ok: boolean}) => void
    const replyPromise = new Promise<{ok: boolean}>(res => {
      resolveReply = res
    })
    const effects = makeEffects({postReply: vi.fn().mockReturnValue(replyPromise)})
    registry.register(makeParams({approvalScopeId: 'scope_A', effects}))

    // Transition to claimed (postReply in-flight, not yet resolved)
    const clickPromise = registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'scope_A',
      decision: 'once',
      actor: makeActor(),
    })

    // #when queried while entry is claimed
    const result = registry.hasPendingForScope('scope_A')

    // #then true (claimed entry matches)
    expect(result).toBe(true)

    // Cleanup: resolve the in-flight reply so no dangling promise
    resolveReply({ok: true})
    await clickPromise
  })

  // Edge: only a confirmed (settled/deleted) entry existed → false
  it('returns false after the matching entry is settled via applySettlement', async () => {
    // #given a registry with one open entry for scope_A
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(makeParams({approvalScopeId: 'scope_A'}))

    // #when the entry is settled (applySettlement deletes it)
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'})

    // #then false (entry is gone — confirmed state is transient and entry is deleted)
    const result = registry.hasPendingForScope('scope_A')
    expect(result).toBe(false)
  })

  // Edge: no entries for scope → false
  it('returns false for a scope with no entries', () => {
    // #given an empty registry
    const registry = createApprovalRegistry({logger: makeLogger()})

    // #when queried for a scope that was never registered
    const result = registry.hasPendingForScope('scope_NONE')

    // #then false
    expect(result).toBe(false)
  })

  // Edge: false after entry is disposed
  it('returns false after the matching entry is disposed via disposeRun', async () => {
    // #given a registry with one open entry for scope_A
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        approvalScopeId: 'scope_A',
        sessionID: 'ses_1',
        request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'}),
      }),
    )

    // #when the run is disposed
    await registry.disposeRun('ses_1', 'run ended')

    // #then false (entry is gone)
    const result = registry.hasPendingForScope('scope_A')
    expect(result).toBe(false)
  })

  // Isolation: different scope does not satisfy the query
  it('returns false when only an entry for a DIFFERENT scope exists', () => {
    // #given a registry with an open entry for scope_B
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(makeParams({approvalScopeId: 'scope_B'}))

    // #when queried for scope_A
    const result = registry.hasPendingForScope('scope_A')

    // #then false (no cross-scope match)
    expect(result).toBe(false)
  })

  // Isolation: multiple scopes — only the matching scope returns true
  it('returns true only for the scope that has an open entry, false for others', () => {
    // #given two entries in different scopes
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        requestID: 'per_1',
        sessionID: 'ses_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'}),
      }),
    )
    registry.register(
      makeParams({
        requestID: 'per_2',
        sessionID: 'ses_2',
        approvalScopeId: 'scope_B',
        request: makeRequest({requestID: 'per_2', sessionID: 'ses_2'}),
      }),
    )

    // #when queried for each scope
    const resultA = registry.hasPendingForScope('scope_A')
    const resultB = registry.hasPendingForScope('scope_B')
    const resultC = registry.hasPendingForScope('scope_C')

    // #then only the matching scope returns true
    expect(resultA).toBe(true)
    expect(resultB).toBe(true)
    expect(resultC).toBe(false)
  })

  // Type safety: return value is always a boolean (never throws)
  it('never throws and always returns a boolean', () => {
    // #given an empty registry
    const registry = createApprovalRegistry({logger: makeLogger()})

    // #when called with various inputs #then it returns a boolean and never throws
    expect(typeof registry.hasPendingForScope('')).toBe('boolean')
    expect(typeof registry.hasPendingForScope('any-scope')).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Scenario 10: describePendingForScope — full bounded DTO enumeration
// ---------------------------------------------------------------------------

describe('describePendingForScope', () => {
  it('returns empty array when no entries exist for the scope', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})

    const result = registry.describePendingForScope('scope_X')

    expect(result).toEqual([])
  })

  it('returns empty array when entries exist for a different scope', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(makeParams({approvalScopeId: 'scope_A'}))

    const result = registry.describePendingForScope('scope_B')

    expect(result).toEqual([])
  })

  it('returns the DTO for a single open entry in the matching scope', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        requestID: 'per_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', permission: 'bash'}),
      }),
    )

    const result = registry.describePendingForScope('scope_A')

    expect(result).toHaveLength(1)
    const dto = result[0] as PendingApprovalDTO
    expect(dto.requestID).toBe('per_1')
    expect(dto.permission).toBe('bash')
  })

  it('returns only entries for the matching scope (not other scopes)', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        requestID: 'per_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'}),
      }),
    )
    registry.register(
      makeParams({
        requestID: 'per_2',
        sessionID: 'ses_2',
        approvalScopeId: 'scope_B',
        request: makeRequest({requestID: 'per_2', sessionID: 'ses_2'}),
      }),
    )

    const resultA = registry.describePendingForScope('scope_A')
    const resultB = registry.describePendingForScope('scope_B')

    expect(resultA).toHaveLength(1)
    expect((resultA[0] as PendingApprovalDTO).requestID).toBe('per_1')
    expect(resultB).toHaveLength(1)
    expect((resultB[0] as PendingApprovalDTO).requestID).toBe('per_2')
  })

  it('returns multiple concurrent open requests for the same scope', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        requestID: 'per_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'}),
      }),
    )
    registry.register(
      makeParams({
        requestID: 'per_2',
        sessionID: 'ses_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_2', sessionID: 'ses_1'}),
      }),
    )

    const result = registry.describePendingForScope('scope_A')

    expect(result).toHaveLength(2)
    const ids = result.map(d => d.requestID)
    expect(ids).toContain('per_1')
    expect(ids).toContain('per_2')
  })

  it('includes bounded command field when the request has a command', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        requestID: 'per_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', permission: 'bash', command: 'echo hello'}),
      }),
    )

    const result = registry.describePendingForScope('scope_A')

    expect(result).toHaveLength(1)
    const dto = result[0] as PendingApprovalDTO
    expect(dto.command).toBe('echo hello')
    expect(dto.filepath).toBeUndefined()
  })

  it('includes bounded filepath field when the request has a filepath', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        requestID: 'per_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', permission: 'external_directory', filepath: '/tmp/foo'}),
      }),
    )

    const result = registry.describePendingForScope('scope_A')

    expect(result).toHaveLength(1)
    const dto = result[0] as PendingApprovalDTO
    expect(dto.filepath).toBe('/tmp/foo')
    expect(dto.command).toBeUndefined()
  })

  it('strips control characters from command/filepath (boundApprovalDetail applied)', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        requestID: 'per_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', permission: 'bash', command: 'echo\u0000hello\u001Fworld'}),
      }),
    )

    const result = registry.describePendingForScope('scope_A')

    const dto = result[0] as PendingApprovalDTO
    expect(dto.command).toBe('echohelloworld')
  })

  it('truncates oversized command to APPROVAL_DETAIL_MAX_LENGTH', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    const oversized = 'x'.repeat(5000)
    registry.register(
      makeParams({
        requestID: 'per_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', permission: 'bash', command: oversized}),
      }),
    )

    const result = registry.describePendingForScope('scope_A')

    const dto = result[0] as PendingApprovalDTO
    expect(dto.command?.length).toBeLessThanOrEqual(4096)
  })

  it('does not include confirmed (already-settled) entries', async () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({approvalScopeId: 'scope_A', effects}))

    await registry.applySettlement({requestID: 'per_1', decision: 'once', reason: 'replied'})

    const result = registry.describePendingForScope('scope_A')
    expect(result).toEqual([])
  })

  it('does NOT include claimed (mid-decision) entries — only open entries are actionable', async () => {
    // #given a registry with one open and one claimed entry for the same scope
    const registry = createApprovalRegistry({logger: makeLogger()})

    // Entry A: open
    registry.register(
      makeParams({
        requestID: 'per_open',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_open', permission: 'bash'}),
      }),
    )

    // Entry B: claimed (decision in-flight — postReply held pending)
    let resolveB!: (v: {ok: boolean}) => void
    const replyPromiseB = new Promise<{ok: boolean}>(res => {
      resolveB = res
    })
    const effectsB = makeEffects({postReply: vi.fn().mockReturnValue(replyPromiseB)})
    registry.register(
      makeParams({
        requestID: 'per_claimed',
        // Use scope_A so handleDecision can claim it (scope must match)
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_claimed', permission: 'edit'}),
        effects: effectsB,
      }),
    )
    // Transition per_claimed to claimed state (decision in-flight)
    const claimPromise = registry.handleDecision({
      requestID: 'per_claimed',
      approvalScopeId: 'scope_A',
      decision: 'once',
      actor: makeActor(),
    })

    // #when describePendingForScope is called
    const result = registry.describePendingForScope('scope_A')

    // #then only the open entry is returned — claimed entry is excluded
    expect(result).toHaveLength(1)
    const dto = result[0] as PendingApprovalDTO
    expect(dto.requestID).toBe('per_open')
    // per_claimed must NOT appear
    const claimedDto = result.find(d => d.requestID === 'per_claimed')
    expect(claimedDto).toBeUndefined()

    // Cleanup: resolve the in-flight reply
    resolveB({ok: true})
    await claimPromise
  })

  it('returns detail (not just IDs) — DTO has requestID, permission, and optional fields', () => {
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(
      makeParams({
        requestID: 'per_1',
        approvalScopeId: 'scope_A',
        request: makeRequest({requestID: 'per_1', permission: 'bash', command: 'ls -la'}),
      }),
    )

    const result = registry.describePendingForScope('scope_A')

    const dto = result[0] as PendingApprovalDTO
    expect(typeof dto.requestID).toBe('string')
    expect(typeof dto.permission).toBe('string')
    expect(dto.command).toBe('ls -la')
  })
})
