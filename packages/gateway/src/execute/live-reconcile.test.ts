/**
 * `reconcileLivePass` in isolation: the closed-at-entry skip, the synchronous abandon at the bound, and the
 * per-pass duration log.
 */

import type {LedgerReconcileAdapter, Logger} from '@fro-bot/runtime'

import {err, ok} from '@bfra.me/es/result'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {LIVE_RECONCILE_TIMEOUT_MS, reconcileLivePass} from './live-reconcile.js'
import {DEFAULT_SETTLE_TIMEOUT_MS} from './settle-owned-sessions.js'

const PARENT = 'sess-root'

function makeLogger(): Logger {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
}

function makeAdapter(overrides: Partial<LedgerReconcileAdapter> = {}): LedgerReconcileAdapter {
  return {
    children: async () => ok([{id: 'child-1'}]),
    liveSessionIds: async () => ok(new Set<string>()),
    ...overrides,
  }
}

/** An outstanding entry behind a ledger whose `markUnknown` is observable, like the hook-wrapped one that persists ownership. */
function observableLedger() {
  const inner = createOwnershipLedger()
  inner.adopt('child-1', 'task')
  const markUnknown = vi.fn((sessionId: string) => {
    inner.markUnknown(sessionId)
  })
  return {ledger: {...inner, markUnknown}, markUnknown, snapshot: () => inner.snapshot()}
}

afterEach(() => {
  vi.useRealTimers()
})

describe('reconcileLivePass', () => {
  it('shares the settle budget, so a slow-but-answering server is not abandoned before teardown would be', () => {
    expect(LIVE_RECONCILE_TIMEOUT_MS).toBe(DEFAULT_SETTLE_TIMEOUT_MS)
    expect(LIVE_RECONCILE_TIMEOUT_MS).toBe(15_000)
  })

  it('makes no upstream call when the run has already moved on to teardown', async () => {
    // #given a closed run
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'task')
    const children = vi.fn(async () => ok([{id: 'child-1'}]))
    const liveSessionIds = vi.fn(async () => ok(new Set<string>()))

    // #when a tick fires anyway
    await reconcileLivePass(
      {ledger, adapter: makeAdapter({children, liveSessionIds}), parentSessionId: PARENT, logger: makeLogger()},
      () => true,
    )

    // #then nothing was asked and nothing changed
    expect(children).not.toHaveBeenCalled()
    expect(liveSessionIds).not.toHaveBeenCalled()
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'task', state: 'outstanding'}])
  })

  it('treats the pass as abandoned before it aborts the request, so an abort-triggered answer settles nothing', async () => {
    // #given a client that answers "child, not live" the instant its signal aborts
    vi.useFakeTimers()
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'task')
    const onAbort = async <T>(signal: AbortSignal | undefined, value: T): Promise<T> =>
      new Promise<T>(resolve => {
        signal?.addEventListener('abort', () => resolve(value), {once: true})
      })
    const adapter = makeAdapter({
      children: async (_parent, signal) => onAbort(signal, ok([{id: 'child-1'}])),
      liveSessionIds: async signal => onAbort(signal, ok(new Set<string>())),
    })

    // #when the bound expires
    const pass = reconcileLivePass({ledger, adapter, parentSessionId: PARENT, logger: makeLogger()}, () => false, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await pass

    // #then the timeout decided the entry (unknown, as for a failed pass), not the answer the abort produced
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'task', state: 'unknown'}])
  })

  it('logs each pass duration at debug level, and a timeout at warning', async () => {
    // #given a pass that answers after 2 s, and one that never answers
    vi.useFakeTimers()
    const slow = makeAdapter({
      children: async () => {
        await new Promise<void>(resolve => {
          setTimeout(resolve, 2_000)
        })
        return ok([{id: 'child-1'}])
      },
    })
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'task')
    const logger = makeLogger()

    // #when
    const pass = reconcileLivePass({ledger, adapter: slow, parentSessionId: PARENT, logger}, () => false)
    await vi.advanceTimersByTimeAsync(2_000)
    await pass

    // #then
    expect(logger.debug).toHaveBeenCalledWith(
      'Ledger reconciliation pass finished',
      expect.objectContaining({durationMs: 2_000, outcome: 'finished'}),
    )
    expect(logger.warning).not.toHaveBeenCalled()

    // #when a pass hangs past the bound
    const hungLogger = makeLogger()
    const hungLedger = createOwnershipLedger()
    hungLedger.adopt('child-1', 'task')
    const hung = reconcileLivePass(
      {
        ledger: hungLedger,
        adapter: makeAdapter({
          children: async () =>
            new Promise<never>(() => {
              /* never resolves */
            }),
        }),
        parentSessionId: PARENT,
        logger: hungLogger,
      },
      () => false,
      1_000,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await hung

    // #then the duration is still logged at debug, and the timeout itself at warning
    expect(hungLogger.debug).toHaveBeenCalledWith(
      'Ledger reconciliation pass finished',
      expect.objectContaining({durationMs: 1_000, outcome: 'timed-out'}),
    )
    expect(hungLogger.warning).toHaveBeenCalledTimes(1)
  })
  describe('a pass that is still in flight when the run closes', () => {
    it('does not mark the entry unknown when its lookup fails after the close', async () => {
      // #given an outstanding entry and a children() call still in flight
      let closed = false
      const {ledger, markUnknown, snapshot} = observableLedger()
      let fail: () => void = () => {}
      const adapter = makeAdapter({
        children: async () =>
          new Promise(resolve => {
            fail = () => resolve(err(new Error('server down')))
          }),
      })
      const pass = reconcileLivePass({ledger, adapter, parentSessionId: PARENT, logger: makeLogger()}, () => closed)

      // #when the run moves on to teardown, and then the lookup fails
      closed = true
      fail()
      await pass

      // #then the failed pass's downgrade was ignored: no mark, no ownership-change side effect
      expect(markUnknown).not.toHaveBeenCalled()
      expect(snapshot()).toEqual([{sessionId: 'child-1', label: 'task', state: 'outstanding'}])
    })

    it('does not mark the entry unknown, or claim it did, when the bound expires after the close', async () => {
      // #given an outstanding entry and a children() call that never answers
      vi.useFakeTimers()
      let closed = false
      const {ledger, markUnknown, snapshot} = observableLedger()
      const logger = makeLogger()
      const adapter = makeAdapter({
        children: async () =>
          new Promise<never>(() => {
            /* never resolves */
          }),
      })
      const pass = reconcileLivePass({ledger, adapter, parentSessionId: PARENT, logger}, () => closed)

      // #when the run moves on to teardown, and then the bound expires
      closed = true
      await vi.advanceTimersByTimeAsync(LIVE_RECONCILE_TIMEOUT_MS)
      await pass

      // #then teardown's settle still owns the entry: no mark, and no warning saying one was made
      expect(markUnknown).not.toHaveBeenCalled()
      expect(snapshot()).toEqual([{sessionId: 'child-1', label: 'task', state: 'outstanding'}])
      expect(logger.warning).not.toHaveBeenCalled()
    })
  })
})
