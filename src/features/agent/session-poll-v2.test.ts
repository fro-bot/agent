import type {RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {observeRootTerminal, pollForSessionCompletionObservationV2} from './session-poll-v2.js'
import {createActivityTrackerV2} from './streaming-v2.js'

const ROOT = 'ses_root'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return {promise, resolve}
}

function client(overrides: {
  active?: () => Promise<Record<string, unknown>>
  outcome?: () => Promise<{success: true; data: {outcome: string | null}}>
}): RemoteOpenCodeV2Client {
  return {
    session: {active: vi.fn(overrides.active ?? (async () => ({})))},
    getSession: vi.fn(overrides.outcome ?? (async () => ({success: true as const, data: {outcome: 'succeeded'}}))),
  } as unknown as RemoteOpenCodeV2Client
}

const FAST = {pollIntervalMs: 5, restEveryTicks: 1}

/** A tracker for a root that ran, went idle, and whose wait route said so without a result: REST is trusted. */
function idleRoot() {
  const tracker = createActivityTrackerV2()
  tracker.firstMeaningfulEventReceived = true
  tracker.rootExecutionStarted = true
  tracker.idleHintWithoutTerminal = true
  return tracker
}

describe('pollForSessionCompletionObservationV2', () => {
  it('does not accept the previous turn persisted success in the gap between a queued notice and the next turn', async () => {
    // #given an idle root whose persisted outcome is the old turn's success, and a notice queued for it
    const tracker = idleRoot()
    tracker.queuedNoticeInboxIds.add('msg_notice')
    tracker.turnOwed = true
    const controller = new AbortController()
    const api = client({})

    // #when the poll runs through many ticks with the notice still waiting for its turn
    const poll = pollForSessionCompletionObservationV2({
      client: api,
      sessionId: ROOT,
      signal: controller.signal,
      logger: createMockLogger(),
      tracker,
      ...FAST,
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    controller.abort()
    const observation = await poll

    // #then nothing authorized completion: the old success was not read back, and the poll ended only on the abort
    expect(tracker.rootTerminal).toBeNull()
    expect(observation.settlement.kind).toBe('cancelled')
  })

  it('accepts the persisted result once the owed turn has run and ended', async () => {
    // #given the same root, with the notice turn started and finished
    const tracker = idleRoot()
    tracker.turnOwed = true
    const controller = new AbortController()
    const poll = pollForSessionCompletionObservationV2({
      client: client({}),
      sessionId: ROOT,
      signal: controller.signal,
      logger: createMockLogger(),
      tracker,
      ...FAST,
    })
    await new Promise(resolve => setTimeout(resolve, 40))

    // #when the owed turn starts (the fence lifts) and its result is the persisted one
    tracker.turnOwed = false
    tracker.rootRevision += 1
    const observation = await poll

    // #then
    expect(observation.settlement.kind).toBe('completion-observed')
  })

  it('discards a persisted success read that was pending when execution restarted', async () => {
    // #given two inactive reads, so the poll asks for the persisted outcome, and that request stays pending
    const tracker = idleRoot()
    const outcomeRead = deferred<{success: true; data: {outcome: string | null}}>()
    let activeCalls = 0
    const api = client({
      // Reads after the restart see the root running again.
      active: async () => {
        activeCalls += 1
        return activeCalls <= 2 ? {} : {[ROOT]: {type: 'running'}}
      },
      outcome: async () => outcomeRead.promise,
    })
    const controller = new AbortController()
    const poll = pollForSessionCompletionObservationV2({
      client: api,
      sessionId: ROOT,
      signal: controller.signal,
      logger: createMockLogger(),
      tracker,
      pollIntervalMs: 5,
      restEveryTicks: 1,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(api.getSession).toHaveBeenCalledTimes(1)

    // #when execution restarts while that read is pending, then the read comes back with the OLD turn's success
    tracker.rootRunning = true
    tracker.rootRevision += 1
    tracker.rootTerminal = null
    outcomeRead.resolve({success: true, data: {outcome: 'succeeded'}})
    await new Promise(resolve => setTimeout(resolve, 60))
    controller.abort()
    const observation = await poll

    // #then the old success never became the run's result
    expect(tracker.rootTerminal).toBeNull()
    expect(observation.settlement.kind).toBe('cancelled')
  })

  it('needs fresh inactive reads after execution restarts before it trusts the persisted outcome', async () => {
    // #given one inactive read already counted for the old turn
    const tracker = idleRoot()
    let reads = 0
    const api = client({
      active: async () => {
        reads += 1
        return {}
      },
    })
    const controller = new AbortController()
    const poll = pollForSessionCompletionObservationV2({
      client: api,
      sessionId: ROOT,
      signal: controller.signal,
      logger: createMockLogger(),
      tracker,
      pollIntervalMs: 20,
      restEveryTicks: 1,
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(reads).toBe(1)

    // #when execution restarts, so the next inactive read is the first of the new generation
    tracker.rootRevision += 1
    await new Promise(resolve => setTimeout(resolve, 25))

    // #then the second read since the start of the poll did not complete it
    expect(tracker.rootTerminal).toBeNull()
    controller.abort()
    await poll
  })
})

describe('observeRootTerminal', () => {
  it('defers a recorded success while a notice-triggered turn is owed, unless the stream is known to have lost events', () => {
    // #given a success on the tracker and a turn owed with nothing queued (the notice was delivered to the idle root)
    const tracker = createActivityTrackerV2()
    tracker.rootTerminal = {kind: 'succeeded'}
    tracker.turnOwed = true
    const logger = createMockLogger()

    // #when / #then
    expect(observeRootTerminal(tracker, logger)).toBeNull()
    tracker.streamBlind = true
    expect(observeRootTerminal(tracker, logger)?.settlement.kind).toBe('completion-observed')
  })

  it('does not defer a failure for an owed turn: a run that ended badly keeps its result', () => {
    // #given
    const tracker = createActivityTrackerV2()
    tracker.rootTerminal = {kind: 'failed'}
    tracker.turnOwed = true

    // #when / #then
    expect(observeRootTerminal(tracker, createMockLogger())?.settlement.kind).toBe('failure-observed')
  })
})
