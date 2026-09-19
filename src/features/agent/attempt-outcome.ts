/**
 * Step 1 of a 7-step restructure of `retry.ts`'s attempt-outcome logic.
 *
 * The bug pattern across seven review rounds: outcome was inferred from a clock
 * reading taken after an `await`, rather than from what actually ended
 * observation. The fix is to record *why an attempt stopped observing*
 * ({@link AttemptSettlement}) as a value separate from *which failure was
 * selected* ({@link FailureObservation}), so neither can silently overwrite the
 * other.
 *
 * Governing invariant (from the design review): selecting an error never
 * proves quiescence, and observing quiescence never erases an error.
 *
 * This module is intentionally narrow: two types, one record, one pure
 * function. No lifecycle framework, no event bus, no historical observation
 * log. Nothing imports it yet — it is wired into `retry.ts` in a later step of
 * this restructure.
 */
import type {ClassificationPath, ErrorInfo} from '@fro-bot/runtime'
import type {AttemptOutcome} from './prompt-sender.js'

/**
 * Why an attempt stopped observing. Deliberately separate from which failure
 * (if any) is reported: a settlement asserts only what ended observation, not
 * whether the remote session itself is done or has an error.
 */
export type AttemptSettlement =
  /** A completion predicate passed, including its ownership gate. No deadline abort; a known error still prevents success. */
  | {readonly kind: 'completion-observed'}
  /** A failure-return policy ended observation. Does NOT assert the remote stopped; retry stays separately constrained. */
  | {readonly kind: 'failure-observed'}
  /** The deadline branch actually ended the operation or wait. No retry; the finalizer may abort the root session. */
  | {readonly kind: 'deadline'}
  /** Cancelled externally, not deadline-expired. No retry; do not manufacture a timeout or abort authority. */
  | {readonly kind: 'cancelled'; readonly reason?: string}
  /** The inactivity watchdog or standalone poll budget ended it. No retry; do not claim the shared deadline fired. */
  | {readonly kind: 'watchdog'; readonly message: string}

/** A single failure signal, attributable to exactly one source. */
export interface FailureObservation {
  readonly source: 'submission' | 'session' | 'provider'
  /** Safe-to-surface diagnostic text. */
  readonly message: string
  readonly llmError: ErrorInfo | null
  readonly classificationPath?: ClassificationPath
}

/**
 * A settlement plus an immutable snapshot of the failure observations
 * available at the moment that producer settled. A delayed continuation must
 * not be able to change the cause or the evidence attached to it after the
 * fact — callers build a fresh `AttemptObservation` per settling producer
 * rather than mutating one in place.
 */
export interface AttemptObservation {
  readonly settlement: AttemptSettlement
  readonly failures: readonly FailureObservation[]
}

/**
 * Current-turn acceptance/activity evidence captured alongside the winning
 * observation. `accepted` mirrors "did the remote turn actually start" (e.g.
 * `activityTracker.firstMeaningfulEventReceived` in `retry.ts`) and is what
 * distinguishes a submission failure that never reached the remote
 * (`submit_failed`) from one folded into an in-progress turn.
 */
export interface TurnEvidence {
  readonly accepted: boolean
}

/** The semantic part of an `AttemptResult`, independent of transport/event-stream fields. */
export interface AttemptOutcomeResult {
  readonly success: boolean
  readonly error: string | null
  readonly llmError: ErrorInfo | null
  readonly classificationPath?: ClassificationPath
  readonly outcome: AttemptOutcome
  readonly settlement: AttemptSettlement
  /** Compatibility view derived from outcome; outcome is authoritative. */
  readonly shouldRetry: boolean
}

/**
 * Single source of truth for the outcome-to-retry mapping. Lives beside the reducer that needs it
 * internally -- this module is the pure leaf in the attempt-outcome/retry relationship, so it must
 * not import back from retry.ts (the orchestrator that already imports `reduceAttemptOutcome` from
 * here); that would close the two into a cycle. retry.ts re-exports this for prompt-sender.ts,
 * which already depends on retry.ts at runtime.
 */
export function shouldRetryFromOutcome(outcome: AttemptOutcome): boolean {
  return outcome === 'turn_failed_retryable'
}

/**
 * Picks the authoritative failure per the precedence rules:
 *
 * 1. Terminal provider failure — first one wins, dominates everything else.
 * 2. Normalized session/turn failure — preferred over a submission transport
 *    diagnostic; first one wins unless a provider failure upgrades it.
 * 3. Preserved submission failure — still a failure even when the settlement
 *    is `completion-observed` or `deadline`.
 *
 * `find()` preserves snapshot order, which is what makes "first wins" work.
 */
function selectWinningFailure(
  failures: readonly FailureObservation[],
  preservedSubmissionFailure: FailureObservation | null,
): FailureObservation | null {
  const providerFailure = failures.find(failure => failure.source === 'provider')
  if (providerFailure != null) return providerFailure

  const sessionFailure = failures.find(failure => failure.source === 'session')
  if (sessionFailure != null) return sessionFailure

  const submissionFailure = failures.find(failure => failure.source === 'submission') ?? preservedSubmissionFailure
  if (submissionFailure != null) return submissionFailure

  return null
}

/** Maps a winning failure to an `AttemptOutcome`, given whether the turn was accepted. */
function outcomeForFailure(failure: FailureObservation, turnEvidence: TurnEvidence): AttemptOutcome {
  if (failure.source === 'provider') return 'turn_failed_terminal'

  if (failure.source === 'session') {
    return failure.llmError?.retryable === true ? 'turn_failed_retryable' : 'turn_failed_terminal'
  }

  // source === 'submission'
  if (!turnEvidence.accepted) return 'submit_failed'
  return failure.llmError?.retryable === true ? 'turn_failed_retryable' : 'turn_failed_terminal'
}

/**
 * Derives an outcome and diagnostic message from the settlement alone, used
 * only when no failure observation won. `completion-observed` has no
 * diagnostic here — it is handled by the success branch in the caller.
 */
function settlementFallback(settlement: AttemptSettlement): {
  readonly outcome: AttemptOutcome
  readonly message: string
} {
  switch (settlement.kind) {
    case 'deadline':
      return {outcome: 'timeout', message: 'Attempt did not settle before the execution deadline'}
    case 'cancelled':
      return {outcome: 'turn_failed_terminal', message: settlement.reason ?? 'Attempt observation was cancelled'}
    case 'watchdog':
      return {outcome: 'turn_failed_terminal', message: settlement.message}
    case 'failure-observed':
      // Defensive only: a failure-observed settlement with no recorded failure and no preserved
      // submission failure is a producer bug, not a representable outcome of this reducer.
      return {outcome: 'turn_failed_terminal', message: 'Attempt failed with no recorded failure detail'}
    case 'completion-observed':
      return {outcome: 'completed', message: ''}
  }
}

/**
 * Asserts the invariant this whole module exists to make expressible:
 * `success: true` implies `outcome: 'completed'`, no selected failure, and
 * `settlement.kind === 'completion-observed'`. The reducer's control flow
 * already makes this structurally true (only one return site sets
 * `success: true`, gated on exactly this condition); this assertion is the
 * explicit, testable statement of that fact rather than an additional path
 * that could drift from it.
 */
function assertSuccessInvariant(result: AttemptOutcomeResult): AttemptOutcomeResult {
  if (result.success === true) {
    const holds =
      result.outcome === 'completed' && result.llmError === null && result.settlement.kind === 'completion-observed'
    if (!holds) {
      throw new Error(
        'attempt-outcome invariant violated: success implies outcome=completed, llmError=null, ' +
          'settlement.kind=completion-observed',
      )
    }
  }
  return result
}

/**
 * Pure reduction from a winning settlement observation to the semantic part
 * of an attempt result. See module doc for the governing invariant.
 *
 * @param observation The settlement and its settle-time failure snapshot.
 * @param preservedSubmissionFailure A submission failure carried forward past
 *   an earlier early-exit point (e.g. an ownership-ledger deferral), if any.
 * @param turnEvidence Current-turn acceptance/activity evidence captured with
 *   the winning observation.
 */
export function reduceAttemptOutcome(
  observation: AttemptObservation,
  preservedSubmissionFailure: FailureObservation | null,
  turnEvidence: TurnEvidence,
): AttemptOutcomeResult {
  const winningFailure = selectWinningFailure(observation.failures, preservedSubmissionFailure)

  if (winningFailure != null) {
    const outcome = outcomeForFailure(winningFailure, turnEvidence)
    return assertSuccessInvariant({
      success: false,
      error: winningFailure.message,
      llmError: winningFailure.llmError,
      classificationPath: winningFailure.classificationPath,
      outcome,
      settlement: observation.settlement,
      shouldRetry: shouldRetryFromOutcome(outcome),
    })
  }

  if (observation.settlement.kind === 'completion-observed') {
    return assertSuccessInvariant({
      success: true,
      error: null,
      llmError: null,
      classificationPath: undefined,
      outcome: 'completed',
      settlement: observation.settlement,
      shouldRetry: shouldRetryFromOutcome('completed'),
    })
  }

  const fallback = settlementFallback(observation.settlement)
  return assertSuccessInvariant({
    success: false,
    error: fallback.message,
    llmError: null,
    classificationPath: undefined,
    outcome: fallback.outcome,
    settlement: observation.settlement,
    shouldRetry: shouldRetryFromOutcome(fallback.outcome),
  })
}
