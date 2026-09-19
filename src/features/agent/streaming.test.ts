import type {OwnershipLedger} from '@fro-bot/runtime'
/**
 * Unit 8: descendant event handling and ownership-ledger integration.
 *
 * These tests target `processEventStream`'s new `ownershipLedger` parameter.
 * Existing root-session-only characterization coverage for the ten filters
 * lives in `opencode.test.ts`'s `describe('processEventStream', ...)` block
 * (2000+ lines, pre-dating this unit) — it already pins single-session
 * behavior for every filter and continues to pass unchanged (verified: no
 * edits made there), which is itself the strongest characterization evidence
 * that widening the filters to an ownership check left the no-ledger path
 * byte-for-byte identical.
 *
 * This file adds:
 * - Characterization tests for a representative sample of the ten filters,
 *   run twice (with and without a ledger), pinning that an unowned session's
 *   event is ignored either way, and that a ledger-adopted descendant's
 *   event is now processed where it previously was not.
 * - The six scenarios from the plan's Unit 8 (adopt, settle, unowned-ignored,
 *   descendant permission auto-deny, discontinuity, no-ledger inertness).
 */
import type {Event} from '@opencode-ai/sdk'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  armRootFreshness,
  clearRootRevalidationRequirement,
  createRootFreshnessTracker,
  hasFreshIdleCandidate,
  invalidateRootFreshness,
  markRootIdleCandidate,
  processEventStream,
  registerPendingRootUserMessage,
  requireRootRevalidation,
  resolvePendingRootUserMessage,
  type ActivityTracker,
  type PermissionAskedRequest,
} from './streaming.js'

const consoleMocks = vi.hoisted(() => ({
  outputTextContent: vi.fn(),
  outputToolExecution: vi.fn(),
}))

vi.mock('../../shared/console.js', () => consoleMocks)

const ROOT_SESSION_ID = 'ses_root'
const CHILD_SESSION_ID = 'ses_child'
const UNOWNED_SESSION_ID = 'ses_stranger'

function createMockEventStream(events: readonly Event[], onExhausted?: () => void): AsyncIterable<Event> {
  return (async function* () {
    for (const event of events) {
      yield event
    }
    // Models a caller that has already decided to stop watching by the time the transport's
    // own stream naturally ends -- e.g. an abort issued in response to a terminal signal this
    // same scripted event list just delivered. Without this, every finite, synchronously-yielding
    // test stream would otherwise look identical to a genuinely silent, unrequested transport
    // drop (Fix 1's new unexpected-EOF detection), which is not what these particular
    // ownership/classification-focused tests are modeling.
    onExhausted?.()
  })()
}

/** A stream that throws mid-iteration, after yielding zero or more events — models a discontinuity. */
function createDiscontinuousEventStream(events: readonly Event[], error: Error): AsyncIterable<Event> {
  return (async function* () {
    for (const event of events) {
      yield event
    }
    throw error
  })()
}

function backgroundDispatchEvent(sessionID: string, jobId: string, label = 'background task'): Event {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {
        type: 'tool',
        tool: 'task',
        state: {
          status: 'completed',
          title: label,
          metadata: {background: true, jobId},
        },
      },
    },
  } as unknown as Event
}

function injectedCompletionEvent(rootSessionID: string, childSessionID: string, state: 'completed' | 'error'): Event {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: rootSessionID,
      part: {
        type: 'text',
        text: `<task id="${childSessionID}" state="${state}">\n<task_result>\ndone\n</task_result>\n</task>`,
        time: {start: 1, end: 2},
      },
    },
  } as unknown as Event
}

function messageUpdatedEvent(sessionID: string): Event {
  return messageUpdatedEventWithTokens(sessionID, {input: 1, output: 2, reasoning: 0, cache: {read: 0, write: 0}})
}

function messageUpdatedEventWithTokens(
  sessionID: string,
  tokens: {input: number; output: number; reasoning: number; cache: {read: number; write: number}},
): Event {
  return {
    type: 'message.updated',
    properties: {
      sessionID,
      info: {role: 'assistant', tokens},
    },
  } as unknown as Event
}

function sessionErrorEvent(sessionID: string): Event {
  return {type: 'session.error', properties: {sessionID, error: 'boom'}} as unknown as Event
}

function contextOverflowErrorEvent(sessionID: string): Event {
  return {
    type: 'session.error',
    properties: {sessionID, error: {name: 'ContextOverflowError'}},
  } as unknown as Event
}

function retryStatusEvent(sessionID: string): Event {
  return {
    type: 'session.status',
    properties: {
      sessionID,
      status: {type: 'retry', action: {reason: 'account_rate_limit', provider: 'anthropic'}, message: 'quota'},
    },
  } as unknown as Event
}

function toolSuccessEvent(sessionID: string): Event {
  return {
    type: 'session.next.tool.called',
    properties: {sessionID, callID: 'call-1', tool: 'bash', input: {command: 'echo hi'}},
  } as unknown as Event
}

describe('processEventStream — ownership ledger integration', () => {
  it('opens a ledger entry when a background dispatch on an owned session is observed', async () => {
    // #given a ledger and a background dispatch event on the root session; the caller aborts
    // once the scripted stream is exhausted, the same as retry.ts does after deciding completion
    const ledger = createOwnershipLedger()
    const abortController = new AbortController()
    const eventStream = createMockEventStream(
      [backgroundDispatchEvent(ROOT_SESSION_ID, CHILD_SESSION_ID, 'do the thing')],
      () => abortController.abort(),
    )

    // #when the stream is processed with the ledger supplied
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the child session is adopted as outstanding
    expect(ledger.outstanding()).toBe(1)
    expect(ledger.snapshot()).toContainEqual({sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'outstanding'})
  })

  it('settles the ledger entry when its completion turn is injected into the parent', async () => {
    // #given a ledger with an outstanding child, and the parent session receiving the injected completion text
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([injectedCompletionEvent(ROOT_SESSION_ID, CHILD_SESSION_ID, 'completed')])

    // #when the stream is processed
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the entry settles
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.snapshot()).toContainEqual({sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'settled'})
  })

  it('does not settle from a similar-looking text part on a descendant session (only the parent injects completion)', async () => {
    // #given a ledger with an outstanding child, and a stray text part carrying the same marker but on the CHILD's own session
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const abortController = new AbortController()
    const eventStream = createMockEventStream(
      [injectedCompletionEvent(CHILD_SESSION_ID, CHILD_SESSION_ID, 'completed')],
      () => abortController.abort(),
    )

    // #when the stream is processed
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the entry is untouched — settlement only fires for text landing on the root session
    expect(ledger.outstanding()).toBe(1)
  })

  it('ignores an event from an unowned session even with a ledger present', async () => {
    // #given a ledger that owns only the root and one adopted child, and an event from a third, unrelated session
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const abortController = new AbortController()
    const eventStream = createMockEventStream([toolSuccessEvent(UNOWNED_SESSION_ID)], () => abortController.abort())
    const logger = createMockLogger()

    // #when the stream is processed
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      logger,
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then nothing from the unowned session is rendered, and the ledger is untouched
    expect(result).toBeDefined()
    expect(ledger.outstanding()).toBe(1)
    expect(ledger.snapshot()).not.toContainEqual(expect.objectContaining({sessionId: UNOWNED_SESSION_ID}))
  })

  it('still routes an event from a SETTLED descendant — a late trailing event is not foreign', async () => {
    // #given a ledger where the child has already settled (e.g. its completion turn was already observed)
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    ledger.settle(CHILD_SESSION_ID)
    expect(ledger.snapshot()).toContainEqual({sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'settled'})
    const eventStream = createMockEventStream([messageUpdatedEvent(CHILD_SESSION_ID)])

    // #when a trailing event from that now-settled session arrives
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then it is still attributed to this run, not dropped as foreign — this would fail if
    // membership meant "still outstanding" instead of "tracked in any state"
    expect(result.tokens).not.toBeNull()
  })

  it('auto-denies a descendant permission.asked exactly as it does a root one, targeting the descendant session id', async () => {
    // #given a ledger owning an adopted child, and a permission ask from that child
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const responder = vi.fn().mockResolvedValue(undefined)
    const eventStream = createMockEventStream([
      {
        type: 'permission.asked',
        properties: {
          id: 'request-id',
          sessionID: CHILD_SESSION_ID,
          permission: 'bash',
          patterns: ['*'],
        },
      } as unknown as Event,
    ])

    // #when the stream is processed
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      responder,
      ledger,
    )

    // #then the descendant's own session id is denied — not the root's
    const call = responder.mock.calls[0]?.[0] as PermissionAskedRequest | undefined
    expect(call).toEqual({
      requestID: 'request-id',
      sessionID: CHILD_SESSION_ID,
      permission: 'bash',
      patterns: ['*'],
    })
  })

  it("answers an untracked foreground subagent's ask — the defect this fix closes: a foreground dispatch is never adopted into the ledger, so the old ownership gate silently dropped its ask and the child hung forever", async () => {
    // #given no ledger entry for this session at all (a foreground `task` dispatch is never
    // adopted — only background dispatches are, per `ownershipLedger.adopt` on the `task` tool's
    // completed part with `metadata.background === true`)
    const ledger = createOwnershipLedger()
    const responder = vi.fn().mockResolvedValue(undefined)
    const eventStream = createMockEventStream([
      {
        type: 'permission.asked',
        properties: {id: 'request-id', sessionID: UNOWNED_SESSION_ID, permission: 'read', patterns: ['*.env']},
      } as unknown as Event,
    ])

    // #when the stream is processed
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      responder,
      ledger,
    )

    // #then the ask is answered anyway, targeting the foreground subagent's own session id
    expect(responder).toHaveBeenCalledWith({
      requestID: 'request-id',
      sessionID: UNOWNED_SESSION_ID,
      permission: 'read',
      patterns: ['*.env'],
    })
  })

  it("answers a pre-adoption background ask — the ask can arrive before the task tool's completed part adopts the child", async () => {
    // #given a ledger that has not yet adopted the child (the adoption event has not been observed
    // yet), and a permission ask already arriving from that not-yet-adopted session
    const ledger = createOwnershipLedger()
    const responder = vi.fn().mockResolvedValue(undefined)
    const abortController = new AbortController()
    const eventStream = createMockEventStream(
      [
        {
          type: 'permission.asked',
          properties: {id: 'request-id', sessionID: CHILD_SESSION_ID, permission: 'bash', patterns: ['*']},
        } as unknown as Event,
        backgroundDispatchEvent(ROOT_SESSION_ID, CHILD_SESSION_ID, 'do the thing'),
      ],
      () => abortController.abort(),
    )

    // #when the stream is processed — the ask arrives strictly before the adoption event. The
    // caller aborts once the scripted stream is exhausted (mirroring retry.ts) so a natural
    // end-of-stream isn't itself recorded as a discontinuity that would mark the freshly-adopted
    // entry unknown before this assertion runs.
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      undefined,
      undefined,
      responder,
      ledger,
    )

    // #then the ask is answered even though the ledger had not adopted the child yet
    expect(responder).toHaveBeenCalledWith({
      requestID: 'request-id',
      sessionID: CHILD_SESSION_ID,
      permission: 'bash',
      patterns: ['*'],
    })
    // #then adoption still proceeds normally afterward, unaffected by permission handling
    expect(ledger.outstanding()).toBe(1)
  })

  it("still answers the root's own ask exactly as before — removing the ownership requirement does not change root behavior", async () => {
    // #given no ledger, and an ask from the root session (the only case that worked pre-fix)
    const responder = vi.fn().mockResolvedValue(undefined)
    const eventStream = createMockEventStream([
      {
        type: 'permission.asked',
        properties: {id: 'request-id', sessionID: ROOT_SESSION_ID, permission: 'edit', patterns: ['*']},
      } as unknown as Event,
    ])

    // #when the stream is processed
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      responder,
    )

    // #then the root's ask is answered, targeting the root's own session id
    expect(responder).toHaveBeenCalledWith({
      requestID: 'request-id',
      sessionID: ROOT_SESSION_ID,
      permission: 'edit',
      patterns: ['*'],
    })
  })

  it('handles a permission ask with no session id without throwing and without issuing a reply', async () => {
    // #given a malformed ask event carrying no session id at all
    const responder = vi.fn().mockResolvedValue(undefined)
    const logger = createMockLogger()
    const eventStream = createMockEventStream([
      {
        type: 'permission.asked',
        properties: {id: 'request-id', permission: 'bash', patterns: ['*']},
      } as unknown as Event,
      messageUpdatedEvent(ROOT_SESSION_ID),
    ])

    // #when the stream is processed — must not throw, and must reach the later event
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      logger,
      undefined,
      undefined,
      responder,
    )

    // #then no reply is issued for a session-less ask, and the stream still completes
    expect(responder).not.toHaveBeenCalled()
    expect(result).toBeDefined()
  })

  it('handles a permission ask with no request id without throwing and without issuing a reply', async () => {
    // #given a malformed ask event carrying a session id but no request id
    const responder = vi.fn().mockResolvedValue(undefined)
    const logger = createMockLogger()
    const eventStream = createMockEventStream([
      {
        type: 'permission.asked',
        properties: {sessionID: UNOWNED_SESSION_ID, permission: 'bash', patterns: ['*']},
      } as unknown as Event,
      messageUpdatedEvent(ROOT_SESSION_ID),
    ])

    // #when the stream is processed — must not throw
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      logger,
      undefined,
      undefined,
      responder,
    )

    // #then no reply is issued for a request-id-less ask, and the missing-id warning still fires
    expect(responder).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalledWith(
      'OpenCode permission request missing request id',
      expect.objectContaining({eventSessionID: UNOWNED_SESSION_ID}),
    )
    expect(result).toBeDefined()
  })

  it('logs and continues — never throws — when the responder rejects for an untracked session, per the documented failure policy', async () => {
    // #given an untracked session's ask, and a responder whose reply fails
    const logger = createMockLogger()
    const responder = vi.fn().mockRejectedValue(new Error('reply failed'))
    const eventStream = createMockEventStream([
      {
        type: 'permission.asked',
        properties: {id: 'request-id', sessionID: UNOWNED_SESSION_ID, permission: 'bash', patterns: ['*']},
      } as unknown as Event,
      messageUpdatedEvent(ROOT_SESSION_ID),
    ])

    // #when the stream is processed
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      logger,
      undefined,
      undefined,
      responder,
    )

    // #then the failure is logged and swallowed — stream processing continues to completion
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to reject OpenCode permission request',
      expect.objectContaining({eventSessionID: UNOWNED_SESSION_ID, error: 'reply failed'}),
    )
    expect(result).toBeDefined()
  })

  it("complement: a foreign session's non-permission events are still ignored — only permission.asked stopped requiring ownership", async () => {
    // #given events of every other ownership-gated type from a session neither root nor ledger-tracked
    const ledger = createOwnershipLedger()
    const logger = createMockLogger()
    const eventStream = createMockEventStream([
      messageUpdatedEvent(UNOWNED_SESSION_ID),
      toolSuccessEvent(UNOWNED_SESSION_ID),
      sessionErrorEvent(UNOWNED_SESSION_ID),
    ])

    // #when the stream is processed
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      logger,
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then none of it is attributed to this run: no tokens recorded, no error surfaced, ledger untouched
    expect(result.tokens).toBeNull()
    expect(result.llmError).toBeNull()
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.snapshot()).toEqual([])
  })

  it('marks outstanding entries unknown on a stream discontinuity and returns a partial result instead of throwing', async () => {
    // #given a ledger with an outstanding child, and a stream that throws mid-iteration
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createDiscontinuousEventStream([], new Error('connection reset'))

    // #when the stream is processed — a discontinuity is an observation-channel failure, not
    // proof the turn ended, so the accumulated result is returned rather than thrown away
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the outstanding entry is downgraded to unknown, never inferred as settled
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.unknown()).toBe(1)
    expect(ledger.snapshot()).toContainEqual({sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'unknown'})

    // #then termination metadata says the channel closed unexpectedly — not that the turn concluded
    expect(result.discontinuity).toEqual({message: 'connection reset'})
  })

  it('does not mark outstanding entries unknown, and does not fabricate a discontinuity, on an intentional abort', async () => {
    // #given a ledger with an outstanding child, and a stream that throws because the caller aborted it
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const abortController = new AbortController()
    const abortError = new DOMException('Aborted', 'AbortError')
    const eventStream = createDiscontinuousEventStream([], abortError)
    abortController.abort()

    // #when the stream is processed with an already-aborted signal
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the caller's own abort is not treated as a transport failure — nothing is marked unknown
    expect(ledger.outstanding()).toBe(1)
    expect(ledger.unknown()).toBe(0)

    // #then no termination metadata and no llmError are fabricated from an intentional shutdown
    expect(result.discontinuity).toBeUndefined()
    expect(result.llmError).toBeNull()
  })

  it('marks outstanding entries unknown and records a discontinuity when the stream ends without a thrown error or an aborted signal', async () => {
    // #given a ledger with an outstanding child, and a stream that simply runs dry -- no throw,
    // no abort. This models a transport that closes the connection without ever signaling why.
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([messageUpdatedEvent(ROOT_SESSION_ID)])

    // #when the stream is processed with a signal that is never aborted
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then this is treated exactly like a thrown discontinuity: outstanding entries go unknown
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.unknown()).toBe(1)

    // #then termination metadata says the channel closed unexpectedly -- an unobserved end of
    // stream is exactly as much a gap as a thrown one, not silent success
    expect(result.discontinuity).toEqual({message: 'Event stream ended unexpectedly'})
  })

  it('does not record a discontinuity when the stream runs dry because the caller already aborted (intentional shutdown, no throw)', async () => {
    // #given a ledger with an outstanding child, and an already-aborted signal -- the loop's own
    // `if (signal.aborted) break` exits the stream without ever throwing
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const abortController = new AbortController()
    abortController.abort()
    const eventStream = createMockEventStream([messageUpdatedEvent(ROOT_SESSION_ID)])

    // #when the stream is processed with the pre-aborted signal
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then nothing is marked unknown and no discontinuity is fabricated -- this was requested
    expect(ledger.outstanding()).toBe(1)
    expect(ledger.unknown()).toBe(0)
    expect(result.discontinuity).toBeUndefined()
  })

  it('does not record a discontinuity when the stream runs dry after the attempt was already decided by deadline expiry (bounded collection, signal aborted)', async () => {
    // #given a deadline that has already expired, whose expiry is reflected in the combined
    // signal being aborted -- mirroring retry.ts's `AbortSignal.any([eventAbortController.signal,
    // deadline.signal])`. The event stream still yields a couple more events (bounded collection
    // continuing past the decided attempt) before running dry.
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const abortController = new AbortController()
    abortController.abort()
    const deadline = {
      timeoutMs: 0,
      signal: abortController.signal,
      isExpired: () => true,
      isTimedOut: () => true,
      remainingMs: () => 0,
      run: async <T>(operation: () => Promise<T>) => operation(),
      dispose: () => {},
    }
    const eventStream = createMockEventStream([
      messageUpdatedEvent(ROOT_SESSION_ID),
      messageUpdatedEvent(ROOT_SESSION_ID),
    ])

    // #when the stream is processed with the deadline-aborted signal
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      undefined,
      deadline,
      undefined,
      ledger,
    )

    // #then a decided-attempt's bounded collection running dry is not an observation gap
    expect(result.discontinuity).toBeUndefined()
    expect(ledger.outstanding()).toBe(1)
    expect(ledger.unknown()).toBe(0)
  })

  it('records a discontinuity on an unexpected end of stream with an empty ledger (the observation gap the check exists to catch)', async () => {
    // #given a ledger supplied but with nothing adopted -- empty, not outstanding. This is exactly
    // the case the old ownership-occupancy gate assumed away: the stream can close before the
    // dispatch-adoption event is ever observed, leaving the ledger with nothing to show for it.
    const ledger = createOwnershipLedger()
    const eventStream = createMockEventStream([messageUpdatedEvent(ROOT_SESSION_ID)])

    // #when the stream is processed with a signal that is never aborted
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the gap is recorded even though the ledger held nothing to mark unknown -- an empty
    // ledger is not proof that no unobserved dispatch happened, only that none was ever recorded
    expect(result.discontinuity).toEqual({message: 'Event stream ended unexpectedly'})
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.unknown()).toBe(0)
  })

  it('records a discontinuity on an unexpected end of stream with a fully settled ledger', async () => {
    // #given a ledger whose only entry already settled before the stream closed
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    ledger.settle(CHILD_SESSION_ID)
    const eventStream = createMockEventStream([messageUpdatedEvent(ROOT_SESSION_ID)])

    // #when the stream is processed with a signal that is never aborted
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the gap is still recorded -- a settled entry does not retroactively prove no *other*
    // unobserved dispatch happened while the channel was blind
    expect(result.discontinuity).toEqual({message: 'Event stream ended unexpectedly'})
    expect(ledger.snapshot()).toEqual([{sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'settled'}])
  })

  it('records a discontinuity on an unexpected end of stream with no ledger supplied at all', async () => {
    // #given no ownershipLedger argument whatsoever -- the gap must not depend on ownership
    // tracking being wired up at all
    const eventStream = createMockEventStream([messageUpdatedEvent(ROOT_SESSION_ID)])

    // #when the stream is processed with a signal that is never aborted, and no ledger
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
    )

    // #then the gap is still recorded
    expect(result.discontinuity).toEqual({message: 'Event stream ended unexpectedly'})
  })

  // #given four ledger states (no ledger, empty, fully settled, outstanding) each paired with a
  // stream that runs dry only after the caller's own abort has already landed -- an intentional
  // shutdown must never be recorded as a gap, regardless of what the ledger holds
  it.each([
    ['no ledger', undefined],
    ['empty ledger', createOwnershipLedger()],
    [
      'fully settled ledger',
      (() => {
        const ledger = createOwnershipLedger()
        ledger.adopt(CHILD_SESSION_ID, 'do the thing')
        ledger.settle(CHILD_SESSION_ID)
        return ledger
      })(),
    ],
    [
      'outstanding ledger',
      (() => {
        const ledger = createOwnershipLedger()
        ledger.adopt(CHILD_SESSION_ID, 'do the thing')
        return ledger
      })(),
    ],
  ] satisfies [string, OwnershipLedger | undefined][])(
    'does not record a discontinuity on an intentional caller-requested shutdown (%s)',
    async (_label, ledger) => {
      // #given a signal the caller aborts exactly when this scripted stream naturally runs dry
      const abortController = new AbortController()
      const eventStream = createMockEventStream([messageUpdatedEvent(ROOT_SESSION_ID)], () => abortController.abort())

      // #when processed
      const result = await processEventStream(
        eventStream,
        ROOT_SESSION_ID,
        abortController.signal,
        createMockLogger(),
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then no gap is fabricated for an intentional shutdown, in any ledger state
      expect(result.discontinuity).toBeUndefined()
    },
  )

  it('still records a discontinuity on a thrown transport failure regardless of ledger occupancy', async () => {
    // #given a stream that throws mid-iteration with an empty (not outstanding) ledger -- pins that
    // the thrown-error path was never gated on ledger occupancy and stays unaffected by the widening
    const ledger = createOwnershipLedger()
    const eventStream = createDiscontinuousEventStream([], new Error('connection reset'))

    // #when processed
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the thrown discontinuity is still recorded
    expect(result.discontinuity).toEqual({message: 'connection reset'})
  })

  it('an ordinary successful run records no discontinuity and still completes normally', async () => {
    // #given a clean run: activity followed by the terminal signal, with the caller aborting only
    // after that terminal signal is what drives the stream closed -- the production shape
    const ledger = createOwnershipLedger()
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream(
      [
        {
          type: 'message.part.delta',
          properties: {sessionID: ROOT_SESSION_ID, delta: {type: 'text', text: 'hello'}},
        } as unknown as Event,
        {type: 'session.idle', properties: {sessionID: ROOT_SESSION_ID}} as unknown as Event,
      ],
      () => abortController.abort(),
    )

    // #when processed
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      activityTracker,
      undefined,
      undefined,
      ledger,
    )

    // #then the run completes normally with no fabricated gap
    expect(result.discontinuity).toBeUndefined()
    expect(activityTracker.sessionIdle).toBe(true)
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
    expect(result.llmError).toBeNull()
  })

  it('behaves exactly as before when no background dispatch occurs and no ledger is supplied (integration)', async () => {
    // #given a single-session run with ordinary activity and no ledger — the byte-for-byte-unchanged path
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {sessionID: ROOT_SESSION_ID, delta: {type: 'text', text: 'hello'}},
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: ROOT_SESSION_ID}} as unknown as Event,
    ])

    // #when processed with no ownershipLedger argument at all
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then normal single-session completion, unaffected by the ownership machinery
    expect(activityTracker.sessionIdle).toBe(true)
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
    expect(result.llmError).toBeNull()
  })

  it('is inert when no ledger is supplied even though a background dispatch event arrives', async () => {
    // #given the same background-dispatch event as the adopt test, but no ledger argument
    const eventStream = createMockEventStream([backgroundDispatchEvent(ROOT_SESSION_ID, CHILD_SESSION_ID)])
    const logger = createMockLogger()

    // #when processed without a ledger
    const result = await processEventStream(eventStream, ROOT_SESSION_ID, new AbortController().signal, logger)

    // #then no adoption side effect occurs — nothing to assert on a ledger that was never created,
    // and no dispatch-adoption log line is emitted
    expect(result).toBeDefined()
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('adopted into ownership ledger'),
      expect.anything(),
    )
  })
})

describe('processEventStream — structured failure capture on the activity tracker', () => {
  it('a terminal provider failure is retrievable in structured form immediately after observation', async () => {
    // #given an activity tracker and a context_overflow session.error on the root session
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([contextOverflowErrorEvent(ROOT_SESSION_ID)])

    // #when processed
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then the structured ErrorInfo and its classification path are retrievable directly off the tracker
    expect(activityTracker.terminalProviderError?.type).toBe('context_overflow')
    expect(activityTracker.classificationPath).toBe('structured')

    // #then a run with only a terminal failure never records a generic one
    expect(activityTracker.genericError).toBeUndefined()
  })

  it('a generic failure is retrievable in structured form immediately, and a later terminal failure upgrades it', async () => {
    // #given an activity tracker and a generic session.error, observed in its own call so the
    // structured record can be inspected before anything terminal arrives
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    await processEventStream(
      createMockEventStream([sessionErrorEvent(ROOT_SESSION_ID)]),
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then the generic failure is retrievable in structured form immediately — not just as the string on sessionError
    expect(activityTracker.genericError?.type).toBeDefined()
    expect(activityTracker.genericError?.type).not.toBe('context_overflow')
    expect(activityTracker.terminalProviderError).toBeUndefined()

    // #when a later terminal provider failure is observed on the same tracker
    const result = await processEventStream(
      createMockEventStream([contextOverflowErrorEvent(ROOT_SESSION_ID)]),
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then the terminal failure upgrades it — the terminal record now wins and the earlier
    // generic record is cleared rather than left reachable, and the final llmError returned to
    // the caller reflects the upgrade, not the earlier generic error
    expect(activityTracker.terminalProviderError?.type).toBe('context_overflow')
    expect(activityTracker.genericError).toBeUndefined()
    expect(result.llmError?.type).toBe('context_overflow')
  })

  it('a second generic failure does not displace the first', async () => {
    // #given an activity tracker and two distinct generic session.error events on the root session
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const secondGenericErrorEvent: Event = {
      type: 'session.error',
      properties: {sessionID: ROOT_SESSION_ID, error: 'second failure'},
    } as unknown as Event
    const eventStream = createMockEventStream([sessionErrorEvent(ROOT_SESSION_ID), secondGenericErrorEvent])

    // #when processed
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then the first generic error's message is preserved, not overwritten by the second
    expect(activityTracker.sessionError).toBe('boom')

    // #then still no terminal failure was ever observed
    expect(activityTracker.terminalProviderError).toBeUndefined()
  })

  it('a classified root retry status no longer sets terminal lifecycle state, but its failure still merges with full precedence', async () => {
    // #given an activity tracker and a root session.status retry classified as terminal (quota)
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const result = await processEventStream(
      createMockEventStream([retryStatusEvent(ROOT_SESSION_ID)]),
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then the failure still merges with full precedence -- terminal, structured, retrievable
    // immediately off the tracker -- exactly as before this change
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(activityTracker.terminalProviderError?.type).toBe('quota_exceeded')
    expect(activityTracker.classificationPath).toBe('structured')

    // #then selecting this error is not proof the turn ended -- that lifecycle flag is reserved
    // for truly terminal signals (session.idle, a completed assistant message)
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
  })

  it("complement: the root's own retry status behaves exactly as before apart from the lifecycle write", async () => {
    // #given a root session.status retry followed by the actual terminal signal (session.idle)
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const idleEvent: Event = {type: 'session.idle', properties: {sessionID: ROOT_SESSION_ID}} as unknown as Event
    const result = await processEventStream(
      createMockEventStream([retryStatusEvent(ROOT_SESSION_ID), idleEvent]),
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then the failure is still observed and returned, and the lifecycle flag is set -- by the
    // session.idle signal that actually observed quiescence, not by the classification itself
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
    expect(activityTracker.sessionIdle).toBe(true)
  })
})

describe('processEventStream — ownership check widens descendant events, no-ledger path unchanged', () => {
  it('message.part.delta: without a ledger a descendant delta never reaches output, with a ledger it does', async () => {
    // #given the same delta event on the CHILD session, run twice: no ledger, then with the child adopted.
    // No trailing session.idle, so the only observable effect is the final `lastText` flush at return time.
    consoleMocks.outputTextContent.mockClear()
    const withoutLedger = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {sessionID: CHILD_SESSION_ID, delta: {type: 'text', text: 'x'}},
      } as unknown as Event,
    ])

    // #when processed with no ledger
    await processEventStream(withoutLedger, ROOT_SESSION_ID, new AbortController().signal, createMockLogger())

    // #then the descendant's delta text never reached output
    expect(consoleMocks.outputTextContent).not.toHaveBeenCalled()

    // #given the same event, but the child is now adopted
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const withLedger = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {sessionID: CHILD_SESSION_ID, delta: {type: 'text', text: 'x'}},
      } as unknown as Event,
    ])

    // #when processed with the ledger supplied
    await processEventStream(
      withLedger,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the descendant's delta text is now flushed to output
    expect(consoleMocks.outputTextContent).toHaveBeenCalledWith('x')
  })

  it('session.next.tool.called + session.next.tool.success: without a ledger a descendant tool call never renders, with a ledger it does', async () => {
    // #given the called+success pair on the CHILD session, run twice
    consoleMocks.outputToolExecution.mockClear()
    const calledEvent = (sessionID: string): Event =>
      ({
        type: 'session.next.tool.called',
        properties: {sessionID, callID: 'call-1', tool: 'bash', input: {command: 'echo hi'}},
      }) as unknown as Event
    const successEvent = (sessionID: string): Event =>
      ({type: 'session.next.tool.success', properties: {sessionID, callID: 'call-1'}}) as unknown as Event

    // #when processed with no ledger
    await processEventStream(
      createMockEventStream([calledEvent(CHILD_SESSION_ID), successEvent(CHILD_SESSION_ID)]),
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
    )

    // #then never rendered — the called event was dropped, so success has no correlated call info either
    expect(consoleMocks.outputToolExecution).not.toHaveBeenCalled()

    // #given the child is now adopted
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')

    // #when processed with the ledger supplied
    await processEventStream(
      createMockEventStream([calledEvent(CHILD_SESSION_ID), successEvent(CHILD_SESSION_ID)]),
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then now rendered
    expect(consoleMocks.outputToolExecution).toHaveBeenCalledWith('bash', 'echo hi')
  })

  it('message.updated: without a ledger a foreign session never sets tokens, same as before', async () => {
    // #given no ledger and a message.updated for an unrelated session
    const eventStream = createMockEventStream([messageUpdatedEvent(UNOWNED_SESSION_ID)])

    // #when processed
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
    )

    // #then no token usage leaked in from the foreign session
    expect(result.tokens).toBeNull()
  })

  it('message.updated: with a ledger an ADOPTED descendant now sets tokens, unlike before', async () => {
    // #given a ledger that has adopted the child session, and a message.updated on that child
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([messageUpdatedEvent(CHILD_SESSION_ID)])

    // #when processed with the ledger supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the descendant's token usage is now recorded
    expect(result.tokens).not.toBeNull()
  })

  it("message.updated: a root-only run (no ledger) reports the root session's totals unchanged", async () => {
    // #given two message.updated reports on the root session only, no ledger
    const eventStream = createMockEventStream([
      messageUpdatedEventWithTokens(ROOT_SESSION_ID, {input: 10, output: 5, reasoning: 1, cache: {read: 2, write: 3}}),
      messageUpdatedEventWithTokens(ROOT_SESSION_ID, {input: 20, output: 8, reasoning: 2, cache: {read: 4, write: 6}}),
    ])

    // #when processed without a ledger
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
    )

    // #then the latest root report wins, exactly as plain assignment always produced
    expect(result.tokens).toEqual({input: 20, output: 8, reasoning: 2, cache: {read: 4, write: 6}})
  })

  it('message.updated: two owned sessions each reporting tokens sum rather than overwrite', async () => {
    // #given a ledger adopting a child, and both root and child reporting token usage
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([
      messageUpdatedEventWithTokens(ROOT_SESSION_ID, {input: 10, output: 5, reasoning: 1, cache: {read: 2, write: 3}}),
      messageUpdatedEventWithTokens(CHILD_SESSION_ID, {input: 7, output: 3, reasoning: 0, cache: {read: 1, write: 1}}),
    ])

    // #when processed with the ledger supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the two sessions' totals are summed, not overwritten
    expect(result.tokens).toEqual({input: 17, output: 8, reasoning: 1, cache: {read: 3, write: 4}})
  })

  it("message.updated: a descendant's message arriving after the root's does not erase the root's contribution", async () => {
    // #given a ledger adopting a child, with the CHILD's report arriving AFTER the root's
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([
      messageUpdatedEventWithTokens(ROOT_SESSION_ID, {input: 10, output: 5, reasoning: 1, cache: {read: 2, write: 3}}),
      messageUpdatedEventWithTokens(CHILD_SESSION_ID, {input: 7, output: 3, reasoning: 0, cache: {read: 1, write: 1}}),
    ])

    // #when processed with the ledger supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the root's contribution (input: 10, output: 5) is still present in the sum —
    // this is the regression guard: against plain assignment, the child's later report
    // would replace the root's entirely, leaving {input: 7, output: 3, ...} instead.
    expect(result.tokens?.input).toBeGreaterThanOrEqual(10)
    expect(result.tokens).toEqual({input: 17, output: 8, reasoning: 1, cache: {read: 3, write: 4}})
  })

  it('message.updated: repeated cumulative reports from one session count once, not twice', async () => {
    // #given a ledger adopting a child, with the child reporting twice (a growing cumulative total for the same message)
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([
      messageUpdatedEventWithTokens(ROOT_SESSION_ID, {input: 10, output: 5, reasoning: 1, cache: {read: 2, write: 3}}),
      messageUpdatedEventWithTokens(CHILD_SESSION_ID, {input: 5, output: 2, reasoning: 0, cache: {read: 0, write: 0}}),
      messageUpdatedEventWithTokens(CHILD_SESSION_ID, {input: 7, output: 3, reasoning: 0, cache: {read: 1, write: 1}}),
    ])

    // #when processed with the ledger supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then the child's second (cumulative) report replaces its first, not adds to it —
    // sum is root (10) + child's LATEST report (7) = 17, not 10 + 5 + 7 = 22
    expect(result.tokens).toEqual({input: 17, output: 8, reasoning: 1, cache: {read: 3, write: 4}})
  })

  it('session.error: without a ledger a foreign session never sets llmError, same as before', async () => {
    // #given no ledger and a session.error for an unrelated session
    const eventStream = createMockEventStream([sessionErrorEvent(UNOWNED_SESSION_ID)])

    // #when processed
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
    )

    // #then no error leaked in from the foreign session
    expect(result.llmError).toBeNull()
  })

  it("session.error: a descendant's error does not end the parent's turn or surface as this run's llmError", async () => {
    // #given a ledger that has adopted the child session, an activity tracker, and a session.error on the CHILD
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([sessionErrorEvent(CHILD_SESSION_ID)])

    // #when processed with the ledger and tracker supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
      undefined,
      undefined,
      ledger,
    )

    // #then the descendant's error does not reach this run's llmError and does not end the turn
    expect(result.llmError).toBeNull()
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
    expect(activityTracker.sessionError).toBeNull()

    // #then it is still observed: the descendant's ledger entry no longer reads outstanding
    expect(ledger.snapshot()).toEqual([{sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'unknown'}])
  })

  it("session.error: a descendant's context_overflow does not surface as llmError, so it cannot trigger root-session overflow recovery", async () => {
    // #given a ledger that has adopted the child session, and a context_overflow session.error on the CHILD
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([contextOverflowErrorEvent(CHILD_SESSION_ID)])

    // #when processed with the ledger supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then no llmError reaches the caller — `runExecute`'s overflow-recovery gate
    // (`result.llmError?.type === 'context_overflow'`) never sees this descendant's error
    expect(result.llmError).toBeNull()
    expect(ledger.snapshot()).toEqual([{sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'unknown'}])
  })

  it("session.error: the ROOT session's own context_overflow error still ends the turn and still surfaces as llmError, unchanged", async () => {
    // #given a ledger (present, but the error fires on the ROOT session id, not a descendant) and an activity tracker
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([contextOverflowErrorEvent(ROOT_SESSION_ID)], () =>
      abortController.abort(),
    )

    // #when processed with the ledger and tracker supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      activityTracker,
      undefined,
      undefined,
      ledger,
    )

    // #then the root's own error still ends the turn and still surfaces as llmError, exactly as before ownership widening
    expect(result.llmError?.type).toBe('context_overflow')
    // Classifying this error is not proof the turn ended -- that lifecycle flag is reserved for
    // truly terminal signals (session.idle, a completed assistant message), which this test never emits.
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
    // #then the unrelated adopted descendant entry is untouched by the root's own error
    expect(ledger.snapshot()).toEqual([{sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'outstanding'}])
  })

  it('session.error: a run with no ledger is unaffected by the root-scoping change', async () => {
    // #given no ledger at all, and a session.error on the root session (the only session a no-ledger run knows about)
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([contextOverflowErrorEvent(ROOT_SESSION_ID)])

    // #when processed with no ledger
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then unchanged: the root session's own error still ends the turn and surfaces as llmError
    expect(result.llmError?.type).toBe('context_overflow')
    // Classifying this error is not proof the turn ended.
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
  })

  it("session.status: a descendant's retry status does not write root failure state, root llmError, or root lifecycle state", async () => {
    // #given a ledger that has adopted the child session, an activity tracker, and a retry status on the CHILD
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([retryStatusEvent(CHILD_SESSION_ID)])

    // #when processed with the ledger and tracker supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
      undefined,
      undefined,
      ledger,
    )

    // #then the descendant's retry status does not reach this run's llmError, root failure
    // accumulator, or lifecycle state
    expect(result.llmError).toBeNull()
    expect(activityTracker.terminalProviderError).toBeUndefined()
    expect(activityTracker.sessionError).toBeNull()
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)

    // #then it is still observed: the descendant's ledger entry no longer reads outstanding, and
    // is left unresolved (marked unknown), not settled -- a retry status is not proof the
    // descendant's own turn concluded either
    expect(ledger.snapshot()).toEqual([{sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'unknown'}])
  })

  it("complement: the ROOT session's own retry status still ends the turn and still writes root failure state, unchanged", async () => {
    // #given a ledger (present, but the retry status fires on the ROOT session id, not a descendant) and a tracker
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([retryStatusEvent(ROOT_SESSION_ID)], () => abortController.abort())

    // #when processed with the ledger and tracker supplied
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      abortController.signal,
      createMockLogger(),
      activityTracker,
      undefined,
      undefined,
      ledger,
    )

    // #then the root's own retry status still merges into llmError and the tracker's failure state,
    // exactly as before ownership widening -- only the lifecycle write is gone (see Finding A)
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(activityTracker.terminalProviderError?.type).toBe('quota_exceeded')
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)

    // #then the unrelated adopted descendant entry is untouched by the root's own retry status
    expect(ledger.snapshot()).toEqual([{sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'outstanding'}])
  })

  it('session.status: a run with no ledger is unaffected by the root-scoping change', async () => {
    // #given no ledger at all, and a retry status on the root session (the only session a no-ledger run knows about)
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([retryStatusEvent(ROOT_SESSION_ID)])

    // #when processed with no ledger
    const result = await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then unchanged: the root session's own retry status still merges into llmError
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(activityTracker.terminalProviderError?.type).toBe('quota_exceeded')
  })

  it('session.idle stays root-scoped: a descendant idle never ends the run', async () => {
    // #given a ledger owning a child, and an idle event fired on the CHILD, not the root
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {type: 'session.idle', properties: {sessionID: CHILD_SESSION_ID}} as unknown as Event,
    ])

    // #when processed
    await processEventStream(
      eventStream,
      ROOT_SESSION_ID,
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
      undefined,
      undefined,
      ledger,
    )

    // #then the run's own activityTracker never observes idle from the descendant's idle
    expect(activityTracker.sessionIdle).toBe(false)
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
  })
})

describe('RootFreshnessTracker — Phase A scaffolding transitions (previously untested)', () => {
  it('starts unarmed, and every mutator is a no-op before arming', () => {
    // #given a freshly created tracker
    const tracker = createRootFreshnessTracker()
    expect(tracker.state).toBe('unarmed')

    // #when invalidation/idle are attempted before arming
    invalidateRootFreshness(tracker)
    markRootIdleCandidate(tracker)

    // #then nothing changed — state stays unarmed, revision stays 0
    expect(tracker.state).toBe('unarmed')
    expect(tracker.revision).toBe(0)
    expect(hasFreshIdleCandidate(tracker)).toBe(false)
  })

  it('arm -> idle-candidate -> fresh; a subsequent invalidation makes it stale at the OLD revision', () => {
    // #given an armed tracker
    const tracker = createRootFreshnessTracker()
    armRootFreshness(tracker)
    expect(tracker.state).toBe('awaiting-activity')
    expect(hasFreshIdleCandidate(tracker)).toBe(false)

    // #when it goes idle
    markRootIdleCandidate(tracker)

    // #then it is a fresh idle candidate at the current revision
    expect(tracker.state).toBe('idle-candidate')
    expect(hasFreshIdleCandidate(tracker)).toBe(true)

    // #when renewed activity is observed afterward
    invalidateRootFreshness(tracker)

    // #then the candidate is no longer fresh — revision advanced past idleCandidateRevision
    expect(tracker.state).toBe('active')
    expect(hasFreshIdleCandidate(tracker)).toBe(false)
  })

  it('a new root user message sets the pending-parent barrier and blocks freshness until resolved', () => {
    // #given an armed, idle tracker
    const tracker = createRootFreshnessTracker()
    armRootFreshness(tracker)
    markRootIdleCandidate(tracker)
    expect(hasFreshIdleCandidate(tracker)).toBe(true)

    // #when a new root user message arrives (e.g. an injected background-task completion turn)
    registerPendingRootUserMessage(tracker, 'msg_injected')

    // #then the barrier blocks freshness even though nothing has gone idle again yet
    expect(tracker.pendingParentMessageId).toBe('msg_injected')
    expect(tracker.latestRootUserMessageId).toBe('msg_injected')
    expect(hasFreshIdleCandidate(tracker)).toBe(false)

    // #when that message's own idle is observed while the barrier is still set
    markRootIdleCandidate(tracker)

    // #then still not fresh — the barrier alone blocks admission regardless of idle-candidate state
    expect(hasFreshIdleCandidate(tracker)).toBe(false)

    // #when the barrier is resolved by the matching assistant reply
    resolvePendingRootUserMessage(tracker, 'msg_injected')

    // #then the barrier itself is clear, but the bump that registered this pending message
    // superseded an existing idle candidate (Finding 1's fix, `invalidateRootFreshness`) -- SSE
    // carries no sequence number, so the idle evidence for this new generation cannot be trusted
    // until a REST/status check corroborates it, exactly as for a delayed idle race
    expect(tracker.pendingParentMessageId).toBeNull()
    expect(hasFreshIdleCandidate(tracker)).toBe(false)

    // #when a REST check corroborates the current generation
    clearRootRevalidationRequirement(tracker)

    // #then freshness is restored
    expect(hasFreshIdleCandidate(tracker)).toBe(true)
  })

  it('registering the same pending message id twice is a no-op — duplicate events do not create a phantom pending turn or re-advance the revision', () => {
    // #given an armed, idle tracker with a pending parent message already registered
    const tracker = createRootFreshnessTracker()
    armRootFreshness(tracker)
    markRootIdleCandidate(tracker)
    registerPendingRootUserMessage(tracker, 'msg_injected')
    const revisionAfterFirstRegister = tracker.revision

    // #when the same message id is registered again (e.g. a duplicate/retried SSE event)
    registerPendingRootUserMessage(tracker, 'msg_injected')

    // #then the revision did not advance again, and the barrier is unchanged
    expect(tracker.revision).toBe(revisionAfterFirstRegister)
    expect(tracker.pendingParentMessageId).toBe('msg_injected')
  })

  it('resolving a barrier with a mismatched id is a no-op', () => {
    // #given a tracker with a pending parent message
    const tracker = createRootFreshnessTracker()
    armRootFreshness(tracker)
    registerPendingRootUserMessage(tracker, 'msg_a')

    // #when a DIFFERENT message id is resolved (e.g. a stale/out-of-order reply)
    resolvePendingRootUserMessage(tracker, 'msg_b')

    // #then the real barrier is untouched
    expect(tracker.pendingParentMessageId).toBe('msg_a')
  })

  it('an SSE discontinuity requires REST revalidation before any retained idle evidence can be trusted again', () => {
    // #given a fresh idle candidate
    const tracker = createRootFreshnessTracker()
    armRootFreshness(tracker)
    markRootIdleCandidate(tracker)
    expect(hasFreshIdleCandidate(tracker)).toBe(true)

    // #when the observation channel breaks
    requireRootRevalidation(tracker)

    // #then the same idle evidence is no longer trusted, even though nothing else changed
    expect(hasFreshIdleCandidate(tracker)).toBe(false)

    // #when a REST check corroborates current state
    clearRootRevalidationRequirement(tracker)

    // #then freshness is restored
    expect(hasFreshIdleCandidate(tracker)).toBe(true)
  })

  it('two consecutive injected parent-user-message barriers require BOTH to resolve before freshness returns', () => {
    // #given an armed, idle tracker
    const tracker = createRootFreshnessTracker()
    armRootFreshness(tracker)
    markRootIdleCandidate(tracker)

    // #when a first injected turn arrives and resolves
    registerPendingRootUserMessage(tracker, 'msg_first')
    resolvePendingRootUserMessage(tracker, 'msg_first')
    markRootIdleCandidate(tracker)
    // The bump that registered 'msg_first' superseded the initial idle candidate, so this
    // generation's freshness needs REST corroboration (Finding 1) before it is trusted, even
    // though the barrier itself is already resolved.
    expect(hasFreshIdleCandidate(tracker)).toBe(false)
    clearRootRevalidationRequirement(tracker)
    expect(hasFreshIdleCandidate(tracker)).toBe(true)

    // #when a second injected turn arrives (a second background dispatch completing)
    registerPendingRootUserMessage(tracker, 'msg_second')

    // #then it blocks freshness again, independently of the first
    expect(hasFreshIdleCandidate(tracker)).toBe(false)
    expect(tracker.pendingParentMessageId).toBe('msg_second')

    // #when only an unrelated id is resolved
    resolvePendingRootUserMessage(tracker, 'msg_first')

    // #then the second barrier still blocks
    expect(hasFreshIdleCandidate(tracker)).toBe(false)

    // #when the actual second barrier resolves
    resolvePendingRootUserMessage(tracker, 'msg_second')
    markRootIdleCandidate(tracker)

    // #then the barrier is clear, but this generation (superseding the second idle candidate) also
    // needs its own REST corroboration before freshness returns
    expect(hasFreshIdleCandidate(tracker)).toBe(false)
    clearRootRevalidationRequirement(tracker)
    expect(hasFreshIdleCandidate(tracker)).toBe(true)
  })
})
