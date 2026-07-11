import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {checkForkOrSelfGuard, submitReviewWithHeadGuard} from './review-guards.js'

function makeOctokit(overrides?: {readonly getPR?: () => unknown; readonly createReview?: () => unknown}) {
  const defaultPR = {
    data: {
      head: {sha: 'head-sha-abc', repo: {full_name: 'owner/repo'}},
      base: {repo: {full_name: 'owner/repo'}},
      user: {login: 'pr-author'},
    },
  }
  const defaultCreateReview = {data: {id: 999, state: 'APPROVED', html_url: 'https://github.com/pr/1/reviews/999'}}

  return {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue(overrides?.getPR?.() ?? defaultPR),
        createReview: vi.fn().mockResolvedValue(overrides?.createReview?.() ?? defaultCreateReview),
        listFiles: vi.fn().mockResolvedValue({data: []}),
      },
    },
  }
}

type MockOctokit = ReturnType<typeof makeOctokit>

describe('checkForkOrSelfGuard', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('allows a normal PR authored by a human on the base repo for APPROVE', async () => {
    // #given a PR authored by a non-bot user on the base repo
    const octokit = makeOctokit() as unknown as Octokit

    // #when checking the guard for an approve
    const result = await checkForkOrSelfGuard(
      {octokit, owner: 'owner', repo: 'repo', prNumber: 1, botLogin: 'fro-bot[bot]', event: 'APPROVE'},
      logger,
    )

    // #then it is allowed, with the head SHA returned
    expect(result).toEqual({allowed: true, currentHeadSha: 'head-sha-abc'})
  })

  it('allows a normal PR authored by a human on the base repo for REQUEST_CHANGES', async () => {
    // #given a PR authored by a non-bot user on the base repo
    const octokit = makeOctokit() as unknown as Octokit

    // #when checking the guard for a request-changes
    const result = await checkForkOrSelfGuard(
      {octokit, owner: 'owner', repo: 'repo', prNumber: 1, botLogin: 'fro-bot[bot]', event: 'REQUEST_CHANGES'},
      logger,
    )

    // #then it is allowed, with the head SHA returned
    expect(result).toEqual({allowed: true, currentHeadSha: 'head-sha-abc'})
  })

  it('blocks a self-authored PR on APPROVE', async () => {
    // #given the bot is the PR author
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha-abc', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'fro-bot[bot]'},
        },
      }),
    }) as unknown as Octokit

    // #when checking the guard for an approve
    const result = await checkForkOrSelfGuard(
      {octokit, owner: 'owner', repo: 'repo', prNumber: 1, botLogin: 'fro-bot[bot]', event: 'APPROVE'},
      logger,
    )

    // #then it is blocked
    expect(result).toEqual({allowed: false, reason: 'self-or-fork'})
  })

  it('allows a self-authored PR on REQUEST_CHANGES', async () => {
    // #given the bot is the PR author
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha-abc', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'fro-bot[bot]'},
        },
      }),
    }) as unknown as Octokit

    // #when checking the guard for a request-changes
    const result = await checkForkOrSelfGuard(
      {octokit, owner: 'owner', repo: 'repo', prNumber: 1, botLogin: 'fro-bot[bot]', event: 'REQUEST_CHANGES'},
      logger,
    )

    // #then it is allowed, since a request-changes can only block, never merge, the bot's own PR
    expect(result).toEqual({allowed: true, currentHeadSha: 'head-sha-abc'})
  })

  it('blocks a fork PR on APPROVE', async () => {
    // #given the PR head repo differs from the base repo
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha-abc', repo: {full_name: 'attacker/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }),
    }) as unknown as Octokit

    // #when checking the guard for an approve
    const result = await checkForkOrSelfGuard(
      {octokit, owner: 'owner', repo: 'repo', prNumber: 1, botLogin: 'fro-bot[bot]', event: 'APPROVE'},
      logger,
    )

    // #then it is blocked
    expect(result).toEqual({allowed: false, reason: 'self-or-fork'})
  })

  it('allows a fork PR on REQUEST_CHANGES', async () => {
    // #given the PR head repo differs from the base repo
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha-abc', repo: {full_name: 'attacker/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }),
    }) as unknown as Octokit

    // #when checking the guard for a request-changes
    const result = await checkForkOrSelfGuard(
      {octokit, owner: 'owner', repo: 'repo', prNumber: 1, botLogin: 'fro-bot[bot]', event: 'REQUEST_CHANGES'},
      logger,
    )

    // #then it is allowed, since a request-changes can only block, never merge, fork-controlled code
    expect(result).toEqual({allowed: true, currentHeadSha: 'head-sha-abc'})
  })
})

describe('submitReviewWithHeadGuard', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('submits the review pinned to the observed head SHA when the head has not moved', async () => {
    // #given the head is unchanged since the caller's fork/self check
    const octokit = makeOctokit() as unknown as Octokit

    // #when submitting with a head guard
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
      },
      logger,
    )

    // #then the review is submitted, pinned to the head SHA
    expect(outcome.submitted).toBe(true)
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'APPROVE', commit_id: 'head-sha-abc'}),
    )
  })

  it('blocks submission when the head moved between the fork/self check and submit (TOCTOU)', async () => {
    // #given the head moved since the caller's fork/self check
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'new-head-sha', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }),
    }) as unknown as Octokit

    // #when submitting with a head guard using the stale head SHA
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
      },
      logger,
    )

    // #then submission is blocked and no review is created
    expect(outcome).toEqual({submitted: false, reason: 'head-moved-before-submit'})
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
  })
})
