import type {RunState} from '@fro-bot/runtime'
import type {OperatorRunStatus, OperatorWebStatus} from './run-status.js'

import {assert, describe, expect, expectTypeOf, it} from 'vitest'
import {toOperatorRunStatus} from './run-status.js'

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const BASE_NOW_MS = 1_000_000

const makeRunState = (overrides: Partial<RunState> = {}): RunState => ({
  run_id: 'run-abc-123',
  surface: 'github',
  thread_id: 'thread-internal-001',
  entity_ref: 'owner/repo#42',
  phase: 'EXECUTING',
  started_at: '2024-01-01T00:00:00.000Z',
  last_heartbeat: new Date(BASE_NOW_MS - 1000).toISOString(), // 1 s ago — fresh
  holder_id: 'holder-internal-xyz',
  details: {internal: 'secret'},
  ...overrides,
})

const BASE_OPTS = {
  nowMs: BASE_NOW_MS,
  staleThresholdMs: 60_000,
  isRepoDenylisted: false,
}

// ---------------------------------------------------------------------------
// Phase → web-status mapping table
// ---------------------------------------------------------------------------

describe('toOperatorRunStatus — phase mapping', () => {
  const cases: [RunState['phase'], OperatorWebStatus][] = [
    ['PENDING', 'queued'],
    ['ACKNOWLEDGED', 'running'],
    ['EXECUTING', 'running'],
    ['COMPLETED', 'succeeded'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'cancelled'],
  ]

  for (const [phase, expectedStatus] of cases) {
    it(`maps ${phase} → '${expectedStatus}'`, () => {
      // #given a run in phase ${phase}
      const runState = makeRunState({phase})

      // #when projected with a non-denylisted repo
      const result = toOperatorRunStatus(runState, BASE_OPTS)

      // #then the web status is ${expectedStatus}
      assert(result !== null, 'expected a populated status for a non-denylisted repo')
      expect(result.status).toBe(expectedStatus)
    })
  }
})

// ---------------------------------------------------------------------------
// Operator-safe field projection
// ---------------------------------------------------------------------------

describe('toOperatorRunStatus — operator-safe fields', () => {
  it('copies operator-safe fields from RunState', () => {
    // #given a fully-populated RunState
    const runState = makeRunState({
      run_id: 'run-xyz',
      entity_ref: 'acme/widget#7',
      surface: 'web',
      phase: 'EXECUTING',
      started_at: '2024-06-01T12:00:00.000Z',
    })

    // #when projected
    const result = toOperatorRunStatus(runState, BASE_OPTS)

    // #then operator-safe fields are present and correct
    assert(result !== null, 'expected a populated status for a non-denylisted repo')
    expect(result.runId).toBe('run-xyz')
    expect(result.entityRef).toBe('acme/widget#7')
    expect(result.surface).toBe('web')
    expect(result.phase).toBe('EXECUTING')
    expect(result.startedAt).toBe('2024-06-01T12:00:00.000Z')
  })

  it('(r5) result object has NO holder_id, thread_id, or details keys', () => {
    // #given a RunState with internal fields
    const runState = makeRunState()

    // #when projected
    const result = toOperatorRunStatus(runState, BASE_OPTS)

    // #then internal fields are absent from the output object
    assert(result !== null, 'expected a populated status for a non-denylisted repo')
    const keys = Object.keys(result)
    expect(keys).not.toContain('holder_id')
    expect(keys).not.toContain('thread_id')
    expect(keys).not.toContain('details')
  })

  it('(r5) OperatorRunStatus type cannot carry holder_id, thread_id, or details', () => {
    // #given the OperatorRunStatus type
    // #when inspected at the type level
    // #then it does not include internal coordination fields
    expectTypeOf<OperatorRunStatus>().not.toHaveProperty('holder_id')
    expectTypeOf<OperatorRunStatus>().not.toHaveProperty('thread_id')
    expectTypeOf<OperatorRunStatus>().not.toHaveProperty('details')
  })
})

// ---------------------------------------------------------------------------
// Security: redaction-aware projection (R5/R6 cross-obligation)
// ---------------------------------------------------------------------------

describe('toOperatorRunStatus — redaction (r5/r6)', () => {
  it('(r6) returns null for a denylisted repo — record is omitted, not populated', () => {
    // #given a run whose repo is on the denylist
    const runState = makeRunState({entity_ref: 'secret-org/secret-repo#1'})

    // #when projected with isRepoDenylisted:true
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, isRepoDenylisted: true})

    // #then the record is omitted entirely — null, not a populated status
    expect(result).toBeNull()
  })

  it('(positive control) returns a populated status for a non-denylisted repo', () => {
    // #given a run whose repo is NOT on the denylist
    const runState = makeRunState({entity_ref: 'public-org/public-repo#5'})

    // #when projected with isRepoDenylisted:false
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, isRepoDenylisted: false})

    // #then the record is populated — not accidentally omitted
    assert(result !== null, 'expected a populated status for a non-denylisted repo')
    expect(result.entityRef).toBe('public-org/public-repo#5')
  })

  it('(r6) denylisted result is null even when phase is EXECUTING (no partial leak)', () => {
    // #given an actively-running denylisted run
    const runState = makeRunState({phase: 'EXECUTING', entity_ref: 'hidden/repo#99'})

    // #when projected with isRepoDenylisted:true
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, isRepoDenylisted: true})

    // #then null — the active status must not leak the repo's activity
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Edge: stale derivation
// ---------------------------------------------------------------------------

describe('toOperatorRunStatus — stale derivation', () => {
  it('stale is false when last_heartbeat is within the threshold', () => {
    // #given a heartbeat 1 ms before the stale boundary (still fresh)
    const staleThresholdMs = 60_000
    const lastHeartbeat = new Date(BASE_NOW_MS - staleThresholdMs + 1).toISOString()
    const runState = makeRunState({last_heartbeat: lastHeartbeat})

    // #when projected
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, staleThresholdMs})

    // #then stale is false
    assert(result !== null, 'expected a populated status')
    expect(result.stale).toBe(false)
  })

  it('stale is true when last_heartbeat is exactly at the stale boundary', () => {
    // #given a heartbeat exactly at the stale boundary (nowMs - staleThresholdMs)
    const staleThresholdMs = 60_000
    const lastHeartbeat = new Date(BASE_NOW_MS - staleThresholdMs).toISOString()
    const runState = makeRunState({last_heartbeat: lastHeartbeat})

    // #when projected
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, staleThresholdMs})

    // #then stale is true (boundary is inclusive — older-than-or-equal is stale)
    assert(result !== null, 'expected a populated status')
    expect(result.stale).toBe(true)
  })

  it('stale is true when last_heartbeat is past the stale boundary', () => {
    // #given a heartbeat 1 ms past the stale boundary
    const staleThresholdMs = 60_000
    const lastHeartbeat = new Date(BASE_NOW_MS - staleThresholdMs - 1).toISOString()
    const runState = makeRunState({last_heartbeat: lastHeartbeat})

    // #when projected
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, staleThresholdMs})

    // #then stale is true
    assert(result !== null, 'expected a populated status')
    expect(result.stale).toBe(true)
  })

  it('stale is true (fail-safe) when last_heartbeat is unparseable', () => {
    // #given a RunState with a garbage last_heartbeat value
    const runState = makeRunState({last_heartbeat: 'not-a-date'})

    // #when projected
    const result = toOperatorRunStatus(runState, BASE_OPTS)

    // #then stale defaults to true (fail-safe — unknown freshness = stale)
    assert(result !== null, 'expected a populated status')
    expect(result.stale).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Barrel re-export smoke test
// ---------------------------------------------------------------------------

describe('barrel re-exports', () => {
  it('toOperatorRunStatus is re-exported from the contract barrel', async () => {
    // #given the public barrel for the operator-contract module
    const barrel = await import('./index.js')

    // #when the projection function is accessed
    // #then it is present and callable
    expect(typeof barrel.toOperatorRunStatus).toBe('function')
  })
})
