/**
 * Cross-seam integration tests for the tool-approval flow
 *
 * Wires the REAL coordinator + REAL registry together with fake injected
 * side-effects (captured calls, no Discord / HTTP) and drives them with
 * synthesised OpenCode events.
 *
 * ### register-before-send pattern (new)
 *
 * `onPending` now:
 *   1. Calls `registry.register(...)` immediately (before any Discord send).
 *   2. "Sends" the embed (simulated here by immediately calling `attachMessage`).
 *   3. Calls `registry.attachMessage(requestID, renderFn)` on success.
 *
 * Fake effects:
 *   postReply    — records { requestID, directory, decision } per call
 *   renderFn     — records { request, decision, decidedBy, reason } per call
 *
 * All timer-sensitive tests use `vi.useFakeTimers()` to control deadline firing.
 */

import type {PermissionReply, PermissionReplyEvent, PermissionRequest} from './coordinator.js'
import type {ApprovalSideEffects, RegisterParams} from './registry.js'

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

interface RenderCall {
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
  const renderCalls: RenderCall[] = []

  function makeEffectsFor(_requestID: string): {
    effects: ApprovalSideEffects
    renderFn: (request: PermissionRequest, decision: string, decidedBy: string | null, reason: string) => Promise<void>
  } {
    const effects: ApprovalSideEffects = {
      postReply: vi.fn(async (requestID: string, directory: string, decision: PermissionReply) => {
        postReplyCalls.push({requestID, directory, decision})
        return {ok: true}
      }),
    }
    const renderFn = vi.fn(
      async (request: PermissionRequest, decision: string, decidedBy: string | null, reason: string) => {
        renderCalls.push({request, decision, decidedBy, reason})
      },
    )
    return {effects, renderFn}
  }

  return {postReplyCalls, renderCalls, makeEffectsFor}
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
  const {postReplyCalls, renderCalls, makeEffectsFor} = makeFakeEffects()

  const registry = createApprovalRegistry({logger})

  /**
   * Simulate what run.ts's onPending does with the register-before-send pattern:
   * 1. register immediately (with deadlineMs — registry owns the timer)
   * 2. "send" the embed (instant in test)
   * 3. attachMessage with the renderFn
   */
  function onPending(request: PermissionRequest) {
    const {effects, renderFn} = makeEffectsFor(request.requestID)
    const params: RegisterParams = {
      requestID: request.requestID,
      sessionID: request.sessionID,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request,
      effects,
      deadlineMs, // registry owns the deadline timer
    }
    // Step 1: register before send
    registry.register(params)
    // Step 2 & 3: simulate successful embed send → attachMessage
    registry.attachMessage(request.requestID, renderFn)
  }

  const coordinator = createPermissionCoordinator({
    logger,
    onPending,
    // New API: forward permission.replied to registry.confirmReply (owns rendering + cascade)
    onReplied: event => {
      registry.confirmReply(event)
    },
    // onDispose: fail-close registry entries for this run
    onDispose: sessionIDs => {
      // eslint-disable-next-line no-void
      void Promise.all(sessionIDs.map(async sid => registry.disposeRun(sid, 'run ended')))
    },
  })

  return {coordinator, registry, postReplyCalls, renderCalls}
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
    const {coordinator, registry, postReplyCalls, renderCalls} = setup()
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

    // #then — no second postReply (applySettlement skips postReply since state is 'confirmed')
    expect(postReplyCalls).toHaveLength(1)

    // renderFn called once
    expect(renderCalls).toHaveLength(1)
    expect(renderCalls[0]).toMatchObject({decision: 'once', reason: 'replied'})

    // Entry is gone
    expect(registry.pending()).not.toContain('req-1')
    expect(registry.has('req-1')).toBe(false)
  })

  // 2. deny→reject ──────────────────────────────────────────────────────────

  it('deny path: postReply once with "reject"; permission.replied{reject} settles once, no second postReply', async () => {
    // #given
    const {coordinator, registry, postReplyCalls, renderCalls} = setup()
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
    expect(renderCalls).toHaveLength(1)
    expect(renderCalls[0]).toMatchObject({decision: 'reject', reason: 'replied'})
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

    // Advance past deadline — registry timer fires (not coordinator)
    await vi.advanceTimersByTimeAsync(200)
    await vi.runAllTimersAsync()

    // Registry has handled the deadline (reject + render + delete)
    expect(registry.has('req-4')).toBe(false)

    // Coordinator's promise is still pending (deadline is now in registry, not coordinator).
    // Dispose to resolve it fail-closed (simulating run end).
    coordinator.dispose('run ended after deadline')
    await p4

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
    const {coordinator, registry, postReplyCalls, renderCalls} = setup()
    const req6a = makeRequest('req-6a', SESSION_A)
    const req6b = makeRequest('req-6b', SESSION_A)

    const p6a = coordinator.onPermissionAsked(req6a)
    const p6b = coordinator.onPermissionAsked(req6b)

    expect(registry.pending()).toContain('req-6a')
    expect(registry.pending()).toContain('req-6b')

    // #when — permission.replied{reject} for req-6a
    // Registry cascade settles req-6b (render + POST). Coordinator still has p6b pending.
    // Simulate the server-side cascade reply for req-6b to resolve the coordinator promise.
    coordinator.onPermissionReplied(makeReplyEvent('req-6a', 'reject'))
    await vi.runAllTimersAsync()
    // Simulate OpenCode's server-side cascade reply for req-6b (registry entry already gone → no-op in registry)
    coordinator.onPermissionReplied(makeReplyEvent('req-6b', 'reject'))
    await Promise.all([p6a, p6b])

    // #then — both entries settled
    expect(registry.has('req-6a')).toBe(false)
    expect(registry.has('req-6b')).toBe(false)
    expect(registry.pending()).toHaveLength(0)

    // renderFn called for both — one 'replied', one 'cascade'
    expect(renderCalls).toHaveLength(2)
    const reasons = renderCalls.map(c => c.reason)
    expect(reasons).toContain('replied')
    expect(reasons).toContain('cascade')

    // postReply: req-6a was settled via 'replied' (state=open → best-effort postReply).
    // req-6b: cascade also calls best-effort postReply (state=open).
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

    // Registry deadline has fired and cleaned up the entry.
    // Coordinator promise is still pending — dispose it (simulating run end/timeout).
    coordinator.dispose('deadline elapsed, run ended')
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

    const {makeEffectsFor, postReplyCalls: postReplyDrain, renderCalls: renderDrain} = makeFakeEffects()

    const e8a = makeEffectsFor('req-8a')
    const e8b = makeEffectsFor('req-8b')

    reg.register({
      requestID: 'req-8a',
      sessionID: SESSION_A,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request: req8a,
      effects: e8a.effects,
    })
    reg.attachMessage('req-8a', e8a.renderFn)

    reg.register({
      requestID: 'req-8b',
      sessionID: SESSION_B,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request: req8b,
      effects: e8b.effects,
    })
    reg.attachMessage('req-8b', e8b.renderFn)

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

    // renderFn called for each entry (disposed reason)
    expect(renderDrain).toHaveLength(2)
    expect(renderDrain.every(c => c.reason === 'disposed')).toBe(true)

    // postReply called with reject for each (best-effort fail-closed)
    expect(postReplyDrain.every(c => c.decision === 'reject')).toBe(true)
  })

  // ── REQUIRED CROSS-OWNER RACE TESTS ─────────────────────────────────────────

  // R1. Button approve in-flight → deadline fires → deadline LOSES
  it('race: button approve in-flight when deadline fires → deadline is no-op; confirmReply renders APPROVED exactly once; reject POST never sent', async () => {
    // #given — deadline wired into registry; postReply for approve is controllable
    const logger = makeLogger()
    const {renderCalls, makeEffectsFor} = makeFakeEffects()
    const postReplyCalls: PostReplyCall[] = []

    // Use a deferred postReply so we can hold the button approve in-flight
    let resolvePostReply!: (v: {ok: boolean}) => void
    const heldPostReply = new Promise<{ok: boolean}>(res => {
      resolvePostReply = res
    })

    const registry = createApprovalRegistry({logger})

    const req = makeRequest('req-r1')
    const {renderFn} = makeEffectsFor('req-r1')

    const heldEffects: ApprovalSideEffects = {
      postReply: vi.fn(async (requestID: string, directory: string, decision: PermissionReply) => {
        postReplyCalls.push({requestID, directory, decision})
        return heldPostReply
      }),
    }

    const DEADLINE_MS = 200
    registry.register({
      requestID: req.requestID,
      sessionID: req.sessionID,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request: req,
      effects: heldEffects,
      deadlineMs: DEADLINE_MS,
    })
    registry.attachMessage(req.requestID, renderFn)

    // #when — button approve claims the entry (postReply is in-flight, not yet resolved)
    const buttonPromise = registry.handleButtonDecision({
      requestID: req.requestID,
      channelID: 'ch-test',
      decision: 'once',
      decidedBy: 'user-approved',
    })

    // Advance past the deadline while button POST is still in-flight
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 100)

    // #then — deadline does NOT render denied and does NOT delete entry
    // (entry is still claimed by the button winner)
    expect(renderCalls).toHaveLength(0)
    expect(registry.has(req.requestID)).toBe(true)

    // Reject POSTs: the deadline must not have called postReply (only the button did)
    const rejectPosts = postReplyCalls.filter(c => c.decision === 'reject')
    expect(rejectPosts).toHaveLength(0)

    // Now resolve the approve POST — button click succeeds
    resolvePostReply({ok: true})
    await buttonPromise

    // Deliver permission.replied('once') — OpenCode's authoritative echo
    registry.confirmReply({requestID: req.requestID, sessionID: req.sessionID, reply: 'once'})
    await vi.runAllTimersAsync()

    // #then — renders APPROVED exactly once
    expect(renderCalls).toHaveLength(1)
    expect(renderCalls[0]).toMatchObject({decision: 'once'})

    // No reject POST ever sent
    const finalRejectPosts = postReplyCalls.filter(c => c.decision === 'reject')
    expect(finalRejectPosts).toHaveLength(0)

    // Entry is cleaned up
    expect(registry.has(req.requestID)).toBe(false)
  })

  // R2. Deadline fires on OPEN entry (no button) → renders denied + posts reject once
  it('race: deadline fires on open entry → rejected via POST + rendered denied + entry deleted', async () => {
    // #given
    const logger = makeLogger()
    const {postReplyCalls, renderCalls, makeEffectsFor} = makeFakeEffects()
    const registry = createApprovalRegistry({logger})

    const req = makeRequest('req-r2')
    const {effects, renderFn} = makeEffectsFor('req-r2')

    registry.register({
      requestID: req.requestID,
      sessionID: req.sessionID,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request: req,
      effects,
      deadlineMs: 100,
    })
    registry.attachMessage(req.requestID, renderFn)

    // #when — advance past deadline, no button click
    await vi.advanceTimersByTimeAsync(500)
    await vi.runAllTimersAsync()

    // #then — reject POST + denied render + entry deleted
    expect(postReplyCalls.some(c => c.decision === 'reject')).toBe(true)
    expect(renderCalls).toHaveLength(1)
    expect(renderCalls[0]).toMatchObject({decision: 'reject'})
    expect(registry.has(req.requestID)).toBe(false)
  })

  // R3. permission.replied swallow regression: deadline must not prevent a later confirmReply from rendering
  it('swallow regression: after deadline no-ops on claimed entry, confirmReply still renders', async () => {
    // #given — same as R1 but we just verify the render path after the race
    const logger = makeLogger()
    const {renderCalls, makeEffectsFor} = makeFakeEffects()
    let resolvePost!: (v: {ok: boolean}) => void
    const heldPost = new Promise<{ok: boolean}>(res => {
      resolvePost = res
    })
    const registry = createApprovalRegistry({logger})
    const req = makeRequest('req-r3')
    const {renderFn} = makeEffectsFor('req-r3')

    registry.register({
      requestID: req.requestID,
      sessionID: req.sessionID,
      channelID: 'ch-test',
      directory: DIRECTORY,
      request: req,
      effects: {postReply: vi.fn().mockReturnValue(heldPost)},
      deadlineMs: 150,
    })
    registry.attachMessage(req.requestID, renderFn)

    const buttonPromise = registry.handleButtonDecision({
      requestID: req.requestID,
      channelID: 'ch-test',
      decision: 'once',
      decidedBy: 'user-approved',
    })

    // Deadline fires while in-flight
    await vi.advanceTimersByTimeAsync(300)

    // Deadline must not have rendered
    expect(renderCalls).toHaveLength(0)

    // Resolve POST and deliver confirmReply
    resolvePost({ok: true})
    await buttonPromise

    registry.confirmReply({requestID: req.requestID, sessionID: req.sessionID, reply: 'once'})
    await vi.runAllTimersAsync()

    // #then — exactly one render (approved), not swallowed
    expect(renderCalls).toHaveLength(1)
    expect(renderCalls[0]).toMatchObject({decision: 'once'})
    expect(registry.has(req.requestID)).toBe(false)
  })

  // 9. register-before-send: entry is immediately available in registry
  //    even before the embed "send" completes (async attach)
  // ─────────────────────────────────────────────────────────────────────────

  it('register-before-send: entry visible in registry before attachMessage resolves', async () => {
    // #given a registry + coordinator wired together
    const logger = makeLogger()
    const reg = createApprovalRegistry({logger})

    // Capture registrations to assert ordering
    const registeredBeforeAttach: string[] = []

    const coordinator = createPermissionCoordinator({
      logger,
      onPending: request => {
        const {effects, renderFn} = makeFakeEffects().makeEffectsFor(request.requestID)
        // Step 1: register immediately — entry should be visible NOW
        reg.register({
          requestID: request.requestID,
          sessionID: request.sessionID,
          channelID: 'ch-test',
          directory: DIRECTORY,
          request,
          effects,
        })
        // Capture state BEFORE attachMessage
        registeredBeforeAttach.push(request.requestID)
        expect(reg.has(request.requestID)).toBe(true)

        // Step 2: attach message async (simulated as microtask)
        Promise.resolve()
          .then(() => {
            reg.attachMessage(request.requestID, renderFn)
          })
          .catch(() => undefined)
      },
      onSettled: (requestID, decision, reason) => {
        reg
          .applySettlement({
            requestID,
            decision,
            reason,
          })
          .catch(() => undefined)
      },
    })

    const req = makeRequest('req-9')
    // #when onPermissionAsked fires (onPending is invoked synchronously inside)
    const replyPromise = coordinator.onPermissionAsked(req)

    // #then — entry was registered before the async embed attach
    expect(registeredBeforeAttach).toContain('req-9')
    expect(reg.has('req-9')).toBe(true)

    // Cleanup
    coordinator.onPermissionReplied(makeReplyEvent('req-9', 'once'))
    await vi.runAllTimersAsync()
    await replyPromise
  })
})
