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

import {QUARANTINE_HOLD_WINDOW_MS} from './root-stop.js'
import {runOpenCodeCore} from './run-core.js'
import {stoppedRootMessages} from './test-helpers.js'

/** The first frame of every event stream: the run waits for it before it sends the prompt. */
const SERVER_CONNECTED = {type: 'server.connected', properties: {}} as const

const ROOT = 'sess-123'
const DIRECTORY = '/workspace/repo'
const INACTIVITY_MS = 5_000
/** Longer than the 15 s settle bound, so a run that cannot confirm the root has concluded. */
const PAST_SETTLE_BOUND_MS = 20_000

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeSink(append: () => void = () => {}): DiscordStreamSink {
  return {
    append: vi.fn(append),
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
  /** `session.status` reply by call, overriding `statuses` (e.g. a root that turns up busy at a given time). */
  readonly status?: () => Readonly<Record<string, object>>
  readonly abort?: () => Promise<unknown>
  /**
   * `session.messages` data per call. Defaults to the aborted reply once `session.abort` has been called, and
   * nothing before: a root that was never told to stop has not produced the evidence that it did.
   */
  readonly messages?: (abortCalls: number) => readonly object[]
  /** Called by every `sink.append`; throwing from it makes the event loop body throw. */
  readonly onAppend?: () => void
  /** The gateway run id threaded into `runOpenCodeCore`; omitted by default. */
  readonly runId?: string
}

interface Run {
  readonly done: Promise<void>
  readonly outcome: () => Outcome | undefined
  readonly close: () => void
  /** Makes the open event stream reject with `error` on its next pull. */
  readonly failStream: (error: unknown) => void
  readonly emit: (event: object) => void
  readonly abort: ReturnType<typeof vi.fn>
  readonly status: ReturnType<typeof vi.fn>
  readonly logger: GatewayLogger
}

function startRun(options: StartOptions = {}): Run {
  vi.useFakeTimers()
  const queue: object[] = []
  let closed = false
  let streamFailure: {readonly error: unknown} | null = null
  let wake: (() => void) | null = null

  async function* stream(): AsyncGenerator<object> {
    // The server announces the stream first; the run sends its prompt only after reading it.

    yield SERVER_CONNECTED
    while (true) {
      if (streamFailure !== null) throw streamFailure.error
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

  const defaultMessages = (abortCalls: number): readonly object[] => (abortCalls > 0 ? stoppedRootMessages(ROOT) : [])
  const statuses = options.statuses ?? [{}]
  let statusCalls = 0
  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
      messages: vi.fn(async () => ({
        data: (options.messages ?? defaultMessages)(client.session.abort.mock.calls.length),
        error: null,
      })),
      promptAsync: vi.fn(async () => {
        options.onPrompt?.()
        return {data: {}, error: null}
      }),
      children: vi.fn().mockResolvedValue({data: [], error: null}),
      status: vi.fn(async () => {
        if (options.status !== undefined) return {data: options.status(), error: null}
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

  const logger = makeLogger()
  let settled: Outcome | undefined
  const done = runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink: makeSink(options.onAppend),
    signal: (options.controller ?? new AbortController()).signal,
    logger,
    coordinator: makeCoordinator(),
    ...(options.runId === undefined ? {} : {runId: options.runId}),
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
    failStream: error => {
      streamFailure = {error}
      wakeStream()
    },
    emit: event => {
      queue.push(event)
      wakeStream()
    },
    abort: client.session.abort,
    status: client.session.status,
    logger,
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
      // the root kept showing up live, so it was told to stop again on every poll, not once
      expect(run.abort.mock.calls.length).toBeGreaterThan(1)
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

describe('an error from the event loop that is not a RunCoreError', () => {
  const rootText = {
    type: 'message.part.delta',
    properties: {sessionID: ROOT, delta: {type: 'text', text: 'hello'}, field: 'text'},
  }

  it('aborts and confirms the root when the event stream rejects mid-run', async () => {
    // #given a stream that dies with a transport error after the run started
    const run = startRun()
    await vi.advanceTimersByTimeAsync(100)

    // #when
    run.failStream(new TypeError('terminated'))
    await vi.advanceTimersByTimeAsync(1_000)

    // #then the original error is classified as a dropped stream, not leaked raw, and the root was stopped first
    const error = failure(run)
    expect(error.kind).toBe('stream-ended')
    expect(error.quarantined).toBe(false)
    expect(error.cause).toBeInstanceOf(TypeError)
    expect(run.abort).toHaveBeenCalledTimes(1)
    expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}, query: {directory: DIRECTORY}}))
    expect(run.status).toHaveBeenCalled()
  })

  it('quarantines when the root stays live after the stream rejected', async () => {
    // #given
    const run = startRun({statuses: [{[ROOT]: {type: 'busy'}}]})
    await vi.advanceTimersByTimeAsync(100)

    // #when
    run.failStream(new Error('socket hang up'))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('stream-ended')
    expect(error.quarantined).toBe(true)
  })

  it('handles an unexpected throw in the loop body the same way', async () => {
    // #given an event whose handling throws (here the reply sink)
    const run = startRun({
      onAppend: () => {
        throw new Error('sink exploded')
      },
    })
    await vi.advanceTimersByTimeAsync(100)

    // #when
    run.emit(rootText)
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('stream-ended')
    expect(error.message).toContain('sink exploded')
    expect(error.cause).toBeInstanceOf(Error)
    expect(run.abort).toHaveBeenCalledTimes(1)
  })

  it('lets a RunCoreError pass through unchanged, without a second barrier', async () => {
    // #given a terminal provider error: a RunCoreError thrown inside the loop, after which the root is already halted
    const run = startRun()
    await vi.advanceTimersByTimeAsync(100)

    // #when
    run.emit({
      type: 'session.error',
      properties: {sessionID: ROOT, error: {name: 'ProviderAuthError', data: {providerID: 'p', message: 'x'}}},
    })
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(false)
    expect(run.abort).not.toHaveBeenCalled()
  })
})

/** Context of every barrier-owned log line: the settle logs plus the barrier's own quarantine line. */
function barrierContexts(run: Run): readonly Record<string, unknown>[] {
  const levels = ['info', 'warn', 'error'] as const
  return levels.flatMap(level =>
    (run.logger[level] as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(call => {
        const message = call[1] as string
        return message.startsWith('settle-owned-sessions:') || message.startsWith('run-core: owned work could not')
      })
      .map(call => call[0] as Record<string, unknown>),
  )
}

describe('run id on the termination barrier logs', () => {
  const RUN_ID = 'run-1889-core'

  it('threads the run id into the settle logs when a stopped root is confirmed quiescent', async () => {
    // #given an operator cancel: the root may still be running, so the barrier aborts and confirms it
    const controller = new AbortController()
    const run = startRun({controller, runId: RUN_ID})
    await vi.advanceTimersByTimeAsync(100)
    controller.abort('operator cancel')
    await vi.advanceTimersByTimeAsync(1_000)

    // #then the barrier's opening and closing log lines both name the run
    expect(failure(run).quarantined).toBe(false)
    const contexts = barrierContexts(run)
    expect(contexts.length).toBeGreaterThanOrEqual(2)
    for (const context of contexts) {
      expect(context.runId).toBe(RUN_ID)
    }
  })

  it('threads the run id into the quarantine logs when the root cannot be confirmed stopped', async () => {
    // #given a root that stays live after the abort
    const controller = new AbortController()
    const run = startRun({controller, runId: RUN_ID, statuses: [{[ROOT]: {type: 'busy'}}]})
    await vi.advanceTimersByTimeAsync(100)
    controller.abort('operator cancel')
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then the unconfirmed-settlement error and the run-core quarantine error both name the run
    expect(failure(run).quarantined).toBe(true)
    const errorContexts = (run.logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(call => {
        const message = call[1] as string
        return message.startsWith('settle-owned-sessions:') || message.startsWith('run-core: owned work could not')
      })
      .map(call => call[0] as Record<string, unknown>)
    expect(errorContexts.length).toBeGreaterThanOrEqual(2)
    for (const context of errorContexts) {
      expect(context.runId).toBe(RUN_ID)
    }
    expect(barrierContexts(run).every(context => context.runId === RUN_ID)).toBe(true)
  })
})

/**
 * Models a cold server. The first abort (while the prompt is still being prepared) is acknowledged and lost. The
 * prompt then starts `startsAfterMs` after that abort and runs until it is aborted AGAIN, after which its aborted
 * reply is the last message and the root leaves the live set.
 */
function coldServer(startsAfterMs: number) {
  const state = {firstAbortAt: null as number | null, effectiveAbort: false}
  const running = (): boolean =>
    !state.effectiveAbort && state.firstAbortAt !== null && Date.now() >= state.firstAbortAt + startsAfterMs
  const options: StartOptions = {
    abort: async () => {
      state.firstAbortAt ??= Date.now()
      // an abort only works once the prompt is running; before that it is acknowledged and lost
      if (running()) state.effectiveAbort = true
      return {data: {}, error: null}
    },
    status: (): Record<string, object> => (running() ? {[ROOT]: {type: 'busy'}} : {}),
    messages: () => (state.effectiveAbort ? stoppedRootMessages(ROOT) : []),
  }
  return {state, options}
}

describe('a cold OpenCode server: an abort sent before the runner exists does nothing', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllTimers()
  })

  const cancelScenario = STOP_SCENARIOS.find(scenario => scenario.label === 'operator cancel')
  if (cancelScenario === undefined) throw new Error('missing scenario')

  it('inside the barrier: no release before evidence, then a re-abort on busy stops the prompt and releases clean', async () => {
    // #given the prompt starts 1.5 s after the (lost) first abort
    const {state, options} = coldServer(1_500)
    const run = await cancelScenario.stop(options)

    // #then about a second into the barrier the root is absent and nothing proves it stopped: no release yet
    expect(run.outcome()).toBeUndefined()
    expect(state.effectiveAbort).toBe(false)

    // #when the prompt starts and is aborted again
    await vi.advanceTimersByTimeAsync(2_000)

    // #then the re-abort stopped it, the terminal reply confirmed it, and the run released without quarantine
    expect(state.effectiveAbort).toBe(true)
    expect(failure(run).quarantined).toBe(false)
    expect(run.abort.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('past the barrier: quarantines for want of evidence, then the root watch re-aborts the late prompt', async () => {
    // #given the prompt starts only after the 15 s barrier has given up
    const {state, options} = coldServer(30_000)
    const run = await cancelScenario.stop(options)

    // #when the barrier's budget runs out
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then nothing confirmed the root, so the run is quarantined, the prompt has not been stopped, and the watch runs
    expect(failure(run).quarantined).toBe(true)
    expect(state.effectiveAbort).toBe(false)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    // #when the late prompt appears during the hold
    await vi.advanceTimersByTimeAsync(40_000)

    // #then the watch aborted it, the aborted reply exists, and the watch ended itself
    expect(state.effectiveAbort).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  /** The persisted turns of a root that answered its prompt: the prompt and a normal, completed reply to it. */
  const turnOneAnswered = (): readonly object[] => [
    {info: {id: 'msg_user_1', sessionID: ROOT, role: 'user', time: {created: 1}}, parts: []},
    {
      info: {
        id: 'msg_assistant_1',
        sessionID: ROOT,
        role: 'assistant',
        parentID: 'msg_user_1',
        time: {created: 2, completed: 3},
        finish: 'stop',
      },
      parts: [],
    },
  ]

  it('background work open and a prior completed reply: never confirmed, so the run takes the whole hold and the watch re-aborts busy turns', async () => {
    // #given a child still running, and a root whose only persisted turn is answered. OpenCode will inject a notice
    // turn when the child finishes or is cancelled; that turn is prepared like any prompt, so it is not in the list yet
    const ledger = createOwnershipLedger()
    ledger.adopt('sess-child', 'background task')
    const startedAt = Date.now()
    const run = await cancelScenario.stop({
      ownershipLedger: ledger,
      messages: turnOneAnswered,
      // the notice turn starts well after the barrier gave up, runs, and is gone again
      status: (): Record<string, object> => {
        const elapsed = Date.now() - startedAt
        return elapsed > 40_000 && elapsed < 41_000 ? {[ROOT]: {type: 'busy'}} : {}
      },
    })

    // #when the barrier finishes
    await vi.advanceTimersByTimeAsync(2_000)

    // #then the stop is quarantined at once: the reply to turn 1 cannot speak for a turn that is not saved yet
    expect(failure(run).quarantined).toBe(true)
    const abortsAtRelease = run.abort.mock.calls.filter(call => (call[0] as {path: {id: string}}).path.id === ROOT)
    expect(abortsAtRelease).toHaveLength(1)

    // #when the notice turn shows up as busy inside the hold
    await vi.advanceTimersByTimeAsync(60_000)

    // #then the watch aborted it, and it did NOT end on the confirmed-looking probe (a completed reply, root absent)
    const rootAborts = run.abort.mock.calls.filter(call => (call[0] as {path: {id: string}}).path.id === ROOT)
    expect(rootAborts.length).toBeGreaterThan(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(run.logger.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('confirmed stopped'))

    // #when the hold closes
    await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS)

    // #then nothing is left
    expect(vi.getTimerCount()).toBe(0)
  })

  it('no background work and the same completed reply to turn 1: confirmed and released with no quarantine', async () => {
    // #given the same persisted turn, but nothing owned
    const run = await cancelScenario.stop({ownershipLedger: createOwnershipLedger(), messages: turnOneAnswered})

    // #then it is confirmed stopped and released at once: over-quarantining would hold the slot for nothing
    expect(failure(run).quarantined).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a user message the stream showed but the message list does not hold: the list is stale, so the root is unconfirmed', async () => {
    // #given the stream announced a user message, and the message list holds an aborted reply but not that message
    const controller = new AbortController()
    const run = startRun({controller, messages: () => stoppedRootMessages(ROOT)})
    await vi.advanceTimersByTimeAsync(100)
    run.emit({type: 'message.updated', properties: {info: {id: 'msg_user_newer', role: 'user', sessionID: ROOT}}})
    await vi.advanceTimersByTimeAsync(100)

    // #when the run is cancelled and the barrier runs its course
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then the reply cannot be tied to the latest prompt, so the run quarantines
    expect(failure(run).quarantined).toBe(true)
  })

  it('a root that never produces evidence is watched for the whole hold and then everything is released', async () => {
    // #given an abort that never works and a root that stays absent
    const run = await cancelScenario.stop({messages: () => []})

    // #when the barrier gives up
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then quarantined, with the watch still running
    expect(failure(run).quarantined).toBe(true)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    // #when the hold window closes
    await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS + 1_000)

    // #then no timer is left
    expect(vi.getTimerCount()).toBe(0)
  })
})
