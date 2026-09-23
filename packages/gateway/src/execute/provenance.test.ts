import type {CheckoutObservation, InspectWorkspaceError} from '../workspace-api/types.js'
import {describe, expect, it} from 'vitest'
import {
  classifyInspectResult,
  formatProvenanceForPrompt,
  formatProvenanceLine,
  REMOTE_FRESHNESS_NOT_CHECKED,
} from './provenance.js'

const REPO = 'acme/widget'

function cleanAttached(overrides: Partial<CheckoutObservation> = {}): CheckoutObservation {
  return {
    head: {kind: 'attached', branch: 'main', sha: 'abc1234def5678901234567890123456789012'},
    worktree: {kind: 'clean'},
    operationInProgress: 'none',
    observedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('classifyInspectResult', () => {
  it('success → proceed with kind "observed", remote not-checked', () => {
    // #given
    const observation = cleanAttached()

    // #when
    const outcome = classifyInspectResult({success: true, data: observation})

    // #then
    expect(outcome).toEqual({
      decision: 'proceed',
      provenance: {kind: 'observed', observation, remote: REMOTE_FRESHNESS_NOT_CHECKED},
    })
  })

  it('checkout-substituted → fail-run (never becomes a provenance value)', () => {
    // #given
    const error: InspectWorkspaceError = {kind: 'inspect-error', code: 'checkout-substituted'}

    // #when
    const outcome = classifyInspectResult({success: false, error})

    // #then
    expect(outcome).toEqual({decision: 'fail-run', reason: 'checkout-substituted'})
  })

  it.each<InspectWorkspaceError>([
    {kind: 'inspect-error', code: 'no-checkout'},
    {kind: 'inspect-error', code: 'inspection-failed'},
    {kind: 'inspect-error', code: 'inspection-timeout'},
    {kind: 'http-error', status: 503},
    {kind: 'network-error'},
    {kind: 'timeout'},
    {kind: 'parse-error'},
    {kind: 'response-mismatch'},
  ])('every other inspect failure ($kind) → proceed with kind "unavailable"', error => {
    // #when
    const outcome = classifyInspectResult({success: false, error})

    // #then
    expect(outcome).toMatchObject({
      decision: 'proceed',
      provenance: {kind: 'unavailable', remote: REMOTE_FRESHNESS_NOT_CHECKED},
    })
  })
})

describe('formatProvenanceLine', () => {
  it('clean, attached branch', () => {
    // #given
    const provenance = {
      kind: 'observed' as const,
      observation: cleanAttached({
        head: {kind: 'attached', branch: 'main', sha: 'abc1234def56789012345678901234567890abcd'},
      }),
      remote: REMOTE_FRESHNESS_NOT_CHECKED,
    }

    // #when
    const line = formatProvenanceLine(REPO, provenance)

    // #then — quiet: short sha, branch, "clean", explicit remote-freshness disclosure
    expect(line).toBe('Started from `acme/widget@abc1234` on `main`, clean. Remote freshness not checked.')
  })

  it('dirty worktree — noticeable, carries all four counts', () => {
    // #given
    const provenance = {
      kind: 'observed' as const,
      observation: cleanAttached({worktree: {kind: 'dirty', staged: 1, unstaged: 2, untracked: 3, conflicted: 0}}),
      remote: REMOTE_FRESHNESS_NOT_CHECKED,
    }

    // #when
    const line = formatProvenanceLine(REPO, provenance)

    // #then
    expect(line).toContain('dirty (staged 1, unstaged 2, untracked 3, conflicted 0)')
    expect(line).toContain('Remote freshness not checked.')
  })

  it('detached HEAD — noticeable, no branch name', () => {
    // #given
    const provenance = {
      kind: 'observed' as const,
      observation: cleanAttached({head: {kind: 'detached', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'}}),
      remote: REMOTE_FRESHNESS_NOT_CHECKED,
    }

    // #when
    const line = formatProvenanceLine(REPO, provenance)

    // #then
    expect(line).toContain('(detached HEAD)')
    expect(line).not.toContain('on `')
  })

  it('operation in progress — noticeable', () => {
    // #given
    const provenance = {
      kind: 'observed' as const,
      observation: cleanAttached({operationInProgress: 'rebase'}),
      remote: REMOTE_FRESHNESS_NOT_CHECKED,
    }

    // #when
    const line = formatProvenanceLine(REPO, provenance)

    // #then
    expect(line).toContain('rebase in progress')
  })

  it('unavailable — says so plainly, no fabricated SHA', () => {
    // #given
    const provenance = {
      kind: 'unavailable' as const,
      reason: {kind: 'timeout' as const},
      remote: REMOTE_FRESHNESS_NOT_CHECKED,
    }

    // #when
    const line = formatProvenanceLine(REPO, provenance)

    // #then
    expect(line).toBe('Started from `acme/widget` — starting state unavailable. Remote freshness not checked.')
  })

  it('is always exactly one line', () => {
    // #given
    const dirty = {
      kind: 'observed' as const,
      observation: cleanAttached({
        worktree: {kind: 'dirty', staged: 1, unstaged: 1, untracked: 1, conflicted: 1},
        operationInProgress: 'merge',
      }),
      remote: REMOTE_FRESHNESS_NOT_CHECKED,
    }

    // #when / #then
    expect(formatProvenanceLine(REPO, dirty)).not.toContain('\n')
  })
})

describe('formatProvenanceForPrompt', () => {
  it('tells the agent the starting commit, branch, worktree state, and that remote freshness was not checked', () => {
    // #given
    const provenance = {kind: 'observed' as const, observation: cleanAttached(), remote: REMOTE_FRESHNESS_NOT_CHECKED}

    // #when
    const block = formatProvenanceForPrompt(provenance)

    // #then
    expect(block).toContain('abc1234def5678901234567890123456789012')
    expect(block).toContain('main')
    expect(block).toContain('clean')
    expect(block).toContain('Remote freshness was not checked')
    // #and — never tells the agent what to do (no imperative verbs like "do not edit")
    expect(block.toLowerCase()).not.toContain('you must')
  })

  it('unavailable — tells the agent plainly, still discloses remote freshness', () => {
    // #given
    const provenance = {
      kind: 'unavailable' as const,
      reason: {kind: 'timeout' as const},
      remote: REMOTE_FRESHNESS_NOT_CHECKED,
    }

    // #when
    const block = formatProvenanceForPrompt(provenance)

    // #then
    expect(block).toContain('could not be determined')
    expect(block).toContain('Remote freshness was not checked')
  })
})
