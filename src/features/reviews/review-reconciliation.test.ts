import {describe, expect, it} from 'vitest'
import {decideReconciliation, parseVerdict} from './review-reconciliation.js'

describe('parseVerdict', () => {
  it('returns PASS for "## Verdict: PASS"', () => {
    // #given a body with a PASS verdict heading
    const body = '## Verdict: PASS'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should return PASS
    expect(result).toBe('PASS')
  })

  it('returns PASS with trailing text on the verdict line', () => {
    // #given a body with trailing text after the verdict
    const body = '## Verdict: PASS — all checks green'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should still return PASS
    expect(result).toBe('PASS')
  })

  it('returns PASS with surrounding whitespace', () => {
    // #given a body with whitespace around the verdict heading
    const body = '  ## Verdict: PASS  \n\nSome other content'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should return PASS
    expect(result).toBe('PASS')
  })

  it('returns CONDITIONAL for "## Verdict: CONDITIONAL"', () => {
    // #given a body with a CONDITIONAL verdict heading
    const body = '## Verdict: CONDITIONAL'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should return CONDITIONAL
    expect(result).toBe('CONDITIONAL')
  })

  it('returns REJECT for "## Verdict: REJECT"', () => {
    // #given a body with a REJECT verdict heading
    const body = '## Verdict: REJECT'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should return REJECT
    expect(result).toBe('REJECT')
  })

  it('returns null when no verdict heading is present', () => {
    // #given a body with no verdict heading
    const body = 'This is a review with no verdict heading.\n\nSome comments here.'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should return null
    expect(result).toBeNull()
  })

  it('returns null for an unrecognized verdict token', () => {
    // #given a body with an unrecognized verdict token
    const body = '## Verdict: MAYBE'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should return null
    expect(result).toBeNull()
  })

  it('returns null when two DIFFERENT verdict headings are present (ambiguous)', () => {
    // #given a body with two conflicting verdict headings
    const body = '## Verdict: PASS\n\nSome content\n\n## Verdict: REJECT'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should return null (ambiguous)
    expect(result).toBeNull()
  })

  it('returns the verdict when the same heading appears twice (not ambiguous)', () => {
    // #given a body with the same verdict heading repeated
    const body = '## Verdict: PASS\n\nSome content\n\n## Verdict: PASS'

    // #when parsing the verdict
    const result = parseVerdict(body)

    // #then should return PASS (not null)
    expect(result).toBe('PASS')
  })
})

describe('decideReconciliation', () => {
  it('returns approve when PASS, not already approved, belongs to run, head matches', () => {
    // #given all conditions met for approval
    const input = {
      verdict: 'PASS' as const,
      alreadyApprovedAtHead: false,
      verdictBelongsToRun: true,
      headMatches: true,
    }

    // #when deciding reconciliation
    const result = decideReconciliation(input)

    // #then should return approve
    expect(result).toEqual({action: 'approve'})
  })

  it('returns skip "already-approved" when PASS but already approved at head', () => {
    // #given PASS verdict but already approved
    const input = {
      verdict: 'PASS' as const,
      alreadyApprovedAtHead: true,
      verdictBelongsToRun: true,
      headMatches: true,
    }

    // #when deciding reconciliation
    const result = decideReconciliation(input)

    // #then should skip with already-approved reason
    expect(result).toEqual({action: 'skip', reason: 'already-approved'})
  })

  it('returns skip "stale-or-not-this-run" when PASS but verdict does not belong to run', () => {
    // #given PASS verdict but from a different run
    const input = {
      verdict: 'PASS' as const,
      alreadyApprovedAtHead: false,
      verdictBelongsToRun: false,
      headMatches: true,
    }

    // #when deciding reconciliation
    const result = decideReconciliation(input)

    // #then should skip with stale-or-not-this-run reason
    expect(result).toEqual({action: 'skip', reason: 'stale-or-not-this-run'})
  })

  it('returns skip "stale-head" when PASS, this run, not already approved, but head does not match', () => {
    // #given PASS verdict from this run but head has changed
    const input = {
      verdict: 'PASS' as const,
      alreadyApprovedAtHead: false,
      verdictBelongsToRun: true,
      headMatches: false,
    }

    // #when deciding reconciliation
    const result = decideReconciliation(input)

    // #then should skip with stale-head reason
    expect(result).toEqual({action: 'skip', reason: 'stale-head'})
  })

  it('returns skip "not-pass" for CONDITIONAL verdict', () => {
    // #given a CONDITIONAL verdict
    const input = {
      verdict: 'CONDITIONAL' as const,
      alreadyApprovedAtHead: false,
      verdictBelongsToRun: true,
      headMatches: true,
    }

    // #when deciding reconciliation
    const result = decideReconciliation(input)

    // #then should skip with not-pass reason
    expect(result).toEqual({action: 'skip', reason: 'not-pass'})
  })

  it('returns skip "not-pass" for REJECT verdict', () => {
    // #given a REJECT verdict
    const input = {
      verdict: 'REJECT' as const,
      alreadyApprovedAtHead: false,
      verdictBelongsToRun: true,
      headMatches: true,
    }

    // #when deciding reconciliation
    const result = decideReconciliation(input)

    // #then should skip with not-pass reason
    expect(result).toEqual({action: 'skip', reason: 'not-pass'})
  })

  it('returns skip "no-verdict" for null verdict', () => {
    // #given a null verdict
    const input = {
      verdict: null,
      alreadyApprovedAtHead: false,
      verdictBelongsToRun: true,
      headMatches: true,
    }

    // #when deciding reconciliation
    const result = decideReconciliation(input)

    // #then should skip with no-verdict reason
    expect(result).toEqual({action: 'skip', reason: 'no-verdict'})
  })

  it('returns skip "no-verdict" even when other flags are false (precedence)', () => {
    // #given null verdict with all other flags also false
    const input = {
      verdict: null,
      alreadyApprovedAtHead: false,
      verdictBelongsToRun: false,
      headMatches: false,
    }

    // #when deciding reconciliation
    const result = decideReconciliation(input)

    // #then no-verdict wins over other skip reasons
    expect(result).toEqual({action: 'skip', reason: 'no-verdict'})
  })
})
