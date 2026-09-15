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
  it('happy path: a live child absent from the ledger is adopted', async () => {
    // #given — a live child the ledger has never heard of
    const ledger = createOwnershipLedger()
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set(['child-1'])),
    })

    // #when
    const result = await reconcileLedgerOnce({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #then
    expect(result.success).toBe(true)
    expect(ledger.outstanding()).toBe(1)
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reconciled', state: 'outstanding'}])
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

  it('edge case: a completed child from a previous invocation is not adopted', async () => {
    // #given — children() returns a long-idle historical child; it is not in the live set
    const ledger = createOwnershipLedger()
    const adapter = makeAdapter({
      children: async () => ok([{id: 'ancient-child'}]),
      liveSessionIds: async () => ok(new Set<string>()),
    })

    // #when
    await reconcileLedgerOnce({ledger, adapter, parentSessionId: PARENT_SESSION_ID, logger: makeLogger()})

    // #then — never adopted, ledger stays empty
    expect(ledger.snapshot()).toEqual([])
    expect(ledger.outstanding()).toBe(0)
  })

  it('edge case: a child that completed during this invocation is not re-adopted after settling', async () => {
    // #given — child-1 is live, gets adopted, then goes idle and is settled
    const ledger = createOwnershipLedger()
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
    expect(ledger.snapshot()).toEqual([{sessionId: 'child-1', label: 'reconciled', state: 'settled'}])
  })

  it('edge case: reconciliation is idempotent across repeated runs', async () => {
    // #given — a stable upstream view across repeated passes
    const ledger = createOwnershipLedger()
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

    // #then — marked unknown, never settled, never silently dropped to zero
    expect(result.success).toBe(false)
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.unknown()).toBe(1)
    expect(ledger.isDrainComplete()).toBe(true)
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

  it('integration: a dispatch whose event was dropped is still discovered without a detected discontinuity', async () => {
    // #given — a child session is live upstream but the ledger never learned of it via any event
    const ledger = createOwnershipLedger()
    const adapter = makeAdapter({
      children: async () => ok([{id: 'dropped-dispatch-child'}]),
      liveSessionIds: async () => ok(new Set(['dropped-dispatch-child'])),
    })

    // #when — reconciliation runs (e.g. on its interval), with no discontinuity ever signaled
    const result = await reconcileLedgerOnce({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #then — the ledger no longer reads zero while the child writes
    expect(result.success).toBe(true)
    expect(ledger.outstanding()).toBe(1)
    expect(ledger.isPersistenceSafe()).toBe(false)
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
    // #given — a live child never reported by any event, and no subscription/discontinuity trigger fires
    const ledger = createOwnershipLedger()
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set(['child-1'])),
    })
    const reconciler = createLedgerReconciler({
      ledger,
      adapter,
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })

    // #when — only the interval elapses
    expect(ledger.outstanding()).toBe(0)
    await vi.advanceTimersByTimeAsync(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)

    // #then
    expect(ledger.outstanding()).toBe(1)
    reconciler.dispose()
  })

  it('does not run again after dispose', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const adapter = makeAdapter({
      children: async () => ok([{id: 'child-1'}]),
      liveSessionIds: async () => ok(new Set(['child-1'])),
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
    expect(ledger.outstanding()).toBe(0)
  })
})
