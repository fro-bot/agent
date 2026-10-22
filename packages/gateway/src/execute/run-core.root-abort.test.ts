/**
 * A run that stops while its root session may still be running must abort that root and confirm it quiescent
 * before the failure escapes, even when the ownership ledger is empty. `promptAsync` runs the prompt in server
 * scope, so only `session.abort` stops it; releasing the lock and slot without that leaves the root writing the
 * checkout under the next run.
 *
 * Drives the real `runOpenCodeCore` loop with fake timers. Every stub terminates: the stream is closed or the
 * run's own bounds end it, and the live-root cases end at the settle bound.
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
const DIRECTORY = '/workspace/repo'
const INACTIVITY_MS = 5_000
/** Longer than the 15 s settle bound, so a run that cannot confirm the root has concluded. */
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

function makeCoordinator(): PermissionCoordinator {
  const owned = new Set<string>()
  return {
    onPermissionAsked: vi.fn().mockResolvedValue('once'),
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    addOwnedSession: vi.fn((id: string) => {
      owned.add(id)
    }),
    isOwned: vi.fn((id: string) => owned.has(id)),
  }
}

type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: RunCoreError}

interface StartOptions {
  readonly controller?: AbortController
  readonly ownershipLedger?: OwnershipLedger
  readonly inactivityTimeoutMs?: number
  /** Called when `promptAsync` runs, before it resolves. */
  readonly onPrompt?: () => void
  /** `session.status` reply per call (the last entry repeats). Defaults to nothing live. */
  readonly statuses?: readonly Readonly<Record<string, object>>[]
  readonly abort?: () => Promise<unknown>
}

interface Run {
  readonly done: Promise<void>
  readonly outcome: () => Outcome | undefined
  readonly close: () => void
  readonly emit: (event: object) => void
  readonly abort: ReturnType<typeof vi.fn>
  readonly status: ReturnType<typeof vi.fn>
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

  const statuses = options.statuses ?? [{}]
  let statusCalls = 0
  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
      messages: vi.fn().mockResolvedValue({data: [], error: null}),
      promptAsync: vi.fn(async () => {
        options.onPrompt?.()
        return {data: {}, error: null}
      }),
      children: vi.fn().mockResolvedValue({data: [], error: null}),
      status: vi.fn(async () => {
        const reply = statuses[Math.min(statusCalls, statuses.length - 1)] ?? {}
        statusCalls += 1
        return {data: reply, error: null}
      }),
      abort: vi.fn(options.abort ?? (async () => ({data: {}, error: null}))),
    },
    event: {subscribe: vi.fn().mockResolvedValue({stream: stream()})},
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
  }
  const handle = {
    client,
    server: {url: 'http://workspace:9200', close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  let settled: Outcome | undefined
  const done = runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink: makeSink(),
    signal: (options.controller ?? new AbortController()).signal,
    logger: makeLogger(),
    coordinator: makeCoordinator(),
    ...(options.ownershipLedger === undefined ? {} : {ownershipLedger: options.ownershipLedger}),
    ...(options.inactivityTimeoutMs === undefined ? {} : {inactivityTimeoutMs: options.inactivityTimeoutMs}),
  }).then(
    () => {
      settled = {ok: true}
    },
    (error: unknown) => {
      settled = {ok: false, error: error as RunCoreError}
    },
  )

  function wakeStream(): void {
    if (wake !== null) {
      const resume: () => void = wake
      wake = null
      resume()
    }
  }

  return {
    done,
    outcome: () => settled,
    close: () => {
      closed = true
      wakeStream()
    },
    emit: event => {
      queue.push(event)
      wakeStream()
    },
    abort: client.session.abort,
    status: client.session.status,
  }
}

interface StopScenario {
  readonly label: string
  readonly kind: RunCoreError['kind']
  /** Starts a run that will stop for this reason, and drives it to the point where it has stopped. */
  readonly stop: (options?: StartOptions) => Promise<Run>
}

const STOP_SCENARIOS: readonly StopScenario[] = [
  {
    label: 'wall-clock timeout',
    kind: 'timeout',
    stop: async options => {
      const controller = new AbortController()
      const run = startRun({...options, controller})
      await vi.advanceTimersByTimeAsync(100)
      controller.abort()
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'operator cancel',
    kind: 'timeout',
    stop: async options => {
      const controller = new AbortController()
      const run = startRun({...options, controller})
      await vi.advanceTimersByTimeAsync(100)
      controller.abort('operator cancel')
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'signal aborted after the prompt was sent',
    kind: 'timeout',
    stop: async options => {
      const controller = new AbortController()
      const run = startRun({...options, controller, onPrompt: () => controller.abort()})
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'inactivity',
    kind: 'inactivity-timeout',
    stop: async options => {
      const run = startRun({...options, inactivityTimeoutMs: INACTIVITY_MS})
      await vi.advanceTimersByTimeAsync(INACTIVITY_MS + 1_000)
      return run
    },
  },
  {
    label: 'stream ended',
    kind: 'stream-ended',
    stop: async options => {
      const run = startRun(options)
      await vi.advanceTimersByTimeAsync(100)
      run.close()
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
]

const LEDGERS: readonly (readonly [string, (() => OwnershipLedger) | undefined])[] = [
  ['no ledger', undefined],
  ['an empty ledger', () => createOwnershipLedger()],
]

function ledgerOption(make: (() => OwnershipLedger) | undefined): StartOptions {
  return make === undefined ? {} : {ownershipLedger: make()}
}

function failure(run: Run): RunCoreError {
  const outcome = run.outcome()
  if (outcome === undefined || outcome.ok) throw new Error('expected the run to have failed')
  return outcome.error
}

afterEach(() => {
  vi.useRealTimers()
})

describe('root abort on a stop that may leave the root running', () => {
  describe.each(STOP_SCENARIOS)('$label', scenario => {
    it.each(LEDGERS)(
      'aborts the root, confirms it quiescent and releases with %s',
      async (_ledgerLabel, makeLedger) => {
        // #given — the run stops with nothing owned, so the ledger cannot speak for the root

        // #when
        const run = await scenario.stop(ledgerOption(makeLedger))

        // #then — same failure kind, root aborted once in this directory, confirmed absent, not quarantined
        const error = failure(run)
        expect(error.kind).toBe(scenario.kind)
        expect(error.quarantined).toBe(false)
        expect(run.abort).toHaveBeenCalledTimes(1)
        expect(run.abort).toHaveBeenCalledWith(
          expect.objectContaining({path: {id: ROOT}, query: {directory: DIRECTORY}}),
        )
        expect(run.status).toHaveBeenCalled()
      },
    )

    it('quarantines when the root is still busy after the abort', async () => {
      // #given — the directory's live set keeps reporting the root
      const run = await scenario.stop({statuses: [{[ROOT]: {type: 'busy'}}]})

      // #when — the bounded settle budget runs out
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then — same kind, with quarantine as extra evidence
      const error = failure(run)
      expect(error.kind).toBe(scenario.kind)
      expect(error.quarantined).toBe(true)
      expect(run.abort).toHaveBeenCalledTimes(1)
    })

    it('quarantines when the abort throws and the root stays live', async () => {
      // #given
      const run = await scenario.stop({
        statuses: [{[ROOT]: {type: 'busy'}}],
        abort: async () => {
          throw new Error('abort refused')
        },
      })

      // #when
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      const error = failure(run)
      expect(error.kind).toBe(scenario.kind)
      expect(error.quarantined).toBe(true)
    })

    it('quarantines when the abort returns an error envelope and the root stays live', async () => {
      // #given
      const run = await scenario.stop({
        statuses: [{[ROOT]: {type: 'busy'}}],
        abort: async () => ({error: 'abort failed'}),
      })

      // #when
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      expect(failure(run).quarantined).toBe(true)
    })

    it('quarantines when the abort hangs and the root cannot be confirmed', async () => {
      // #given — an abort that never resolves; the settle bound alone must end the barrier
      const run = await scenario.stop({
        abort: async () =>
          new Promise<never>(() => {
            /* never resolves */
          }),
      })

      // #when
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      expect(failure(run).quarantined).toBe(true)
    })

    it('releases once the root leaves the live set within the budget', async () => {
      // #given — busy for the first two polls, then gone
      const run = await scenario.stop({statuses: [{[ROOT]: {type: 'busy'}}, {[ROOT]: {type: 'busy'}}, {}]})

      // #when
      await vi.advanceTimersByTimeAsync(3_000)

      // #then
      expect(failure(run).quarantined).toBe(false)
      expect(run.status.mock.calls.length).toBeGreaterThanOrEqual(3)
    })
  })

  it('does not abort the root on a clean completion', async () => {
    // #given — the root reaches idle
    const run = startRun({ownershipLedger: createOwnershipLedger()})
    await vi.advanceTimersByTimeAsync(100)

    // #when
    run.emit({type: 'session.idle', properties: {sessionID: ROOT}})
    await vi.advanceTimersByTimeAsync(1_000)

    // #then — the fast path stays: no abort and no liveness lookup
    expect(run.outcome()).toEqual({ok: true})
    expect(run.abort).not.toHaveBeenCalled()
    expect(run.status).not.toHaveBeenCalled()
  })
})

/** A `promptAsync` whose request the run signal cancels: the signal fires, then the request rejects. */
function abortedDuringPrompt(controller: AbortController): () => never {
  return () => {
    controller.abort()
    throw new DOMException('This operation was aborted', 'AbortError')
  }
}

describe('promptAsync throwing', () => {
  it('aborts and confirms the root when the request was cancelled by the run signal', async () => {
    // #given the signal fires while promptAsync is in flight: the server may already have started the prompt
    const controller = new AbortController()
    const run = startRun({controller, onPrompt: abortedDuringPrompt(controller)})

    // #when
    await vi.advanceTimersByTimeAsync(1_000)

    // #then the stop is a timeout, not an unreachable server, and the root was aborted and checked
    const error = failure(run)
    expect(error.kind).toBe('timeout')
    expect(error.quarantined).toBe(false)
    expect(run.abort).toHaveBeenCalledTimes(1)
    expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}, query: {directory: DIRECTORY}}))
    expect(run.status).toHaveBeenCalled()
  })

  it('quarantines when the root stays live after a cancelled promptAsync', async () => {
    // #given
    const controller = new AbortController()
    const run = startRun({
      controller,
      onPrompt: abortedDuringPrompt(controller),
      statuses: [{[ROOT]: {type: 'busy'}}],
    })

    // #when
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('timeout')
    expect(error.quarantined).toBe(true)
  })

  it('keeps the unreachable fast path when the signal did not fire', async () => {
    // #given a network failure with the run signal untouched
    const run = startRun({
      onPrompt: () => {
        throw new TypeError('fetch failed')
      },
    })

    // #when
    await vi.advanceTimersByTimeAsync(1_000)

    // #then no abort and no liveness lookup: the prompt never reached the server
    const error = failure(run)
    expect(error.kind).toBe('unreachable')
    expect(error.quarantined).toBe(false)
    expect(run.abort).not.toHaveBeenCalled()
    expect(run.status).not.toHaveBeenCalled()
  })
})
