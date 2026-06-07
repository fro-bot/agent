/**
 * Tests for runReviewReconciliation phase
 *
 * TDD: these tests are written BEFORE the implementation.
 * They should fail (RED) until review-reconciliation.ts is created.
 */

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
  readonly listComments?: () => Promise<unknown>
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
  const defaultComments = {data: []}
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
        listComments: vi.fn().mockResolvedValue(overrides?.listComments?.() ?? defaultComments),
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
  }
}

// ---------------------------------------------------------------------------
// Helper: build a bot review object
// ---------------------------------------------------------------------------

function makeBotReview(opts: {
  readonly state: string
  readonly body: string
  readonly commitId: string
  readonly submittedAt: string
  readonly login?: string
}) {
  return {
    id: 1,
    user: {login: opts.login ?? 'fro-bot[bot]'},
    state: opts.state,
    body: opts.body,
    commit_id: opts.commitId,
    submitted_at: opts.submittedAt,
    html_url: 'https://github.com/pr/1/reviews/1',
  }
}

// ---------------------------------------------------------------------------
// Helper: build an issue comment object
// ---------------------------------------------------------------------------

function makeBotComment(opts: {readonly body: string; readonly createdAt: string; readonly login?: string}) {
  return {
    id: 10,
    user: {login: opts.login ?? 'fro-bot[bot]'},
    body: opts.body,
    created_at: opts.createdAt,
    html_url: 'https://github.com/pr/1#issuecomment-10',
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
  // Happy path: issue-comment fallback (gh pr comment path)
  // -------------------------------------------------------------------------

  it('approves via issue-comment fallback when bot used gh pr comment with PASS', async () => {
    // #given no bot reviews, but bot left an issue comment with PASS verdict
    const octokit = makeOctokit()
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        head: {sha: HEAD_SHA, repo: {full_name: 'owner/repo'}},
        base: {repo: {full_name: 'owner/repo'}},
        user: {login: 'pr-author'},
      },
    })
    octokit.rest.pulls.listReviews.mockResolvedValue({data: []})
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        makeBotComment({
          body: '## Verdict: PASS\n\nAll checks pass.',
          createdAt: AFTER_START,
        }),
      ],
    })
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then approve is submitted via the issue-comment fallback path
    expect(result.reconciled).toBe(true)
    expect(result.reason).toBe('approved')
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({event: 'APPROVE'}))
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
    octokit.rest.issues.listComments.mockResolvedValue({data: []})
    const params = makeParams({octokit})

    // #when running review reconciliation
    const result = await runReviewReconciliation(params, logger)

    // #then no review is submitted — stale artifact
    expect(result.reconciled).toBe(false)
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
  // Early no-op guards — zero octokit calls
  // -------------------------------------------------------------------------

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
  // Bot login normalization: fro-bot[bot] matches fro-bot[bot] reviews
  // -------------------------------------------------------------------------

  it('matches bot reviews using normalized login (strips [bot] suffix)', async () => {
    // #given bot login is 'fro-bot[bot]' and review user.login is also 'fro-bot[bot]'
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
        }),
        // A non-bot review that should be ignored
        {
          id: 2,
          user: {login: 'human-reviewer'},
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
