import {describe, expect, it} from 'vitest'
import {assessInvocationOutcome, isVerificationIncomplete, type InvocationVerificationFacts} from './outcome.js'

const CLEAN: InvocationVerificationFacts = {
  observationGap: false,
  ownershipUnresolved: false,
  quiescenceConfirmed: true,
  continuityUnverified: false,
}

describe('assessInvocationOutcome', () => {
  it('reports succeeded when delivery succeeded and every verification fact is clean', () => {
    // #given a clean delivery and clean verification
    // #when assessed
    const result = assessInvocationOutcome({deliverySucceeded: true, verification: CLEAN})
    // #then the outcome is succeeded with no incomplete reasons
    expect(result).toEqual({outcome: 'succeeded', deliverySucceeded: true, incompleteReasons: []})
  })

  it('reports failed when delivery did not succeed but verification is clean', () => {
    // #given a failed delivery, clean verification
    const result = assessInvocationOutcome({deliverySucceeded: false, verification: CLEAN})
    // #then failed, not incomplete -- verification never became a question here
    expect(result).toEqual({outcome: 'failed', deliverySucceeded: false, incompleteReasons: []})
  })

  it.each([
    ['observation-gap', {...CLEAN, observationGap: true}, ['observation-gap']],
    ['ownership-unresolved', {...CLEAN, ownershipUnresolved: true}, ['ownership-unresolved']],
    ['server-quiescence-unconfirmed', {...CLEAN, quiescenceConfirmed: false}, ['server-quiescence-unconfirmed']],
    ['lease-continuity-unverified', {...CLEAN, continuityUnverified: true}, ['lease-continuity-unverified']],
  ] as const)(
    'reports incomplete with reason %s when delivery succeeded but that verification fact is dirty',
    (_name, verification, expectedReasons) => {
      // #given a successful delivery, but this one verification fact is unresolved
      // #when assessed
      const result = assessInvocationOutcome({deliverySucceeded: true, verification})
      // #then the outcome is incomplete -- a successful-looking delivery does not override
      // an unresolved verification fact (the complement pairing this subsystem needs: remove
      // the dirty fact and this test flips to succeeded, proving the fact alone decided it)
      expect(result.outcome).toBe('incomplete')
      expect(result.incompleteReasons).toEqual(expectedReasons)
    },
  )

  it('preserves both a genuine delivery failure and verification incompleteness together (neither erases the other)', () => {
    // #given a failed delivery AND an unresolved verification fact
    const result = assessInvocationOutcome({
      deliverySucceeded: false,
      verification: {...CLEAN, ownershipUnresolved: true},
    })
    // #then the outcome is incomplete (the stricter axis), but deliverySucceeded still
    // reports false and the incomplete reason is still named -- nothing here silently
    // downgrades a real failure into a soft "incomplete" label, or hides the failure
    // fact once incompleteness is also present
    expect(result.outcome).toBe('incomplete')
    expect(result.deliverySucceeded).toBe(false)
    expect(result.incompleteReasons).toEqual(['ownership-unresolved'])
  })

  it('accumulates every dirty verification fact into incompleteReasons, not just the first', () => {
    // #given every verification fact dirty at once
    const result = assessInvocationOutcome({
      deliverySucceeded: true,
      verification: {
        observationGap: true,
        ownershipUnresolved: true,
        quiescenceConfirmed: false,
        continuityUnverified: true,
      },
    })
    // #then all four reasons are named
    expect(result.outcome).toBe('incomplete')
    expect(result.incompleteReasons).toEqual([
      'observation-gap',
      'ownership-unresolved',
      'server-quiescence-unconfirmed',
      'lease-continuity-unverified',
    ])
  })
})

describe('isVerificationIncomplete', () => {
  it('is false for the clean facts the provisional (pre-cleanup) call defaults teardown to', () => {
    // #given the provisional defaults: nothing has reported a teardown problem yet
    // #when checked
    // #then verification reads complete
    expect(isVerificationIncomplete(CLEAN)).toBe(false)
  })

  it('is true as soon as either execution-time fact (observation gap or unresolved ownership) is dirty', () => {
    // #given only execution/drain facts available (the provisional call's actual inputs)
    expect(isVerificationIncomplete({...CLEAN, observationGap: true})).toBe(true)
    expect(isVerificationIncomplete({...CLEAN, ownershipUnresolved: true})).toBe(true)
  })
})
