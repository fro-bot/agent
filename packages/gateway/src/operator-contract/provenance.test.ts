import {describe, expect, it} from 'vitest'
import {parseOperatorCheckoutPreparation, parseOperatorCheckoutProvenance} from './provenance.js'

const VALID_OBSERVED = {
  kind: 'observed',
  observation: {
    head: {kind: 'attached', branch: 'main', sha: 'b'.repeat(40)},
    worktree: {kind: 'clean'},
    operationInProgress: 'none',
    observedAt: '2026-01-01T00:00:00.000Z',
  },
  remote: {kind: 'not-checked'},
}

const VALID_UNAVAILABLE = {kind: 'unavailable', remote: {kind: 'not-checked'}}

describe('parseOperatorCheckoutProvenance — happy path', () => {
  it('accepts a valid observed value (attached HEAD, clean worktree)', () => {
    expect(parseOperatorCheckoutProvenance(VALID_OBSERVED)).toEqual(VALID_OBSERVED)
  })

  it('accepts a valid observed value (detached HEAD)', () => {
    const detached = {
      kind: 'observed',
      observation: {
        head: {kind: 'detached', sha: 'c'.repeat(40)},
        worktree: {kind: 'clean'},
        operationInProgress: 'none',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
      remote: {kind: 'not-checked'},
    }
    expect(parseOperatorCheckoutProvenance(detached)).toEqual(detached)
  })

  it('accepts a valid observed value (dirty worktree with all four counts)', () => {
    const dirty = {
      kind: 'observed',
      observation: {
        head: {kind: 'attached', branch: 'feature/x', sha: 'd'.repeat(40)},
        worktree: {kind: 'dirty', staged: 1, unstaged: 2, untracked: 3, conflicted: 0},
        operationInProgress: 'rebase',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
      remote: {kind: 'not-checked'},
    }
    expect(parseOperatorCheckoutProvenance(dirty)).toEqual(dirty)
  })

  it('accepts a valid unavailable value', () => {
    expect(parseOperatorCheckoutProvenance(VALID_UNAVAILABLE)).toEqual(VALID_UNAVAILABLE)
  })

  it('accepts a valid observed value with a checked/unchanged remote (1.8.0)', () => {
    const value = {
      kind: 'observed',
      observation: VALID_OBSERVED.observation,
      remote: {
        kind: 'checked',
        defaultBranch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
        change: 'unchanged',
      },
    }
    expect(parseOperatorCheckoutProvenance(value)).toEqual(value)
  })

  it('accepts a valid observed value with a checked/fast-forward remote (1.8.0)', () => {
    const value = {
      kind: 'observed',
      observation: VALID_OBSERVED.observation,
      remote: {
        kind: 'checked',
        defaultBranch: 'main',
        sha: 'b'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
        change: 'fast-forward',
        fromSha: 'a'.repeat(40),
      },
    }
    expect(parseOperatorCheckoutProvenance(value)).toEqual(value)
  })
})

describe('parseOperatorCheckoutProvenance — rejects malformed input to undefined (never throws, never passes through)', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'observed'],
    ['a number', 42],
    ['an empty object', {}],
    ['missing remote', {kind: 'observed', observation: VALID_OBSERVED.observation}],
    ['wrong remote kind', {kind: 'observed', observation: VALID_OBSERVED.observation, remote: {kind: 'checked'}}],
    ['unknown top-level kind', {kind: 'partial', remote: {kind: 'not-checked'}}],
    ['observed with missing observation', {kind: 'observed', remote: {kind: 'not-checked'}}],
    [
      'observed with invalid sha (not 40 hex chars)',
      {
        kind: 'observed',
        observation: {...VALID_OBSERVED.observation, head: {kind: 'attached', branch: 'main', sha: 'not-a-sha'}},
        remote: {kind: 'not-checked'},
      },
    ],
    [
      'observed with attached head missing branch',
      {
        kind: 'observed',
        observation: {...VALID_OBSERVED.observation, head: {kind: 'attached', sha: 'e'.repeat(40)}},
        remote: {kind: 'not-checked'},
      },
    ],
    [
      'observed with dirty worktree missing a count field',
      {
        kind: 'observed',
        observation: {
          ...VALID_OBSERVED.observation,
          worktree: {kind: 'dirty', staged: 1, unstaged: 2, untracked: 3},
        },
        remote: {kind: 'not-checked'},
      },
    ],
    [
      'observed with negative worktree count',
      {
        kind: 'observed',
        observation: {
          ...VALID_OBSERVED.observation,
          worktree: {kind: 'dirty', staged: -1, unstaged: 0, untracked: 0, conflicted: 0},
        },
        remote: {kind: 'not-checked'},
      },
    ],
    [
      'observed with unrecognized operationInProgress',
      {
        kind: 'observed',
        observation: {...VALID_OBSERVED.observation, operationInProgress: 'time-travel'},
        remote: {kind: 'not-checked'},
      },
    ],
    [
      'checked/fast-forward with fromSha equal to sha (no real advance)',
      {
        kind: 'observed',
        observation: VALID_OBSERVED.observation,
        remote: {
          kind: 'checked',
          defaultBranch: 'main',
          sha: 'a'.repeat(40),
          checkedAt: '2026-01-01T00:00:00.000Z',
          change: 'fast-forward',
          fromSha: 'a'.repeat(40),
        },
      },
    ],
    [
      'checked/fast-forward missing fromSha',
      {
        kind: 'observed',
        observation: VALID_OBSERVED.observation,
        remote: {
          kind: 'checked',
          defaultBranch: 'main',
          sha: 'a'.repeat(40),
          checkedAt: '2026-01-01T00:00:00.000Z',
          change: 'fast-forward',
        },
      },
    ],
    [
      'checked with a missing change field',
      {
        kind: 'observed',
        observation: VALID_OBSERVED.observation,
        remote: {kind: 'checked', defaultBranch: 'main', sha: 'a'.repeat(40), checkedAt: '2026-01-01T00:00:00.000Z'},
      },
    ],
    [
      'checked with a malformed checkedAt (not a string)',
      {
        kind: 'observed',
        observation: VALID_OBSERVED.observation,
        remote: {kind: 'checked', defaultBranch: 'main', sha: 'a'.repeat(40), checkedAt: 12345, change: 'unchanged'},
      },
    ],
    [
      'checked with an invalid sha',
      {
        kind: 'observed',
        observation: VALID_OBSERVED.observation,
        remote: {
          kind: 'checked',
          defaultBranch: 'main',
          sha: 'not-a-sha',
          checkedAt: '2026-01-01T00:00:00.000Z',
          change: 'unchanged',
        },
      },
    ],
  ])('%s → undefined', (_label, input) => {
    expect(parseOperatorCheckoutProvenance(input)).toBeUndefined()
  })
})

describe('parseOperatorCheckoutPreparation — happy path', () => {
  it('accepts a valid failed value', () => {
    const value = {outcome: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false}
    expect(parseOperatorCheckoutPreparation(value)).toEqual(value)
  })

  it('accepts a valid failed value with mutationStarted possibly', () => {
    const value = {outcome: 'failed', reason: 'termination-unconfirmed', mutationStarted: 'possibly', permanent: false}
    expect(parseOperatorCheckoutPreparation(value)).toEqual(value)
  })

  it.each(['needs-recovery', 'checkout-substituted', 'detached', 'diverged', 'ahead', 'maintenance-hold'])(
    'accepts a valid refused/%s value with no extra detail',
    reason => {
      const value = {outcome: 'refused', reason}
      expect(parseOperatorCheckoutPreparation(value)).toEqual(value)
    },
  )

  it('accepts a valid refused/unsupported-layout value', () => {
    const value = {outcome: 'refused', reason: 'unsupported-layout', layoutReason: 'bare-repository'}
    expect(parseOperatorCheckoutPreparation(value)).toEqual(value)
  })

  it('accepts a valid refused/dirty value', () => {
    const value = {outcome: 'refused', reason: 'dirty', changedPaths: ['a.txt', 'b.txt']}
    expect(parseOperatorCheckoutPreparation(value)).toEqual(value)
  })

  it('accepts a valid refused/obstructed value', () => {
    const value = {outcome: 'refused', reason: 'obstructed', obstructions: [{path: 'a.txt', kind: 'exact-conflict'}]}
    expect(parseOperatorCheckoutPreparation(value)).toEqual(value)
  })
})

describe('parseOperatorCheckoutPreparation — rejects malformed input to undefined', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'refused'],
    ['an empty object', {}],
    ['unknown outcome', {outcome: 'partial', reason: 'dirty'}],
    ['unknown refusal reason', {outcome: 'refused', reason: 'time-travel'}],
    ['failed missing reason', {outcome: 'failed', mutationStarted: false, permanent: false}],
    [
      'failed with an unrecognized reason',
      {outcome: 'failed', reason: 'bogus', mutationStarted: false, permanent: false},
    ],
    [
      'failed with an invalid mutationStarted',
      {outcome: 'failed', reason: 'fetch-timeout', mutationStarted: 'yes', permanent: false},
    ],
    ['failed missing permanent', {outcome: 'failed', reason: 'fetch-timeout', mutationStarted: false}],
    ['refused/unsupported-layout missing layoutReason', {outcome: 'refused', reason: 'unsupported-layout'}],
    [
      'refused/unsupported-layout with an unrecognized layoutReason',
      {outcome: 'refused', reason: 'unsupported-layout', layoutReason: 'time-travel'},
    ],
    ['refused/dirty with a non-string-array changedPaths', {outcome: 'refused', reason: 'dirty', changedPaths: [1, 2]}],
    ['refused/obstructed with a missing kind', {outcome: 'refused', reason: 'obstructed', obstructions: [{path: 'a'}]}],
    [
      'refused/obstructed with an unrecognized kind',
      {outcome: 'refused', reason: 'obstructed', obstructions: [{path: 'a', kind: 'time-travel'}]},
    ],
    ['refused/non-default-branch missing branch', {outcome: 'refused', reason: 'non-default-branch'}],
  ])('%s → undefined', (_label, input) => {
    expect(parseOperatorCheckoutPreparation(input)).toBeUndefined()
  })
})
