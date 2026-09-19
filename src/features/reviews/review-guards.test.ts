import type {
  ReviewDeliveryReceiptIdentity,
  ReviewDeliveryReceiptOperations,
} from '../../services/github/review-delivery-receipt.js'
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

function makeReservationOps(overrides?: {
  readonly reserve?: ReviewDeliveryReceiptOperations['reserve']
  readonly recordDelivered?: ReviewDeliveryReceiptOperations['recordDelivered']
}): ReviewDeliveryReceiptOperations {
  return {
    reserve: overrides?.reserve ?? vi.fn(async () => ({kind: 'reserved' as const, etag: 'reservation-etag'})),
    recordDelivered: overrides?.recordDelivered ?? vi.fn(async () => undefined),
  }
}

describe('submitReviewWithHeadGuard publication receipt', () => {
  let logger: Logger
  const IDENTITY: ReviewDeliveryReceiptIdentity = {repo: 'owner/repo', runId: 'run-1', prNumber: 1}

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('reserves after the head check and before the POST, then records delivery with the returned review id', async () => {
    // #given a reservation that succeeds
    const octokit = makeOctokit() as unknown as Octokit
    const reserve = vi.fn(async () => ({kind: 'reserved' as const, etag: 'reservation-etag'}))
    const recordDelivered = vi.fn(async () => undefined)
    const reservationOps = makeReservationOps({reserve, recordDelivered})

    // #when submitting with reservationOps injected
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
        reservationOps,
        receiptIdentity: IDENTITY,
        attempt: 1,
      },
      logger,
    )

    // #then reserve is called before the POST, the POST happens, and delivery is recorded
    // afterward with the review id the POST returned
    expect(outcome.submitted).toBe(true)
    expect(reserve).toHaveBeenCalledExactlyOnceWith(IDENTITY, 1)
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'APPROVE'}),
    )
    expect(recordDelivered).toHaveBeenCalledExactlyOnceWith(IDENTITY, 'reservation-etag', 1, 999)
  })

  it('head guard rejects before reservation is ever attempted -- no receipt consumed', async () => {
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
    const reserve = vi.fn(async () => ({kind: 'reserved' as const, etag: 'reservation-etag'}))
    const reservationOps = makeReservationOps({reserve})

    // #when submitting with the stale head SHA
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
        reservationOps,
        receiptIdentity: IDENTITY,
        attempt: 1,
      },
      logger,
    )

    // #then blocked by the head guard, and the reservation was never attempted -- no receipt
    // slot was consumed for a submission that was never going to happen
    expect(outcome).toEqual({submitted: false, reason: 'head-moved-before-submit'})
    expect(reserve).not.toHaveBeenCalled()
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('a blocked reservation performs zero POSTs (covers rerun-after-cleanup-failure, ambiguous-timeout-retry, and conflict cases uniformly)', async () => {
    // #given the receipt blocks (any reason -- the guard treats them uniformly)
    const octokit = makeOctokit() as unknown as Octokit
    const reserve = vi.fn(async () => ({
      kind: 'blocked' as const,
      reason: 'already-reserved' as const,
      detail: 'existing receipt',
    }))
    const reservationOps = makeReservationOps({reserve})

    // #when submitting
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
        reservationOps,
        receiptIdentity: IDENTITY,
        attempt: 2,
      },
      logger,
    )

    // #then zero POSTs, and the block surfaces the receipt's own reason
    expect(outcome).toEqual({submitted: false, reason: 'receipt-blocked', receiptReason: 'already-reserved'})
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('omitting reservationOps preserves the pre-receipt behavior unchanged (no receipt call site exists to skip)', async () => {
    // #given a caller that does not inject reservationOps at all
    const octokit = makeOctokit() as unknown as Octokit

    // #when submitting without reservationOps/receiptIdentity/attempt
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

    // #then it submits exactly as it did before this feature existed
    expect(outcome.submitted).toBe(true)
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'APPROVE'}),
    )
  })
})
