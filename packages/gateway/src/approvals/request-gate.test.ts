/**
 * Tests for the gate's terminal notification as seen through the approval family.
 *
 * Every approval emits exactly one terminal event when it leaves the gate,
 * whether or not OpenCode's echo follows.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'
import type {RegisterParams, RenderFn} from './registry.js'
import type {ApprovalGateEntry, QuestionGateEntry, TerminalEvent} from './request-gate.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createApprovalRegistry} from './registry.js'
import {createRequestGate} from './request-gate.js'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRequest(requestID: string, sessionID = 'ses_1'): PermissionRequest {
  return {requestID, sessionID, permission: 'bash', patterns: ['ls'], title: 'Run ls'}
}

function makeParams(requestID: string, overrides: Partial<RegisterParams> = {}): RegisterParams {
  const sessionID = overrides.sessionID ?? 'ses_1'
  return {
    requestID,
    sessionID,
    approvalScopeId: 'chan_1',
    directory: '/ws',
    request: makeRequest(requestID, sessionID),
    effects: {postReply: vi.fn().mockResolvedValue({ok: true})},
    ...overrides,
  }
}

function setup() {
  const logger = makeLogger()
  const gate = createRequestGate({logger})
  const registry = createApprovalRegistry({logger, gate})
  const terminals: TerminalEvent[] = []
  gate.onTerminal(event => {
    terminals.push(event)
  })
  return {logger, gate, registry, terminals}
}

const ACTOR = {kind: 'discord-user', userId: 'user_A'} as const
const OTHER_ACTOR = {kind: 'discord-user', userId: 'user_B'} as const

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('approval terminal notification', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('confirm of a claimed approval: one event after the echo, none before', async () => {
    // #given a claimed approval
    const {registry, terminals} = setup()
    registry.register(makeParams('per_1'))
    await registry.handleDecision({requestID: 'per_1', approvalScopeId: 'chan_1', decision: 'once', actor: ACTOR})
    expect(terminals).toEqual([])

    // #when the echo arrives
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await vi.advanceTimersByTimeAsync(10)

    // #then exactly one event with identifiers only
    expect(terminals).toEqual([
      {requestID: 'per_1', sessionID: 'ses_1', family: 'approval', scopeId: 'chan_1', outcome: 'confirmed'},
    ])
  })

  it('confirm of an open approval (OpenCode-initiated) emits one event', async () => {
    // #given
    const {registry, terminals} = setup()
    registry.register(makeParams('per_1'))

    // #when
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'always'})
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(terminals.map(event => event.outcome)).toEqual(['confirmed'])
  })

  it('deadline emits one event, and a late echo emits no second', async () => {
    // #given an approval with a deadline
    const {registry, terminals} = setup()
    registry.register(makeParams('per_1', {deadlineMs: 1_000}))

    // #when the deadline passes and the reject echo arrives afterwards
    await vi.advanceTimersByTimeAsync(1_000)
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'reject'})
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(terminals.map(event => event.outcome)).toEqual(['deadline'])
  })

  it('disposeRun emits one event per approval of the session', async () => {
    // #given approvals on two sessions
    const {registry, terminals} = setup()
    registry.register(makeParams('per_1'))
    registry.register(makeParams('per_2'))
    registry.register(makeParams('per_3', {sessionID: 'ses_2'}))

    // #when one session is disposed
    await registry.disposeRun('ses_1', 'run-ended')

    // #then
    expect(terminals.map(event => `${event.requestID}:${event.outcome}`).sort((a, b) => a.localeCompare(b))).toEqual([
      'per_1:disposed',
      'per_2:disposed',
    ])
  })

  it('a failed decision after the deadline fail-closes with one event', async () => {
    // #given a decision whose POST fails after the deadline fired
    const {registry, terminals} = setup()
    let resolveButton!: (value: {ok: boolean}) => void
    const postReply = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<{ok: boolean}>(resolve => {
          resolveButton = resolve
        }),
      )
      .mockResolvedValue({ok: true})
    registry.register(makeParams('per_1', {deadlineMs: 1_000, effects: {postReply}}))
    const decision = registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: ACTOR,
    })
    await vi.advanceTimersByTimeAsync(1_000)

    // #when the decision POST fails
    resolveButton({ok: false})
    await decision
    await vi.advanceTimersByTimeAsync(10)

    // #then fail-closed, once
    expect(terminals.map(event => event.outcome)).toEqual(['fail-closed'])
  })

  it('cascade-rejected siblings each emit one event', async () => {
    // #given two approvals on one session
    const {registry, terminals} = setup()
    registry.register(makeParams('per_A'))
    registry.register(makeParams('per_B'))

    // #when A is rejected
    registry.confirmReply({requestID: 'per_A', sessionID: 'ses_1', reply: 'reject'})
    await vi.advanceTimersByTimeAsync(10)

    // #then A confirmed, B cascaded
    expect(terminals.map(event => `${event.requestID}:${event.outcome}`).sort((a, b) => a.localeCompare(b))).toEqual([
      'per_A:confirmed',
      'per_B:cascade',
    ])
  })

  it('applySettlement emits one event and is idempotent', async () => {
    // #given
    const {registry, terminals} = setup()
    registry.register(makeParams('per_1'))

    // #when settled twice
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'disposed'})
    await registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'disposed'})

    // #then
    expect(terminals).toHaveLength(1)
  })

  it('re-registering a pending id emits nothing for the replaced entry; the replacement emits once', async () => {
    // #given an approval that is re-asked
    const {registry, terminals} = setup()
    const render: RenderFn = vi.fn().mockResolvedValue(undefined)
    registry.register(makeParams('per_1'))
    registry.attachMessage('per_1', render)
    registry.register(makeParams('per_1'))
    await vi.advanceTimersByTimeAsync(10)

    // #then the request id is still pending: no event yet
    expect(terminals).toEqual([])

    // #when the replacement settles
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await vi.advanceTimersByTimeAsync(10)

    // #then exactly one event for the request id
    expect(terminals).toHaveLength(1)
  })
})

describe('terminal listeners', () => {
  it('a throwing listener is contained and later listeners still run', async () => {
    // #given two listeners, the first throws
    const {gate, registry, logger} = setup()
    const second = vi.fn()
    gate.onTerminal(() => {
      throw new Error('listener bug')
    })
    gate.onTerminal(second)
    registry.register(makeParams('per_1'))

    // #when an approval settles
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await flush()

    // #then the error is logged and the second listener still got the event
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({requestID: 'per_1', family: 'approval'}),
      expect.stringContaining('terminal listener threw'),
    )
    expect(second).toHaveBeenCalledOnce()
  })

  it('an unsubscribed listener receives nothing', async () => {
    // #given
    const {gate, registry} = setup()
    const listener = vi.fn()
    const unsubscribe = gate.onTerminal(listener)
    unsubscribe()
    registry.register(makeParams('per_1'))

    // #when
    registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'once'})
    await flush()

    // #then
    expect(listener).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Gate-owned lifecycle operations: the paired steps never run on their own
// ---------------------------------------------------------------------------

/** A bare approval-family entry registered straight on the gate. */
function makeEntry(requestID: string, postDeadlineReply = vi.fn().mockResolvedValue({ok: true})): ApprovalGateEntry {
  return {
    family: 'approval',
    requestID,
    sessionID: 'ses_1',
    scopeId: 'chan_1',
    payload: {request: makeRequest(requestID), directory: '/ws', effects: {postReply: vi.fn()}, renderFn: null},
    ops: {
      postDeadlineReply,
      renderDeadline: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      onDeadlineSettled: undefined,
    },
    state: 'open',
    actor: null,
    timer: null,
    deadlineExpired: false,
    terminalFired: false,
  }
}

describe('gate lifecycle surface', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exposes no lifecycle primitive that could be called without its pair', () => {
    // #given a gate
    const {gate} = setup()

    // #when / #then only whole operations are exposed: no put-less timer, remove, terminate, claim, or detach
    expect(Object.keys(gate).sort((a, b) => a.localeCompare(b))).toEqual([
      'admit',
      'disposeAllAcrossFamilies',
      'disposeFamilyAll',
      'disposeFamilyRun',
      'get',
      'hasPendingForScope',
      'list',
      'logRenderFailure',
      'onTerminal',
      'put',
      'retire',
      'settleEcho',
      'settleNow',
    ])
  })

  it('settleNow clears the timer, removes the entry and emits one terminal event together', async () => {
    // #given an entry with a live deadline
    const {gate, terminals} = setup()
    const entry = makeEntry('per_1')
    gate.put(entry, 1_000)

    // #when
    gate.settleNow(entry, 'cascade')

    // #then it is gone, notified once, and its deadline can no longer fire
    expect(gate.get('per_1')).toBeUndefined()
    expect(terminals.map(event => event.outcome)).toEqual(['cascade'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(entry.ops.postDeadlineReply).not.toHaveBeenCalled()
    expect(terminals).toHaveLength(1)
  })

  it('retire clears the timer first, leaves the entry registered while the work runs, then removes and notifies', async () => {
    // #given an entry with a live deadline
    const {gate, terminals} = setup()
    const entry = makeEntry('per_1')
    gate.put(entry, 1_000)
    const seen: {registered: boolean; terminals: number}[] = []

    // #when it retires, with work that outlasts the deadline
    const retiring = gate.retire(entry, 'disposed', async () => {
      await new Promise(resolve => setTimeout(resolve, 2_000))
      seen.push({registered: gate.get('per_1') === entry, terminals: terminals.length})
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await retiring

    // #then the deadline never fired, the entry was still registered during the work, and it left once after it
    expect(entry.ops.postDeadlineReply).not.toHaveBeenCalled()
    expect(seen).toEqual([{registered: true, terminals: 0}])
    expect(gate.get('per_1')).toBeUndefined()
    expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
  })

  it('retire is a no-op for an entry that already left, and does not run its work', async () => {
    // #given an entry settled by an echo before the retire
    const {gate, terminals} = setup()
    const entry = makeEntry('per_1')
    gate.put(entry, undefined)
    await gate.settleEcho(entry, async () => undefined)
    const work = vi.fn().mockResolvedValue(undefined)

    // #when
    await gate.retire(entry, 'disposed', work)

    // #then
    expect(work).not.toHaveBeenCalled()
    expect(terminals.map(event => event.outcome)).toEqual(['confirmed'])
  })

  it('put returns the entry it replaces; the replaced entry is silent and its timer is cleared', async () => {
    // #given a registered entry with a deadline
    const {gate, terminals} = setup()
    const first = makeEntry('per_1')
    gate.put(first, 1_000)

    // #when a new entry takes the same request id
    const second = makeEntry('per_1')
    const replaced = gate.put(second, undefined)

    // #then the old one is handed back, its deadline is dead, and no terminal event was emitted for it
    expect(replaced).toBe(first)
    expect(gate.get('per_1')).toBe(second)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(first.ops.postDeadlineReply).not.toHaveBeenCalled()
    expect(second.ops.postDeadlineReply).not.toHaveBeenCalled()
    expect(terminals).toEqual([])

    // #and even if the replaced entry is settled later, it stays silent and the replacement stays registered
    await gate.settleEcho(first, async () => undefined)
    expect(terminals).toEqual([])
    expect(gate.get('per_1')).toBe(second)
  })

  it('put of a new request id replaces nothing', () => {
    // #given / #when
    const {gate} = setup()

    // #then
    expect(gate.put(makeEntry('per_1'), undefined)).toBeUndefined()
  })

  it('an admission claims only when submitted: a validation failure that never submits leaves the entry open', async () => {
    // #given an admitted entry
    const {gate} = setup()
    const entry = makeEntry('per_1')
    gate.put(entry, undefined)
    const admission = gate.admit(
      entry,
      {scopeId: 'chan_1', actor: ACTOR},
      (e, request) => e.scopeId === request.scopeId,
    )
    expect(admission.kind).toBe('admitted')

    // #when the family walks away without submitting
    // #then the entry is still open
    expect(entry.state).toBe('open')

    // #when it does submit
    const outcome = admission.kind === 'admitted' ? await admission.submit(async () => ({ok: true})) : undefined

    // #then it is claimed by the admitted actor and blocks the next decision
    expect(outcome).toBe('ok')
    expect(entry.state).toBe('claimed')
    expect(entry.actor).toBe(ACTOR)
    expect(gate.admit(entry, {scopeId: 'chan_1', actor: ACTOR}, () => true).kind).toBe('already-claimed')
  })

  it('two admissions granted before either submits: only the first claims, the second is refused without posting', async () => {
    // #given two admissions on one open entry
    const {gate} = setup()
    const entry = makeEntry('per_1')
    gate.put(entry, undefined)
    const first = gate.admit(entry, {scopeId: 'chan_1', actor: ACTOR}, () => true)
    const second = gate.admit(entry, {scopeId: 'chan_1', actor: OTHER_ACTOR}, () => true)
    const firstPost = vi.fn().mockResolvedValue({ok: true})
    const secondPost = vi.fn().mockResolvedValue({ok: true})

    // #when both submit
    const firstOutcome = first.kind === 'admitted' ? await first.submit(firstPost) : undefined
    const secondOutcome = second.kind === 'admitted' ? await second.submit(secondPost) : undefined

    // #then the second is refused, sends nothing, and does not steal the claim
    expect(firstOutcome).toBe('ok')
    expect(secondOutcome).toBe('already-claimed')
    expect(firstPost).toHaveBeenCalledOnce()
    expect(secondPost).not.toHaveBeenCalled()
    expect(entry.actor).toBe(ACTOR)
  })

  it('submit is one-shot: after a failed reply reopens the entry, a second submit on the same admission is refused', async () => {
    // #given an admission whose first submit fails and releases the claim
    const {gate} = setup()
    const entry = makeEntry('per_1')
    gate.put(entry, undefined)
    const admission = gate.admit(entry, {scopeId: 'chan_1', actor: ACTOR}, () => true)
    if (admission.kind !== 'admitted') throw new Error('expected an admission')
    expect(await admission.submit(async () => ({ok: false, error: 'down'}))).toBe('reply-failed')
    expect(entry.state).toBe('open')
    const retryPost = vi.fn().mockResolvedValue({ok: true})

    // #when the same admission submits again
    const outcome = await admission.submit(retryPost)

    // #then it is refused; the caller must be admitted afresh
    expect(outcome).toBe('already-claimed')
    expect(retryPost).not.toHaveBeenCalled()
    expect(entry.state).toBe('open')
  })

  it('submit re-checks currency: an entry settled or replaced after admit is refused, claiming nothing', async () => {
    // #given an admission, then the entry is replaced under the same request id
    const {gate, terminals} = setup()
    const entry = makeEntry('per_1')
    gate.put(entry, undefined)
    const admission = gate.admit(entry, {scopeId: 'chan_1', actor: ACTOR}, () => true)
    const replacement = makeEntry('per_1')
    gate.put(replacement, undefined)
    const post = vi.fn().mockResolvedValue({ok: true})

    // #when the stale admission submits
    const outcome = admission.kind === 'admitted' ? await admission.submit(post) : undefined

    // #then not-found: nothing sent, neither entry claimed
    expect(outcome).toBe('not-found')
    expect(post).not.toHaveBeenCalled()
    expect(entry.state).toBe('open')
    expect(replacement.state).toBe('open')
    expect(terminals).toEqual([])
  })

  it('submit re-checks state: an entry that stopped being open after admit is refused', async () => {
    // #given an admission, then another path claims the entry
    const {gate} = setup()
    const entry = makeEntry('per_1')
    gate.put(entry, undefined)
    const admission = gate.admit(entry, {scopeId: 'chan_1', actor: ACTOR}, () => true)
    entry.state = 'claimed'
    entry.actor = OTHER_ACTOR
    const post = vi.fn().mockResolvedValue({ok: true})

    // #when
    const outcome = admission.kind === 'admitted' ? await admission.submit(post) : undefined

    // #then
    expect(outcome).toBe('already-claimed')
    expect(post).not.toHaveBeenCalled()
    expect(entry.actor).toBe(OTHER_ACTOR)
  })

  it('approvals keep their caller-visible outcomes through the gate', async () => {
    // #given an approval and a second decision attempt after the first claimed it
    const {registry} = setup()
    registry.register(makeParams('per_1'))
    const first = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: ACTOR,
    })
    const second = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: ACTOR,
    })
    const unknown = await registry.handleDecision({
      requestID: 'per_missing',
      approvalScopeId: 'chan_1',
      decision: 'once',
      actor: ACTOR,
    })
    const wrongScope = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'chan_other',
      decision: 'once',
      actor: ACTOR,
    })

    // #then the vocabulary callers already handle
    expect([first, second, unknown, wrongScope]).toEqual(['ok', 'already-claimed', 'not-found', 'channel-mismatch'])
  })

  describe('retire leaves the gate even when the work rejects', () => {
    it('gate level: the entry is removed, one terminal event fires, the failure is logged by id, nothing escapes', async () => {
      // #given an entry whose retire work rejects
      const {gate, logger, terminals} = setup()
      const entry = makeEntry('per_1')
      gate.put(entry, 1_000)

      // #when it retires
      await expect(
        gate.retire(entry, 'disposed', async () => {
          throw new Error('render exploded: SECRET-TEXT')
        }),
      ).resolves.toBeUndefined()

      // #then it left once, its timer is dead, and the log carries the request id
      expect(gate.get('per_1')).toBeUndefined()
      expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'per_1'}),
        expect.stringContaining('retire work threw'),
      )
      await vi.advanceTimersByTimeAsync(5_000)
      expect(entry.ops.postDeadlineReply).not.toHaveBeenCalled()
      expect(terminals).toHaveLength(1)
    })

    it('a question entry logs the error name only, never its message', async () => {
      // #given a question-family entry whose work rejects with text in the message
      const {gate, logger} = setup()
      const entry: QuestionGateEntry = {
        ...makeEntry('que_1'),
        family: 'question',
        payload: {
          questions: [],
          runId: null,
          effects: {replyQuestion: vi.fn(), rejectQuestion: vi.fn()},
          renderFns: [],
        },
      }
      gate.put(entry, undefined)

      // #when
      await gate.retire(entry, 'disposed', async () => {
        throw new TypeError('QUESTION-TEXT-LEAK')
      })

      // #then
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('QUESTION-TEXT-LEAK')
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'que_1', errName: 'TypeError'}),
        expect.any(String),
      )
    })

    it('a replacement registered during the work is never removed and emits nothing', async () => {
      // #given an entry retiring with work that outlives a re-registration under the same id
      const {gate, terminals} = setup()
      const entry = makeEntry('per_1')
      gate.put(entry, undefined)
      const replacement = makeEntry('per_1')

      // #when
      await gate.retire(entry, 'disposed', async () => {
        gate.put(replacement, undefined)
        throw new Error('boom')
      })

      // #then the replacement is still the live entry for the id and no event was emitted for either
      expect(gate.get('per_1')).toBe(replacement)
      expect(terminals).toEqual([])
    })

    it('approval path: a settled render whose failure log also throws still removes the entry and emits once', async () => {
      // #given an approval whose render rejects while the log sink throws on the failure record
      const {registry, logger, terminals} = setup()
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      registry.register(makeParams('per_1'))
      registry.attachMessage('per_1', vi.fn().mockRejectedValue(new Error('discord down')))
      vi.mocked(logger.error).mockImplementationOnce(() => {
        throw new Error('log sink down')
      })

      try {
        // #when the approval is torn down
        await expect(
          registry.applySettlement({requestID: 'per_1', decision: 'reject', reason: 'disposed'}),
        ).resolves.toBeUndefined()
        await vi.advanceTimersByTimeAsync(10)

        // #then it is gone, exactly one event fired, and nothing was left unhandled
        expect(registry.has('per_1')).toBe(false)
        expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })
  })
})
