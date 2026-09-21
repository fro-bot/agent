import type {Logger} from '../shared/logger.js'
import type {LedgerReconcileAdapter} from './ledger-reconcile.js'

import {err, ok} from '@bfra.me/es/result'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createLedgerReconciler, DEFAULT_LEDGER_RECONCILE_INTERVAL_MS, reconcileLedgerOnce} from './ledger-reconcile.js'
import {createOwnershipLedger} from './ownership-ledger.js'

const PARENT_SESSION_ID = 'parent-session'

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function makeAdapter(overrides: Partial<LedgerReconcileAdapter> = {}): LedgerReconcileAdapter {
  return {
    children: async () => ok([]),
    liveSessionIds: async () => ok(new Set<string>()),
    ...overrides,
  }
}

describe('reconcileLedgerOnce', () => {
  it('regression guard: a live foreground child of this parent, never tracked by the ledger, is NOT adopted', async () => {
    // #given — upstream reports a live child under this parent that the ledger has never heard
    // of. This is exactly the shape of an ordinary foreground `task` subagent mid-run: upstream
    // creates its child session identically for foreground and background dispatch, so
    // `children()` and `liveSessionIds()` alone cannot tell the two apart — there is no
    // discriminant to adopt on. An untracked entry (already-tracked entries below are a
    // different case) must never be adopted regardless of what upstream reports about it.
    const ledger = createOwnershipLedger()
    ledger.adopt('other-tracked-child', 'reviewer-subagent') // keeps the ledger non-empty so the pass actually runs upstream calls
    const adapter = makeAdapter({
      children: async () => ok([{id: 'other-tracked-child'}, {id: 'foreground-child'}]),
      liveSessionIds: async () => ok(new Set(['other-tracked-child', 'foreground-child'])),
    })

    // #when
    const result = await reconcileLedgerOnce({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #then — the untracked live child is never adopted; only the entry the ledger already
    // tracked is present, and it stays outstanding (still live, still a child of this parent).
    expect(result.success).toBe(true)
    expect(ledger.snapshot()).toEqual([
      {sessionId: 'other-tracked-child', label: 'reviewer-subagent', state: 'outstanding'},
    ])
    expect(ledger.isTracked('foreground-child')).toBe(false)
  })

  it('empty ledger: performs no remote calls at all', async () => {
    // #given — a ledger with nothing tracked, and an adapter that fails the test if called
    const ledger = createOwnershipLedger()
    const children = vi.fn(async () => ok([{id: 'irrelevant'}]))
    const liveSessionIds = vi.fn(async () => ok(new Set<string>()))
    const adapter = makeAdapter({children, liveSessionIds})

    // #when
    const result = await reconcileLedgerOnce({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #then — no upstream call was made; there is nothing an empty ledger could learn
    expect(result.success).toBe(true)
    expect(children).not.toHaveBeenCalled()
    expect(liveSessionIds).not.toHaveBeenCalled()
    expect(ledger.snapshot()).toEqual([])
  })

  it('happy path: a ledger entry whose session reports idle is settled', async () => {
    // #given — an already-adopted entry that upstream now reports idle (absent from live set)
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set<string>()),
    })

    // #when
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})

    // #then
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reviewer-subagent', state: 'settled'}])
  })

  it('edge case: a tracked entry that is a child but no longer live settles, and stays settled', async () => {
    // #given — child-1 is already tracked (adopted via the real dispatch-observed path, not by
    // reconciliation) and live; a later pass observes it went idle
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    let live = new Set(['child-1'])
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(live),
    })
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})
    expect(ledger.outstanding()).toBe(1)

    // #when — child-1 goes idle, then a later pass still sees it in children() but not live
    live = new Set()
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})

    // #then — settled once, never bounced back to outstanding
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reviewer-subagent', state: 'settled'}])
  })

  it('edge case: reconciliation is idempotent across repeated runs', async () => {
    // #given — a tracked, live entry and a stable upstream view across repeated passes
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set(['child-1'])),
    })

    // #when
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})
    const afterFirst = ledger.snapshot()
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})

    // #then — no duplicate entries, no state change
    expect(ledger.snapshot()).toEqual(afterFirst)
    expect(ledger.outstanding()).toBe(1)
  })

  it('error path: a failed reconciliation call leaves the ledger unknown, not empty', async () => {
    // #given — an outstanding entry, and an upstream call that fails
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    const logger = makeLogger()
    const adapter = makeAdapter({
      children: async () => err(new Error('upstream unreachable')),
    })

    // #when
    const result = await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger})

    // #then — marked unknown, never settled, never silently dropped to zero. An
    // unknown entry must keep blocking drain, not just persistence: a caller
    // cannot treat "we lost track of it" as "it must be done" -- the run keeps
    // draining (bounded by its own deadline) rather than reporting complete.
    expect(result.success).toBe(false)
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.unknown()).toBe(1)
    expect(ledger.isDrainComplete()).toBe(false)
    expect(ledger.isPersistenceSafe()).toBe(false)
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reviewer-subagent', state: 'unknown'}])
    expect(logger.warning).toHaveBeenCalledWith(
      'Ledger reconciliation failed; marking outstanding entries unknown rather than settling them',
      expect.objectContaining({unknownCount: 1}),
    )
  })

  it('error path: an unknown entry is settled only on a later positive observation, never on absence of evidence', async () => {
    // #given — a previously-failed reconciliation left an entry unknown
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    const failingAdapter = makeAdapter({children: async () => err(new Error('unreachable'))})
    await reconcileLedgerOnce({
      ledger,
      adapter: failingAdapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })
    expect(ledger.unknown()).toBe(1)

    // #when — a later successful pass positively confirms the session is no longer live
    const succeedingAdapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set<string>()),
    })
    await reconcileLedgerOnce({
      ledger,
      adapter: succeedingAdapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #then
    expect(ledger.unknown()).toBe(0)
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reviewer-subagent', state: 'settled'}])
  })

  it('three-way: a tracked entry that is a live child of this parent stays outstanding', async () => {
    // #given — a tracked entry that IS a child of this parent and IS live
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set(['child-1'])),
    })

    // #when
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})

    // #then — left outstanding, not settled or marked unknown
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reviewer-subagent', state: 'outstanding'}])
  })

  it('three-way: a tracked entry that is a child of this parent but not live is settled', async () => {
    // #given — a ledger entry that IS a child of this parent but is NOT live
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set<string>()),
    })

    // #when
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})

    // #then — settled, since the child of this parent is confirmed no longer live
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reviewer-subagent', state: 'settled'}])
  })

  it('three-way (regression guard): a tracked entry live elsewhere on the server but not a child of this parent is marked unknown, not settled and not left outstanding', async () => {
    // #given — a ledger entry naming a session that liveSessionIds() reports live (it is running
    // somewhere on the server right now), but children(parentSessionId) does NOT include it — the
    // live server does not recognize it as a descendant of this parent at all.
    const ledger = createOwnershipLedger()
    ledger.adopt('elsewhere-child', 'reviewer-subagent')
    const adapter = makeAdapter({
      children: async () => ok([]), // not a child of this parent
      liveSessionIds: async () => ok(new Set(['elsewhere-child'])), // live, but under someone else's tree
    })

    // #when
    const result = await reconcileLedgerOnce({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #then — marked unknown: not settled (no positive observation of completion), and not left
    // outstanding (that would block drain forever on work that was never this parent's). Still
    // blocks drain, same as it blocks persistence -- unknown is unknown either way.
    expect(result.success).toBe(true)
    expect(ledger.snapshot()).toEqual([{sessionId: 'elsewhere-child', label: 'reviewer-subagent', state: 'unknown'}])
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.unknown()).toBe(1)
    expect(ledger.isDrainComplete()).toBe(false)
    expect(ledger.isPersistenceSafe()).toBe(false)
  })

  it('integration: a tracked entry whose settlement event was dropped is still settled without a detected discontinuity', async () => {
    // #given — a tracked entry the ledger already knows about (adopted via the real
    // dispatch-observed path), whose completion event never arrived; upstream now reports it idle
    const ledger = createOwnershipLedger()
    ledger.adopt('dropped-settlement-child', 'background task')
    const adapter = makeAdapter({
      children: async () => ok([{id: 'dropped-settlement-child'}]),
      liveSessionIds: async () => ok(new Set<string>()),
    })

    // #when — reconciliation runs (e.g. on its interval), with no discontinuity ever signaled
    const result = await reconcileLedgerOnce({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #then — settled without waiting on an event that never arrived
    expect(result.success).toBe(true)
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.snapshot()).toEqual([
      {sessionId: 'dropped-settlement-child', label: 'background task', state: 'settled'},
    ])
  })
})

describe('createLedgerReconciler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('edge case: reconciliation runs on its interval even with no subscription event or discontinuity', async () => {
    // #given — a tracked entry that goes idle upstream, and no subscription/discontinuity trigger fires
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set<string>()),
    })
    const reconciler = createLedgerReconciler({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #when — only the interval elapses
    expect(ledger.outstanding()).toBe(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)

    // #then
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reviewer-subagent', state: 'settled'}])
    reconciler.dispose()
  })

  it('does not run again after dispose', async () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent')
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set<string>()),
    })
    const reconciler = createLedgerReconciler({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
      intervalMs: 1000,
    })

    // #when
    reconciler.dispose()
    reconciler.dispose() // idempotent
    await vi.advanceTimersByTimeAsync(10_000)

    // #then — no pass ever ran
    expect(ledger.outstanding()).toBe(1)
  })

  it('skips a tick while a pass is still in flight rather than starting a second pass', async () => {
    // #given — children() hangs until released, so the first pass never completes on its own
    let releaseChildren: (() => void) | undefined
    let childrenCallCount = 0
    const adapter = makeAdapter({
      children: async () => {
        childrenCallCount += 1
        await new Promise<void>(resolve => {
          releaseChildren = resolve
        })
        return ok([])
      },
    })
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent') // non-empty so each tick actually calls upstream
    const reconciler = createLedgerReconciler({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
      intervalMs: 1000,
    })

    // #when — the first tick starts a pass and hangs mid-flight
    await vi.advanceTimersByTimeAsync(1000)
    expect(childrenCallCount).toBe(1)

    // A second (and third) interval tick elapses while the first pass is still in flight
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    // #then — no second call was made; the overlapping ticks were skipped, not stacked
    expect(childrenCallCount).toBe(1)

    // #and — once the first pass completes, the next tick runs a fresh pass normally
    releaseChildren?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(childrenCallCount).toBe(2)

    reconciler.dispose()
  })

  it('dispose() during an in-flight pass does not leave a dangling timer or throw', async () => {
    // #given — children() hangs until released, so dispose() is called mid-pass
    let releaseChildren: (() => void) | undefined
    let childrenCallCount = 0
    const adapter = makeAdapter({
      children: async () => {
        childrenCallCount += 1
        await new Promise<void>(resolve => {
          releaseChildren = resolve
        })
        return ok([])
      },
    })
    const ledger = createOwnershipLedger()
    ledger.adopt('child-1', 'reviewer-subagent') // non-empty so the tick actually calls upstream
    const reconciler = createLedgerReconciler({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
      intervalMs: 1000,
    })

    // #when — the first tick starts a pass and hangs mid-flight, then dispose() is called
    await vi.advanceTimersByTimeAsync(1000)
    expect(childrenCallCount).toBe(1)
    expect(() => reconciler.dispose()).not.toThrow()
    expect(() => reconciler.dispose()).not.toThrow() // idempotent

    // #then — no further tick fires even though time keeps advancing (timer is cleared)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(childrenCallCount).toBe(1)

    // #and — letting the in-flight pass finally resolve after dispose() does not throw
    // or resurrect the timer
    expect(() => releaseChildren?.()).not.toThrow()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(childrenCallCount).toBe(1)
  })
})
