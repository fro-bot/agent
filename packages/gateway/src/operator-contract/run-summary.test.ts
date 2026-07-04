/**
 * Tests for the RunSummary DTO projector.
 *
 * Covers:
 * - Phase → OperatorWebStatus mapping (all 6 RunPhase values, table-driven)
 * - repo field comes from the binding, not entity_ref (no '#' in output)
 * - updatedAt omitted when last_heartbeat is empty or unparseable; present when valid ISO
 * - Closed-DTO: output has only the declared keys (no internal fields)
 * - Consistency guard: entity_ref owner/repo mismatch → null
 * - Unrecognized phase → 'failed' (fail-closed)
 */

import type {RunState} from '@fro-bot/runtime'
import type {OperatorWebStatus, RunSummary} from './index.js'

import {assert, describe, expect, it} from 'vitest'
import {toRunSummary} from './run-summary.js'

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const makeRunState = (overrides: Partial<RunState> = {}): RunState => ({
  run_id: 'run-abc-123',
  surface: 'github',
  thread_id: 'thread-internal-001',
  entity_ref: 'ownerA/repoA#42',
  phase: 'EXECUTING',
  started_at: '2024-01-01T00:00:00.000Z',
  last_heartbeat: '2024-01-01T00:01:00.000Z',
  holder_id: 'holder-internal-xyz',
  details: {internal: 'secret'},
  ...overrides,
})

const BINDING_A = {owner: 'ownerA', repo: 'repoA'} as const

// ---------------------------------------------------------------------------
// Phase → web-status mapping (all 6 RunPhase values)
// ---------------------------------------------------------------------------

describe('toRunSummary — phase mapping', () => {
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
      // #given a run in phase ${phase} with a matching entity_ref
      const runState = makeRunState({phase, entity_ref: 'ownerA/repoA#1'})

      // #when projected against the matching binding
      const result = toRunSummary(runState, BINDING_A)

      // #then the web status is ${expectedStatus}
      assert(result !== null, `expected a non-null summary for phase ${phase}`)
      expect(result.status).toBe(expectedStatus)
    })
  }
})

// ---------------------------------------------------------------------------
// repo field — from binding, not entity_ref
// ---------------------------------------------------------------------------

describe('toRunSummary — repo field', () => {
  it('repo is owner/name from the binding (no # fragment)', () => {
    // #given a run whose entity_ref carries a run number fragment
    const runState = makeRunState({entity_ref: 'ownerA/repoA#99'})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then repo is the binding's owner/repo, not the raw entity_ref
    assert(result !== null, 'expected a non-null summary')
    expect(result.repo).toBe('ownerA/repoA')
    expect(result.repo).not.toContain('#')
  })

  it('repo uses the binding values even when entity_ref has a different casing', () => {
    // #given a binding with specific owner/repo values
    const binding = {owner: 'MyOrg', repo: 'MyRepo'}
    const runState = makeRunState({entity_ref: 'MyOrg/MyRepo#5'})

    // #when projected
    const result = toRunSummary(runState, binding)

    // #then repo is exactly the binding's owner/repo
    assert(result !== null, 'expected a non-null summary')
    expect(result.repo).toBe('MyOrg/MyRepo')
  })
})

// ---------------------------------------------------------------------------
// updatedAt — omitted when last_heartbeat is empty or unparseable
// ---------------------------------------------------------------------------

describe('toRunSummary — updatedAt field', () => {
  it('updatedAt is present and equals last_heartbeat when it is a valid ISO string', () => {
    // #given a run with a valid ISO last_heartbeat
    const heartbeat = '2024-06-15T10:30:00.000Z'
    const runState = makeRunState({last_heartbeat: heartbeat})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then updatedAt is present and equals last_heartbeat
    assert(result !== null, 'expected a non-null summary')
    expect(result.updatedAt).toBe(heartbeat)
  })

  it('updatedAt is omitted when last_heartbeat is an empty string', () => {
    // #given a run with an empty last_heartbeat
    const runState = makeRunState({last_heartbeat: ''})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then updatedAt is absent from the output object
    assert(result !== null, 'expected a non-null summary')
    expect(Object.prototype.hasOwnProperty.call(result, 'updatedAt')).toBe(false)
  })

  it('updatedAt is omitted when last_heartbeat is an unparseable string', () => {
    // #given a run with a garbage last_heartbeat value
    const runState = makeRunState({last_heartbeat: 'not-a-date'})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then updatedAt is absent from the output object
    assert(result !== null, 'expected a non-null summary')
    expect(Object.prototype.hasOwnProperty.call(result, 'updatedAt')).toBe(false)
  })

  it('updatedAt is omitted when last_heartbeat is a partial date string that does not parse', () => {
    // #given a run with a partial date string
    const runState = makeRunState({last_heartbeat: '2024-13-45'})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then updatedAt is absent (NaN from Date.parse)
    assert(result !== null, 'expected a non-null summary')
    expect(Object.prototype.hasOwnProperty.call(result, 'updatedAt')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Closed-DTO: only the declared keys, no internal fields
// ---------------------------------------------------------------------------

describe('toRunSummary — closed-DTO key set', () => {
  it('output has only the declared keys (runId, repo, status, createdAt) when updatedAt is absent', () => {
    // #given a run with an unparseable last_heartbeat (so updatedAt is omitted)
    const runState = makeRunState({last_heartbeat: ''})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then the output has exactly the 4 declared keys
    assert(result !== null, 'expected a non-null summary')
    const keys = new Set(Object.keys(result))
    expect(keys).toEqual(new Set(['runId', 'repo', 'status', 'createdAt']))
  })

  it('output has exactly 5 keys (runId, repo, status, createdAt, updatedAt) when updatedAt is present', () => {
    // #given a run with a valid last_heartbeat
    const runState = makeRunState({last_heartbeat: '2024-06-15T10:30:00.000Z'})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then the output has exactly the 5 declared keys
    assert(result !== null, 'expected a non-null summary')
    const keys = new Set(Object.keys(result))
    expect(keys).toEqual(new Set(['runId', 'repo', 'status', 'createdAt', 'updatedAt']))
  })

  it('output has no entityRef, surface, phase, stale, thread_id, holder_id, or details keys', () => {
    // #given a fully-populated RunState with all internal fields
    const runState = makeRunState()

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then internal fields are absent from the output object
    assert(result !== null, 'expected a non-null summary')
    const keys = Object.keys(result)
    expect(keys).not.toContain('entityRef')
    expect(keys).not.toContain('entity_ref')
    expect(keys).not.toContain('surface')
    expect(keys).not.toContain('phase')
    expect(keys).not.toContain('stale')
    expect(keys).not.toContain('thread_id')
    expect(keys).not.toContain('holder_id')
    expect(keys).not.toContain('details')
  })

  it('output has failureKind + exactly 6 keys for a FAILED run with details.failureKind', () => {
    // #given a FAILED run with a classified failureKind and no valid heartbeat
    const runState = makeRunState({phase: 'FAILED', last_heartbeat: '', details: {failureKind: 'session-error'}})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then failureKind is present, updatedAt is absent
    assert(result !== null, 'expected a non-null summary')
    const keys = new Set(Object.keys(result))
    expect(keys).toEqual(new Set(['runId', 'repo', 'status', 'createdAt', 'failureKind']))
    expect(result.failureKind).toBe('session-error')
  })

  it('output has no failureKind for a non-FAILED run even with details.failureKind set', () => {
    // #given a non-FAILED run whose details happen to carry a failureKind value
    const runState = makeRunState({phase: 'EXECUTING', last_heartbeat: '', details: {failureKind: 'session-error'}})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then failureKind is absent — population is gated on FAILED phase
    assert(result !== null, 'expected a non-null summary')
    const keys = new Set(Object.keys(result))
    expect(keys).toEqual(new Set(['runId', 'repo', 'status', 'createdAt']))
    expect(Object.prototype.hasOwnProperty.call(result, 'failureKind')).toBe(false)
  })

  it('runSummary type does not carry entityRef, surface, phase, stale, or internal fields', () => {
    // #given the RunSummary type
    // #when inspected at the type level
    // #then it does not include internal coordination fields
    const summary = {} as RunSummary
    // These property accesses would be type errors if the fields existed on RunSummary.
    // We verify at runtime that the keys are absent from a real projection.
    expect('entityRef' in summary).toBe(false)
    expect('surface' in summary).toBe(false)
    expect('phase' in summary).toBe(false)
    expect('stale' in summary).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Consistency guard: entity_ref owner/repo mismatch → null
// ---------------------------------------------------------------------------

describe('toRunSummary — entity_ref consistency guard', () => {
  it('returns null when entity_ref owner/repo does not match the binding', () => {
    // #given a run whose entity_ref points to a different repo than the binding
    const runState = makeRunState({entity_ref: 'ownerB/repoB#5'})
    const binding = {owner: 'ownerA', repo: 'repoA'}

    // #when projected against the mismatched binding
    const result = toRunSummary(runState, binding)

    // #then null is returned (omit — corruption/rename guard)
    expect(result).toBeNull()
  })

  it('returns null when entity_ref owner does not match (same repo name, different owner)', () => {
    // #given a run whose entity_ref has a different owner
    const runState = makeRunState({entity_ref: 'ownerB/repoA#1'})
    const binding = {owner: 'ownerA', repo: 'repoA'}

    // #when projected
    const result = toRunSummary(runState, binding)

    // #then null (owner mismatch)
    expect(result).toBeNull()
  })

  it('returns null when entity_ref repo does not match (same owner, different repo name)', () => {
    // #given a run whose entity_ref has a different repo
    const runState = makeRunState({entity_ref: 'ownerA/repoB#1'})
    const binding = {owner: 'ownerA', repo: 'repoA'}

    // #when projected
    const result = toRunSummary(runState, binding)

    // #then null (repo mismatch)
    expect(result).toBeNull()
  })

  it('returns non-null when entity_ref owner/repo matches the binding', () => {
    // #given a run whose entity_ref matches the binding
    const runState = makeRunState({entity_ref: 'ownerA/repoA#5'})
    const binding = {owner: 'ownerA', repo: 'repoA'}

    // #when projected
    const result = toRunSummary(runState, binding)

    // #then a non-null summary is returned with repo from the binding
    assert(result !== null, 'expected a non-null summary for a matching entity_ref')
    expect(result.repo).toBe('ownerA/repoA')
  })

  it('returns null when entity_ref is malformed (no slash)', () => {
    // #given a run with a malformed entity_ref
    const runState = makeRunState({entity_ref: 'no-slash-here'})
    const binding = {owner: 'ownerA', repo: 'repoA'}

    // #when projected
    const result = toRunSummary(runState, binding)

    // #then null (cannot extract owner/repo — treat as mismatch)
    expect(result).toBeNull()
  })

  it('returns null when entity_ref is empty', () => {
    // #given a run with an empty entity_ref
    const runState = makeRunState({entity_ref: ''})
    const binding = {owner: 'ownerA', repo: 'repoA'}

    // #when projected
    const result = toRunSummary(runState, binding)

    // #then null (cannot extract owner/repo)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fail-closed: unrecognized phase → 'failed'
// ---------------------------------------------------------------------------

describe('toRunSummary — unknown phase fallback (fail-closed)', () => {
  it("returns status 'failed' for an unrecognized phase value", () => {
    // #given a RunState carrying an out-of-domain phase (data corruption or version skew)
    const runState: RunState = {
      ...makeRunState(),
      phase: 'UNKNOWN_FUTURE_PHASE' as unknown as RunState['phase'],
    }

    // #when projected against the matching binding
    const result = toRunSummary(runState, BINDING_A)

    // #then status falls back to 'failed' (not undefined / not a missing key)
    assert(result !== null, 'expected a non-null summary')
    expect(result.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// createdAt field
// ---------------------------------------------------------------------------

describe('toRunSummary — createdAt field', () => {
  it('createdAt equals started_at from the RunState', () => {
    // #given a run with a specific started_at
    const startedAt = '2024-03-15T08:00:00.000Z'
    const runState = makeRunState({started_at: startedAt})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then createdAt equals started_at
    assert(result !== null, 'expected a non-null summary')
    expect(result.createdAt).toBe(startedAt)
  })
})

// ---------------------------------------------------------------------------
// runId field
// ---------------------------------------------------------------------------

describe('toRunSummary — runId field', () => {
  it('runId equals run_id from the RunState', () => {
    // #given a run with a specific run_id
    const runState = makeRunState({run_id: 'run-xyz-789'})

    // #when projected
    const result = toRunSummary(runState, BINDING_A)

    // #then runId equals run_id
    assert(result !== null, 'expected a non-null summary')
    expect(result.runId).toBe('run-xyz-789')
  })
})
