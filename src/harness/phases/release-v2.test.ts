import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {ReleaseOutcomeV2} from '../../features/agent/drain-v2.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {PRE_SHUTDOWN_REQUEST_TIMEOUT_MS} from '../../features/agent/drain-v2.js'
import {createActivityTrackerV2} from '../../features/agent/streaming-v2.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {boundRequests} from './release-v2.js'

const mocks = vi.hoisted(() => ({
  releaseRunV2: vi.fn(),
  pruneSessionsV2: vi.fn(),
  addSyntheticMessage: vi.fn(),
  createClient: vi.fn(),
}))

vi.mock('../../features/agent/drain-v2.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../features/agent/drain-v2.js')>()),
  releaseRunV2: mocks.releaseRunV2,
}))
vi.mock('../../features/agent/execution-v2.js', () => ({
  createActionClientV2: (handle: unknown): unknown => mocks.createClient(handle),
}))
vi.mock('./prune-v2.js', () => ({pruneSessionsV2: mocks.pruneSessionsV2}))

const handle = {
  url: 'http://127.0.0.1:1',
  directory: '/workspace',
  fetch: vi.fn(),
  shutdown: vi.fn(),
} as unknown as OpenCodeV2ServerHandle

function outcome(overrides: Partial<ReleaseOutcomeV2> = {}): ReleaseOutcomeV2 {
  return {
    quiet: true,
    drain: 'quiet',
    stopped: false,
    unknownCount: 0,
    shutdown: null,
    declineReason: null,
    ...overrides,
  }
}

async function release(overrides: Partial<Parameters<typeof import('./release-v2.js').runReleaseV2>[0]> = {}) {
  const {runReleaseV2} = await import('./release-v2.js')
  return runReleaseV2({
    serverHandle: handle,
    executionSucceeded: true,
    rootSessionId: 'ses_root',
    ledger: createOwnershipLedger(),
    runStartedAt: 1,
    deadlineMs: 60_000,
    sessionRetention: 7,
    logger: createMockLogger(),
    ...overrides,
  })
}

function liveFor(order: string[]) {
  const tracker = createActivityTrackerV2()
  tracker.rootTerminal = {kind: 'failed'}
  tracker.genericError = {type: 'api_error', message: 'notice turn failed', retryable: false}
  const result = {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }
  const refreshUsage = vi.fn(async () => ({tokens: null, cost: 0.2, model: null}))
  const observation = {
    tracker,
    snapshot: () => result,
    stop: async () => {
      order.push('stop')
      return result
    },
    refreshUsage,
  }
  return {observation, refreshUsage}
}

describe('runReleaseV2', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pruneSessionsV2.mockResolvedValue({prunedCount: 0, remainingCount: 0})
    mocks.addSyntheticMessage.mockResolvedValue({success: true, data: undefined})
    mocks.createClient.mockImplementation(() => ({addSyntheticMessage: mocks.addSyntheticMessage}))
  })

  it('reports a drained run as complete and allows persistence', async () => {
    // #given
    mocks.releaseRunV2.mockResolvedValue(outcome())

    // #when
    const result = await release()

    // #then
    expect(result).toEqual({
      drain: {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0},
      persistenceDeclineReason: undefined,
    })
    expect(mocks.releaseRunV2.mock.calls[0]?.[0]).toMatchObject({
      directory: '/workspace',
      rootSessionId: 'ses_root',
      executionSucceeded: true,
      deadlineMs: 60_000,
    })
  })

  it('reports a drain that ran out as expired, and an unconfirmed directory as a reason not to save', async () => {
    // #given
    mocks.releaseRunV2.mockResolvedValue(
      outcome({
        quiet: false,
        drain: 'expired',
        stopped: true,
        declineReason: 'the directory could not be confirmed quiet',
      }),
    )

    // #when
    const result = await release()

    // #then at least one unresolved entry is reported even though the ledger was empty
    expect(result.drain).toMatchObject({expired: true, unknownCount: 1})
    expect(result.persistenceDeclineReason).toBe('the directory could not be confirmed quiet')
  })

  it('does not call a stop after a failed execution an expired drain', async () => {
    // #given
    mocks.releaseRunV2.mockResolvedValue(outcome({drain: 'not-attempted', stopped: true}))

    // #when
    const result = await release({executionSucceeded: false})

    // #then
    expect(result.drain.expired).toBe(false)
    expect(result.persistenceDeclineReason).toBeUndefined()
  })

  it('prunes to the configured retention while the server is still up, through the release step', async () => {
    // #given the release runs its pre-shutdown step
    mocks.releaseRunV2.mockImplementation(
      async (options: {beforeShutdown?: (signal: AbortSignal) => Promise<void>}) => {
        await options.beforeShutdown?.(new AbortController().signal)
        return outcome()
      },
    )

    // #when
    await release({sessionRetention: 7})
    await release({sessionRetention: null})

    // #then
    expect(mocks.pruneSessionsV2.mock.calls[0]?.[0]).toMatchObject({
      directory: '/workspace',
      config: {maxSessions: 7},
    })
    expect(mocks.pruneSessionsV2.mock.calls[1]?.[0]).toMatchObject({config: {maxSessions: 50}})
  })

  it('writes the held run summary once the directory is quiet and before the server goes down, then prunes', async () => {
    // #given a summary the execute phase held back for this handle
    const order: string[] = []
    mocks.addSyntheticMessage.mockImplementation(async () => {
      order.push('summary')
      return {success: true, data: undefined}
    })
    mocks.pruneSessionsV2.mockImplementation(async () => {
      order.push('prune')
      return {prunedCount: 0, remainingCount: 0}
    })
    mocks.releaseRunV2.mockImplementation(
      async (options: {beforeShutdown?: (signal: AbortSignal) => Promise<void>}) => {
        order.push('quiet')
        await options.beforeShutdown?.(new AbortController().signal)
        order.push('shutdown')
        return outcome()
      },
    )

    // #when
    await release({deferredSummary: {sessionId: 'ses_root', text: 'summary text'}})

    // #then
    expect(order).toEqual(['quiet', 'summary', 'prune', 'shutdown'])
    expect(mocks.addSyntheticMessage).toHaveBeenCalledWith({sessionId: 'ses_root', text: 'summary text'})
  })

  it('does not write the held summary when the release never reached a quiet directory', async () => {
    // #given the release skips its pre-shutdown step
    mocks.releaseRunV2.mockResolvedValue(outcome({quiet: false, declineReason: 'not quiet'}))

    // #when
    await release({deferredSummary: {sessionId: 'ses_root', text: 'summary text'}})

    // #then nothing is written to a session that may still be running
    expect(mocks.addSyntheticMessage).not.toHaveBeenCalled()
  })

  it('still prunes and shuts down when the summary cannot be written', async () => {
    // #given
    mocks.addSyntheticMessage.mockRejectedValue(new Error('socket closed'))
    mocks.releaseRunV2.mockImplementation(
      async (options: {beforeShutdown?: (signal: AbortSignal) => Promise<void>}) => {
        await options.beforeShutdown?.(new AbortController().signal)
        return outcome()
      },
    )

    // #when
    await release({deferredSummary: {sessionId: 'ses_root', text: 'summary text'}})

    // #then
    expect(mocks.pruneSessionsV2).toHaveBeenCalledTimes(1)
  })

  describe('the event observation kept through the wait', () => {
    it('stops after the directory is decided, before the server goes down, and reports the last root turn', async () => {
      // #given an observation handed over in the execute result
      const order: string[] = []
      const {observation, refreshUsage} = liveFor(order)
      mocks.releaseRunV2.mockImplementation(
        async (options: {onSettled?: (quiet: boolean, signal: AbortSignal) => Promise<void>}) => {
          order.push('decided')
          await options.onSettled?.(true, new AbortController().signal)
          order.push('shutdown')
          return outcome()
        },
      )

      // #when
      const result = await release({liveObservation: observation})

      // #then
      expect(order).toEqual(['decided', 'stop', 'shutdown'])
      expect(result.observed).toMatchObject({
        rootTerminal: {kind: 'failed'},
        failure: {message: 'notice turn failed'},
        usage: {cost: 0.2},
      })
      expect(refreshUsage).toHaveBeenCalledTimes(1)
    })

    it('does not re-read usage from a directory that was not confirmed quiet', async () => {
      // #given
      const {observation, refreshUsage} = liveFor([])
      mocks.releaseRunV2.mockImplementation(
        async (options: {onSettled?: (quiet: boolean, signal: AbortSignal) => Promise<void>}) => {
          await options.onSettled?.(false, new AbortController().signal)
          return outcome({quiet: false, declineReason: 'not quiet'})
        },
      )

      // #when
      const result = await release({liveObservation: observation})

      // #then
      expect(refreshUsage).not.toHaveBeenCalled()
      expect(result.observed?.usage).toBeNull()
    })

    it('reports nothing observed for a run that handed nothing over', async () => {
      // #given
      mocks.releaseRunV2.mockImplementation(
        async (options: {onSettled?: (quiet: boolean, signal: AbortSignal) => Promise<void>}) => {
          await options.onSettled?.(true, new AbortController().signal)
          return outcome()
        },
      )

      // #when
      const result = await release()

      // #then
      expect(result.observed).toBeUndefined()
    })
  })

  it('shares nothing between two runs released together: each writes its own summary and stops its own observation', async () => {
    // #given two runs in one process, each with its own observation and summary
    const order: string[] = []
    const first = liveFor(order)
    const second = liveFor(order)
    mocks.releaseRunV2.mockImplementation(
      async (options: {
        onSettled?: (quiet: boolean, signal: AbortSignal) => Promise<void>
        beforeShutdown?: (signal: AbortSignal) => Promise<void>
      }) => {
        await options.onSettled?.(true, new AbortController().signal)
        await options.beforeShutdown?.(new AbortController().signal)
        return outcome()
      },
    )

    // #when
    const [a, b] = await Promise.all([
      release({liveObservation: first.observation, deferredSummary: {sessionId: 'ses_a', text: 'summary a'}}),
      release({liveObservation: second.observation, deferredSummary: {sessionId: 'ses_b', text: 'summary b'}}),
    ])

    // #then
    expect(mocks.addSyntheticMessage).toHaveBeenCalledWith({sessionId: 'ses_a', text: 'summary a'})
    expect(mocks.addSyntheticMessage).toHaveBeenCalledWith({sessionId: 'ses_b', text: 'summary b'})
    expect(mocks.addSyntheticMessage).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['stop', 'stop'])
    expect(first.refreshUsage).toHaveBeenCalledTimes(1)
    expect(second.refreshUsage).toHaveBeenCalledTimes(1)
    expect(a.observed).not.toBe(b.observed)
  })

  describe('the pre-shutdown step is bounded', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('cuts a summary request that never answers at its request bound and still prunes', async () => {
      // #given the real V2 client over a fetch that only ends when its signal aborts
      vi.useFakeTimers()
      const actual = await vi.importActual<typeof import('../../features/agent/execution-v2.js')>(
        '../../features/agent/execution-v2.js',
      )
      const hanging = vi.fn(
        async (_path: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
          }),
      )
      const hangingHandle = {...handle, fetch: hanging} as unknown as OpenCodeV2ServerHandle
      mocks.createClient.mockImplementation((h: OpenCodeV2ServerHandle) => actual.createActionClientV2(h))
      mocks.releaseRunV2.mockImplementation(
        async (options: {beforeShutdown?: (signal: AbortSignal) => Promise<void>}) => {
          await options.beforeShutdown?.(new AbortController().signal)
          return outcome()
        },
      )
      let done = false

      // #when the request goes out and never answers
      const pending = release({
        serverHandle: hangingHandle,
        deferredSummary: {sessionId: 'ses_root', text: 'summary text'},
      }).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(PRE_SHUTDOWN_REQUEST_TIMEOUT_MS)
      await pending

      // #then it was aborted at the bound, and the step went on to the prune
      expect(hanging).toHaveBeenCalledTimes(1)
      expect(mocks.pruneSessionsV2).toHaveBeenCalledTimes(1)
    })

    it('aborts a request when the phase signal aborts, whatever the request bound', async () => {
      // #given
      const phase = new AbortController()
      const seen: AbortSignal[] = []
      const bounded = boundRequests(
        async (_path, init) => {
          seen.push(init?.signal as AbortSignal)
          return new Response(null, {status: 204})
        },
        phase.signal,
        60_000,
      )

      // #when
      await bounded('/api/x')
      phase.abort()

      // #then
      expect(seen[0]?.aborted).toBe(true)
    })
  })
})
