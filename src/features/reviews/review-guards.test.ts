import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {
  ReviewDeliveryReceiptIdentity,
  ReviewDeliveryReceiptOperations,
} from '../../services/github/review-delivery-receipt.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import {err, ok} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createReviewDeliveryReceiptOperations} from '../../services/github/review-delivery-receipt.js'
import {markRunCancelled, resetRunCancellation, startCancellationCleanups} from '../../shared/cancellation.js'
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
    expect(result).toEqual({allowed: true, currentHeadSha: 'head-sha-abc', selfAuthored: false})
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
    expect(result).toEqual({allowed: true, currentHeadSha: 'head-sha-abc', selfAuthored: false})
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

    // #then it is blocked, and the block is identified as self-authorship
    expect(result).toEqual({allowed: false, reason: 'self-or-fork', selfAuthored: true})
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

    // #then the guard allows it but reports self-authorship so the caller can avoid GitHub's own-PR 422
    expect(result).toEqual({allowed: true, currentHeadSha: 'head-sha-abc', selfAuthored: true})
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

    // #then it is blocked, and the block is not self-authorship
    expect(result).toEqual({allowed: false, reason: 'self-or-fork', selfAuthored: false})
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
    expect(result).toEqual({allowed: true, currentHeadSha: 'head-sha-abc', selfAuthored: false})
  })

  it('reports a self-authored fork PR on APPROVE as blocked and self-authored', async () => {
    // #given the bot authored a PR from a fork head
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha-abc', repo: {full_name: 'attacker/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'fro-bot'},
        },
      }),
    }) as unknown as Octokit

    // #when checking the guard for an approve
    const result = await checkForkOrSelfGuard(
      {octokit, owner: 'owner', repo: 'repo', prNumber: 1, botLogin: 'fro-bot[bot]', event: 'APPROVE'},
      logger,
    )

    // #then it stays blocked; the caller may only ever downgrade it to a non-approving COMMENT
    expect(result).toEqual({allowed: false, reason: 'self-or-fork', selfAuthored: true})
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
        reviewedHeadSha: 'head-sha-abc',
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
        reviewedHeadSha: 'head-sha-abc',
      },
      logger,
    )

    // #then submission is blocked and no review is created
    expect(outcome).toEqual({submitted: false, reason: 'head-moved-before-submit'})
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
  })
})

describe('submitReviewWithHeadGuard reviewed-head pinning (#2124)', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('aborts when the PR head at submit differs from the reviewed head, even though both delivery-time fetches agree', async () => {
    // #given the agent reviewed A and the PR has since moved to B (every fetch reads B)
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-B', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }),
    }) as unknown as Octokit

    // #when submitting with the reviewed head A
    const outcome = await submitReviewWithHeadGuard(
      {octokit, owner: 'owner', repo: 'repo', prNumber: 1, event: 'APPROVE', body: 'lgtm', reviewedHeadSha: 'head-A'},
      logger,
    )

    // #then the review is dropped; it is never attributed to B
    expect(outcome).toEqual({submitted: false, reason: 'head-moved-before-submit'})
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('pins commit_id to the reviewed head and reports it as the submitted commit', async () => {
    // #given the PR still sits at the reviewed head
    const octokit = makeOctokit() as unknown as Octokit

    // #when submitting
    const outcome = await submitReviewWithHeadGuard(
      {
        octokit,
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        event: 'REQUEST_CHANGES',
        body: 'fix',
        reviewedHeadSha: 'head-sha-abc',
      },
      logger,
    )

    // #then the POST and the outcome both carry the reviewed head
    expect(outcome).toMatchObject({submitted: true, commitSha: 'head-sha-abc'})
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({commit_id: 'head-sha-abc'}),
    )
  })
})

function makeReservationOps(overrides?: {
  readonly reserve?: ReviewDeliveryReceiptOperations['reserve']
  readonly recordDelivered?: ReviewDeliveryReceiptOperations['recordDelivered']
  readonly release?: ReviewDeliveryReceiptOperations['release']
}): ReviewDeliveryReceiptOperations {
  return {
    reserve:
      overrides?.reserve ?? vi.fn(async () => ({kind: 'reserved-configured' as const, etag: 'reservation-etag'})),
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
    const reserve = vi.fn(async () => ({kind: 'reserved-configured' as const, etag: 'reservation-etag'}))
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
        reviewedHeadSha: 'head-sha-abc',
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
    const reserve = vi.fn(async () => ({kind: 'reserved-configured' as const, etag: 'reservation-etag'}))
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
        reviewedHeadSha: 'head-sha-abc',
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
        reviewedHeadSha: 'head-sha-abc',
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
        reviewedHeadSha: 'head-sha-abc',
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
    const reserve = vi.fn(async () => ({kind: 'reserved-configured' as const, etag: 'reservation-etag'}))
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
        reviewedHeadSha: 'head-sha-abc',
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

  it('a CONFIGURED reservation whose etag happens to equal the unconfigured sentinel literal still gets its post-reservation head re-check, and still refuses to submit against a moved head', async () => {
    // #given a CONFIGURED store's reservation that happens to carry the same etag string the
    // unconfigured path used to use as a sentinel -- provenance, not etag spelling, must
    // decide whether the post-reservation re-check runs. The head reads as unchanged on the
    // pre-reservation check but has moved by the time the post-reservation re-check runs.
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
    const reserve = vi.fn(async () => ({kind: 'reserved-configured' as const, etag: 'unconfigured'}))
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
        reviewedHeadSha: 'head-sha-abc',
        receipt: {ops, identity: IDENTITY, attempt: 1},
      },
      logger,
    )

    // #then the re-check runs because the reservation is CONFIGURED (provenance), not because
    // of what its etag spells -- the move is caught, submission is refused, and the
    // reservation is released
    expect(outcome).toEqual({submitted: false, reason: 'head-moved-before-submit'})
    expect(reserve).toHaveBeenCalledExactlyOnceWith(IDENTITY, 1)
    expect(release).toHaveBeenCalledExactlyOnceWith(IDENTITY, 'unconfigured')
    expect((octokit as unknown as MockOctokit).rest.pulls.createReview).not.toHaveBeenCalled()
    expect(recordDelivered).not.toHaveBeenCalled()
  })

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
        reviewedHeadSha: 'head-sha-abc',
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
        reviewedHeadSha: 'head-sha-abc',
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
        reviewedHeadSha: 'head-sha-abc',
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

describe('submitReviewWithHeadGuard after a cancel', () => {
  const IDENTITY: ReviewDeliveryReceiptIdentity = {repo: 'owner/repo', runId: 'run-1', prNumber: 1}
  const params = (octokit: Octokit, receipt?: ReviewDeliveryReceiptOperations) => ({
    octokit,
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    event: 'APPROVE' as const,
    body: 'lgtm',
    reviewedHeadSha: 'head-sha-abc',
    ...(receipt === undefined ? {} : {receipt: {ops: receipt, identity: IDENTITY, attempt: 1}}),
  })

  afterEach(() => {
    resetRunCancellation()
  })

  it('submits no approval when the signal arrives while the pre-approval head read is in flight, and reserves nothing', async () => {
    // #given a head read that is in flight when the signal arrives
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockImplementation(async () => {
      markRunCancelled()
      return {
        data: {
          head: {sha: 'head-sha-abc', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }
    })
    const reserve = vi.fn(async () => ({kind: 'reserved-configured' as const, etag: 'e'}))
    const ops = makeReservationOps({reserve})

    // #when the read finishes after the signal
    const outcome = submitReviewWithHeadGuard(params(octokit as unknown as Octokit, ops), createMockLogger())

    // #then the approval is refused before anything is reserved or sent
    await expect(outcome).rejects.toMatchObject({name: 'RunCancelledError'})
    expect(reserve).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('releases the reservation and sends nothing when the signal arrives during the reservation round trip', async () => {
    // #given a reservation that takes a signal with it
    const octokit = makeOctokit()
    const reserve = vi.fn(async () => {
      markRunCancelled()
      return {kind: 'reserved-configured' as const, etag: 'reservation-etag'}
    })
    const release = vi.fn(async () => undefined)
    const ops = makeReservationOps({reserve, release})

    // #when
    const outcome = submitReviewWithHeadGuard(params(octokit as unknown as Octokit, ops), createMockLogger())

    // #then the slot is given back (a rerun can still deliver the review) and no review was created
    await expect(outcome).rejects.toMatchObject({name: 'RunCancelledError'})
    expect(release).toHaveBeenCalledExactlyOnceWith(IDENTITY, 'reservation-etag')
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })
})

/**
 * The same guard over the REAL receipt operations and an in-memory conditional store, across a cancellation: what the store holds
 * afterwards is what decides whether a rerun of the same run id can still deliver the review.
 */
describe('submitReviewWithHeadGuard with a real receipt store across a cancel', () => {
  const IDENTITY: ReviewDeliveryReceiptIdentity = {repo: 'owner/repo', runId: 'run-1', prNumber: 1}
  let logger: Logger

  interface StoreHooks {
    readonly onGet?: () => void | Promise<void>
    readonly onPut?: () => void | Promise<void>
  }

  function createStore(hooks: StoreHooks = {}) {
    // Each hook fires on the first call only: the signal of one run, not of the rerun that follows it.
    const once = (hook: StoreHooks['onGet']): StoreHooks['onGet'] => {
      let fired = false
      return async () => {
        if (fired) return
        fired = true
        await hook?.()
      }
    }
    const onGet = once(hooks.onGet)
    const onPut = once(hooks.onPut)
    const objects = new Map<string, {readonly data: string; readonly etag: string}>()
    let counter = 0
    const deletes: {key: string; ifMatch: string}[] = []
    const puts: string[] = []
    const adapter: ObjectStoreAdapter = {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      getObject: vi.fn(async (key: string) => {
        await onGet?.()
        const found = objects.get(key)
        return found === undefined
          ? err(Object.assign(new Error('NoSuchKey: object not found'), {errorCode: 'NoSuchKey'}))
          : ok(found)
      }),
      conditionalPut: vi.fn(async (key: string, data: string, options: {ifNoneMatch?: string; ifMatch?: string}) => {
        await onPut?.()
        puts.push(key)
        const existing = objects.get(key)
        if (options.ifNoneMatch === '*' && existing !== undefined) return err(new Error('PreconditionFailed'))
        if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch)
          return err(new Error('PreconditionFailed'))
        counter += 1
        objects.set(key, {data, etag: `etag-${counter}`})
        return ok({etag: `etag-${counter}`})
      }),
      conditionalDelete: vi.fn(async (key: string, options: {ifMatch: string}) => {
        deletes.push({key, ifMatch: options.ifMatch})
        if (objects.get(key)?.etag !== options.ifMatch) return err(new Error('PreconditionFailed'))
        objects.delete(key)
        return ok(undefined)
      }),
    }
    return {adapter, objects, deletes, puts}
  }

  const runParams = (octokit: Octokit, adapter: ObjectStoreAdapter, logger: Logger) => ({
    octokit,
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    event: 'APPROVE' as const,
    body: 'lgtm',
    reviewedHeadSha: 'head-sha-abc',
    receipt: {
      ops: createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter),
      identity: IDENTITY,
      attempt: 1,
    },
  })

  /** What a rerun of the same run id sees: whether it can reserve, then submit. */
  async function rerun(adapter: ObjectStoreAdapter) {
    resetRunCancellation()
    const octokit = makeOctokit()
    const outcome = await submitReviewWithHeadGuard(runParams(octokit as unknown as Octokit, adapter, logger), logger)
    return {outcome, octokit}
  }

  beforeEach(() => {
    logger = createMockLogger()
  })
  afterEach(() => {
    resetRunCancellation()
  })

  it('writes no receipt when the signal arrives during the store read, and a rerun delivers the review', async () => {
    // #given a store whose read is in flight when the signal arrives
    const store = createStore({
      onGet: () => {
        markRunCancelled()
      },
    })
    const octokit = makeOctokit()

    // #when the guard goes on
    const outcome = submitReviewWithHeadGuard(runParams(octokit as unknown as Octokit, store.adapter, logger), logger)

    // #then the conditional PUT never happened, nothing was sent, and the store is empty
    await expect(outcome).rejects.toMatchObject({name: 'RunCancelledError'})
    expect(store.puts).toEqual([])
    expect(store.objects.size).toBe(0)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    // #and a rerun of the same run id reserves and delivers
    const second = await rerun(store.adapter)
    expect(second.outcome.submitted).toBe(true)
  })

  it('releases the receipt, conditioned on its etag, when the signal arrives during the PUT, and a rerun delivers', async () => {
    // #given a PUT that lands and takes a signal with it
    const store = createStore({
      onPut: () => {
        markRunCancelled()
      },
    })
    const octokit = makeOctokit()

    // #when
    const outcome = submitReviewWithHeadGuard(runParams(octokit as unknown as Octokit, store.adapter, logger), logger)

    // #then no review was sent, the receipt was deleted with its own etag, and the store is empty again
    await expect(outcome).rejects.toMatchObject({name: 'RunCancelledError'})
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    // the signal is acted on straight after the PUT: no second head lookup was made first
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1)
    expect(store.deletes.map(item => item.ifMatch)).toEqual(['etag-1'])
    expect(store.objects.size).toBe(0)
    expect((await rerun(store.adapter)).outcome.submitted).toBe(true)
  })

  it('releases the receipt when the second head lookup fails, and a rerun delivers', async () => {
    // #given a head lookup that works once and then fails (the one after the reservation)
    const store = createStore()
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockReset()
    octokit.rest.pulls.get
      .mockResolvedValueOnce({
        data: {
          head: {sha: 'head-sha-abc', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      })
      .mockRejectedValueOnce(new Error('GitHub is unavailable'))

    // #when
    const outcome = submitReviewWithHeadGuard(runParams(octokit as unknown as Octokit, store.adapter, logger), logger)

    // #then the failure surfaces, no review was sent, and the receipt did not survive to block the rerun
    await expect(outcome).rejects.toThrow('GitHub is unavailable')
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(store.deletes).toHaveLength(1)
    expect(store.objects.size).toBe(0)
    expect((await rerun(store.adapter)).outcome.submitted).toBe(true)
  })

  it('releases the receipt at once when the signal arrives while the second head lookup hangs', async () => {
    // #given a second head lookup that does not answer until the test lets it
    const store = createStore()
    const octokit = makeOctokit()
    let answer: () => void = () => undefined
    const headResponse = {
      data: {
        head: {sha: 'head-sha-abc', repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    }
    octokit.rest.pulls.get.mockReset()
    octokit.rest.pulls.get.mockResolvedValueOnce(headResponse).mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          answer = () => resolve(headResponse)
        }),
    )
    const outcome = submitReviewWithHeadGuard(runParams(octokit as unknown as Octokit, store.adapter, logger), logger)
    await vi.waitFor(() => {
      expect(store.objects.size).toBe(1)
      expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(2)
    })

    // #when the signal arrives while that lookup is still pending (the owner marks the run, then starts the cleanups)
    markRunCancelled()
    await Promise.all(startCancellationCleanups())
    await vi.waitFor(() => {
      expect(store.deletes).toHaveLength(1)
    })

    // #then the receipt is already gone, before the lookup has answered; and when it does, nothing is sent
    expect(store.objects.size).toBe(0)
    answer()
    await expect(outcome).rejects.toMatchObject({name: 'RunCancelledError'})
    expect(store.deletes).toHaveLength(1)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('keeps the receipt when the review POST itself fails after it was sent', async () => {
    // #given a POST that fails after the request may have gone out
    const store = createStore()
    const octokit = makeOctokit()
    octokit.rest.pulls.createReview.mockRejectedValue(new Error('socket hang up'))

    // #when
    const outcome = submitReviewWithHeadGuard(runParams(octokit as unknown as Octokit, store.adapter, logger), logger)

    // #then the failure surfaces and the receipt stays: a rerun must not send a second review
    await expect(outcome).rejects.toThrow()
    expect(store.deletes).toEqual([])
    expect(store.objects.size).toBe(1)
    expect((await rerun(store.adapter)).outcome).toMatchObject({submitted: false, reason: 'receipt-blocked'})
  })

  it('keeps the receipt when the signal arrives after the POST began', async () => {
    // #given a POST during which the signal arrives
    const store = createStore()
    const octokit = makeOctokit()
    octokit.rest.pulls.createReview.mockImplementation(async () => {
      markRunCancelled()
      await Promise.all(startCancellationCleanups())
      return {data: {id: 999, state: 'APPROVED', html_url: 'https://github.com/pr/1/reviews/999'}}
    })

    // #when
    const outcome = await submitReviewWithHeadGuard(
      runParams(octokit as unknown as Octokit, store.adapter, logger),
      logger,
    )

    // #then the review was sent, the receipt was not released, and it is marked delivered
    expect(outcome.submitted).toBe(true)
    expect(store.deletes).toEqual([])
    expect(JSON.parse([...store.objects.values()][0]?.data ?? '{}')).toMatchObject({status: 'delivered', reviewId: 999})
  })
})
