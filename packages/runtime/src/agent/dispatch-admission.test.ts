import type {Result} from '../shared/types.js'
import type {DispatchRefusal, DispatchRequest} from './dispatch-admission.js'

import {describe, expect, it} from 'vitest'

import {createDispatchAdmission} from './dispatch-admission.js'
import {createOwnershipLedger} from './ownership-ledger.js'

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function expectOk<T, E>(r: Result<T, E>): T {
  if (r.success === false) throw new Error(`expected ok, got err: ${JSON.stringify(r.error)}`)
  return r.data
}

function expectErr<T, E>(r: Result<T, E>): E {
  if (r.success === true) throw new Error('expected err, got ok')
  return r.error
}

function request(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    sessionId: 'session-a',
    label: 'test-dispatch',
    kind: 'new',
    depth: 1,
    ...overrides,
  }
}

describe('createDispatchAdmission', () => {
  it('admits a dispatch below both caps', () => {
    // #given an empty ledger and default caps
    const ledger = createOwnershipLedger()
    const admission = createDispatchAdmission(ledger)

    // #when a dispatch is requested
    const result = admission.tryAdmit(request())

    // #then it is admitted
    expectOk(result)
    expect(admission.totalDispatched()).toBe(1)
  })

  it('refuses the dispatch that would make outstanding three, leaving the ledger unchanged', () => {
    // #given a ledger already at the outstanding cap (2)
    const ledger = createOwnershipLedger()
    ledger.adopt('session-a', 'label-a')
    ledger.adopt('session-b', 'label-b')
    const admission = createDispatchAdmission(ledger, {maxOutstanding: 2})

    // #when a third new dispatch is requested
    const result = admission.tryAdmit(request({sessionId: 'session-c'}))

    // #then it is refused and the ledger is unchanged
    const refusal = expectErr(result)
    expect(refusal.reason).toBe('outstanding-cap-exceeded')
    expect(ledger.outstanding()).toBe(2)
    expect(ledger.snapshot().some(entry => entry.sessionId === 'session-c')).toBe(false)
  })

  it('counts an extension against an existing entry toward the total, bypassing the outstanding check', () => {
    // #given a ledger already at the outstanding cap (1), holding the entry being extended
    const ledger = createOwnershipLedger()
    ledger.adopt('session-a', 'label-a')
    const admission = createDispatchAdmission(ledger, {maxOutstanding: 1})

    // #when an extension against the existing entry is requested
    const result = admission.tryAdmit(request({sessionId: 'session-a', kind: 'extension'}))

    // #then it is admitted despite outstanding already being at the cap, and counts toward total
    expectOk(result)
    expect(admission.totalDispatched()).toBe(1)
    expect(ledger.outstanding()).toBe(1)
  })

  it('counts a promotion of foreground work toward the total', () => {
    // #given an empty ledger (the promoted session was never tracked)
    const ledger = createOwnershipLedger()
    const admission = createDispatchAdmission(ledger)

    // #when a promotion is requested
    const result = admission.tryAdmit(request({sessionId: 'session-promoted', kind: 'promotion'}))

    // #then it is admitted and counts toward total
    expectOk(result)
    expect(admission.totalDispatched()).toBe(1)
  })

  it('refuses every dispatch once finalization has begun', () => {
    // #given admission that has entered finalization
    const ledger = createOwnershipLedger()
    const admission = createDispatchAdmission(ledger)
    admission.enterTerminalPhase('finalization')

    // #when a dispatch below both caps is requested
    const result = admission.tryAdmit(request())

    // #then it is refused, naming the terminal phase, and nothing is counted
    const refusal = expectErr(result)
    expect(refusal.reason).toBe('terminal-phase')
    expect(admission.totalDispatched()).toBe(0)
  })

  it('refuses every dispatch once cancellation has begun', () => {
    // #given admission that has entered cancellation
    const ledger = createOwnershipLedger()
    const admission = createDispatchAdmission(ledger)
    admission.enterTerminalPhase('cancellation')

    // #when a dispatch below both caps is requested
    const result = admission.tryAdmit(request())

    // #then it is refused
    const refusal = expectErr(result)
    expect(refusal.reason).toBe('terminal-phase')
  })

  it('refuses a dispatch requesting depth beyond one', () => {
    // #given default admission
    const ledger = createOwnershipLedger()
    const admission = createDispatchAdmission(ledger)

    // #when a dispatch at depth 2 is requested
    const result = admission.tryAdmit(request({depth: 2}))

    // #then it is refused for depth, and nothing is counted
    const refusal = expectErr(result)
    expect(refusal.reason).toBe('depth-exceeded')
    expect(refusal.limit).toBe(1)
    expect(refusal.actual).toBe(2)
    expect(admission.totalDispatched()).toBe(0)
  })

  it("identifies which cap was exceeded in a refused dispatch's error", () => {
    // #given admission configured with a total cap already reached
    const ledger = createOwnershipLedger()
    const admission = createDispatchAdmission(ledger, {maxOutstanding: 5, maxTotal: 1})
    expectOk(admission.tryAdmit(request({sessionId: 'session-first'})))

    // #when a second dispatch is requested beyond the total cap
    const result = admission.tryAdmit(request({sessionId: 'session-second'}))

    // #then the error names the total cap specifically, with its limit and actual value
    const refusal: DispatchRefusal = expectErr(result)
    expect(refusal.reason).toBe('total-cap-exceeded')
    expect(refusal.limit).toBe(1)
    expect(refusal.actual).toBe(1)
    expect(typeof refusal.message).toBe('string')
  })
})
