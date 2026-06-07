/**
 * Review Reconciliation (RFC-009 extension)
 *
 * Pure logic module that decides whether the harness should submit an APPROVE
 * review, given already-fetched GitHub facts. No I/O, no octokit, no network.
 */

/**
 * The set of verdict tokens the agent emits in its review body heading.
 */
export type Verdict = 'PASS' | 'CONDITIONAL' | 'REJECT'

/**
 * Input facts for the reconciliation decision.
 * All fields are pre-fetched by the caller (the reconciliation phase) — this module is pure.
 */
export interface ReconciliationInput {
  /** Parsed verdict from the agent's review body, or null if absent/ambiguous. */
  readonly verdict: Verdict | null
  /** True if the bot already has an APPROVED review on the current head SHA. */
  readonly alreadyApprovedAtHead: boolean
  /** True if the verdict artifact timestamp is >= the current run's start time. */
  readonly verdictBelongsToRun: boolean
  /** True if the verdict artifact corresponds to the current PR head SHA. */
  readonly headMatches: boolean
}

/**
 * Decision to submit an APPROVE review.
 */
export interface ApproveAction {
  readonly action: 'approve'
}

/**
 * Decision to skip — includes a stable reason identifier.
 */
export interface SkipAction {
  readonly action: 'skip'
  readonly reason: 'no-verdict' | 'not-pass' | 'already-approved' | 'stale-or-not-this-run' | 'stale-head'
}

export type ReconciliationDecision = ApproveAction | SkipAction

/**
 * Parse the agent's verdict from a review body string.
 *
 * Looks for a `## Verdict: <TOKEN>` heading (case-sensitive uppercase tokens,
 * tolerant of surrounding whitespace and trailing text on the line).
 *
 * Returns:
 * - The matched `Verdict` token when exactly one distinct verdict heading is found.
 * - `null` when: no heading present, unrecognized token, or multiple DIFFERENT
 *   verdict headings (ambiguous). A single heading repeated identically is fine.
 */
export function parseVerdict(body: string): Verdict | null {
  // Match lines of the form (optional leading whitespace) ## Verdict: TOKEN (anything after)
  const headingPattern = /^\s*##\s+Verdict:\s+(\S+)/gm
  const validVerdicts = new Set<string>(['PASS', 'CONDITIONAL', 'REJECT'])

  const found = new Set<string>()
  let match = headingPattern.exec(body)

  while (match !== null) {
    const token = match[1]
    if (token !== undefined) {
      // Strip any trailing punctuation that might follow the token on the same line
      // The regex already stops at whitespace via \S+, so token is the bare word.
      if (!validVerdicts.has(token)) {
        // Unrecognized token — treat the whole body as unparseable
        return null
      }
      found.add(token)
    }
    match = headingPattern.exec(body)
  }

  if (found.size === 0) {
    return null
  }

  if (found.size > 1) {
    // Multiple DIFFERENT valid verdicts — ambiguous
    return null
  }

  // Exactly one distinct valid verdict
  const [verdict] = found
  return verdict as Verdict
}

/**
 * Decide whether to submit an APPROVE review or skip, given pre-fetched facts.
 *
 * Approval requires ALL of:
 * - `verdict === 'PASS'`
 * - `alreadyApprovedAtHead === false`
 * - `verdictBelongsToRun === true`
 * - `headMatches === true`
 *
 * Skip reasons are checked in precedence order so the most informative wins.
 */
export function decideReconciliation(input: ReconciliationInput): ReconciliationDecision {
  const {verdict, alreadyApprovedAtHead, verdictBelongsToRun, headMatches} = input

  if (verdict === null) {
    return {action: 'skip', reason: 'no-verdict'}
  }

  if (verdict !== 'PASS') {
    return {action: 'skip', reason: 'not-pass'}
  }

  if (alreadyApprovedAtHead === true) {
    return {action: 'skip', reason: 'already-approved'}
  }

  if (verdictBelongsToRun === false) {
    return {action: 'skip', reason: 'stale-or-not-this-run'}
  }

  if (headMatches === false) {
    return {action: 'skip', reason: 'stale-head'}
  }

  return {action: 'approve'}
}
