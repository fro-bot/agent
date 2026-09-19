/**
 * Step 1 of a 7-step restructure of `retry.ts`'s attempt-outcome logic.
 *
 * `reduceAttemptOutcome` is pure, so these are plain table-driven unit tests —
 * no mocks, no fakes, no timers. The table below exists specifically to avoid
 * the one-sided coverage that produced seven review rounds on the code this
 * replaces: every row asserting a failure wins has a sibling asserting the
 * case where it does not.
 */
import type {ErrorInfo} from '@fro-bot/runtime'
import type {AttemptOutcome} from './prompt-sender.js'
import {describe, expect, it} from 'vitest'
import {
  reduceAttemptOutcome,
  type AttemptObservation,
  type FailureObservation,
  type TurnEvidence,
} from './attempt-outcome.js'

function mkErrorInfo(overrides: Partial<ErrorInfo> = {}): ErrorInfo {
  return {type: 'api_error', message: 'boom', retryable: false, ...overrides}
}

function mkFailure(
  source: FailureObservation['source'],
  overrides: Partial<FailureObservation> = {},
): FailureObservation {
  return {
    source,
    message: `${source} failure`,
    llmError: mkErrorInfo(),
    classificationPath: 'structured',
    ...overrides,
  }
}

const ACCEPTED: TurnEvidence = {accepted: true}
const NOT_ACCEPTED: TurnEvidence = {accepted: false}

interface ExpectedShape {
  readonly success: boolean
  readonly outcome: AttemptOutcome
  readonly settlementKind: AttemptObservation['settlement']['kind']
  readonly error: string | null
  readonly llmError: ErrorInfo | null
  readonly classificationPath?: string
  readonly shouldRetry: boolean
}

function assertOutcome(
  observation: AttemptObservation,
  preservedSubmissionFailure: FailureObservation | null,
  turnEvidence: TurnEvidence,
  expected: ExpectedShape,
): void {
  const result = reduceAttemptOutcome(observation, preservedSubmissionFailure, turnEvidence)
  expect(result.success).toBe(expected.success)
  expect(result.outcome).toBe(expected.outcome)
  expect(result.settlement.kind).toBe(expected.settlementKind)
  expect(result.error).toBe(expected.error)
  expect(result.llmError).toEqual(expected.llmError)
  expect(result.classificationPath).toBe(expected.classificationPath)
  expect(result.shouldRetry).toBe(expected.shouldRetry)
}

describe('reduceAttemptOutcome', () => {
  describe('no failure present (settlement alone decides)', () => {
    it('completion-observed with no failures succeeds (baseline for the "completion never erases a failure" complement)', () => {
      // #given a bare completion-observed settlement with no failure evidence
      const observation: AttemptObservation = {settlement: {kind: 'completion-observed'}, failures: []}
      // #when reducing
      // #then success is reported, tied to completion-observed + completed + no error
      assertOutcome(observation, null, ACCEPTED, {
        success: true,
        outcome: 'completed',
        settlementKind: 'completion-observed',
        error: null,
        llmError: null,
        classificationPath: undefined,
        shouldRetry: false,
      })
    })

    it('stream discontinuity alone does not override independent completion (no failure observation fabricated)', () => {
      // #given a completion settlement where the only thing that happened was transport loss --
      // by contract, a producer that saw only stream discontinuity must not synthesize a
      // FailureObservation for it, so the reducer sees exactly the same input as a clean completion
      const observation: AttemptObservation = {settlement: {kind: 'completion-observed'}, failures: []}
      // #when reducing
      // #then it still succeeds -- this reducer cannot distinguish "discontinuity, no real failure"
      // from "nothing happened" because that is precisely the point: it must not fabricate one
      assertOutcome(observation, null, ACCEPTED, {
        success: true,
        outcome: 'completed',
        settlementKind: 'completion-observed',
        error: null,
        llmError: null,
        shouldRetry: false,
      })
    })

    it('deadline with no failures reports timeout, not success', () => {
      // #given a deadline settlement with no failure evidence at all
      const observation: AttemptObservation = {settlement: {kind: 'deadline'}, failures: []}
      // #when reducing
      // #then it is a failed timeout outcome, never a success -- the invariant forbids success
      // outside completion-observed
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'timeout',
        settlementKind: 'deadline',
        error: 'Attempt did not settle before the execution deadline',
        llmError: null,
        shouldRetry: false,
      })
    })

    it('cancelled with no reason uses a generic diagnostic and does not manufacture a timeout', () => {
      const observation: AttemptObservation = {settlement: {kind: 'cancelled'}, failures: []}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'cancelled',
        error: 'Attempt observation was cancelled',
        llmError: null,
        shouldRetry: false,
      })
    })

    it('cancelled with a bounded reason surfaces that reason as the diagnostic', () => {
      const observation: AttemptObservation = {
        settlement: {kind: 'cancelled', reason: 'shutdown requested'},
        failures: [],
      }
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'cancelled',
        error: 'shutdown requested',
        llmError: null,
        shouldRetry: false,
      })
    })

    it('watchdog carries its diagnostic message through and never claims the shared deadline fired', () => {
      const observation: AttemptObservation = {
        settlement: {kind: 'watchdog', message: 'no agent activity detected after 90000ms'},
        failures: [],
      }
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'watchdog',
        error: 'no agent activity detected after 90000ms',
        llmError: null,
        shouldRetry: false,
      })
    })
  })

  describe('a single failure source, with and without the turn having been accepted', () => {
    it('submission failure before the turn was accepted reports submit_failed', () => {
      const failure = mkFailure('submission', {message: 'connection refused', llmError: null})
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [failure]}
      assertOutcome(observation, null, NOT_ACCEPTED, {
        success: false,
        outcome: 'submit_failed',
        settlementKind: 'failure-observed',
        error: 'connection refused',
        llmError: null,
        classificationPath: 'structured',
        shouldRetry: false,
      })
    })

    it('complement: the same submission failure after the turn was accepted folds into turn_failed_* instead', () => {
      const failure = mkFailure('submission', {
        message: 'connection refused',
        llmError: mkErrorInfo({retryable: false}),
      })
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [failure]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'failure-observed',
        error: 'connection refused',
        llmError: failure.llmError,
        classificationPath: 'structured',
        shouldRetry: false,
      })
    })

    it('a retryable session failure reports turn_failed_retryable', () => {
      const failure = mkFailure('session', {llmError: mkErrorInfo({type: 'rate_limit', retryable: true})})
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [failure]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_retryable',
        settlementKind: 'failure-observed',
        error: failure.message,
        llmError: failure.llmError,
        classificationPath: 'structured',
        shouldRetry: true,
      })
    })

    it('complement: a generic (non-retryable) session failure reports turn_failed_terminal and cannot report success', () => {
      const failure = mkFailure('session', {llmError: mkErrorInfo({type: 'validation', retryable: false})})
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [failure]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'failure-observed',
        error: failure.message,
        llmError: failure.llmError,
        classificationPath: 'structured',
        shouldRetry: false,
      })
    })

    it('a terminal provider failure always reports turn_failed_terminal, even if marked retryable', () => {
      // Provider failures dominate regardless of retryable -- the precedence rule, not the
      // ErrorInfo.retryable flag, is authoritative for provider-sourced failures.
      const failure = mkFailure('provider', {llmError: mkErrorInfo({type: 'provider_auth_error', retryable: true})})
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [failure]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'failure-observed',
        error: failure.message,
        llmError: failure.llmError,
        classificationPath: 'structured',
        shouldRetry: false,
      })
    })
  })

  describe('precedence when multiple sources are present at once', () => {
    it('session beats submission: "prefer real turn evidence over a submission transport diagnostic"', () => {
      const submission = mkFailure('submission', {message: 'transport reset'})
      const session = mkFailure('session', {
        message: 'assistant turn errored',
        llmError: mkErrorInfo({retryable: true}),
      })
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [submission, session]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_retryable',
        settlementKind: 'failure-observed',
        error: session.message,
        llmError: session.llmError,
        classificationPath: session.classificationPath,
        shouldRetry: true,
      })
    })

    it('complement: with no session failure present, the submission failure is what wins', () => {
      const submission = mkFailure('submission', {message: 'transport reset'})
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [submission]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: submission.llmError?.retryable === true ? 'turn_failed_retryable' : 'turn_failed_terminal',
        settlementKind: 'failure-observed',
        error: submission.message,
        llmError: submission.llmError,
        classificationPath: submission.classificationPath,
        shouldRetry: false,
      })
    })

    it('provider beats session: the first terminal provider error stays authoritative', () => {
      const session = mkFailure('session', {message: 'assistant turn errored'})
      const provider = mkFailure('provider', {
        message: 'quota exhausted',
        llmError: mkErrorInfo({type: 'quota_exceeded'}),
      })
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [session, provider]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'failure-observed',
        error: provider.message,
        llmError: provider.llmError,
        classificationPath: provider.classificationPath,
        shouldRetry: false,
      })
    })

    it('complement: with no provider failure present, the session failure is what wins', () => {
      const session = mkFailure('session', {
        message: 'assistant turn errored',
        llmError: mkErrorInfo({retryable: true}),
      })
      const observation: AttemptObservation = {settlement: {kind: 'failure-observed'}, failures: [session]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_retryable',
        settlementKind: 'failure-observed',
        error: session.message,
        llmError: session.llmError,
        classificationPath: session.classificationPath,
        shouldRetry: true,
      })
    })

    it('provider beats all three at once', () => {
      const submission = mkFailure('submission', {message: 'transport reset'})
      const session = mkFailure('session', {message: 'assistant turn errored'})
      const provider = mkFailure('provider', {
        message: 'auth revoked',
        llmError: mkErrorInfo({type: 'provider_auth_error'}),
      })
      const observation: AttemptObservation = {
        settlement: {kind: 'failure-observed'},
        failures: [submission, session, provider],
      }
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'failure-observed',
        error: provider.message,
        llmError: provider.llmError,
        classificationPath: provider.classificationPath,
        shouldRetry: false,
      })
    })

    it('first-wins ordering: the first provider failure in the snapshot is authoritative over a later one', () => {
      const firstProvider = mkFailure('provider', {
        message: 'first classification',
        llmError: mkErrorInfo({type: 'quota_exceeded'}),
      })
      const secondProvider = mkFailure('provider', {
        message: 'second classification',
        llmError: mkErrorInfo({type: 'provider_auth_error'}),
      })
      const observation: AttemptObservation = {
        settlement: {kind: 'failure-observed'},
        failures: [firstProvider, secondProvider],
      }
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'failure-observed',
        error: firstProvider.message,
        llmError: firstProvider.llmError,
        classificationPath: firstProvider.classificationPath,
        shouldRetry: false,
      })
    })
  })

  describe('completion never erases a failure', () => {
    it('a failure observed alongside a completion-observed settlement still reports failure', () => {
      const session = mkFailure('session', {message: 'assistant turn errored'})
      const observation: AttemptObservation = {settlement: {kind: 'completion-observed'}, failures: [session]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'completion-observed',
        error: session.message,
        llmError: session.llmError,
        classificationPath: session.classificationPath,
        shouldRetry: false,
      })
    })

    it('complement: the same completion-observed settlement with no failure at all still succeeds', () => {
      const observation: AttemptObservation = {settlement: {kind: 'completion-observed'}, failures: []}
      assertOutcome(observation, null, ACCEPTED, {
        success: true,
        outcome: 'completed',
        settlementKind: 'completion-observed',
        error: null,
        llmError: null,
        shouldRetry: false,
      })
    })
  })

  describe('deadline preserves an existing failure while still settling as deadline', () => {
    it('a failure observed at deadline settlement reports that failure, not a generic timeout', () => {
      const session = mkFailure('session', {
        message: 'assistant turn errored',
        llmError: mkErrorInfo({retryable: true}),
      })
      const observation: AttemptObservation = {settlement: {kind: 'deadline'}, failures: [session]}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_retryable',
        settlementKind: 'deadline',
        error: session.message,
        llmError: session.llmError,
        classificationPath: session.classificationPath,
        shouldRetry: true,
      })
    })

    it('complement: with no failure at deadline settlement, the generic timeout diagnostic is used instead', () => {
      const observation: AttemptObservation = {settlement: {kind: 'deadline'}, failures: []}
      assertOutcome(observation, null, ACCEPTED, {
        success: false,
        outcome: 'timeout',
        settlementKind: 'deadline',
        error: 'Attempt did not settle before the execution deadline',
        llmError: null,
        shouldRetry: false,
      })
    })
  })

  describe('a preserved submission failure survives past its own settling point', () => {
    it('is reported even though the winning settlement is completion-observed', () => {
      const preserved = mkFailure('submission', {message: 'deferred submission failure', llmError: null})
      const observation: AttemptObservation = {settlement: {kind: 'completion-observed'}, failures: []}
      assertOutcome(observation, preserved, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'completion-observed',
        error: preserved.message,
        llmError: null,
        classificationPath: preserved.classificationPath,
        shouldRetry: false,
      })
    })

    it('is reported even though the winning settlement is deadline', () => {
      const preserved = mkFailure('submission', {message: 'deferred submission failure', llmError: null})
      const observation: AttemptObservation = {settlement: {kind: 'deadline'}, failures: []}
      assertOutcome(observation, preserved, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_terminal',
        settlementKind: 'deadline',
        error: preserved.message,
        llmError: null,
        classificationPath: preserved.classificationPath,
        shouldRetry: false,
      })
    })

    it('complement: a real session failure observed at settlement still outranks the preserved submission failure', () => {
      const preserved = mkFailure('submission', {message: 'deferred submission failure'})
      const session = mkFailure('session', {
        message: 'assistant turn errored',
        llmError: mkErrorInfo({retryable: true}),
      })
      const observation: AttemptObservation = {settlement: {kind: 'completion-observed'}, failures: [session]}
      assertOutcome(observation, preserved, ACCEPTED, {
        success: false,
        outcome: 'turn_failed_retryable',
        settlementKind: 'completion-observed',
        error: session.message,
        llmError: session.llmError,
        classificationPath: session.classificationPath,
        shouldRetry: true,
      })
    })

    it('complement: with no preserved failure and no observed failure, completion-observed still succeeds', () => {
      const observation: AttemptObservation = {settlement: {kind: 'completion-observed'}, failures: []}
      assertOutcome(observation, null, ACCEPTED, {
        success: true,
        outcome: 'completed',
        settlementKind: 'completion-observed',
        error: null,
        llmError: null,
        shouldRetry: false,
      })
    })
  })

  describe('message, llmError, and classification always come from the same failure', () => {
    it('a provider failure with a distinctive message/error/path triple returns all three coherently, not mixed with a submission diagnostic', () => {
      const submission = mkFailure('submission', {
        message: 'submission-side message',
        llmError: mkErrorInfo({type: 'internal', message: 'submission llmError'}),
        classificationPath: 'fallback',
      })
      const provider = mkFailure('provider', {
        message: 'provider-side message',
        llmError: mkErrorInfo({type: 'quota_exceeded', message: 'provider llmError'}),
        classificationPath: 'name',
      })
      const observation: AttemptObservation = {
        settlement: {kind: 'failure-observed'},
        failures: [submission, provider],
      }
      const result = reduceAttemptOutcome(observation, null, ACCEPTED)
      // The current code this replaces can pair a submission message with an unrelated provider
      // classification (retry.ts:579-594). Assert all three fields trace to the *same* failure.
      expect(result.error).toBe(provider.message)
      expect(result.llmError).toEqual(provider.llmError)
      expect(result.classificationPath).toBe(provider.classificationPath)
      expect(result.error).not.toBe(submission.message)
      expect(result.llmError).not.toEqual(submission.llmError)
      expect(result.classificationPath).not.toBe(submission.classificationPath)
    })
  })

  describe('shouldRetry is derived from outcome, not asserted independently', () => {
    it.each<{outcome: AttemptOutcome; expectedShouldRetry: boolean}>([
      {outcome: 'turn_failed_retryable', expectedShouldRetry: true},
      {outcome: 'turn_failed_terminal', expectedShouldRetry: false},
      {outcome: 'submit_failed', expectedShouldRetry: false},
      {outcome: 'timeout', expectedShouldRetry: false},
      {outcome: 'completed', expectedShouldRetry: false},
    ])('outcome $outcome maps to shouldRetry=$expectedShouldRetry', ({outcome, expectedShouldRetry}) => {
      // Exercised indirectly through the settlement shapes that reach each outcome, rather than
      // reimplementing shouldRetryFromOutcome's table here. The observation is selected first so the
      // assertion stays unconditional -- a branch around `expect` hides which case actually ran.
      const observationFor = (): {observation: AttemptObservation; turnEvidence: TurnEvidence} => {
        if (outcome === 'completed')
          return {observation: {settlement: {kind: 'completion-observed'}, failures: []}, turnEvidence: ACCEPTED}
        if (outcome === 'timeout')
          return {observation: {settlement: {kind: 'deadline'}, failures: []}, turnEvidence: ACCEPTED}
        const retryable = outcome === 'turn_failed_retryable'
        const source = outcome === 'submit_failed' ? 'submission' : 'session'
        const failure = mkFailure(source, {llmError: mkErrorInfo({retryable})})
        return {
          observation: {settlement: {kind: 'failure-observed'}, failures: [failure]},
          turnEvidence: outcome === 'submit_failed' ? NOT_ACCEPTED : ACCEPTED,
        }
      }

      const {observation, turnEvidence} = observationFor()
      expect(reduceAttemptOutcome(observation, null, turnEvidence).shouldRetry).toBe(expectedShouldRetry)
    })
  })
})
