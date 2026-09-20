import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {
  ReviewDeliveryReceiptIdentity,
  ReviewDeliveryReceiptOperations,
} from '../../services/github/review-delivery-receipt.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createReviewDeliveryReceiptOperations} from '../../services/github/review-delivery-receipt.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {checkForkOrSelfGuard, submitReviewWithHeadGuard} from './review-guards.js'

function createStoreConfig(overrides: Partial<ObjectStoreConfig> = {}): ObjectStoreConfig {
  return {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state', ...overrides}
}

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
  readonly release?: ReviewDeliveryReceiptOperations['release']
}): ReviewDeliveryReceiptOperations {
  return {
    reserve: overrides?.reserve ?? vi.fn(async () => ({kind: 'reserved' as const, etag: 'reservation-etag'})),
    recordDelivered: overrides?.recordDelivered ?? vi.fn(async () => undefined),
    release: overrides?.release ?? vi.fn(async () => undefined),
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
    const release = vi.fn(async () => undefined)
    const ops = makeReservationOps({reserve, recordDelivered, release})

    // #when submitting with receipt injected
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
        receipt: {ops, identity: IDENTITY, attempt: 1},
      },
      logger,
    )

    // #then reserve is called before the POST, the POST happens, and delivery is recorded
    // afterward with the review id the POST returned -- and the head not having moved since
    // reservation means release is never consulted
    expect(outcome.submitted).toBe(true)
    expect(reserve).toHaveBeenCalledExactlyOnceWith(IDENTITY, 1)
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'APPROVE'}),
    )
    expect(recordDelivered).toHaveBeenCalledExactlyOnceWith(IDENTITY, 'reservation-etag', 1, 999)
    expect(release).not.toHaveBeenCalled()
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
    const ops = makeReservationOps({reserve})

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
        receipt: {ops, identity: IDENTITY, attempt: 1},
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
    const ops = makeReservationOps({reserve})

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
        receipt: {ops, identity: IDENTITY, attempt: 2},
      },
      logger,
    )

    // #then zero POSTs, and the block surfaces the receipt's own reason
    expect(outcome).toEqual({submitted: false, reason: 'receipt-blocked', receiptReason: 'already-reserved'})
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('omitting receipt preserves the pre-receipt behavior unchanged (no receipt call site exists to skip)', async () => {
    // #given a caller that does not inject a receipt at all
    const octokit = makeOctokit() as unknown as Octokit

    // #when submitting without a receipt
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

  it('the head moving DURING the reservation call aborts after reserving, releases the reservation, and never submits', async () => {
    // #given the head reads as unchanged on the guard's pre-reservation check, but has
    // moved by the time the post-reservation re-check runs. `makeOctokit`'s getPR override
    // is captured once at mock-creation time (`mockResolvedValue`), so a per-call sequence
    // is set up directly with `mockImplementation` on the already-built mock instead: the
    // first call (pre-reservation check) returns the original SHA, every call after (the
    // post-reservation re-check) returns the moved one.
    const octokitBase = makeOctokit()
    let callCount = 0
    octokitBase.rest.pulls.get.mockImplementation(async () => {
      callCount += 1
      const sha = callCount <= 1 ? 'head-sha-abc' : 'moved-during-reservation-sha'
      return {
        data: {
          head: {sha, repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }
    })
    const octokit = octokitBase as unknown as Octokit
    const reserve = vi.fn(async () => ({kind: 'reserved' as const, etag: 'reservation-etag'}))
    const recordDelivered = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    const ops = makeReservationOps({reserve, recordDelivered, release})

    // #when submitting with a receipt injected
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
        receipt: {ops, identity: IDENTITY, attempt: 1},
      },
      logger,
    )

    // #then the reservation was acquired (the race window is INSIDE the reserve call), but
    // the post-reservation re-check catches the move: submission is aborted, the reservation
    // is released (a stale-head abort is not a delivery -- it must not permanently suppress a
    // later legitimate review for this run), and delivery is never recorded
    expect(outcome).toEqual({submitted: false, reason: 'head-moved-before-submit'})
    expect(reserve).toHaveBeenCalledExactlyOnceWith(IDENTITY, 1)
    expect(release).toHaveBeenCalledExactlyOnceWith(IDENTITY, 'reservation-etag')
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
    expect(recordDelivered).not.toHaveBeenCalled()
  })

  // Every test above builds `ReviewDeliveryReceiptOperations` with `makeReservationOps`, a
  // hand-rolled stub that returns whatever the test expects. That leaves the real
  // `createReviewDeliveryReceiptOperations` (review-delivery-receipt.ts) never composed with
  // this guard at all -- exactly the seam an unconfigured store's `reserve` regressed
  // through and shipped broken (fixed in 64bcae354): it made every default-configured
  // consumer and every fork PR fail closed with nothing posted. These next three tests build
  // the real operations from real `ObjectStoreConfig`s, not a stub of the caller's own
  // assumption.

  it('end to end: real operations built from a disabled store (default s3-backup: false) submit the review, unprotected but not blocked', async () => {
    // #given the REAL operations, built from an unconfigured store config -- not a stub
    const octokit = makeOctokit() as unknown as Octokit
    const storeConfig = createStoreConfig({enabled: false})
    const ops = createReviewDeliveryReceiptOperations(storeConfig, logger)

    // #when submitting through the head guard with those real operations
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
        receipt: {ops, identity: IDENTITY, attempt: 1},
      },
      logger,
    )

    // #then the review IS submitted. Against the reverted fail-closed behavior (reserve
    // always blocking when storeConfig.enabled === false), this assertion fails with
    // `outcome.submitted === false` -- the exact shape of the shipped regression.
    expect(outcome.submitted).toBe(true)
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'APPROVE', commit_id: 'head-sha-abc'}),
    )
    // The unconfigured-store `reserve` above returned synchronously without any reservation
    // round trip, so the post-reservation head re-check (review-guards.ts ~202) must be
    // skipped: only the one pre-reservation `pulls.get` call happens, not a wasted second one.
    expect((octokit as unknown as MockOctokit).rest.pulls.get).toHaveBeenCalledOnce()
  })

  it('complement, end to end: real operations built from a CONFIGURED but failing store still block submission', async () => {
    // #given the REAL operations, built from a configured store whose adapter lacks
    // conditional operations -- the case the receipt exists to fail closed against
    const octokit = makeOctokit() as unknown as Octokit
    const storeConfig = createStoreConfig({enabled: true})
    const bareAdapter: ObjectStoreAdapter = {upload: vi.fn(), download: vi.fn(), list: vi.fn()}
    const ops = createReviewDeliveryReceiptOperations(storeConfig, logger, bareAdapter)

    // #when submitting through the head guard with those real operations
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'APPROVE',
        body: 'lgtm',
        currentHeadSha: 'head-sha-abc',
        receipt: {ops, identity: IDENTITY, attempt: 1},
      },
      logger,
    )

    // #then still blocked -- a configured-but-failing store must never be treated like an
    // unconfigured one, unlike the disabled-store case above
    expect(outcome).toEqual({submitted: false, reason: 'receipt-blocked', receiptReason: 'store-unavailable'})
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('a fork PR (store force-disabled per inputs.ts ~332-338) delivers a REQUEST_CHANGES review via the real disabled-store operations', async () => {
    // #given a fork PR -- inputs.ts forces storeConfig.enabled = false for forks regardless of
    // configuration -- and REQUEST_CHANGES specifically, since APPROVE has its own separate
    // fork/self gating (checkForkOrSelfGuard) that would pass or fail this test for unrelated
    // reasons. This is the plain delivery path forks actually depend on.
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha-abc', repo: {full_name: 'attacker/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }),
      createReview: () => ({
        data: {id: 111, state: 'CHANGES_REQUESTED', html_url: 'https://github.com/pr/1/reviews/111'},
      }),
    }) as unknown as Octokit
    const storeConfig = createStoreConfig({enabled: false})
    const ops = createReviewDeliveryReceiptOperations(storeConfig, logger)

    // #when submitting a REQUEST_CHANGES review through the head guard
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'REQUEST_CHANGES',
        body: 'please address these issues',
        currentHeadSha: 'head-sha-abc',
        receipt: {ops, identity: IDENTITY, attempt: 1},
      },
      logger,
    )

    // #then the review is submitted, pinned to the observed head SHA
    expect(outcome.submitted).toBe(true)
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'REQUEST_CHANGES', commit_id: 'head-sha-abc'}),
    )
  })
})
