/**
 * Tests for the gate's terminal notification as seen through the approval family.
 *
 * Every approval emits exactly one terminal event when it leaves the gate,
 * whether or not OpenCode's echo follows.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'
import type {RegisterParams, RenderFn} from './registry.js'
import type {TerminalEvent} from './request-gate.js'

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
