/**
 * The reconcile passes a gateway run makes WHILE it executes (the periodic tick and the one-shot on root idle)
 * are bounded: a hung `children()` call must not stop reconciliation for the rest of the run, must not change the
 * ledger when it finally answers, and a timed-out pass leaves the ledger exactly as a failed pass does.
 *
 * Drives the real `runOpenCodeCore` loop with fake timers. `children()` is only called by reconciliation, so it
 * is the call each scenario scripts; `status()` always reports nothing live (every child has finished).
 */

import type {OpenCodeServerHandle, OwnershipEntryState} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'

import {createOwnershipLedger, DEFAULT_LEDGER_RECONCILE_INTERVAL_MS} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {runOpenCodeCore} from './run-core.js'

const ROOT = 'sess-123'
const CHILD = 'sess-child'
const TICK_MS = DEFAULT_LEDGER_RECONCILE_INTERVAL_MS
const BOUND_MS = 5_000

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

/** What one `children()` call does, by call number (1-based). */
type ChildrenScript = (call: number) => 'child' | 'throw' | 'hang' | 'defer'

interface Run {
  readonly ledger: ReturnType<typeof createOwnershipLedger>
  readonly controller: AbortController
  readonly emit: (event: object) => void
  readonly childrenSignals: AbortSignal[]
  /** Answers every deferred `children()` call with the child as a live-listed direct child. */
  readonly answerDeferred: () => void
  readonly abort: ReturnType<typeof vi.fn>
  readonly outcome: () => 'pending' | 'resolved' | 'rejected'
  readonly onOwnershipChange: ReturnType<typeof vi.fn>
}

function startRun(script: ChildrenScript): Run {
  vi.useFakeTimers()
  const queue: object[] = []
  let wake: (() => void) | null = null
  async function* stream(): AsyncGenerator<object> {
    while (true) {
      const next = queue.shift()
      if (next === undefined) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      } else {
        yield next
      }
    }
  }

  const childrenSignals: AbortSignal[] = []
  const deferred: (() => void)[] = []
  let childrenCalls = 0
  const abort = vi.fn().mockResolvedValue({data: {}, error: null})
  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
      messages: vi.fn().mockResolvedValue({data: [], error: null}),
      promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
      children: vi.fn(async (args: {signal?: AbortSignal}) => {
        childrenCalls += 1
        if (args.signal !== undefined) childrenSignals.push(args.signal)
        const action = script(childrenCalls)
        if (action === 'throw') throw new Error('children failed')
        if (action === 'hang') {
          return new Promise<never>(() => {
            /* never resolves, whatever the signal does */
          })
        }
        if (action === 'defer') {
          return new Promise<{data: {id: string}[]; error: null}>(resolve => {
            deferred.push(() => resolve({data: [{id: CHILD}], error: null}))
          })
        }
        return {data: [{id: CHILD}], error: null}
      }),
      status: vi.fn().mockResolvedValue({data: {}, error: null}),
      abort,
    },
    event: {subscribe: vi.fn().mockResolvedValue({stream: stream()})},
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
  }
  const handle = {
    client,
    server: {url: 'http://workspace:9200', close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  const ledger = createOwnershipLedger()
  const controller = new AbortController()
  const onOwnershipChange = vi.fn()
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  runOpenCodeCore({
    handle,
    directory: '/workspace/repo',
    promptText: 'Fix the bug please',
    sink: makeSink(),
    signal: controller.signal,
    logger: makeLogger(),
    coordinator: makeCoordinator(),
    ownershipLedger: ledger,
    onOwnershipChange,
  }).then(
    () => {
      state = 'resolved'
    },
    () => {
      state = 'rejected'
    },
  )

  return {
    ledger,
    controller,
    emit: event => {
      queue.push(event)
      if (wake !== null) {
        const resume: () => void = wake
        wake = null
        resume()
      }
    },
    childrenSignals,
    answerDeferred: () => {
      for (const answer of deferred) answer()
    },
    abort,
    outcome: () => state,
    onOwnershipChange,
  }
}

/** A completed `task` tool part with `metadata.background`, which adopts the child into the ledger. */
const adoptChild = {
  type: 'message.part.updated',
  properties: {
    sessionID: ROOT,
    part: {
      type: 'tool',
      tool: 'task',
      sessionID: ROOT,
      state: {status: 'completed', title: 'background task', metadata: {background: true, jobId: CHILD}},
    },
  },
}

const rootIdle = {type: 'session.idle', properties: {sessionID: ROOT}}

function childState(run: Run): OwnershipEntryState | undefined {
  return run.ledger.snapshot().find(entry => entry.sessionId === CHILD)?.state
}

async function ledgerAfterFirstPass(first: 'throw' | 'hang') {
  const run = startRun(call => (call === 1 ? first : 'throw'))
  run.emit(adoptChild)
  await vi.advanceTimersByTimeAsync(TICK_MS + BOUND_MS + 100)
  const result = {
    snapshot: run.ledger.snapshot(),
    persisted: run.onOwnershipChange.mock.calls.at(-1)?.[0] as unknown,
  }
  run.controller.abort()
  await vi.advanceTimersByTimeAsync(20_000)
  return result
}

afterEach(() => {
  vi.useRealTimers()
})

describe('live-path ledger reconcile passes', () => {
  describe('the periodic tick', () => {
    it('keeps reconciling after a tick hangs: a later tick settles a child that has gone idle', async () => {
      // #given the first tick's children() never answers; later ones report the child, which is no longer live
      const run = startRun(call => (call === 1 ? 'hang' : 'child'))
      run.emit(adoptChild)
      await vi.advanceTimersByTimeAsync(100)
      expect(childState(run)).toBe('outstanding')

      // #when the hung tick fires and its bound passes, then the next tick fires
      await vi.advanceTimersByTimeAsync(TICK_MS)
      await vi.advanceTimersByTimeAsync(BOUND_MS + 100)
      await vi.advanceTimersByTimeAsync(TICK_MS)

      // #then the hung pass was cancelled by its signal and the later tick settled the child
      expect(run.childrenSignals[0]?.aborted).toBe(true)
      expect(childState(run)).toBe('settled')

      run.controller.abort()
      await vi.advanceTimersByTimeAsync(20_000)
    })

    it('ignores an answer that arrives after the pass timed out', async () => {
      // #given the first tick's answer is deferred, and every later pass fails
      const run = startRun(call => (call === 1 ? 'defer' : 'throw'))
      run.emit(adoptChild)
      await vi.advanceTimersByTimeAsync(TICK_MS + BOUND_MS + 100)
      expect(childState(run)).toBe('unknown')

      // #when the abandoned pass finally answers "direct child, not live"
      run.answerDeferred()
      await vi.advanceTimersByTimeAsync(100)

      // #then the decision already made stands
      expect(childState(run)).toBe('unknown')

      run.controller.abort()
      await vi.advanceTimersByTimeAsync(20_000)
    })

    it('ignores an answer that arrives after the run entered teardown', async () => {
      // #given a tick is in flight (within its bound) when the run is cancelled; the teardown's own confirmation
      // pass fails, so the barrier marks the child unknown
      const run = startRun(call => (call === 1 ? 'defer' : 'throw'))
      run.emit(adoptChild)
      await vi.advanceTimersByTimeAsync(TICK_MS + 1_000)
      run.controller.abort('operator cancel')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(run.abort).toHaveBeenCalled()
      expect(childState(run)).toBe('unknown')

      // #when the live pass answers, still inside its own 5 s bound
      run.answerDeferred()
      await vi.advanceTimersByTimeAsync(100)

      // #then teardown owns the ledger: the late result settles nothing
      expect(childState(run)).toBe('unknown')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(run.outcome()).toBe('rejected')
    })
  })

  describe('the one-shot on root idle', () => {
    it('is bounded, and its signal is aborted when the bound expires', async () => {
      // #given the idle pass's children() never answers
      const run = startRun(() => 'hang')
      run.emit(adoptChild)
      await vi.advanceTimersByTimeAsync(100)

      // #when the root goes idle with the child still outstanding, and the bound passes
      run.emit(rootIdle)
      await vi.advanceTimersByTimeAsync(100)
      expect(run.childrenSignals).toHaveLength(1)
      expect(run.childrenSignals[0]?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(BOUND_MS)

      // #then the request was cancelled
      expect(run.childrenSignals[0]?.aborted).toBe(true)

      run.controller.abort()
      await vi.advanceTimersByTimeAsync(20_000)
    })

    it('ignores an answer that arrives after the pass timed out', async () => {
      // #given
      const run = startRun(call => (call === 1 ? 'defer' : 'throw'))
      run.emit(adoptChild)
      await vi.advanceTimersByTimeAsync(100)
      run.emit(rootIdle)
      await vi.advanceTimersByTimeAsync(BOUND_MS + 100)
      expect(childState(run)).toBe('unknown')

      // #when
      run.answerDeferred()
      await vi.advanceTimersByTimeAsync(100)

      // #then
      expect(childState(run)).toBe('unknown')

      run.controller.abort()
      await vi.advanceTimersByTimeAsync(20_000)
    })
  })

  describe('a pass that times out', () => {
    it('leaves the ledger and the persisted ownership exactly as a failed pass does', async () => {
      // #given / #when the first tick fails outright, and in a second run it hangs past its bound
      const failed = await ledgerAfterFirstPass('throw')
      vi.useRealTimers()
      const timedOut = await ledgerAfterFirstPass('hang')

      // #then both leave the outstanding child unknown, and persist the same claim
      expect(failed.snapshot).toEqual([{sessionId: CHILD, label: 'background task', state: 'unknown'}])
      expect(timedOut.snapshot).toEqual(failed.snapshot)
      expect(timedOut.persisted).toEqual(failed.persisted)
    })
  })
})
