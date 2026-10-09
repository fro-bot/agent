import {describe, expect, it} from 'vitest'

import {createOwnershipLedger} from './ownership-ledger.js'

describe('createOwnershipLedger', () => {
  it('happy path: adopt two entries, settle both, outstanding reaches zero', () => {
    // #given — a fresh ledger
    const ledger = createOwnershipLedger()

    // #when — two entries are adopted then both settled
    ledger.adopt('session-1', 'reviewer-subagent')
    ledger.adopt('session-2', 'linter-subagent')
    expect(ledger.outstanding()).toBe(2)
    ledger.settle('session-1')
    ledger.settle('session-2')

    // #then
    expect(ledger.outstanding()).toBe(0)
  })

  it('edge case: adopting the same session id twice counts once', () => {
    // #given
    const ledger = createOwnershipLedger()

    // #when
    ledger.adopt('session-1', 'reviewer-subagent')
    ledger.adopt('session-1', 'reviewer-subagent')

    // #then
    expect(ledger.outstanding()).toBe(1)
  })

  it('edge case: a second adopt call does not reset an already-settled entry back to outstanding', () => {
    // #given — an entry already settled
    const ledger = createOwnershipLedger()
    ledger.adopt('session-1', 'reviewer-subagent')
    ledger.settle('session-1')

    // #when — upstream notifies adopt again for the same session id
    ledger.adopt('session-1', 'reviewer-subagent')

    // #then — the entry stays settled, not reopened as outstanding
    expect(ledger.outstanding()).toBe(0)
  })

  it('edge case: settling an entry that was never adopted does not create one', () => {
    // #given — an empty ledger
    const ledger = createOwnershipLedger()

    // #when
    ledger.settle('session-never-adopted')

    // #then
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.snapshot()).toEqual([])
  })

  it('edge case: settling the same entry twice leaves the count unchanged', () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt('session-1', 'reviewer-subagent')
    ledger.settle('session-1')
    expect(ledger.outstanding()).toBe(0)

    // #when
    ledger.settle('session-1')

    // #then — no error, no change
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.snapshot()).toEqual([{sessionId: 'session-1', label: 'reviewer-subagent', state: 'settled'}])
  })

  it('error path: an entry marked unknown is excluded from settled but still blocks a persistence check', () => {
    // #given — an outstanding entry
    const ledger = createOwnershipLedger()
    ledger.adopt('session-1', 'reviewer-subagent')

    // #when — the entry is marked unknown (e.g. a dropped event)
    ledger.markUnknown('session-1')

    // #then — not counted as outstanding, not settled, but persistence is unsafe
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.unknown()).toBe(1)
    expect(ledger.snapshot()).toEqual([{sessionId: 'session-1', label: 'reviewer-subagent', state: 'unknown'}])
    expect(ledger.isPersistenceSafe()).toBe(false)
  })

  it('integration: a ledger with one unknown and zero outstanding reports neither drain-complete nor persistence-safe', () => {
    // #given — one entry resolved to unknown, nothing outstanding. An unknown
    // entry might still be a live writer, so it must block drain the same way
    // it blocks persistence -- not knowing is a reason to keep waiting, and
    // the deadline (not this predicate) is what bounds that wait.
    const ledger = createOwnershipLedger()
    ledger.adopt('session-1', 'reviewer-subagent')
    ledger.markUnknown('session-1')

    // #when / #then
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.isDrainComplete()).toBe(false)
    expect(ledger.isPersistenceSafe()).toBe(false)
  })

  it('markUnknown is a no-op on an entry that was never adopted', () => {
    // #given
    const ledger = createOwnershipLedger()

    // #when
    ledger.markUnknown('session-never-adopted')

    // #then
    expect(ledger.unknown()).toBe(0)
    expect(ledger.snapshot()).toEqual([])
  })

  it('markUnknown is a no-op on an already-settled entry — settled is terminal', () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt('session-1', 'reviewer-subagent')
    ledger.settle('session-1')

    // #when
    ledger.markUnknown('session-1')

    // #then
    expect(ledger.unknown()).toBe(0)
    expect(ledger.snapshot()).toEqual([{sessionId: 'session-1', label: 'reviewer-subagent', state: 'settled'}])
  })

  it('settle transitions an unknown entry to settled', () => {
    // #given — an unknown entry
    const ledger = createOwnershipLedger()
    ledger.adopt('session-1', 'reviewer-subagent')
    ledger.markUnknown('session-1')
    expect(ledger.unknown()).toBe(1)

    // #when — reconciliation later confirms the session finished
    ledger.settle('session-1')

    // #then
    expect(ledger.unknown()).toBe(0)
    expect(ledger.isPersistenceSafe()).toBe(true)
  })

  it('isTracked is true for an entry in every state, and false for an unknown session id', () => {
    // #given three sessions, one in each state, and a fourth session never adopted
    const ledger = createOwnershipLedger()
    ledger.adopt('session-outstanding', 'reviewer-subagent')
    ledger.adopt('session-unknown', 'linter-subagent')
    ledger.markUnknown('session-unknown')
    ledger.adopt('session-settled', 'formatter-subagent')
    ledger.settle('session-settled')

    // #when / #then — tracked regardless of state
    expect(ledger.isTracked('session-outstanding')).toBe(true)
    expect(ledger.isTracked('session-unknown')).toBe(true)
    expect(ledger.isTracked('session-settled')).toBe(true)

    // #then — a session never adopted is not tracked
    expect(ledger.isTracked('session-never-adopted')).toBe(false)
  })

  it('isDrainComplete and isPersistenceSafe agree when the ledger is fully settled', () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt('session-1', 'reviewer-subagent')
    ledger.adopt('session-2', 'linter-subagent')

    // #when
    ledger.settle('session-1')
    ledger.settle('session-2')

    // #then
    expect(ledger.isDrainComplete()).toBe(true)
    expect(ledger.isPersistenceSafe()).toBe(true)
  })
})
