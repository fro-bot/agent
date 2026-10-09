/**
 * Characterization tests for approval-registry behaviors that the registry
 * lifecycle shares with other request families: OpenCode-originated
 * settlement, the claimed-vs-deadline handshake, cascade, and teardown.
 *
 * These pin today's approval behavior independently of how the lifecycle is
 * implemented.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'
import type {ApprovalActor, ApprovalSideEffects, RegisterParams, RenderFn} from './registry.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createApprovalRegistry} from './registry.js'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRequest(requestID: string, sessionID = 'ses_1'): PermissionRequest {
  return {requestID, sessionID, permission: 'bash', patterns: ['ls'], title: 'Run ls'}
}

function makeEffects(): ApprovalSideEffects {
  return {postReply: vi.fn().mockResolvedValue({ok: true})}
}

function makeRenderFn(): RenderFn {
  return vi.fn().mockResolvedValue(undefined)
}

const ACTOR: ApprovalActor = {kind: 'discord-user', userId: 'user_A'}

function makeParams(requestID: string, overrides: Partial<RegisterParams> = {}): RegisterParams {
  const sessionID = overrides.sessionID ?? 'ses_1'
  return {
    requestID,
    sessionID,
    approvalScopeId: 'chan_1',
    directory: '/workspace/proj',
    request: makeRequest(requestID, sessionID),
    effects: makeEffects(),
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('confirmReply — authoritative settlement', () => {
  it('open entry (OpenCode-initiated): renders the echoed reply with no actor, sends no POST, unregisters', async () => {
    // #given an open entry with a rendered message
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const render = makeRenderFn()
    const request = makeRequest('per_1')
    registry.register(makeParams('per_1', {effects, request}))
    registry.attachMessage('per_1', render)

    // #when OpenCode echoes a reply nobody on the gateway claimed
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'always'})
    await flush()

    // #then the echo is rendered as replied with no actor, and no POST was made
    expect(render).toHaveBeenCalledExactlyOnceWith(request, 'always', null, 'replied')
    expect(effects.postReply).not.toHaveBeenCalled()
    expect(registry.has('per_1')).toBe(false)
  })

  it('claimed entry: renders the echoed reply with the claiming actor and sends no second POST', async () => {
    // #given an entry claimed by a decision
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const render = makeRenderFn()
    const request = makeRequest('per_1')
    registry.register(makeParams('per_1', {effects, request}))
    registry.attachMessage('per_1', render)
    await registry.handleDecision({requestID: 'per_1', approvalScopeId: 'chan_1', decision: 'once', actor: ACTOR})

    // #when the echo arrives
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await flush()

    // #then rendered once with the actor; the decision POST was the only POST
    expect(render).toHaveBeenCalledExactlyOnceWith(request, 'once', ACTOR, 'replied')
    expect(effects.postReply).toHaveBeenCalledOnce()
    expect(registry.has('per_1')).toBe(false)
  })

  it('unknown request id: no-op that does not throw', () => {
    // #given an empty registry
    const registry = createApprovalRegistry({logger: makeLogger()})

    // #when / #then
    expect(() => registry.confirmReply({requestID: 'per_GONE', sessionID: 'ses_1', reply: 'once'})).not.toThrow()
    expect(registry.pending()).toEqual([])
  })

  it('a second echo for a settled request renders nothing more', async () => {
    // #given an entry settled by its echo
    const registry = createApprovalRegistry({logger: makeLogger()})
    const render = makeRenderFn()
    registry.register(makeParams('per_1'))
    registry.attachMessage('per_1', render)
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await flush()

    // #when the same echo repeats
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await flush()

    // #then still rendered once
    expect(render).toHaveBeenCalledOnce()
  })
})

describe('reject cascade', () => {
  it('rejecting one request POSTs reject for open same-session siblings and renders them as cascade', async () => {
    // #given two open requests on one session and one on another
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effectsB = makeEffects()
    const effectsC = makeEffects()
    const renderB = makeRenderFn()
    const renderC = makeRenderFn()
    registry.register(makeParams('per_A'))
    registry.register(makeParams('per_B', {effects: effectsB}))
    registry.register(makeParams('per_C', {sessionID: 'ses_2', effects: effectsC}))
    registry.attachMessage('per_B', renderB)
    registry.attachMessage('per_C', renderC)

    // #when A is rejected
    registry.confirmReply({requestID: 'per_A', sessionID: 'ses_1', reply: 'reject'})
    await flush()

    // #then B is cascade-rejected; the other session's C is untouched
    expect(effectsB.postReply).toHaveBeenCalledExactlyOnceWith('per_B', '/workspace/proj', 'reject')
    expect(renderB).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'reject', null, 'cascade')
    expect(registry.has('per_B')).toBe(false)
    expect(registry.has('per_C')).toBe(true)
    expect(effectsC.postReply).not.toHaveBeenCalled()
    expect(renderC).not.toHaveBeenCalled()
  })

  it('a non-reject echo does not cascade', async () => {
    // #given two open requests on one session
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effectsB = makeEffects()
    registry.register(makeParams('per_A'))
    registry.register(makeParams('per_B', {effects: effectsB}))

    // #when A is approved
    registry.confirmReply({requestID: 'per_A', sessionID: 'ses_1', reply: 'once'})
    await flush()

    // #then B stays open
    expect(registry.has('per_B')).toBe(true)
    expect(effectsB.postReply).not.toHaveBeenCalled()
  })
})

describe('deadline timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('open entry: POSTs reject, renders deadline with no actor, unregisters', async () => {
    // #given an open entry with a deadline
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const render = makeRenderFn()
    const request = makeRequest('per_1')
    registry.register(makeParams('per_1', {effects, request, deadlineMs: 1_000}))
    registry.attachMessage('per_1', render)

    // #when the deadline passes
    await vi.advanceTimersByTimeAsync(1_000)

    // #then the entry is fail-closed
    expect(effects.postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'reject')
    expect(render).toHaveBeenCalledExactlyOnceWith(request, 'reject', null, 'deadline')
    expect(registry.has('per_1')).toBe(false)
  })

  it('claimed entry: the decision wins, the deadline sends nothing and leaves the entry for its echo', async () => {
    // #given a decision in flight when the deadline fires
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const render = makeRenderFn()
    registry.register(makeParams('per_1', {effects, deadlineMs: 1_000}))
    registry.attachMessage('per_1', render)
    await registry.handleDecision({requestID: 'per_1', approvalScopeId: 'chan_1', decision: 'once', actor: ACTOR})

    // #when the deadline passes
    await vi.advanceTimersByTimeAsync(1_000)

    // #then only the decision POST exists, and the entry remains for the echo
    expect(effects.postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'once')
    expect(render).not.toHaveBeenCalled()
    expect(registry.has('per_1')).toBe(true)
  })

  it('confirmReply clears the deadline timer', async () => {
    // #given an open entry with a deadline
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    registry.register(makeParams('per_1', {effects, deadlineMs: 1_000}))

    // #when the echo arrives before the deadline
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await vi.advanceTimersByTimeAsync(5_000)

    // #then the deadline never POSTs
    expect(effects.postReply).not.toHaveBeenCalled()
  })
})

describe('applySettlement and teardown on claimed entries', () => {
  it("reason 'deadline' on a claimed entry is a no-op", async () => {
    // #given a claimed entry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const render = makeRenderFn()
    registry.register(makeParams('per_1', {effects}))
    registry.attachMessage('per_1', render)
    await registry.handleDecision({requestID: 'per_1', approvalScopeId: 'chan_1', decision: 'once', actor: ACTOR})

    // #when a deadline settlement is applied
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'deadline'})

    // #then the claimant keeps ownership
    expect(registry.has('per_1')).toBe(true)
    expect(render).not.toHaveBeenCalled()
    expect(effects.postReply).toHaveBeenCalledOnce()
  })

  it("reason 'disposed' on a claimed entry renders and unregisters without a second POST", async () => {
    // #given a claimed entry
    const registry = createApprovalRegistry({logger: makeLogger()})
    const effects = makeEffects()
    const render = makeRenderFn()
    registry.register(makeParams('per_1', {effects}))
    registry.attachMessage('per_1', render)
    await registry.handleDecision({requestID: 'per_1', approvalScopeId: 'chan_1', decision: 'once', actor: ACTOR})

    // #when the run is disposed
    await registry.disposeRun('ses_1', 'run-ended')

    // #then torn down regardless of state, with no extra POST
    expect(registry.has('per_1')).toBe(false)
    expect(render).toHaveBeenCalledOnce()
    expect(effects.postReply).toHaveBeenCalledOnce()
  })

  it('disposeAll settles entries across sessions', async () => {
    // #given entries on two sessions
    const registry = createApprovalRegistry({logger: makeLogger()})
    registry.register(makeParams('per_1'))
    registry.register(makeParams('per_2', {sessionID: 'ses_2'}))

    // #when everything is disposed
    await registry.disposeAll('shutdown')

    // #then nothing remains
    expect(registry.pending()).toEqual([])
  })
})
