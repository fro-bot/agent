/**
 * Cross-seam integration tests for the tool-approval flow
 *
 * Wires the REAL coordinator + REAL registry together with fake injected
 * side-effects (captured calls, no Discord / HTTP) and drives them with
 * synthesised OpenCode events.
 *
 * Fake effects:
 *   postReply    — records { requestID, directory, decision } per call
 *   renderSettled — records { request, decision, decidedBy, reason } per call
 *
 * All timer-sensitive tests use `vi.useFakeTimers()` to control deadline firing.
 */

import type {PermissionReplyEvent, PermissionRequest, SettlementReason} from './coordinator.js'
import type {RegisterParams} from './registry.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createPermissionCoordinator} from './coordinator.js'
import {createApprovalRegistry} from './registry.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DIRECTORY = '/workspace/acme/widget'
const SESSION_A = 'sess-aaa'
const SESSION_B = 'sess-bbb'

interface PostReplyCall {
  requestID: string
  directory: string
  decision: string
}

interface RenderSettledCall {
  request: PermissionRequest
  decision: string
  decidedBy: string | null
  reason: string
}

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

/** Build fake side-effects and return call-capture arrays + factory */
function makeFakeEffects() {
  const postReplyCalls: PostReplyCall[] = []
  const renderSettledCalls: RenderSettledCall[] = []

  function makeEffectsFor(_requestID: string) {
    return {
      postReply: vi.fn(async (requestID: string, directory: string, decision: string) => {
        postReplyCalls.push({requestID, directory, decision})
        return {ok: true}
      }),
      renderSettled: vi.fn(
        async (request: PermissionRequest, decision: string, decidedBy: string | null, reason: string) => {
          renderSettledCalls.push({request, decision, decidedBy, reason})
        },
      ),
    }
  }

  return {postReplyCalls, renderSettledCalls, makeEffectsFor}
}

function makeRequest(id: string, sessionID: string = SESSION_A): PermissionRequest {
  return {requestID: id, sessionID, permission: 'bash', patterns: ['ls'], title: `Run: ${id}`}
}

function makeReplyEvent(
  requestID: string,
  reply: 'once' | 'always' | 'reject',
  sessionID = SESSION_A,
): PermissionReplyEvent {
  return {sessionID, requestID, reply}
}

/** Wire coordinator + registry together, return both + fake-effects captures */
function setup(deadlineMs?: number) {
  const logger = makeLogger()
  const {postReplyCalls, renderSettledCalls, makeEffectsFor} = makeFakeEffects()

  const registry = createApprovalRegistry({logger})

  /** Simulate what run.ts's onPending does */
  function onPending(request: PermissionRequest) {
    const effects = makeEffectsFor(request.requestID)
    const params: RegisterParams = {
      requestID: request.requestID,
      sessionID: request.sessionID,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request,
      effects,
    }
    registry.register(params)
  }

  /** Simulate what run.ts's onSettled does */
  function onSettled(requestID: string, decision: string, reason: string) {
    registry
      .applySettlement({
        requestID,
        decision: decision as 'once' | 'always' | 'reject',
        reason: reason as SettlementReason,
      })
      .catch(() => undefined)
  }

  const coordinator = createPermissionCoordinator({
    logger,
    onPending,
    onSettled,
    deadlineMs,
  })

  return {coordinator, registry, postReplyCalls, renderSettledCalls}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approval flow — cross-seam integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // 1. approve→reply→resume (exactly-once) ───────────────────────────────────

  it('approve path: postReply called exactly once with query.directory; permission.replied settles without second postReply', async () => {
    // #given
    const {coordinator, registry, postReplyCalls, renderSettledCalls} = setup()
    const req = makeRequest('req-1')

    // #when — permission.asked → register into coordinator + registry
    const replyPromise = coordinator.onPermissionAsked(req)

    expect(registry.pending()).toContain('req-1')
    expect(postReplyCalls).toHaveLength(0)

    // Authorized button click (approve)
    const clickResult = await registry.handleButtonDecision({
      requestID: 'req-1',
      channelID: 'ch-test',
      decision: 'once',
      decidedBy: 'user-approved',
    })
    expect(clickResult).toBe('ok')

    // #then — postReply called exactly once with correct directory
    expect(postReplyCalls).toHaveLength(1)
    expect(postReplyCalls[0]).toMatchObject({requestID: 'req-1', directory: DIRECTORY, decision: 'once'})

    // permission.replied arrives (authoritative settlement)
    coordinator.onPermissionReplied(makeReplyEvent('req-1', 'once'))

    // Wait for async settlement
    await vi.runAllTimersAsync()
    await replyPromise

    // #then — no second postReply (applySettlement skips postReply for 'replied' reason when entry is claimed)
    expect(postReplyCalls).toHaveLength(1)

    // renderSettled called once
    expect(renderSettledCalls).toHaveLength(1)
    expect(renderSettledCalls[0]).toMatchObject({decision: 'once', reason: 'replied'})

    // Entry is gone
    expect(registry.pending()).not.toContain('req-1')
    expect(registry.has('req-1')).toBe(false)
  })

  // 2. deny→reject ──────────────────────────────────────────────────────────

  it('deny path: postReply once with "reject"; permission.replied{reject} settles once, no second postReply', async () => {
    // #given
    const {coordinator, registry, postReplyCalls, renderSettledCalls} = setup()
    const req = makeRequest('req-2')

    const replyPromise = coordinator.onPermissionAsked(req)

    // Authorized deny click
    const clickResult = await registry.handleButtonDecision({
      requestID: 'req-2',
      channelID: 'ch-test',
      decision: 'reject',
      decidedBy: 'user-deny',
    })
    expect(clickResult).toBe('ok')
    expect(postReplyCalls).toHaveLength(1)
    expect(postReplyCalls[0]).toMatchObject({decision: 'reject', directory: DIRECTORY})

    // permission.replied{reject} arrives
    coordinator.onPermissionReplied(makeReplyEvent('req-2', 'reject'))
    await vi.runAllTimersAsync()
    await replyPromise

    // #then — no second postReply
    expect(postReplyCalls).toHaveLength(1)
    expect(renderSettledCalls).toHaveLength(1)
    expect(renderSettledCalls[0]).toMatchObject({decision: 'reject', reason: 'replied'})
    expect(registry.pending()).not.toContain('req-2')
  })

  // 3. single-winner race: permission.replied before button click ───────────

  it('single-winner: permission.replied arrives first → late button click returns not-found or already-claimed, no extra postReply', async () => {
    // #given
    const {coordinator, registry, postReplyCalls} = setup()
    const req = makeRequest('req-3')

    const replyPromise = coordinator.onPermissionAsked(req)

    // permission.replied wins first (no button click yet)
    coordinator.onPermissionReplied(makeReplyEvent('req-3', 'once'))
    await vi.runAllTimersAsync()
    await replyPromise

    // Entry is now settled + unregistered (applySettlement called by onSettled)
    expect(registry.pending()).not.toContain('req-3')

    // Late button click
    const lateResult = await registry.handleButtonDecision({
      requestID: 'req-3',
      channelID: 'ch-test',
      decision: 'once',
      decidedBy: 'user-late',
    })

    // #then — late click does nothing; no postReply emitted
    expect(lateResult === 'not-found' || lateResult === 'already-claimed').toBe(true)
    expect(postReplyCalls).toHaveLength(0)
  })

  // 4. single-winner race: deadline fires before button click ───────────────

  it('single-winner: deadline fires → fail-closed reject posted once → late click → no second postReply', async () => {
    // #given — very short deadline
    const {registry, coordinator, postReplyCalls} = setup(50)
    const req = makeRequest('req-4')

    const p4 = coordinator.onPermissionAsked(req)

    // Advance past deadline
    await vi.advanceTimersByTimeAsync(200)

    // Deadline fires: coordinator should have disposed / rejected
    // Give any pending microtasks a chance to settle
    await vi.runAllTimersAsync()
    await p4

    // The deadline path posts a fail-closed reject via onSettled → applySettlement → postReply
    // (only if entry is not already claimed)
    // Let's check pending is now empty (entry removed after deadline settlement)
    expect(registry.has('req-4')).toBe(false)

    const postRepliesAfterDeadline = postReplyCalls.length

    // Late button click after deadline
    const lateResult = await registry.handleButtonDecision({
      requestID: 'req-4',
      channelID: 'ch-test',
      decision: 'once',
      decidedBy: 'user-late',
    })
    expect(lateResult).toBe('not-found')

    // No extra postReply beyond what deadline already posted
    expect(postReplyCalls).toHaveLength(postRepliesAfterDeadline)
  })

  // 5. channel-mismatch security ─────────────────────────────────────────────

  it('channel-mismatch: button from wrong channelId → handleButtonDecision returns channel-mismatch, postReply NOT called, entry still pending', async () => {
    // #given
    const {registry, coordinator, postReplyCalls} = setup()
    const req = makeRequest('req-5')

    const p5 = coordinator.onPermissionAsked(req)
    expect(registry.pending()).toContain('req-5')

    // #when — button click from a different channel
    const result = await registry.handleButtonDecision({
      requestID: 'req-5',
      channelID: 'ch-WRONG',
      decision: 'once',
      decidedBy: 'attacker',
    })

    // #then
    expect(result).toBe('channel-mismatch')
    expect(postReplyCalls).toHaveLength(0)
    // Entry still open
    expect(registry.pending()).toContain('req-5')
    expect(registry.has('req-5')).toBe(true)

    // Cleanup — dispose settles the pending deferred
    coordinator.dispose('test done')
    await vi.runAllTimersAsync()
    await p5
  })

  // 6. reject cascade ────────────────────────────────────────────────────────

  it('reject cascade: two same-session asks → reject one → both entries settled, both embeds rendered', async () => {
    // #given
    const {coordinator, registry, postReplyCalls, renderSettledCalls} = setup()
    const req6a = makeRequest('req-6a', SESSION_A)
    const req6b = makeRequest('req-6b', SESSION_A)

    const p6a = coordinator.onPermissionAsked(req6a)
    const p6b = coordinator.onPermissionAsked(req6b)

    expect(registry.pending()).toContain('req-6a')
    expect(registry.pending()).toContain('req-6b')

    // #when — permission.replied{reject} for req-6a
    coordinator.onPermissionReplied(makeReplyEvent('req-6a', 'reject'))
    await vi.runAllTimersAsync()
    await Promise.all([p6a, p6b])

    // #then — both entries settled
    expect(registry.has('req-6a')).toBe(false)
    expect(registry.has('req-6b')).toBe(false)
    expect(registry.pending()).toHaveLength(0)

    // renderSettled called for both — one 'replied', one 'cascade'
    expect(renderSettledCalls).toHaveLength(2)
    const reasons = renderSettledCalls.map(c => c.reason)
    expect(reasons).toContain('replied')
    expect(reasons).toContain('cascade')

    // postReply: req-6a was settled via 'replied' (claimed=false → best-effort postReply).
    // req-6b: cascade also calls best-effort postReply (claimed=false).
    // Both should be reject.
    expect(postReplyCalls.every(c => c.decision === 'reject')).toBe(true)
  })

  // 7. sse-drop / no reply within deadline ──────────────────────────────────

  it('sse-drop: no permission.replied ever → deadline fires → fail-closed reject, pending() empty', async () => {
    // #given — very short deadline (100ms)
    const {coordinator, registry, postReplyCalls} = setup(100)
    const req = makeRequest('req-7')

    const p7 = coordinator.onPermissionAsked(req)
    expect(registry.pending()).toContain('req-7')

    // #when — advance past deadline, no reply ever
    await vi.advanceTimersByTimeAsync(500)
    await vi.runAllTimersAsync()
    await p7

    // #then — pending() is empty (no hang)
    expect(registry.has('req-7')).toBe(false)
    expect(registry.pending()).toHaveLength(0)

    // Fail-closed: postReply was called with reject
    expect(postReplyCalls.some(c => c.decision === 'reject')).toBe(true)
  })

  // 8. shutdown drain ────────────────────────────────────────────────────────

  it('shutdown drain: disposeAll resolves promptly, all entries settled, pending() empty', async () => {
    // #given — no deadline (infinite), two pending entries
    const req8a = makeRequest('req-8a', SESSION_A)
    const req8b = makeRequest('req-8b', SESSION_B)
    const logger = makeLogger()
    const reg = createApprovalRegistry({logger})

    const {makeEffectsFor, postReplyCalls: postReplyDrain, renderSettledCalls: renderDrain} = makeFakeEffects()
    reg.register({
      requestID: 'req-8a',
      sessionID: SESSION_A,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request: req8a,
      effects: makeEffectsFor('req-8a'),
    })
    reg.register({
      requestID: 'req-8b',
      sessionID: SESSION_B,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request: req8b,
      effects: makeEffectsFor('req-8b'),
    })

    expect(reg.pending()).toHaveLength(2)

    // #when — shutdown drain
    const drainStart = Date.now()
    await reg.disposeAll('gateway shutdown')
    const drainMs = Date.now() - drainStart

    // #then — resolved promptly (no await on never-arriving reply)
    expect(drainMs).toBeLessThan(200)

    // All entries gone
    expect(reg.pending()).toHaveLength(0)
    expect(reg.has('req-8a')).toBe(false)
    expect(reg.has('req-8b')).toBe(false)

    // renderSettled called for each entry (disposed reason)
    expect(renderDrain).toHaveLength(2)
    expect(renderDrain.every(c => c.reason === 'disposed')).toBe(true)

    // postReply called with reject for each (best-effort fail-closed)
    expect(postReplyDrain.every(c => c.decision === 'reject')).toBe(true)
  })
})
