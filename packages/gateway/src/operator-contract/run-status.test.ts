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
  isRepoDenylisted: () => false,
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

    // #when projected with a predicate that always returns true
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, isRepoDenylisted: () => true})

    // #then the record is omitted entirely — null, not a populated status
    expect(result).toBeNull()
  })

  it('(positive control) returns a populated status for a non-denylisted repo', () => {
    // #given a run whose repo is NOT on the denylist
    const runState = makeRunState({entity_ref: 'public-org/public-repo#5'})

    // #when projected with a predicate that always returns false
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, isRepoDenylisted: () => false})

    // #then the record is populated — not accidentally omitted
    assert(result !== null, 'expected a populated status for a non-denylisted repo')
    expect(result.entityRef).toBe('public-org/public-repo#5')
  })

  it('(r6) denylisted result is null even when phase is EXECUTING (no partial leak)', () => {
    // #given an actively-running denylisted run
    const runState = makeRunState({phase: 'EXECUTING', entity_ref: 'hidden/repo#99'})

    // #when projected with a predicate that always returns true
    const result = toOperatorRunStatus(runState, {...BASE_OPTS, isRepoDenylisted: () => true})

    // #then null — the active status must not leak the repo's activity
    expect(result).toBeNull()
  })

  it('(r6) membership-based predicate gates on entity_ref — denylisted org omitted, public org surfaced', () => {
    // #given a predicate backed by org-prefix membership (simulates metadata/repos.yaml)
    const isRepoDenylisted = (ref: string) => ref.startsWith('secret-org/')

    // #given a run in the denylisted org
    const secretRun = makeRunState({entity_ref: 'secret-org/secret-repo#1'})
    // #given a run in a public org
    const publicRun = makeRunState({entity_ref: 'public-org/ok-repo#2'})

    // #when projected with the membership predicate
    const secretResult = toOperatorRunStatus(secretRun, {...BASE_OPTS, isRepoDenylisted})
    const publicResult = toOperatorRunStatus(publicRun, {...BASE_OPTS, isRepoDenylisted})

    // #then the denylisted run is omitted
    expect(secretResult).toBeNull()
    // #then the public run is surfaced with its entity_ref
    assert(publicResult !== null, 'expected a populated status for a non-denylisted repo')
    expect(publicResult.entityRef).toBe('public-org/ok-repo#2')
  })

  it('(r6) predicate receives the run entity_ref as its argument', () => {
    // #given a spy predicate that records the argument it was called with
    const capturedArgs: string[] = []
    const isRepoDenylisted = (ref: string) => {
      capturedArgs.push(ref)
      return false
    }
    const runState = makeRunState({entity_ref: 'acme/widget#7'})

    // #when projected
    toOperatorRunStatus(runState, {...BASE_OPTS, isRepoDenylisted})

    // #then the predicate was called with the run's entity_ref
    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0]).toBe('acme/widget#7')
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
// Fail-closed fallback: unknown phase → 'failed'
// ---------------------------------------------------------------------------

describe('toOperatorRunStatus — unknown phase fallback (fail-closed)', () => {
  it("returns status 'failed' for an unrecognized phase value (defense-in-depth)", () => {
    // #given — a RunState carrying an out-of-domain phase (data corruption or a
    // newer-build phase this version does not know). The cast injects the runtime
    // value the type system forbids, exercising the ?? 'failed' fallback.
    const runState: RunState = {
      ...makeRunState(),
      phase: 'UNKNOWN_FUTURE_PHASE' as unknown as RunState['phase'],
    }

    // #when projected with a non-denylisted repo
    const result = toOperatorRunStatus(runState, BASE_OPTS)

    // #then status falls back to 'failed' (not undefined / not a missing key)
    expect(result).not.toBeNull()
    expect(result?.status).toBe('failed')
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
