import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {fallbackIssueContext, fallbackPullRequestContext} from './fallback.js'
import {createMockLogger} from './test-helpers.js'
import {DEFAULT_CONTEXT_BUDGET} from './types.js'

describe('fallbackIssueContext', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns issue context from REST API on success', async () => {
    // #given
    const mockOctokit = {
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 123,
              title: 'Test Issue',
              body: 'Issue body',
              state: 'open',
              created_at: '2024-01-01T00:00:00Z',
              user: {login: 'testuser'},
              labels: [{name: 'bug'}],
              assignees: [{login: 'dev'}],
            },
          }),
          listComments: vi.fn().mockResolvedValue({
            data: [
              {
                body: 'Comment 1',
                created_at: '2024-01-01T01:00:00Z',
                user: {login: 'user1'},
                author_association: 'MEMBER',
              },
            ],
          }),
        },
      },
    } as unknown as Octokit

    // #when
    const result = await fallbackIssueContext(mockOctokit, 'owner', 'repo', 123, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.type).toBe('issue')
    expect(result?.number).toBe(123)
    expect(result?.title).toBe('Test Issue')
    expect(result?.comments).toHaveLength(1)
  })

  it('returns null on REST API error', async () => {
    // #given
    const mockOctokit = {
      rest: {
        issues: {
          get: vi.fn().mockRejectedValue(new Error('REST failed')),
          listComments: vi.fn(),
        },
      },
    } as unknown as Octokit

    // #when
    const result = await fallbackIssueContext(mockOctokit, 'owner', 'repo', 123, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('handles null user gracefully', async () => {
    // #given
    const mockOctokit = {
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 1,
              title: 'Ghost Issue',
              body: null,
              state: 'open',
              created_at: '2024-01-01T00:00:00Z',
              user: null,
              labels: [],
              assignees: [],
            },
          }),
          listComments: vi.fn().mockResolvedValue({data: []}),
        },
      },
    } as unknown as Octokit

    // #when
    const result = await fallbackIssueContext(mockOctokit, 'owner', 'repo', 1, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.author).toBeNull()
  })
})

describe('fallbackPullRequestContext', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns PR context from REST API on success', async () => {
    // #given
    const mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 456,
              title: 'Test PR',
              body: 'PR body',
              state: 'open',
              created_at: '2024-01-01T00:00:00Z',
              user: {login: 'contributor'},
              base: {ref: 'main', repo: {owner: {login: 'owner'}}},
              head: {ref: 'feature', repo: {owner: {login: 'owner'}}},
              labels: [],
              assignees: [],
            },
          }),
          listCommits: vi.fn().mockResolvedValue({
            data: [{sha: 'abc123', commit: {message: 'Initial commit', author: {name: 'Dev'}}}],
          }),
          listFiles: vi.fn().mockResolvedValue({
            data: [{filename: 'src/test.ts', additions: 10, deletions: 5, status: 'modified'}],
          }),
          listReviews: vi.fn().mockResolvedValue({data: []}),
        },
        issues: {
          listComments: vi.fn().mockResolvedValue({data: []}),
        },
      },
    } as unknown as Octokit

    // #when
    const result = await fallbackPullRequestContext(mockOctokit, 'owner', 'repo', 456, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.type).toBe('pull_request')
    expect(result?.number).toBe(456)
    expect(result?.baseBranch).toBe('main')
    expect(result?.headBranch).toBe('feature')
    expect(result?.isFork).toBe(false)
    expect(result?.commits).toHaveLength(1)
    expect(result?.files).toHaveLength(1)
  })

  it('detects fork PR correctly', async () => {
    // #given
    const mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 789,
              title: 'Fork PR',
              body: 'From fork',
              state: 'open',
              created_at: '2024-01-01T00:00:00Z',
              user: {login: 'external'},
              base: {ref: 'main', repo: {owner: {login: 'upstream'}}},
              head: {ref: 'patch-1', repo: {owner: {login: 'fork-owner'}}},
              labels: [],
              assignees: [],
            },
          }),
          listCommits: vi.fn().mockResolvedValue({data: []}),
          listFiles: vi.fn().mockResolvedValue({data: []}),
          listReviews: vi.fn().mockResolvedValue({data: []}),
        },
        issues: {
          listComments: vi.fn().mockResolvedValue({data: []}),
        },
      },
    } as unknown as Octokit

    // #when
    const result = await fallbackPullRequestContext(
      mockOctokit,
      'upstream',
      'repo',
      789,
      DEFAULT_CONTEXT_BUDGET,
      logger,
    )

    // #then
    expect(result).not.toBeNull()
    expect(result?.isFork).toBe(true)
  })

  it('returns null on REST API error', async () => {
    // #given
    const mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockRejectedValue(new Error('REST failed')),
        },
      },
    } as unknown as Octokit

    // #when
    const result = await fallbackPullRequestContext(mockOctokit, 'owner', 'repo', 456, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalled()
  })
})
