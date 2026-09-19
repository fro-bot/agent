/**
 * Tests for runReviewReconciliation phase
 *
 * TDD: these tests are written BEFORE the implementation.
 * They should fail (RED) until review-reconciliation.ts is created.
 */

import type {ReviewDeliveryReceiptOperations} from '../../services/github/review-delivery-receipt.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {runReviewReconciliation} from './review-reconciliation.js'

// ---------------------------------------------------------------------------
// Octokit mock factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal deterministic octokit mock.
 * Each method is a vi.fn() so tests can override per-scenario.
 */
function makeOctokit(overrides?: {
  readonly getPR?: () => Promise<unknown>
  readonly listReviews?: () => Promise<unknown>
  readonly createReview?: () => Promise<unknown>
  readonly getPRDiff?: () => Promise<unknown>
}) {
  const defaultPR = {
    data: {
      head: {sha: 'head-sha-abc', repo: {full_name: 'owner/repo'}},
      base: {repo: {full_name: 'owner/repo'}},
      user: {login: 'pr-author'},
    },
  }
  const defaultReviews = {data: []}
  const defaultCreateReview = {data: {id: 999, state: 'APPROVED', html_url: 'https://github.com/pr/1/reviews/999'}}
  const defaultDiff = {data: []}

  return {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue(overrides?.getPR?.() ?? defaultPR),
        listReviews: vi.fn().mockResolvedValue(overrides?.listReviews?.() ?? defaultReviews),
        createReview: vi.fn().mockResolvedValue(overrides?.createReview?.() ?? defaultCreateReview),
        listFiles: vi.fn().mockResolvedValue(overrides?.getPRDiff?.() ?? defaultDiff),
      },
      issues: {
        // listComments is no longer called by the phase — kept in mock for
        // tests that assert it is NOT called.
        listComments: vi.fn().mockResolvedValue({data: []}),
      },
    },
  }
}

/** Type alias for the mock octokit returned by makeOctokit() */
type MockOctokit = ReturnType<typeof makeOctokit>

// ---------------------------------------------------------------------------
// Shared params builder
// ---------------------------------------------------------------------------

const RUN_START_MS = new Date('2026-06-06T10:00:00.000Z').getTime()
const AFTER_START = new Date('2026-06-06T10:05:00.000Z').toISOString()
const BEFORE_START = new Date('2026-06-06T09:55:00.000Z').toISOString()
const HEAD_SHA = 'head-sha-abc'
const STALE_SHA = 'old-sha-xyz'

function makeParams(overrides?: {
  readonly isPullRequestReviewTrigger?: boolean
  readonly prNumber?: number | null
  readonly responseModeIsGithub?: boolean
  readonly agentSucceeded?: boolean
  readonly botLogin?: string | null
  readonly owner?: string
  readonly repo?: string
  readonly octokit?: MockOctokit
  readonly runStartMs?: number
  readonly isFileConventionDelivery?: boolean
  readonly knownExecutionVeto?: boolean
  readonly receipt?: {
    readonly ops: ReviewDeliveryReceiptOperations
    readonly runId: string
    readonly runAttempt: number
  }
}) {
  return {
    octokit: (overrides?.octokit ?? makeOctokit()) as unknown as Octokit,
    // Use explicit 'botLogin' key check so null is preserved (not coalesced to default)
    botLogin: Object.prototype.hasOwnProperty.call(overrides ?? {}, 'botLogin')
      ? (overrides?.botLogin ?? null)
      : 'fro-bot[bot]',
    owner: overrides?.owner ?? 'owner',
    repo: overrides?.repo ?? 'repo',
    prNumber: overrides?.prNumber === undefined ? 42 : overrides.prNumber,
    isPullRequestReviewTrigger: overrides?.isPullRequestReviewTrigger ?? true,
    responseModeIsGithub: overrides?.responseModeIsGithub ?? true,
    agentSucceeded: overrides?.agentSucceeded ?? true,
    runStartMs: overrides?.runStartMs ?? RUN_START_MS,
    isFileConventionDelivery: overrides?.isFileConventionDelivery ?? false,
    knownExecutionVeto: overrides?.knownExecutionVeto ?? false,
    receipt: overrides?.receipt,
  }
}

// ---------------------------------------------------------------------------
// Helper: build a bot review object
// ---------------------------------------------------------------------------

/**
 * Builds an octokit fixture that genuinely qualifies for approval -- a bot COMMENTED review
 * carrying a PASS verdict at the current head. Shared by the `knownExecutionVeto` and
 * `receipt` describe blocks below so their "blocked" assertions are never
 * vacuous: without a fixture that would otherwise approve, a no-op for an unrelated reason
 * (e.g. isFileConventionDelivery or no qualifying review) would "pass" even with no gate at all.
 */
function makeQualifyingOctokit(): MockOctokit {
  const octokit = makeOctokit()
  octokit.rest.pulls.get.mockResolvedValue({
    data: {
      head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
      base: {repo: {full_name: 'owner/repo'}},
      user: {login: 'pr-author'},
    },
  })
  octokit.rest.pulls.listReviews.mockResolvedValue({
    data: [
      makeBotReview({
        state: 'COMMENTED',
        body: '## Verdict: PASS\n\nLooks good.',
        commitId: HEAD_SHA,
        submittedAt: AFTER_START,
      }),
    ],
  })
  return octokit
}

function makeBotReview(opts: {
  readonly state: string
  readonly body: string
  readonly commitId: string
  readonly submittedAt: string
  readonly login?: string
  readonly userType?: string
}) {
  return {
    id: 1,
    user: {login: opts.login ?? 'fro-bot[bot]', type: opts.userType ?? 'Bot'},
    state: opts.state,
    body: opts.body,
    commit_id: opts.commitId,
    submitted_at: opts.submittedAt,
    html_url: 'https://github.com/pr/1/reviews/1',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runReviewReconciliation', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Happy path: COMMENTED review with PASS at current head → approve
  // -------------------------------------------------------------------------

  it('submits APPROVE when bot left a COMMENTED review with PASS at current head', async () => {
    // #given bot left a COMMENTED review with PASS verdict at current head
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then submitReview is called with APPROVE event
    expect(result.reconciled).toBe(true)
    expect(result.reason).toBe('approved')
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: 'APPROVE',
        owner: 'owner',
        repo: 'repo',
        pull_number: 42,
      }),
    )
  })

  // -------------------------------------------------------------------------
  // Security: issue-comment-only path must NOT approve (FIX 1)
  // -------------------------------------------------------------------------

  it('skips with no-bot-review when bot used only an issue comment (no PR review) with PASS', async () => {
    // #given no bot PR reviews, but bot left an issue comment with PASS verdict
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({data: []})
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no approval — issue comments cannot verify the reviewed SHA
    expect(result.reconciled).toBe(false)
    expect(result.reason).toBe('no-bot-review')
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    // listComments must NOT be called — the fallback is removed
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Edge: bot already APPROVED at current head → no-op
  // -------------------------------------------------------------------------

  it('skips when bot already has an APPROVED review at current head', async () => {
    // #given bot already has an APPROVED review at the current head SHA
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'APPROVED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no additional review is submitted
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Edge: verdict artifact from a prior run (older timestamp) → no-op
  // -------------------------------------------------------------------------

  it('skips when the latest bot review predates the current run start', async () => {
    // #given bot review was submitted before this run started
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: HEAD_SHA,
          submittedAt: BEFORE_START, // older than run start
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no review is submitted — stale artifact (no qualifying review this run)
    expect(result.reconciled).toBe(false)
    expect(result.reason).toBe('no-bot-review')
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Edge: head advanced since the verdict review → no-op
  // -------------------------------------------------------------------------

  it('skips when the verdict review commit_id does not match current head', async () => {
    // #given bot review was for a prior commit, head has since advanced
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: STALE_SHA, // different from current HEAD_SHA
          submittedAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no review is submitted — stale head
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Security: head moves between initial fetch and pre-submit re-fetch (FIX 2c)
  // -------------------------------------------------------------------------

  it('skips with head-moved-before-submit when head changes between initial fetch and pre-submit re-check', async () => {
    // #given bot left a PASS review at HEAD_SHA, but a push happens before submit
    const octokit = makeOctokit()
    const NEW_HEAD = 'new-sha-pushed-after-review'

    // First pulls.get returns HEAD_SHA; second (pre-submit re-check) returns NEW_HEAD
    octokit.rest.pulls.get
      .mockResolvedValueOnce({
        data: {
          head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      })
      .mockResolvedValueOnce({
        data: {
          head: {sha: NEW_HEAD, repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no approval — head moved before submit
    expect(result.reconciled).toBe(false)
    expect(result.reason).toBe('head-moved-before-submit')
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Security: approve path pins commit_id to reviewed SHA (FIX 2a)
  // -------------------------------------------------------------------------

  it('passes commitSha (currentHeadSha) to createReview as commit_id on the approve path', async () => {
    // #given bot left a PASS review at HEAD_SHA, head is stable
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then createReview is called with commit_id pinned to the reviewed SHA
    expect(result.reconciled).toBe(true)
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        commit_id: HEAD_SHA,
        event: 'APPROVE',
      }),
    )
  })

  // -------------------------------------------------------------------------
  // Early no-op guards — zero octokit calls
  // -------------------------------------------------------------------------

  it('no-ops with zero octokit calls and reason finalize-owns-response for a file-convention run', async () => {
    // #given this run's response is delivered via the file-convention path
    const octokit = makeOctokit()
    const params = makeParams({octokit, isFileConventionDelivery: true})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then it skips before any octokit call, so it cannot double-submit
    expect(result).toEqual({reconciled: false, reason: 'finalize-owns-response'})
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.listReviews).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('no-ops with zero octokit calls when not a pull_request review trigger', async () => {
    // #given a non-PR-review trigger
    const octokit = makeOctokit()
    const params = makeParams({octokit, isPullRequestReviewTrigger: false})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then early no-op, no API calls
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.listReviews).not.toHaveBeenCalled()
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('no-ops with zero octokit calls when prNumber is null', async () => {
    // #given no PR number available
    const octokit = makeOctokit()
    const params = makeParams({octokit, prNumber: null})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then early no-op
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
  })

  it('no-ops with zero octokit calls when responseMode is not github', async () => {
    // #given response mode is not github
    const octokit = makeOctokit()
    const params = makeParams({octokit, responseModeIsGithub: false})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then early no-op
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
  })

  it('no-ops with zero octokit calls when agent did not succeed', async () => {
    // #given agent execution failed
    const octokit = makeOctokit()
    const params = makeParams({octokit, agentSucceeded: false})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then early no-op
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
  })

  it('no-ops with zero octokit calls when botLogin is null', async () => {
    // #given bot login is not available
    const octokit = makeOctokit()
    const params = makeParams({octokit, botLogin: null})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then early no-op
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
  })

  it('no-ops with zero octokit calls when botLogin is empty string', async () => {
    // #given bot login is empty
    const octokit = makeOctokit()
    const params = makeParams({octokit, botLogin: ''})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then early no-op
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Error path: submitReview throws (e.g. 403) → caught, no rethrow
  // -------------------------------------------------------------------------

  it('catches submitReview errors and returns no-op without rethrowing', async () => {
    // #given bot left a PASS review but createReview throws 403
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
        }),
      ],
    })
    octokit.rest.pulls.createReview.mockRejectedValue(
      Object.assign(new Error('Resource not accessible by integration'), {status: 403}),
    )
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then error is caught, phase returns no-op, does not rethrow
    expect(result.reconciled).toBe(false)
    expect(result.reason).toBe('error')
    // logger.warn should have been called
    expect(logger.warning).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Error path: self-authored or fork PR → no-op
  // -------------------------------------------------------------------------

  it('skips when the PR author is the bot itself', async () => {
    // #given PR author is the bot
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'fro-bot[bot]'}, // same as botLogin
      },
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no-op — cannot approve own PR
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('skips for a fork PR (head repo differs from base repo)', async () => {
    // #given PR is from a fork
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'fork-owner/repo'}}, // different from base
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'external-contributor'},
      },
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no-op — fork PRs may lack write permission
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Integration: run.ts wiring — error in reconciliation does not change exitCode
  // -------------------------------------------------------------------------

  it('does not throw even when pulls.get rejects unexpectedly', async () => {
    // #given pulls.get throws an unexpected error
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockRejectedValue(new Error('Network error'))
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then error is swallowed, phase returns no-op
    expect(result.reconciled).toBe(false)
    expect(result.reason).toBe('error')
    expect(logger.warning).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Edge: CONDITIONAL verdict → no-op
  // -------------------------------------------------------------------------

  it('skips when the verdict is CONDITIONAL', async () => {
    // #given bot left a COMMENTED review with CONDITIONAL verdict
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: CONDITIONAL\n\nNeeds minor fixes.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no approve submitted
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Edge: no verdict heading in body → no-op
  // -------------------------------------------------------------------------

  it('skips when the bot review body has no ## Verdict heading', async () => {
    // #given bot review body has no verdict heading
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: 'I reviewed this PR and it looks fine.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no approve submitted
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Security: non-bot user.type must NOT be treated as bot verdict (FIX 3)
  // -------------------------------------------------------------------------

  it('does not treat a non-bot (user.type=User) review with PASS as the bot verdict', async () => {
    // #given a human account named 'fro-bot[bot]' (user.type=User) left a PASS review
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
          login: 'fro-bot[bot]', // same login as bot
          userType: 'User', // but NOT a Bot account
        }),
      ],
    })
    const params = makeParams({octokit, botLogin: 'fro-bot[bot]'})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no approval — user.type !== 'Bot' fails the exact-match guard
    expect(result.reconciled).toBe(false)
    expect(result.reason).toBe('no-bot-review')
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Bot login exact match: fro-bot[bot] matches fro-bot[bot] reviews
  // -------------------------------------------------------------------------

  it('matches bot reviews using exact login + Bot type (fro-bot[bot] matches fro-bot[bot])', async () => {
    // #given bot login is 'fro-bot[bot]' and review user.login is also 'fro-bot[bot]' with type Bot
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: PASS\n\nLooks good.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
          login: 'fro-bot[bot]',
          userType: 'Bot',
        }),
        // A non-bot review that should be ignored
        {
          id: 2,
          user: {login: 'human-reviewer', type: 'User'},
          state: 'APPROVED',
          body: 'LGTM',
          commit_id: HEAD_SHA,
          submitted_at: AFTER_START,
          html_url: 'https://github.com/pr/1/reviews/2',
        },
      ],
    })
    const params = makeParams({octokit, botLogin: 'fro-bot[bot]'})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then bot's PASS review is found and approve is submitted
    expect(result.reconciled).toBe(true)
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// knownExecutionVeto: early no-op before any approval submission
// ---------------------------------------------------------------------------

describe('runReviewReconciliation knownExecutionVeto', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
    vi.clearAllMocks()
  })

  it('control: the qualifying fixture approves when knownExecutionVeto is false (sanity check against vacuous gating)', async () => {
    // #given a fixture that genuinely qualifies for approval, and no veto
    const octokit = makeQualifyingOctokit()
    const params = makeParams({octokit, knownExecutionVeto: false})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then it approves -- proving the fixture is not vacuous before the veto is asserted
    expect(result.reconciled).toBe(true)
    expect(result.reason).toBe('approved')
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledOnce()
  })

  it('blocks the otherwise-qualifying approval when knownExecutionVeto is true, before any PR fact is even fetched', async () => {
    // #given the identical qualifying fixture, but a known execution veto
    const octokit = makeQualifyingOctokit()
    const params = makeParams({octokit, knownExecutionVeto: true})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then it no-ops with the specific reason, and never makes a single octokit call --
    // the guard runs before checkForkOrSelfGuard, listReviews, or submitReview
    expect(result.reconciled).toBe(false)
    expect(result.reason).toBe('known-execution-veto')
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.listReviews).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('rEQUEST_CHANGES-equivalent skip path is untouched by the veto (decideReconciliation policy is not widened)', async () => {
    // #given a bot review carrying a FAIL verdict (decideReconciliation's existing skip
    // path for non-approving verdicts), combined with no veto
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        makeBotReview({
          state: 'COMMENTED',
          body: '## Verdict: FAIL\n\nNeeds work.',
          commitId: HEAD_SHA,
          submittedAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit, knownExecutionVeto: false})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then this phase never submits REQUEST_CHANGES itself (only ever APPROVE) -- the
    // FAIL verdict already skips via decideReconciliation, unrelated to knownExecutionVeto,
    // and that policy is not widened by this change
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// receipt: threaded into this phase's own submitReviewWithHeadGuard call
// ---------------------------------------------------------------------------

describe('runReviewReconciliation receipt', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
    vi.clearAllMocks()
  })

  it('reserves with the identity built from owner/repo/prNumber/runId/runAttempt before submitting the formal APPROVE', async () => {
    // #given a qualifying fixture and injected receipt operations that succeed
    const octokit = makeQualifyingOctokit()
    const reserve = vi.fn(async () => ({kind: 'reserved' as const, etag: 'reservation-etag'}))
    const recordDelivered = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    const params = makeParams({
      octokit,
      receipt: {ops: {reserve, recordDelivered, release}, runId: 'run-9', runAttempt: 2},
    })

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then reserve is called with the reconciliation identity, and it still approves
    expect(result.reconciled).toBe(true)
    expect(reserve).toHaveBeenCalledExactlyOnceWith({repo: 'owner/repo', runId: 'run-9', prNumber: 42}, 2)
    expect(recordDelivered).toHaveBeenCalledOnce()
  })

  it('a receipt-blocked reservation prevents the APPROVE from ever being submitted', async () => {
    // #given a qualifying fixture, but the receipt blocks
    const octokit = makeQualifyingOctokit()
    const reserve = vi.fn(async () => ({
      kind: 'blocked' as const,
      reason: 'already-reserved' as const,
      detail: 'existing receipt',
    }))
    const recordDelivered = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    const params = makeParams({
      octokit,
      receipt: {ops: {reserve, recordDelivered, release}, runId: 'run-9', runAttempt: 2},
    })

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then reconciled is false and no review was ever created
    expect(result.reconciled).toBe(false)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(recordDelivered).not.toHaveBeenCalled()
  })
})
