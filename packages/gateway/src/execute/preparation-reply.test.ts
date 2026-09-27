import type {UpdateFailed, UpdateRefused} from '../workspace-api/types.js'
import {describe, expect, it} from 'vitest'
import {
  CLIENT_TIMEOUT_REPLY,
  formatPreparationFailedReply,
  formatPreparationRefusedReply,
  MAINTENANCE_HOLD_REPLY,
  RECOVER_SUFFIX,
  TERMINATION_UNCONFIRMED_REPLY,
} from './preparation-reply.js'

type NonSubstitutedRefused = Exclude<UpdateRefused, {readonly reason: 'checkout-substituted'}>

describe('formatPreparationRefusedReply', () => {
  it.each<[NonSubstitutedRefused['reason'], NonSubstitutedRefused, string]>([
    [
      'dirty',
      {kind: 'refused', reason: 'dirty', changedPaths: []},
      "The checkout has uncommitted or untracked changes, so I can't update it safely.",
    ],
    ['detached', {kind: 'refused', reason: 'detached'}, "The checkout isn't on a branch, so I can't update it safely."],
    [
      'diverged',
      {kind: 'refused', reason: 'diverged'},
      "The checkout has local commits the remote doesn't have, so a fast-forward isn't possible.",
    ],
    [
      'unsupported-layout',
      {kind: 'refused', reason: 'unsupported-layout', layoutReason: 'bare-repository'},
      "The checkout's git configuration or layout isn't one I can update safely.",
    ],
    [
      'unsupported-config',
      {kind: 'refused', reason: 'unsupported-config', disallowedKeys: []},
      "The checkout's git configuration or layout isn't one I can update safely.",
    ],
    [
      'obstructed',
      {kind: 'refused', reason: 'obstructed', obstructions: []},
      "An incoming file or directory would overwrite something already in the checkout, so I can't update it safely.",
    ],
    [
      'submodule-initialized',
      {kind: 'refused', reason: 'submodule-initialized', submodules: []},
      "The checkout has an initialized submodule, which I don't support updating.",
    ],
    [
      'operation-in-progress',
      {kind: 'refused', reason: 'operation-in-progress', operation: 'rebase'},
      "The checkout has a git operation in progress (merge, rebase, or similar), so I can't update it safely.",
    ],
    [
      'needs-recovery',
      {kind: 'refused', reason: 'needs-recovery'},
      'A previous update to this checkout was interrupted and needs recovery before I can run here.',
    ],
  ])("%s: the plan's exact clause, plus the recover suffix", (_reason, result, expectedClause) => {
    expect(formatPreparationRefusedReply(result)).toBe(`${expectedClause}\n\n${RECOVER_SUFFIX}`)
  })

  it("non-default-branch interpolates the branch name into the plan's exact clause", () => {
    const result: NonSubstitutedRefused = {kind: 'refused', reason: 'non-default-branch', branch: 'feature/x'}
    expect(formatPreparationRefusedReply(result)).toBe(
      `The checkout is on \`feature/x\`, not the repository's default branch, so I can't update it safely.\n\n${RECOVER_SUFFIX}`,
    )
  })

  it('non-default-branch neutralizes backticks and truncates a long branch name the same way the reply/prompt branch does', () => {
    const longBranch = `feature/\`inject\`-${'x'.repeat(500)}`
    const result: NonSubstitutedRefused = {kind: 'refused', reason: 'non-default-branch', branch: longBranch}
    const reply = formatPreparationRefusedReply(result)
    expect(reply).not.toContain(longBranch)
    expect(reply).not.toContain('`inject`')
    expect(reply.length).toBeLessThan(longBranch.length)
  })

  it("ahead gets grounded text (not in the plan's table) with the recover suffix", () => {
    const result: NonSubstitutedRefused = {kind: 'refused', reason: 'ahead'}
    const reply = formatPreparationRefusedReply(result)
    expect(reply).toContain(RECOVER_SUFFIX)
    expect(reply).not.toBe(RECOVER_SUFFIX)
  })

  it('maintenance-hold returns its own grounded text and NEVER the recover suffix', () => {
    const result: NonSubstitutedRefused = {kind: 'refused', reason: 'maintenance-hold'}
    const reply = formatPreparationRefusedReply(result)
    expect(reply).toBe(MAINTENANCE_HOLD_REPLY)
    expect(reply).not.toContain('recover-checkout')
    expect(reply).not.toContain(RECOVER_SUFFIX)
  })
})

describe('formatPreparationFailedReply', () => {
  const TRANSIENT_REMOTE =
    "I couldn't reach the repository's remote right now. This is usually temporary - try again shortly."
  const PERMANENT_ACCESS =
    "I don't have access to this repository's remote anymore. Check that the GitHub App still has access, then try again."
  const CHECK_OR_UPDATE_TRANSIENT =
    "I couldn't check or update the checkout just now. This is usually temporary, so try again shortly."
  const APPLY_INTERRUPTED =
    "The update started changing the checkout but didn't finish, so it needs recovery before I can run here."

  it.each<UpdateFailed['reason']>([
    'fetch-auth-rejected',
    'fetch-rate-limited',
    'fetch-unreachable',
    'fetch-timeout',
    'fetch-failed',
    'remote-moved',
  ])('%s maps to the transient remote text, regardless of the permanent flag', reason => {
    const result: UpdateFailed = {kind: 'failed', reason, mutationStarted: false, permanent: true}
    expect(formatPreparationFailedReply(result)).toBe(TRANSIENT_REMOTE)
  })

  it.each<UpdateFailed['reason']>(['fetch-not-found', 'fetch-forbidden'])(
    '%s maps to the permanent access text, regardless of the permanent flag (reason wins on disagreement)',
    reason => {
      const result: UpdateFailed = {kind: 'failed', reason, mutationStarted: false, permanent: false}
      expect(formatPreparationFailedReply(result)).toBe(PERMANENT_ACCESS)
    },
  )

  it('workspace classification agreement: fetch-not-found/fetch-forbidden are permanent in practice, matching the permanent-text mapping', () => {
    for (const reason of ['fetch-not-found', 'fetch-forbidden'] as const) {
      const result: UpdateFailed = {kind: 'failed', reason, mutationStarted: false, permanent: true}
      expect(formatPreparationFailedReply(result)).toBe(PERMANENT_ACCESS)
    }
  })

  it('apply-failed with mutationStarted true maps to the interrupted-update text plus the recover suffix', () => {
    const result: UpdateFailed = {kind: 'failed', reason: 'apply-failed', mutationStarted: true, permanent: false}
    expect(formatPreparationFailedReply(result)).toBe(`${APPLY_INTERRUPTED}\n\n${RECOVER_SUFFIX}`)
  })

  it("apply-failed with mutationStarted 'possibly' maps to the same interrupted-update text plus the recover suffix", () => {
    const result: UpdateFailed = {kind: 'failed', reason: 'apply-failed', mutationStarted: 'possibly', permanent: false}
    expect(formatPreparationFailedReply(result)).toBe(`${APPLY_INTERRUPTED}\n\n${RECOVER_SUFFIX}`)
  })

  it('apply-failed with mutationStarted false maps to the check-or-update transient text, no recover suffix', () => {
    const result: UpdateFailed = {kind: 'failed', reason: 'apply-failed', mutationStarted: false, permanent: false}
    expect(formatPreparationFailedReply(result)).toBe(CHECK_OR_UPDATE_TRANSIENT)
  })

  it('inspection-failed maps to the check-or-update transient text', () => {
    const result: UpdateFailed = {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    expect(formatPreparationFailedReply(result)).toBe(CHECK_OR_UPDATE_TRANSIENT)
  })

  it('aborted maps to the same text as CLIENT_TIMEOUT_REPLY', () => {
    const result: UpdateFailed = {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}
    expect(formatPreparationFailedReply(result)).toBe(CLIENT_TIMEOUT_REPLY)
  })

  it('termination-unconfirmed maps to its own grounded text, regardless of permanent', () => {
    const result: UpdateFailed = {
      kind: 'failed',
      reason: 'termination-unconfirmed',
      mutationStarted: 'possibly',
      permanent: false,
    }
    expect(formatPreparationFailedReply(result)).toBe(TERMINATION_UNCONFIRMED_REPLY)
  })
})

describe('CLIENT_TIMEOUT_REPLY', () => {
  it('is the plan\'s exact "state unknown" wording', () => {
    expect(CLIENT_TIMEOUT_REPLY).toBe(
      "The update didn't finish within its time budget, and I can't tell whether the checkout changed. The next run will check its state before doing anything.",
    )
  })
})
