/**
 * Unit-level tests for `checkTempIndexCleanliness` (checkout-profile.ts) that need to observe or
 * fake a privileged operation the test host itself can't perform — chowning a directory to an
 * arbitrary uid/gid. Real-git, no-mock behavioral coverage for this module lives in
 * `update-fixtures/dirty-state.test.ts`; this file only pins down the temp-index-directory
 * ownership handoff, which that real-git suite can't exercise (it never passes uid/gid, since this
 * developer/CI host can't actually chown to an arbitrary identity).
 */

import type {GitOutcome, GitRunnerFn} from './git-safety.js'

import {lchown, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {checkTempIndexCleanliness} from './checkout-profile.js'

// #given a mocked lchown — the test host can't really chown to an arbitrary uid/gid, and every
// other fs call this module makes (mkdtemp, rm, realpath, read/write of a real temp index
// directory) stays real so the surrounding flow behaves exactly as it does outside tests.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    lchown: vi.fn().mockResolvedValue(undefined),
  }
})

const mockLchown = vi.mocked(lchown)

const OK: GitOutcome = {kind: 'ok', stdout: '', stderr: ''}
const NO_FILTERS_CONFIGURED: GitOutcome = {kind: 'failed', code: 1, stdout: '', stderr: ''}

/** A fake gitRunner that records every invocation's arg vector into `calls` and answers every call with a benign "nothing configured / nothing changed" outcome — enough for `checkTempIndexCleanliness` to reach a `clean` result without spawning real git. */
function makeFakeGitRunner(calls: string[]): GitRunnerFn {
  return async (args: readonly string[]) => {
    calls.push(`git:${args.join(' ')}`)
    if (args.includes('--get-regexp')) return NO_FILTERS_CONFIGURED
    return OK
  }
}

let checkoutPath: string

beforeEach(async () => {
  checkoutPath = await mkdtemp(join(tmpdir(), 'checkout-profile-unit-checkout-'))
  mockLchown.mockReset()
  mockLchown.mockResolvedValue(undefined)
})

afterEach(async () => {
  await rm(checkoutPath, {recursive: true, force: true})
})

describe('checkTempIndexCleanliness — temp index directory ownership handoff', () => {
  it('chowns the temp index directory to the given uid/gid before any git call runs', async () => {
    const calls: string[] = []
    mockLchown.mockImplementation(async () => {
      calls.push('lchown')
    })

    const outcome = await checkTempIndexCleanliness({
      checkoutPath,
      headSha: '0'.repeat(40),
      gitRunner: makeFakeGitRunner(calls),
      timeoutMs: 5_000,
      uid: 12_345,
      gid: 12_346,
    })

    expect(outcome.kind).toBe('clean')
    expect(mockLchown).toHaveBeenCalledTimes(1)
    const [, uidArg, gidArg] = mockLchown.mock.calls[0] as [string, number, number]
    expect(uidArg).toBe(12_345)
    expect(gidArg).toBe(12_346)

    const chownIndex = calls.indexOf('lchown')
    const firstGitIndex = calls.findIndex(entry => entry.startsWith('git:'))
    expect(chownIndex).toBe(0)
    expect(firstGitIndex).toBeGreaterThan(chownIndex)
  })

  it('never chowns when uid and gid are both omitted', async () => {
    const calls: string[] = []
    const outcome = await checkTempIndexCleanliness({
      checkoutPath,
      headSha: '0'.repeat(40),
      gitRunner: makeFakeGitRunner(calls),
      timeoutMs: 5_000,
    })

    expect(outcome.kind).toBe('clean')
    expect(mockLchown).not.toHaveBeenCalled()
  })

  it('fails closed (inspection-failed) when the chown itself fails, and never runs a git call', async () => {
    const calls: string[] = []
    mockLchown.mockRejectedValue(new Error('EPERM: not permitted'))

    const outcome = await checkTempIndexCleanliness({
      checkoutPath,
      headSha: '0'.repeat(40),
      gitRunner: makeFakeGitRunner(calls),
      timeoutMs: 5_000,
      uid: 12_345,
      gid: 12_346,
    })

    expect(outcome.kind).toBe('inspection-failed')
    expect(calls).toEqual([])
  })
})
