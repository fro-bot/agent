import {describe, expect, it} from 'vitest'
import {parseOperatorCheckoutProvenance} from './provenance.js'

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
  ])('%s → undefined', (_label, input) => {
    expect(parseOperatorCheckoutProvenance(input)).toBeUndefined()
  })
})
