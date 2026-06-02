/**
 * Tests for the program-scoped approval registry bridge.
 *
 * Convention: `vi.fn()` for all injected side-effects. No real Discord.js or
 * SDK imports here — pure unit tests. BDD `// #given/#when/#then` per repo convention.
 *
 * ### Core scenarios
 *
 * 1. register / has / pending — basic lifecycle
 * 2. handleButtonDecision — unknown id (not-found)
 * 3. handleButtonDecision — channel mismatch
 * 4. handleButtonDecision — happy path (open→claimed→confirmed)
 * 5. handleButtonDecision — claimed blocks second click while in-flight (single-winner)
 * 6. handleButtonDecision — reply-failed resets to open, retry works
 * 7. applySettlement — replied path (renderFn called; no second postReply)
 * 8. applySettlement — deadline/cascade path on open entry
 * 9. disposeRun — only settles entries for the matching sessionID
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'
import type {ApprovalSideEffects, DecisionOutcome, RegisterParams, RenderFn} from './registry.js'

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

function makeParams(overrides: Partial<RegisterParams> = {}): RegisterParams {
  const request = overrides.request ?? makeRequest()
  return {
    requestID: request.requestID,
    sessionID: request.sessionID,
    channelID: 'chan_1',
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
// Scenario 2: handleButtonDecision — unknown id
// ---------------------------------------------------------------------------

describe('handleButtonDecision — unknown id', () => {
  it("returns 'not-found' and does NOT call postReply", async () => {
    // #given an empty registry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({effects}))

    // #when clicking a button for an unknown requestID
    const outcome = await registry.handleButtonDecision({
      requestID: 'per_UNKNOWN',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
    })

    // #then not-found; no side effects
    expect(outcome).toBe<DecisionOutcome>('not-found')
    expect(effects.postReply).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: handleButtonDecision — channel mismatch
// ---------------------------------------------------------------------------

describe('handleButtonDecision — channel mismatch', () => {
  it("returns 'channel-mismatch' and does NOT call postReply", async () => {
    // #given a registry entry bound to chan_1
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({channelID: 'chan_1', effects}))

    // #when a button arrives from a different channel
    const outcome = await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_WRONG',
      decision: 'once',
      decidedBy: 'user_A',
    })

    // #then channel-mismatch; no reply sent
    expect(outcome).toBe<DecisionOutcome>('channel-mismatch')
    expect(effects.postReply).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: handleButtonDecision — happy path (open→claimed→confirmed)
// ---------------------------------------------------------------------------

describe('handleButtonDecision — happy path', () => {
  it("returns 'ok', calls postReply once, state transitions to confirmed", async () => {
    // #given a registered entry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({channelID: 'chan_1', directory: '/workspace/proj', effects}))

    // #when the button is clicked with a valid channel
    const outcome = await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
    })

    // #then ok; postReply called once with correct args; entry still exists (not yet settled)
    expect(outcome).toBe<DecisionOutcome>('ok')
    expect(effects.postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'once')
    expect(registry.has('per_1')).toBe(true)
  })

  it('confirmed entry does not call postReply on applySettlement(replied)', async () => {
    // #given a confirmed entry (button clicked → postReply succeeded)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const renderFn = makeRenderFn()
    registry.register(makeParams({effects}))
    registry.attachMessage('per_1', renderFn)
    await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
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
// Scenario 5: handleButtonDecision — claimed blocks second click (single-winner)
// ---------------------------------------------------------------------------

describe('handleButtonDecision — already-claimed (single-winner)', () => {
  it("returns 'already-claimed' on second click; postReply called only ONCE total", async () => {
    // #given first click already settled
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({effects}))
    await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
    })

    // #when a second click arrives
    const outcome = await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'always',
      decidedBy: 'user_B',
    })

    // #then already-claimed; no second postReply
    expect(outcome).toBe<DecisionOutcome>('already-claimed')
    expect(effects.postReply).toHaveBeenCalledOnce()
  })

  it("'claimed' state (postReply in-flight) blocks concurrent second click", async () => {
    // #given postReply is slow (controllable via deferred promise)
    const registry = createApprovalRegistry({logger: makeLogger()})
    let resolveReply!: (v: {ok: boolean}) => void
    const replyPromise = new Promise<{ok: boolean}>(res => {
      resolveReply = res
    })
    const effects = makeEffects({postReply: vi.fn().mockReturnValue(replyPromise)})
    registry.register(makeParams({effects}))

    // Start first click (in-flight, not yet resolved)
    const firstClickPromise = registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
    })

    // Second click while first is in-flight
    const secondOutcome = await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_B',
    })

    // #then second click is blocked immediately (claimed)
    expect(secondOutcome).toBe<DecisionOutcome>('already-claimed')

    // Resolve the in-flight reply
    resolveReply({ok: true})
    const firstOutcome = await firstClickPromise
    expect(firstOutcome).toBe<DecisionOutcome>('ok')
    expect(effects.postReply).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: handleButtonDecision — reply-failed resets to open, retry works
// ---------------------------------------------------------------------------

describe('handleButtonDecision — reply-failed', () => {
  it("returns 'reply-failed' and resets to open so a subsequent click can retry", async () => {
    // #given postReply fails on first call, succeeds on retry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const postReply = vi.fn().mockResolvedValueOnce({ok: false, error: 'timeout'}).mockResolvedValueOnce({ok: true})
    const effects = makeEffects({postReply})
    registry.register(makeParams({effects}))

    // #when first click fails
    const first = await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
    })

    // #then reply-failed; state reset to open
    expect(first).toBe<DecisionOutcome>('reply-failed')

    // #when retry click
    const retry = await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
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
  it('calls renderFn with stashed decidedBy; does NOT call postReply again; unregisters', async () => {
    // #given a confirmed entry (button was clicked)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const request = makeRequest()
    const renderFn = makeRenderFn()
    registry.register(makeParams({request, effects}))
    registry.attachMessage('per_1', renderFn)
    await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
    })

    // #when the coordinator fires settlement with reason 'replied'
    await registry.applySettlement({requestID: 'per_1', decision: 'once', reason: 'replied'})

    // #then postReply NOT called again; renderFn called with correct args
    expect(effects.postReply).toHaveBeenCalledOnce()
    expect(renderFn).toHaveBeenCalledExactlyOnceWith(request, 'once', 'user_A', 'replied')
    expect(registry.has('per_1')).toBe(false)
  })

  it('skips renderFn if no message was attached (embed post failed)', async () => {
    // #given entry where embed post failed (no attachMessage called)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({effects}))
    registry.markMessagePostFailed('per_1')
    await registry.handleButtonDecision({requestID: 'per_1', channelID: 'chan_1', decision: 'once', decidedBy: 'u'})

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
  it('calls postReply(reject), renderFn(null, deadline), then unregisters', async () => {
    // #given an open entry with a message attached
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const request = makeRequest()
    const renderFn = makeRenderFn()
    registry.register(makeParams({request, effects}))
    registry.attachMessage('per_1', renderFn)

    // #when deadline fires
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'})

    // #then postReply called with reject; renderFn with decidedBy=null
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
  it('cascade from A reject does NOT send reject POST to B when B is claimed (button in-flight)', async () => {
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

    // Entry B: claimed (button approve in-flight — postReply held pending)
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

    // Claim B (button click in-flight, not yet resolved)
    const bClickPromise = registry.handleButtonDecision({
      requestID: 'per_B',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_B',
    })

    // #when A's confirmReply fires with reject (triggers cascade)
    registry.confirmReply({requestID: 'per_A', sessionID: 'ses_1', reply: 'reject'})

    // Allow the cascade async chain to settle
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then A is gone (settled via confirmReply)
    expect(registry.has('per_A')).toBe(false)

    // #then B is still present (claimed, not cascaded)
    expect(registry.has('per_B')).toBe(true)

    // #then effectsB.postReply was called ONCE (the button click), NOT a second time for cascade
    // (it's still pending — the promise hasn't resolved yet)
    expect(effectsB.postReply).toHaveBeenCalledOnce()

    // #when B's button postReply resolves successfully
    resolveB({ok: true})
    const bOutcome = await bClickPromise
    expect(bOutcome).toBe<DecisionOutcome>('ok')

    // #when B's confirmReply arrives (echo of the button approve)
    registry.confirmReply({requestID: 'per_B', sessionID: 'ses_1', reply: 'once'})
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then B is now settled (rendered approved once)
    expect(registry.has('per_B')).toBe(false)
    expect(renderFnB).toHaveBeenCalledOnce()
    // renderFn called with 'once' (the button decision), not 'reject'
    const [, decision] = (renderFnB as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string, ...unknown[]]
    expect(decision).toBe('once')
  })
})

// ---------------------------------------------------------------------------
// FIX 2: deadlineExpired flag — fail-close on button postReply failure after deadline
// ---------------------------------------------------------------------------

describe('FIX 2 — deadlineExpired: fail-close when button postReply fails after deadline fired', () => {
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

    // #when button is clicked (entry transitions to claimed)
    const buttonClickPromise = registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
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

  it('throw path — entry is fail-closed when button postReply throws after deadline fired', async () => {
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

    // #when button is clicked
    const buttonClickPromise = registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
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
    registry.register(makeParams({sessionID: 'ses_1', request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'})}))
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
