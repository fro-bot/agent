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
import {processEventStream, type ActivityTracker, type PermissionAskedRequest} from './streaming.js'

const consoleMocks = vi.hoisted(() => ({
  outputTextContent: vi.fn(),
  outputToolExecution: vi.fn(),
}))

vi.mock('../../shared/console.js', () => consoleMocks)

const ROOT_SESSION_ID = 'ses_root'
const CHILD_SESSION_ID = 'ses_child'
const UNOWNED_SESSION_ID = 'ses_stranger'

function createMockEventStream(events: readonly Event[]): AsyncIterable<Event> {
  return (async function* () {
    for (const event of events) {
      yield event
    }
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

function toolSuccessEvent(sessionID: string): Event {
  return {
    type: 'session.next.tool.called',
    properties: {sessionID, callID: 'call-1', tool: 'bash', input: {command: 'echo hi'}},
  } as unknown as Event
}

describe('processEventStream — ownership ledger integration', () => {
  it('opens a ledger entry when a background dispatch on an owned session is observed', async () => {
    // #given a ledger and a background dispatch event on the root session
    const ledger = createOwnershipLedger()
    const eventStream = createMockEventStream([
      backgroundDispatchEvent(ROOT_SESSION_ID, CHILD_SESSION_ID, 'do the thing'),
    ])

    // #when the stream is processed with the ledger supplied
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
    const eventStream = createMockEventStream([
      injectedCompletionEvent(CHILD_SESSION_ID, CHILD_SESSION_ID, 'completed'),
    ])

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

    // #then the entry is untouched — settlement only fires for text landing on the root session
    expect(ledger.outstanding()).toBe(1)
  })

  it('ignores an event from an unowned session even with a ledger present', async () => {
    // #given a ledger that owns only the root and one adopted child, and an event from a third, unrelated session
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([toolSuccessEvent(UNOWNED_SESSION_ID)])
    const logger = createMockLogger()

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

  it('marks outstanding entries unknown on a stream discontinuity', async () => {
    // #given a ledger with an outstanding child, and a stream that throws mid-iteration
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createDiscontinuousEventStream([], new Error('connection reset'))

    // #when the stream is processed
    await expect(
      processEventStream(
        eventStream,
        ROOT_SESSION_ID,
        new AbortController().signal,
        createMockLogger(),
        undefined,
        undefined,
        undefined,
        ledger,
      ),
    ).rejects.toThrow('connection reset')

    // #then the outstanding entry is downgraded to unknown, never inferred as settled
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.unknown()).toBe(1)
    expect(ledger.snapshot()).toContainEqual({sessionId: CHILD_SESSION_ID, label: 'do the thing', state: 'unknown'})
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

  it("session.error: with a ledger an ADOPTED descendant's error is now this run's problem too, unlike before", async () => {
    // #given a ledger that has adopted the child session, and a session.error on that child
    const ledger: OwnershipLedger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'do the thing')
    const eventStream = createMockEventStream([sessionErrorEvent(CHILD_SESSION_ID)])

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

    // #then the descendant's error surfaces as this run's llmError
    expect(result.llmError).not.toBeNull()
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
