import type {CacheSaveOutcome, CacheSaveResult} from './cache-save-result.js'
import {describe, expect, it} from 'vitest'

interface OutcomeExpectation {
  readonly description: string
  readonly backendsAttempted: boolean
}

/**
 * Exhaustiveness pin, mirroring `RESPONSE_SURFACE_POLICIES` in
 * `packages/runtime/src/agent/prompt.ts`: `satisfies Record<CacheSaveOutcome, ...>` makes
 * adding a new outcome to the union a compile-time failure here rather than a case this
 * table silently stops covering.
 */
const OUTCOME_EXPECTATIONS = {
  'skipped-by-configuration': {
    description: 'SKIP_CACHE=true; a deliberate no-op',
    backendsAttempted: false,
  },
  'skipped-empty': {
    description: 'no cacheable content existed',
    backendsAttempted: false,
  },
  'checkpoint-declined': {
    description: 'the SQLite write-ahead log could not be checkpointed before the save could proceed',
    backendsAttempted: false,
  },
  'cache-rejected': {
    description:
      'the Actions cache write returned its -1 sentinel; an inference covering both a denial and a collision, never distinguished',
    backendsAttempted: true,
  },
  'cache-error': {
    description: 'the save threw an error other than a caught "already exists" collision',
    backendsAttempted: true,
  },
  persisted: {
    description:
      'the save reached a durable state through at least one backend, including a folded-in "already exists" collision',
    backendsAttempted: true,
  },
} as const satisfies Record<CacheSaveOutcome, OutcomeExpectation>

describe('CacheSaveOutcome', () => {
  it('names every outcome exhaustively (compile-time pin: adding an outcome without updating this table fails check-types)', () => {
    const expectedOutcomes: readonly CacheSaveOutcome[] = [
      'cache-error',
      'cache-rejected',
      'checkpoint-declined',
      'persisted',
      'skipped-by-configuration',
      'skipped-empty',
    ]

    expect(Object.keys(OUTCOME_EXPECTATIONS).sort()).toEqual([...expectedOutcomes].sort())
  })

  it('never attempts a backend for a skip or decline outcome', () => {
    const skippedOutcomes: readonly CacheSaveOutcome[] = [
      'skipped-by-configuration',
      'skipped-empty',
      'checkpoint-declined',
    ]

    for (const outcome of skippedOutcomes) {
      expect(OUTCOME_EXPECTATIONS[outcome].backendsAttempted).toBe(false)
    }
  })
})

describe('CacheSaveResult', () => {
  it('is constructible with every outcome and both persistence axes independent of each other', () => {
    const results: readonly CacheSaveResult[] = [
      {cachePersisted: false, storePersisted: false, outcome: 'skipped-by-configuration'},
      {cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'},
      {cachePersisted: false, storePersisted: false, outcome: 'checkpoint-declined'},
      // The case the plan exists for: the store persisted while the cache write was
      // rejected. cachePersisted and storePersisted disagree, which a boolean return
      // could never represent.
      {cachePersisted: false, storePersisted: true, outcome: 'cache-rejected'},
      {cachePersisted: false, storePersisted: false, outcome: 'cache-error'},
      {cachePersisted: true, storePersisted: true, outcome: 'persisted'},
      {cachePersisted: true, storePersisted: false, outcome: 'persisted'},
    ]

    expect(results).toHaveLength(7)
    for (const result of results) {
      expect(typeof result.cachePersisted).toBe('boolean')
      expect(typeof result.storePersisted).toBe('boolean')
    }
  })

  it('distinguishes cache-rejected from cache-error as separate outcomes for the same false cachePersisted axis', () => {
    const rejected: CacheSaveResult = {cachePersisted: false, storePersisted: false, outcome: 'cache-rejected'}
    const errored: CacheSaveResult = {cachePersisted: false, storePersisted: false, outcome: 'cache-error'}

    expect(rejected.outcome).not.toBe(errored.outcome)
  })
})
