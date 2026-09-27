/**
 * Round-trip test: internal `CheckoutProvenance` (execute/provenance.ts) → storage → operator DTO.
 *
 * `run.ts` writes the internal `CheckoutProvenance` into `runState.details.checkoutProvenance`
 * (persisted as JSON — the type information is gone by the time it hits disk).
 * `parseOperatorCheckoutProvenance` reads that `unknown` value back and validates it into an
 * `OperatorCheckoutProvenance`. The parser's own tests (`provenance.test.ts`) use hand-written
 * fixtures, so nothing catches the writer's shape drifting away from what the parser accepts —
 * both sides could stay green while provenance silently disappears from every run's status.
 *
 * This test closes that gap: it builds values against the REAL internal `CheckoutProvenance`
 * type (imported as a type-only import — a mistyped fixture is a compile error, not a runtime
 * surprise), simulates the JSON round-trip storage takes, and asserts the operator parser
 * recovers every field the dashboard needs.
 *
 * `execute/` is off-limits to edit in this lane, but a type-only import for a test asserting
 * compatibility with it is exactly the seam this test exists to guard.
 */

import type {CheckoutPreparation, CheckoutProvenance, RemoteFreshness} from '../execute/provenance.js'
import type {CheckoutObservation, CheckoutOperation} from '../workspace-api/types.js'
import {describe, expect, it} from 'vitest'

import {parseOperatorCheckoutPreparation, parseOperatorCheckoutProvenance} from './provenance.js'

/** Simulates the JSON round-trip `runState.details.checkoutProvenance` actually takes on disk. */
function throughStorage(value: CheckoutProvenance): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function observationWith(
  head: CheckoutObservation['head'],
  worktree: CheckoutObservation['worktree'],
  operationInProgress: CheckoutOperation,
): CheckoutObservation {
  return {head, worktree, operationInProgress, observedAt: '2026-01-01T00:00:00.000Z'}
}

const ATTACHED_HEAD: CheckoutObservation['head'] = {
  kind: 'attached',
  branch: 'main',
  sha: 'a'.repeat(40),
}
const DETACHED_HEAD: CheckoutObservation['head'] = {kind: 'detached', sha: 'b'.repeat(40)}

const CLEAN_WORKTREE: CheckoutObservation['worktree'] = {kind: 'clean'}
const DIRTY_WORKTREE: CheckoutObservation['worktree'] = {
  kind: 'dirty',
  staged: 1,
  unstaged: 2,
  untracked: 3,
  conflicted: 4,
}

/** Every `CheckoutOperation` variant — including 'am', distinguished from 'rebase'. */
const ALL_OPERATIONS: readonly CheckoutOperation[] = [
  'none',
  'merge',
  'rebase',
  'am',
  'cherry-pick',
  'revert',
  'bisect',
]

describe('operator provenance round-trip: internal CheckoutProvenance → storage → OperatorCheckoutProvenance', () => {
  describe('observed — every head variant', () => {
    it.each<[string, CheckoutObservation['head']]>([
      ['attached', ATTACHED_HEAD],
      ['detached', DETACHED_HEAD],
    ])('%s head survives the round trip', (_label, head) => {
      // #given — a real internal CheckoutProvenance value, typed against the writer's own type
      const internal: CheckoutProvenance = {
        kind: 'observed',
        observation: observationWith(head, CLEAN_WORKTREE, 'none'),
        remote: {kind: 'not-checked'},
      }

      // #when — simulate the disk round trip, then parse as the operator surface does
      const parsed = parseOperatorCheckoutProvenance(throughStorage(internal))

      // #then — every field the dashboard needs survives intact
      expect(parsed).toEqual({
        kind: 'observed',
        observation: internal.observation,
        remote: {kind: 'not-checked'},
      })
    })
  })

  describe('observed — every worktree variant', () => {
    it.each<[string, CheckoutObservation['worktree']]>([
      ['clean', CLEAN_WORKTREE],
      ['dirty', DIRTY_WORKTREE],
    ])('%s worktree survives the round trip', (_label, worktree) => {
      // #given
      const internal: CheckoutProvenance = {
        kind: 'observed',
        observation: observationWith(ATTACHED_HEAD, worktree, 'none'),
        remote: {kind: 'not-checked'},
      }

      // #when
      const parsed = parseOperatorCheckoutProvenance(throughStorage(internal))

      // #then
      expect(parsed).toEqual({
        kind: 'observed',
        observation: internal.observation,
        remote: {kind: 'not-checked'},
      })
    })
  })

  describe('observed — every CheckoutOperation variant, including am', () => {
    it.each(ALL_OPERATIONS)("operationInProgress '%s' survives the round trip", operation => {
      // #given
      const internal: CheckoutProvenance = {
        kind: 'observed',
        observation: observationWith(ATTACHED_HEAD, CLEAN_WORKTREE, operation),
        remote: {kind: 'not-checked'},
      }

      // #when
      const parsed = parseOperatorCheckoutProvenance(throughStorage(internal))

      // #then
      expect(parsed).toEqual({
        kind: 'observed',
        observation: internal.observation,
        remote: {kind: 'not-checked'},
      })
    })

    it("distinguishes 'am' from 'rebase' rather than collapsing them", () => {
      // #given
      const am: CheckoutProvenance = {
        kind: 'observed',
        observation: observationWith(ATTACHED_HEAD, CLEAN_WORKTREE, 'am'),
        remote: {kind: 'not-checked'},
      }
      const rebase: CheckoutProvenance = {
        kind: 'observed',
        observation: observationWith(ATTACHED_HEAD, CLEAN_WORKTREE, 'rebase'),
        remote: {kind: 'not-checked'},
      }

      // #when
      const parsedAm = parseOperatorCheckoutProvenance(throughStorage(am))
      const parsedRebase = parseOperatorCheckoutProvenance(throughStorage(rebase))

      // #then
      expect(parsedAm?.kind === 'observed' && parsedAm.observation.operationInProgress).toBe('am')
      expect(parsedRebase?.kind === 'observed' && parsedRebase.observation.operationInProgress).toBe('rebase')
    })
  })

  describe('unavailable', () => {
    it('survives the round trip, dropping the internal-only reason field the DTO never carries', () => {
      // #given — the internal type carries a `reason` the operator DTO intentionally omits
      // (it is engine-internal ops/automation detail, not part of the operator-safe projection).
      const internal: CheckoutProvenance = {
        kind: 'unavailable',
        reason: {kind: 'network-error'},
        remote: {kind: 'not-checked'},
      }

      // #when
      const parsed = parseOperatorCheckoutProvenance(throughStorage(internal))

      // #then — kind + remote survive; the DTO shape never had a `reason` field to preserve
      expect(parsed).toEqual({kind: 'unavailable', remote: {kind: 'not-checked'}})
    })
  })

  describe('observed — checked remote (1.8.0)', () => {
    it('checked/unchanged survives the round trip', () => {
      // #given
      const remote: RemoteFreshness = {
        kind: 'checked',
        defaultBranch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
        change: 'unchanged',
      }
      const internal: CheckoutProvenance = {
        kind: 'observed',
        observation: observationWith(ATTACHED_HEAD, CLEAN_WORKTREE, 'none'),
        remote,
      }

      // #when
      const parsed = parseOperatorCheckoutProvenance(throughStorage(internal))

      // #then
      expect(parsed).toEqual({kind: 'observed', observation: internal.observation, remote})
    })

    it('checked/fast-forward survives the round trip, including fromSha', () => {
      // #given
      const remote: RemoteFreshness = {
        kind: 'checked',
        defaultBranch: 'main',
        sha: 'b'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
        change: 'fast-forward',
        fromSha: 'a'.repeat(40),
      }
      const internal: CheckoutProvenance = {
        kind: 'observed',
        observation: observationWith(ATTACHED_HEAD, CLEAN_WORKTREE, 'none'),
        remote,
      }

      // #when
      const parsed = parseOperatorCheckoutProvenance(throughStorage(internal))

      // #then
      expect(parsed).toEqual({kind: 'observed', observation: internal.observation, remote})
    })
  })
})

/** Simulates the JSON round-trip `runState.details.checkoutPreparation` actually takes on disk. */
function preparationThroughStorage(value: CheckoutPreparation): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

describe('operator preparation round-trip: internal CheckoutPreparation → storage → OperatorCheckoutPreparation', () => {
  it.each<[string, CheckoutPreparation]>([
    ['needs-recovery', {outcome: 'refused', reason: 'needs-recovery'}],
    ['checkout-substituted', {outcome: 'refused', reason: 'checkout-substituted'}],
    ['unsupported-layout', {outcome: 'refused', reason: 'unsupported-layout', layoutReason: 'bare-repository'}],
    ['unsupported-config', {outcome: 'refused', reason: 'unsupported-config', disallowedKeys: ['url.x.insteadOf']}],
    ['operation-in-progress', {outcome: 'refused', reason: 'operation-in-progress', operation: 'rebase'}],
    ['dirty', {outcome: 'refused', reason: 'dirty', changedPaths: ['a.txt', 'b.txt']}],
    ['submodule-initialized', {outcome: 'refused', reason: 'submodule-initialized', submodules: ['libs/x']}],
    ['detached', {outcome: 'refused', reason: 'detached'}],
    ['non-default-branch', {outcome: 'refused', reason: 'non-default-branch', branch: 'feature/x'}],
    ['diverged', {outcome: 'refused', reason: 'diverged'}],
    ['ahead', {outcome: 'refused', reason: 'ahead'}],
    ['obstructed', {outcome: 'refused', reason: 'obstructed', obstructions: [{path: 'a.txt', kind: 'exact-conflict'}]}],
    ['maintenance-hold', {outcome: 'refused', reason: 'maintenance-hold'}],
    ['failed', {outcome: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false}],
    [
      'failed with mutationStarted possibly',
      {outcome: 'failed', reason: 'termination-unconfirmed', mutationStarted: 'possibly', permanent: false},
    ],
  ])('%s survives the round trip', (_label, internal) => {
    // #when
    const parsed = parseOperatorCheckoutPreparation(preparationThroughStorage(internal))

    // #then
    expect(parsed).toEqual(internal)
  })
})
