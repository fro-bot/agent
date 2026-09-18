/**
 * Invocation outcome assessment.
 *
 * An audit found this harness detects safety conditions -- unresolved background-dispatch
 * ownership, an SSE observation gap, unconfirmed OpenCode server quiescence, an unverified
 * coordination-lease renewal -- logs them, and never carries them into the run's reported
 * outcome. A run could therefore publish its response, mark itself deduplicated, react
 * success, and exit 0 while its own state was never actually verified.
 *
 * This module is the single place that turns those facts into a reported outcome. It is a
 * pure function over explicit inputs -- no event bus, no lifecycle framework, no new state
 * machine, no I/O -- called from `run.ts` at two points in the same invocation:
 *
 *   1. Provisionally, right after drain, before anything publishes. At that point only
 *      execution and drain facts are known (cleanup has not run yet), so the caller
 *      supplies `quiescenceConfirmed: true` and `continuityUnverified: false` -- "nothing
 *      has yet told us teardown failed" -- and only ever inspects
 *      `isVerificationIncomplete()`, never the full three-way `outcome`, since
 *      `deliverySucceeded` is not decided yet either.
 *   2. Finally, after `runCleanup` returns its safety evidence, with the real teardown
 *      facts and `deliverySucceeded` derived from the invocation's actual exit code.
 *
 * Deliberately NOT part of this: `execution.success` (the attempt-settlement model) is
 * never read or cleared here. Execution success is folded into `deliverySucceeded` by the
 * caller (`runFinalizeWithResult` already turns execution facts into an exit code, including
 * its existing allowance of exit 0 for a recoverable LLM error whose response was still
 * delivered) -- this module does not re-derive or second-guess that decision, it only adds
 * a verification axis orthogonal to it. A genuine execution or delivery failure and
 * verification incompleteness are independent facts and both survive together: see
 * `incompleteReasons` on `InvocationAssessment`, which is populated whenever verification is
 * incomplete regardless of whether delivery also failed.
 */

/**
 * `'skipped'` is never produced by `assessInvocationOutcome` below -- it is assigned
 * directly by `run.ts` for the routing/dedup/lock-contention early-return paths, which
 * exit before execution, drain, or cleanup ever run and therefore have no delivery or
 * verification facts to assess. Those paths attempted no delivery and found nothing wrong,
 * which is a distinct condition from `succeeded` (delivered), `incomplete` (attempted but
 * could not certify), and `failed` (attempted and did not succeed) -- forcing a skip into
 * any of those three would misreport what actually happened.
 */
export type InvocationOutcome = 'succeeded' | 'incomplete' | 'failed' | 'skipped'

/**
 * The verification axis: can this invocation vouch for its own state, independent of
 * whether execution or delivery succeeded?
 */
export interface InvocationVerificationFacts {
  /**
   * `true` when the event stream that observed this invocation's execution recorded an
   * unexpected discontinuity (`EventStreamResult.discontinuity` / `AgentResult.observationGap`)
   * -- the observation channel closed without an intentional local shutdown and without a
   * terminal signal. Selecting an error never proves quiescence, and observing quiescence
   * never erases an observation gap; this stays `true` for the rest of the invocation once
   * set, even if a later poll or retry attempt completes cleanly.
   */
  readonly observationGap: boolean
  /**
   * `true` when drain ended with the ownership ledger reporting one or more `unknown`
   * entries (`DrainOutcome.unknownCount > 0`) -- background dispatch work this invocation
   * owns that neither settled nor was positively confirmed cancelled.
   */
  readonly ownershipUnresolved: boolean
  /**
   * `false` when the OpenCode server's shutdown did not confirm the child process actually
   * quiesced before the checkpoint that follows (`runCleanup`'s `quiescenceConfirmed`).
   * Defaults to `true` for the provisional (pre-cleanup) call -- nothing has reported
   * otherwise yet.
   */
  readonly quiescenceConfirmed: boolean
  /**
   * `true` when the coordination lease's latched `continuityUnverified()` fired at any
   * point during this invocation -- a renewal tick failed, threw, or was still unresolved
   * when `stop()` returned. Defaults to `false` for the provisional (pre-cleanup) call.
   */
  readonly continuityUnverified: boolean
}

export interface AssessInvocationOutcomeInput {
  /** Whether the invocation's response was actually delivered without error (finalize's exit code === 0). */
  readonly deliverySucceeded: boolean
  readonly verification: InvocationVerificationFacts
}

export interface InvocationAssessment {
  readonly outcome: InvocationOutcome
  readonly deliverySucceeded: boolean
  /** Stable identifiers naming every verification gap found, empty when verification is complete. */
  readonly incompleteReasons: readonly string[]
}

function incompleteVerificationReasons(verification: InvocationVerificationFacts): string[] {
  const reasons: string[] = []
  if (verification.observationGap) reasons.push('observation-gap')
  if (verification.ownershipUnresolved) reasons.push('ownership-unresolved')
  if (verification.quiescenceConfirmed === false) reasons.push('server-quiescence-unconfirmed')
  if (verification.continuityUnverified) reasons.push('lease-continuity-unverified')
  return reasons
}

/** `true` when any verification gap is present -- the provisional call's only question. */
export function isVerificationIncomplete(verification: InvocationVerificationFacts): boolean {
  return incompleteVerificationReasons(verification).length > 0
}

/**
 * The single pure assessment function. Three outcomes, computed from explicit inputs only:
 *
 * - `incomplete` -- one or more verification facts could not be established, regardless of
 *   whether delivery succeeded. "A useful result may exist, but this invocation cannot
 *   certify completion."
 * - `failed` -- verification is complete, but delivery did not succeed.
 * - `succeeded` -- verification is complete and delivery succeeded.
 *
 * `incompleteReasons` is populated whenever verification is incomplete, independent of
 * `deliverySucceeded` -- a genuine delivery failure alongside incomplete verification still
 * reports `incomplete` (verification is the stricter axis), but the caller can still see
 * `deliverySucceeded: false` on the same result rather than losing that fact.
 */
export function assessInvocationOutcome(input: AssessInvocationOutcomeInput): InvocationAssessment {
  const {deliverySucceeded, verification} = input
  const incompleteReasons = incompleteVerificationReasons(verification)

  const outcome: InvocationOutcome =
    incompleteReasons.length > 0 ? 'incomplete' : deliverySucceeded ? 'succeeded' : 'failed'

  return {outcome, deliverySucceeded, incompleteReasons}
}
