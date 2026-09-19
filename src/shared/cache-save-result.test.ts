import type {CacheSaveOutcome, CacheSaveResult, CacheSaveStateValue} from './cache-save-result.js'
import {describe, expect, it} from 'vitest'
import {parseCacheSaveStateValue, toCacheSaveStateValue} from './cache-save-result.js'

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
  'ownership-declined': {
    description:
      'persistence safety could not be confirmed -- unresolved ownership, unconfirmed server quiescence, or a failed coordination lease renewal',
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
      'ownership-declined',
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
      'ownership-declined',
    ]

    for (const outcome of skippedOutcomes) {
      expect(OUTCOME_EXPECTATIONS[outcome].backendsAttempted).toBe(false)
    }
  })
})

describe('CacheSaveResult', () => {
  // 'ownership-declined' is deliberately not in this fixture: it is exhaustively covered
  // by OUTCOME_EXPECTATIONS above and the toCacheSaveStateValue case table below. This
  // fixture exists to demonstrate the two persistence axes varying independently (see the
  // duplicated 'persisted' entries), not to enumerate every CacheSaveOutcome -- that
  // guarantee is the compile-time satisfies-pinned tables, not this array.
  it('constructs representative outcomes with both persistence axes independent of each other', () => {
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

describe('toCacheSaveStateValue', () => {
  // Exhaustiveness is pinned at compile time by `OUTCOME_TO_STATE_VALUE`'s
  // `satisfies Record<CacheSaveOutcome, CacheSaveStateMapper>` in cache-save-result.ts --
  // mirroring the OUTCOME_EXPECTATIONS table above. Verified by temporarily deleting the
  // 'cache-error' case from that table during implementation: `bun run check-types` then
  // fails with "Property 'cache-error' is missing in type ... but required in type
  // 'Record<CacheSaveOutcome, CacheSaveStateMapper>'", proving a new/removed outcome
  // cannot silently map to nothing. The case was restored immediately after confirming
  // the failure; this table below exercises the restored, complete mapping at runtime.
  const cases: readonly {readonly result: CacheSaveResult; readonly expected: CacheSaveStateValue}[] = [
    {result: {cachePersisted: false, storePersisted: false, outcome: 'skipped-by-configuration'}, expected: 'skipped'},
    // hasCacheableContent is a point-in-time filesystem observation, not a configuration
    // constant, so an empty save must retry rather than fold into the deliberate skip.
    {result: {cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'}, expected: 'not-persisted'},
    {result: {cachePersisted: false, storePersisted: false, outcome: 'checkpoint-declined'}, expected: 'not-persisted'},
    // Deliberately NOT 'not-persisted': a retry here would silently override the
    // persistence safety gate runCleanup just applied -- the review finding this state
    // value exists to fix. See OUTCOME_TO_STATE_VALUE's 'ownership-declined' case.
    {
      result: {cachePersisted: false, storePersisted: false, outcome: 'ownership-declined'},
      expected: 'declined-for-safety',
    },
    // The case the whole plan exists for: the object store persisted independently of a
    // rejected cache write, so the state is durable through the other backend.
    {result: {cachePersisted: false, storePersisted: true, outcome: 'cache-rejected'}, expected: 'store-only'},
    {result: {cachePersisted: false, storePersisted: false, outcome: 'cache-rejected'}, expected: 'not-persisted'},
    {result: {cachePersisted: false, storePersisted: true, outcome: 'cache-error'}, expected: 'store-only'},
    {result: {cachePersisted: false, storePersisted: false, outcome: 'cache-error'}, expected: 'not-persisted'},
    {result: {cachePersisted: true, storePersisted: false, outcome: 'persisted'}, expected: 'durable'},
    {result: {cachePersisted: true, storePersisted: true, outcome: 'persisted'}, expected: 'durable'},
  ]

  for (const {result, expected} of cases) {
    it(`maps ${result.outcome} (storePersisted: ${result.storePersisted}) to ${expected}`, () => {
      expect(toCacheSaveStateValue(result)).toBe(expected)
    })
  }
})

// Compile-time exhaustiveness pin, mirroring OUTCOME_EXPECTATIONS above:
// `satisfies Record<CacheSaveStateValue, true>` makes adding a value to the
// CacheSaveStateValue union without updating this object fail check-types. Deliberately
// NOT derived from CACHE_SAVE_STATE_VALUES (the array parseCacheSaveStateValue itself
// reads) -- a round-trip test built from that array would be tautological with exactly
// the blind spot it needs to catch: if 'declined-for-safety' (or a future value) were
// ever dropped from CACHE_SAVE_STATE_VALUES, parseCacheSaveStateValue would silently
// fall back to 'not-persisted' (the value that re-enables the unsafe post retry this
// whole change closed), and a test sourced from that same array would drop the value
// too and never notice. Pinning against the type instead means this test still lists
// every value even if the array quietly loses one.
const ALL_STATE_VALUES = {
  durable: true,
  'store-only': true,
  skipped: true,
  'declined-for-safety': true,
  'not-persisted': true,
} as const satisfies Record<CacheSaveStateValue, true>

describe('parseCacheSaveStateValue', () => {
  it('round-trips every valid CacheSaveStateValue', () => {
    for (const value of Object.keys(ALL_STATE_VALUES) as CacheSaveStateValue[]) {
      expect(parseCacheSaveStateValue(value)).toBe(value)
    }
  })

  it('treats an absent state value (empty string, what core.getState returns for an unset key) as not-persisted', () => {
    expect(parseCacheSaveStateValue('')).toBe('not-persisted')
  })

  it('treats an unrecognized value (e.g. the old boolean "true", or corrupted state) as not-persisted -- fail toward retrying, never toward skipping', () => {
    expect(parseCacheSaveStateValue('true')).toBe('not-persisted')
    expect(parseCacheSaveStateValue('banana')).toBe('not-persisted')
  })
})
