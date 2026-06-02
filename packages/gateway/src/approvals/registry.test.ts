/**
 * Tests for the program-scoped approval registry bridge.
 *
 * Convention: `vi.fn()` for all injected side-effects. No real Discord.js or
 * SDK imports here — pure unit tests. BDD `// #given/#when/#then` per repo convention.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'
import type {ApprovalSideEffects, DecisionOutcome, RegisterParams} from './registry.js'

import {describe, expect, it, vi} from 'vitest'

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
    renderSettled: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
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
// register / has / pending — basic lifecycle
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
// handleButtonDecision — unknown id
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
// handleButtonDecision — channel mismatch
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
// handleButtonDecision — happy path
// ---------------------------------------------------------------------------

describe('handleButtonDecision — happy path', () => {
  it("returns 'ok', calls postReply once, entry stays registered", async () => {
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
    expect(effects.renderSettled).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// handleButtonDecision — second click after claim (single-winner)
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
})

// ---------------------------------------------------------------------------
// handleButtonDecision — reply-failed → claimed reset → retry works
// ---------------------------------------------------------------------------

describe('handleButtonDecision — reply-failed', () => {
  it("returns 'reply-failed' and resets claimed so a subsequent click can retry", async () => {
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

    // #then reply-failed; claimed was reset
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
// applySettlement — 'replied' (button already POSTed)
// ---------------------------------------------------------------------------

describe("applySettlement — reason 'replied'", () => {
  it('does NOT postReply again; calls renderSettled with stashed decidedBy; unregisters', async () => {
    // #given a claimed entry (button was clicked)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const request = makeRequest()
    registry.register(makeParams({request, effects}))
    await registry.handleButtonDecision({
      requestID: 'per_1',
      channelID: 'chan_1',
      decision: 'once',
      decidedBy: 'user_A',
    })

    // #when the coordinator fires settlement with reason 'replied'
    await registry.applySettlement({requestID: 'per_1', decision: 'once', reason: 'replied'})

    // #then postReply NOT called again (was called once by button); renderSettled called with correct args
    expect(effects.postReply).toHaveBeenCalledOnce()
    expect(effects.renderSettled).toHaveBeenCalledExactlyOnceWith(request, 'once', 'user_A', 'replied')
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applySettlement — 'deadline' on unclaimed entry
// ---------------------------------------------------------------------------

describe("applySettlement — reason 'deadline' (unclaimed)", () => {
  it('calls postReply(reject), renderSettled(null, deadline), then unregisters', async () => {
    // #given an unclaimed entry (no button click)
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const request = makeRequest()
    registry.register(makeParams({request, effects}))

    // #when deadline fires
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'})

    // #then postReply called with reject; renderSettled with decidedBy=null
    expect(effects.postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'reject')
    expect(effects.renderSettled).toHaveBeenCalledExactlyOnceWith(request, 'reject', null, 'deadline')
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applySettlement — 'cascade' with postReply failing → non-fatal
// ---------------------------------------------------------------------------

describe("applySettlement — reason 'cascade' with failing postReply", () => {
  it('does NOT throw; still calls renderSettled and unregisters', async () => {
    // #given an unclaimed entry and a failing postReply
    const registry = createApprovalRegistry({logger: makeLogger()})
    const postReply = vi.fn().mockResolvedValue({ok: false, error: 'server gone'})
    const effects = makeEffects({postReply})
    registry.register(makeParams({effects}))

    // #when cascade settlement arrives
    await expect(
      registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'cascade'}),
    ).resolves.not.toThrow()

    // #then renderSettled was still called and entry unregistered
    expect(effects.renderSettled).toHaveBeenCalledOnce()
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applySettlement — idempotent (second call after unregister is a no-op)
// ---------------------------------------------------------------------------

describe('applySettlement — idempotent', () => {
  it('second call after unregister is a no-op and does not throw', async () => {
    // #given entry settled once
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams({effects}))
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'})

    // #when called again
    await expect(
      registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'}),
    ).resolves.not.toThrow()

    // #then no additional side effects
    expect(effects.postReply).toHaveBeenCalledOnce()
    expect(effects.renderSettled).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// applySettlement — renderSettled throwing → still unregisters, does not throw
// ---------------------------------------------------------------------------

describe('applySettlement — renderSettled throws', () => {
  it('still unregisters and does not propagate the error', async () => {
    // #given renderSettled throws
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects({
      renderSettled: vi.fn().mockRejectedValue(new Error('Discord edit failed')),
    })
    registry.register(makeParams({effects}))

    // #when settlement fires
    await expect(
      registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'}),
    ).resolves.not.toThrow()

    // #then entry was still removed
    expect(registry.has('per_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// disposeAll
// ---------------------------------------------------------------------------

describe('disposeAll', () => {
  it('rejects all open entries, renders settled, empties pending()', async () => {
    // #given two open entries
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects1 = makeEffects()
    const effects2 = makeEffects()
    registry.register(
      makeParams({
        requestID: 'per_1',
        sessionID: 'ses_1',
        request: makeRequest({requestID: 'per_1', sessionID: 'ses_1'}),
        effects: effects1,
      }),
    )
    registry.register(
      makeParams({
        requestID: 'per_2',
        sessionID: 'ses_2',
        request: makeRequest({requestID: 'per_2', sessionID: 'ses_2'}),
        effects: effects2,
      }),
    )

    // #when disposeAll is called
    await registry.disposeAll('shutdown')

    // #then both entries settled with reject/disposed; pending empty
    expect(effects1.renderSettled).toHaveBeenCalledOnce()
    expect(effects2.renderSettled).toHaveBeenCalledOnce()
    expect(registry.pending()).toHaveLength(0)
  })

  it('does not throw even if all effects fail', async () => {
    // #given entries whose effects all throw
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects({
      postReply: vi.fn().mockRejectedValue(new Error('boom')),
      renderSettled: vi.fn().mockRejectedValue(new Error('boom')),
    })
    registry.register(makeParams({effects}))

    // #when disposeAll
    await expect(registry.disposeAll('shutdown')).resolves.not.toThrow()

    // #then pending is empty
    expect(registry.pending()).toHaveLength(0)
  })
})
