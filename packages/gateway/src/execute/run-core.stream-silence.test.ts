/**
 * The event stream must end the run in every state when it is lost: a transport failure is not retried, a second
 * `server.connected` marks a replaced stream, and a stream that stays silent for `streamSilenceTimeoutMs` is
 * treated as dead whatever the run is waiting on (a drain, a human).
 *
 * Drives the real `runOpenCodeCore` loop with fake timers. The silence watchdog is never paused, so the
 * scenarios here include the states that pause the ordinary inactivity watchdog (drain, an approval wait).
 */

import type {OpenCodeServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'
import type {RunCoreError} from './run-core.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {runOpenCodeCore} from './run-core.js'

const ROOT = 'sess-123'
const CHILD = 'child-1'
const DIRECTORY = '/workspace/repo'
const SILENCE_MS = 30_000
const HEARTBEAT_MS = 10_000
/** Longer than the 15 s settle bound, so a barrier that cannot confirm the root has concluded. */
const PAST_SETTLE_BOUND_MS = 20_000

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeSink(): DiscordStreamSink {
  return {
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
    buffered: () => '',
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
  }
}

function makeCoordinator(onAsked: () => Promise<unknown> = async () => 'once'): PermissionCoordinator {
  const owned = new Set<string>()
  return {
    onPermissionAsked: vi.fn(onAsked) as unknown as PermissionCoordinator['onPermissionAsked'],
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    addOwnedSession: vi.fn((id: string) => {
      owned.add(id)
    }),
    isOwned: vi.fn((id: string) => owned.has(id)),
  }
}

const heartbeat = (): object => ({type: 'server.heartbeat', properties: {}})
const connected = (): object => ({type: 'server.connected', properties: {}})
const idle = (sessionID = ROOT): object => ({type: 'session.idle', properties: {sessionID}})
const permissionAsked = (requestID: string): object => ({
  type: 'permission.asked',
  properties: {id: requestID, sessionID: ROOT, permission: 'bash', patterns: [], tool: 'bash'},
})
const backgroundTaskCompleted = (jobId: string): object => ({
  type: 'message.part.updated',
  properties: {
    sessionID: ROOT,
    part: {
      type: 'tool',
      tool: 'task',
      sessionID: ROOT,
      state: {status: 'completed', title: 'background task', metadata: {background: true, jobId}},
    },
  },
})

type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: RunCoreError}

interface StartOptions {
  readonly controller?: AbortController
  readonly streamSilenceTimeoutMs?: number
  readonly inactivityTimeoutMs?: number
  readonly ownershipLedger?: OwnershipLedger
  readonly coordinator?: PermissionCoordinator
  /** Whether the child session is reported live by the reconciler (a drain that never settles). */
  readonly childLive?: boolean
}

interface Run {
  readonly outcome: () => Outcome | undefined
  readonly emit: (event: object) => void
  readonly close: () => void
  readonly subscribe: ReturnType<typeof vi.fn>
  readonly abort: ReturnType<typeof vi.fn>
  readonly logger: GatewayLogger
  readonly coordinator: PermissionCoordinator
}

function startRun(options: StartOptions = {}): Run {
  vi.useFakeTimers()
  const queue: object[] = []
  let closed = false
  let wake: (() => void) | null = null

  async function* stream(): AsyncGenerator<object> {
    while (true) {
      const next = queue.shift()
      if (next !== undefined) {
        yield next
      } else if (closed) {
        return
      } else {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    }
  }

  const wakeStream = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }

  const subscribe = vi.fn().mockResolvedValue({stream: stream()})
  const abort = vi.fn(async () => ({data: {}, error: null}))
  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
      messages: vi.fn().mockResolvedValue({data: [], error: null}),
      promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
      children: vi.fn().mockResolvedValue({data: [{id: CHILD}], error: null}),
      status: vi
        .fn()
        .mockResolvedValue({data: options.childLive === true ? {[CHILD]: {}, [ROOT]: {}} : {}, error: null}),
      abort,
    },
    event: {subscribe},
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
  }
  const handle = {
    client,
    server: {url: 'http://workspace:9200', close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  const logger = makeLogger()
  const coordinator = options.coordinator ?? makeCoordinator()
  let settled: Outcome | undefined
  // eslint-disable-next-line no-void
  void runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink: makeSink(),
    signal: (options.controller ?? new AbortController()).signal,
    logger,
    coordinator,
    ...(options.ownershipLedger === undefined ? {} : {ownershipLedger: options.ownershipLedger}),
    ...(options.inactivityTimeoutMs === undefined ? {} : {inactivityTimeoutMs: options.inactivityTimeoutMs}),
    ...(options.streamSilenceTimeoutMs === undefined ? {} : {streamSilenceTimeoutMs: options.streamSilenceTimeoutMs}),
  }).then(
    () => {
      settled = {ok: true}
    },
    (error: unknown) => {
      settled = {ok: false, error: error as RunCoreError}
    },
  )

  return {
    outcome: () => settled,
    emit: event => {
      queue.push(event)
      wakeStream()
    },
    close: () => {
      closed = true
      wakeStream()
    },
    subscribe,
    abort,
    logger,
    coordinator,
  }
}

function failure(run: Run): RunCoreError {
  const outcome = run.outcome()
  if (outcome === undefined || outcome.ok === true) {
    throw new Error(`expected the run to have failed, got ${outcome === undefined ? 'still running' : 'success'}`)
  }
  return outcome.error
}

/** A run that has adopted background work and is draining, with the child reported live forever. */
async function startDrainingRun(options: StartOptions = {}): Promise<Run> {
  const run = startRun({...options, ownershipLedger: createOwnershipLedger(), childLive: true})
  await vi.advanceTimersByTimeAsync(10)
  run.emit(backgroundTaskCompleted(CHILD))
  run.emit(idle())
  await vi.advanceTimersByTimeAsync(10)
  return run
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runOpenCodeCore — the event stream watchdog', () => {
  describe('silence', () => {
    it('does not trip while heartbeats keep arriving, even during a drain', async () => {
      // #given a draining run (the ordinary inactivity watchdog is paused) and a 30 s silence watchdog
      const run = await startDrainingRun({streamSilenceTimeoutMs: SILENCE_MS, inactivityTimeoutMs: 5_000})

      // #when a heartbeat arrives every 10 s for two minutes
      for (let elapsed = 0; elapsed < 120_000; elapsed += HEARTBEAT_MS) {
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
        run.emit(heartbeat())
        await vi.advanceTimersByTimeAsync(0)
      }

      // #then the run is still alive and nothing was aborted
      expect(run.outcome()).toBeUndefined()
      expect(run.abort).not.toHaveBeenCalled()
    })

    it('ends a draining run as stream-ended through the barrier after 30 s of silence', async () => {
      // #given a draining run whose stream then goes quiet
      const run = await startDrainingRun({streamSilenceTimeoutMs: SILENCE_MS})
      run.emit(heartbeat())
      await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000)
      expect(run.outcome()).toBeUndefined()

      // #when the silence window passes and the barrier runs
      await vi.advanceTimersByTimeAsync(1_000 + PAST_SETTLE_BOUND_MS)

      // #then the run ended as a stream loss, with the root and the child aborted by the barrier
      const error = failure(run)
      expect(error.kind).toBe('stream-ended')
      expect(error.message).toContain('silent')
      expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
      expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: CHILD}}))
    })

    it('ends a run waiting on an approval after 30 s of silence, while the ordinary watchdog stays paused', async () => {
      // #given an approval that nobody answers, with the ordinary watchdog (5 s) paused for the human wait
      const coordinator = makeCoordinator(async () => new Promise<never>(() => {}))
      const run = startRun({streamSilenceTimeoutMs: SILENCE_MS, inactivityTimeoutMs: 5_000, coordinator})
      await vi.advanceTimersByTimeAsync(10)
      run.emit(permissionAsked('perm-1'))
      await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000)

      // #then still waiting: neither watchdog has fired before the silence window
      expect(run.outcome()).toBeUndefined()
      expect(coordinator.onPermissionAsked).toHaveBeenCalledTimes(1)

      // #when the silence window passes
      await vi.advanceTimersByTimeAsync(1_000 + PAST_SETTLE_BOUND_MS)

      // #then the run ended as a stream loss, with the root abort attempted, and not as an inactivity timeout
      const error = failure(run)
      expect(error.kind).toBe('stream-ended')
      expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
    })

    it('classifies the run as silence when the wall clock fires in the same tick', async () => {
      // #given a wall-clock deadline at exactly the silence deadline
      const controller = new AbortController()
      const run = startRun({controller, streamSilenceTimeoutMs: SILENCE_MS})
      await vi.advanceTimersByTimeAsync(10)
      setTimeout(() => {
        controller.abort()
      }, SILENCE_MS - 10)

      // #when both fire in one synchronous advance, before any continuation runs
      vi.advanceTimersByTime(SILENCE_MS)
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then silence wins
      const error = failure(run)
      expect(error.kind).toBe('stream-ended')
      expect(error.message).toContain('silent')
    })

    it('leaves a run that completes before 30 s of silence COMPLETED', async () => {
      // #given a run with the watchdog armed that goes idle after 20 s
      const run = startRun({streamSilenceTimeoutMs: SILENCE_MS})
      await vi.advanceTimersByTimeAsync(20_000)

      // #when the root goes idle
      run.emit(idle())
      await vi.advanceTimersByTimeAsync(10)

      // #then the run completed, and no watchdog timer is left running to flip it to a failure later
      expect(run.outcome()).toEqual({ok: true})
      expect(vi.getTimerCount()).toBe(0)

      // #and the silence window passing changes nothing
      await vi.advanceTimersByTimeAsync(SILENCE_MS * 2)
      expect(run.outcome()).toEqual({ok: true})
    })

    it('changes nothing when streamSilenceTimeoutMs is unset: a quiet stream stays open', async () => {
      // #given no silence watchdog configured
      const run = startRun()

      // #when the stream stays silent for ten minutes
      await vi.advanceTimersByTimeAsync(600_000)

      // #then the run is still waiting
      expect(run.outcome()).toBeUndefined()
      expect(run.abort).not.toHaveBeenCalled()
    })
  })

  describe('no reconnect', () => {
    it('subscribes once, with the SDK retry loop limited to a single attempt', async () => {
      // #given
      const run = startRun({streamSilenceTimeoutMs: SILENCE_MS})
      await vi.advanceTimersByTimeAsync(10)

      // #then the subscription refuses reconnects and reports its transport errors
      expect(run.subscribe).toHaveBeenCalledTimes(1)
      const options = run.subscribe.mock.calls[0]?.[0] as {sseMaxRetryAttempts?: number; onSseError?: unknown}
      expect(options.sseMaxRetryAttempts).toBe(1)
      expect(typeof options.onSseError).toBe('function')
    })

    it('captures the transport error as the cause, makes no second attempt, and ends as stream-ended', async () => {
      // #given a stream the SDK gave up on after its one attempt: it reports the error, then ends
      const run = startRun()
      await vi.advanceTimersByTimeAsync(10)
      const options = run.subscribe.mock.calls[0]?.[0] as {onSseError: (error: unknown) => void}
      const transportError = new TypeError('fetch failed')

      // #when
      options.onSseError(transportError)
      run.close()
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then the run ended as a stream loss that carries the cause, and nothing re-subscribed
      const error = failure(run)
      expect(error.kind).toBe('stream-ended')
      expect(error.cause).toBe(transportError)
      expect(run.subscribe).toHaveBeenCalledTimes(1)
      expect(run.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({streamError: 'fetch failed'}),
        'run-core: event stream closed before session.idle',
      )
    })

    it('ends as stream-ended on a second server.connected, the sign of a replaced stream', async () => {
      // #given a stream that connected once
      const run = startRun()
      await vi.advanceTimersByTimeAsync(10)
      run.emit(connected())
      await vi.advanceTimersByTimeAsync(10)
      expect(run.outcome()).toBeUndefined()

      // #when it announces itself again
      run.emit(connected())
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then the run ended as a stream loss with the root abort attempted
      expect(failure(run).kind).toBe('stream-ended')
      expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
    })

    it('treats a single server.connected as ordinary', async () => {
      // #given
      const run = startRun()
      await vi.advanceTimersByTimeAsync(10)

      // #when
      run.emit(connected())
      run.emit(idle())
      await vi.advanceTimersByTimeAsync(10)

      // #then
      expect(run.outcome()).toEqual({ok: true})
    })
  })
})
