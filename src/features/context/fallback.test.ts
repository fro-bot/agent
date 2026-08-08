import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
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
                id: 1001,
                node_id: 'comment-1',
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
              author_association: 'COLLABORATOR',
            },
          }),
          listCommits: vi.fn().mockResolvedValue({
            data: [{sha: 'abc123', commit: {message: 'Initial commit', author: {name: 'Dev'}}}],
          }),
          listFiles: vi.fn().mockResolvedValue({
            data: [{filename: 'src/test.ts', additions: 10, deletions: 5, status: 'modified'}],
          }),
          listReviews: vi.fn().mockResolvedValue({data: []}),
          listRequestedReviewers: vi.fn().mockResolvedValue({data: {users: [], teams: []}}),
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
              author_association: 'NONE',
            },
          }),
          listCommits: vi.fn().mockResolvedValue({data: []}),
          listFiles: vi.fn().mockResolvedValue({data: []}),
          listReviews: vi.fn().mockResolvedValue({data: []}),
          listRequestedReviewers: vi.fn().mockResolvedValue({data: {users: [], teams: []}}),
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

  it('returns PR context with empty reviewers when listRequestedReviewers fails', async () => {
    // #given — listRequestedReviewers rejects but all other calls succeed
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
              author_association: 'COLLABORATOR',
            },
          }),
          listCommits: vi.fn().mockResolvedValue({
            data: [{sha: 'abc123', commit: {message: 'Initial commit', author: {name: 'Dev'}}}],
          }),
          listFiles: vi.fn().mockResolvedValue({
            data: [{filename: 'src/test.ts', additions: 10, deletions: 5, status: 'modified'}],
          }),
          listReviews: vi.fn().mockResolvedValue({data: []}),
          listRequestedReviewers: vi.fn().mockRejectedValue(new Error('Resource not accessible by integration')),
        },
        issues: {
          listComments: vi.fn().mockResolvedValue({data: []}),
        },
      },
    } as unknown as Octokit

    // #when
    const result = await fallbackPullRequestContext(mockOctokit, 'owner', 'repo', 456, DEFAULT_CONTEXT_BUDGET, logger)

    // #then — PR context is returned with empty reviewer arrays, not null
    expect(result).not.toBeNull()
    expect(result?.type).toBe('pull_request')
    expect(result?.number).toBe(456)
    expect(result?.requestedReviewers).toEqual([])
    expect(result?.requestedReviewerTeams).toEqual([])
    expect(result?.commits).toHaveLength(1)
    expect(result?.files).toHaveLength(1)
  })

  it('keeps the newest REST comments, commits, and reviews while preserving file order', async () => {
    // #given
    const comments = Array.from({length: 10}, (_, index) => ({
      id: index + 1,
      node_id: `c${index + 1}`,
      body: `Comment ${index + 1}`,
      created_at: `2024-01-01T00:${String(index + 1).padStart(2, '0')}:00Z`,
      user: {login: `commenter${index + 1}`},
      author_association: 'NONE',
    }))
    const commits = Array.from({length: 10}, (_, index) => ({
      sha: `commit-${index + 1}`,
      commit: {
        message: `Commit ${index + 1}`,
        author: {name: `author${index + 1}`},
      },
    }))
    const reviews = Array.from({length: 10}, (_, index) => ({
      state: 'COMMENTED',
      body: `Review ${index + 1}`,
      submitted_at: `2024-01-01T01:${String(index + 1).padStart(2, '0')}:00Z`,
      user: {login: `reviewer${index + 1}`},
    }))
    const mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 1,
              title: 'Recent Evidence PR',
              body: 'Body',
              state: 'open',
              created_at: '2024-01-01T00:00:00Z',
              user: {login: 'user'},
              base: {ref: 'main', repo: {owner: {login: 'owner'}}},
              head: {ref: 'feature', repo: {owner: {login: 'owner'}}},
              labels: [],
              assignees: [],
              author_association: 'MEMBER',
            },
          }),
          listCommits: vi.fn().mockResolvedValue({data: commits}),
          listFiles: vi.fn().mockResolvedValue({
            data: [
              {filename: 'src/a.ts', additions: 1, deletions: 0, status: 'modified'},
              {filename: 'src/b.ts', additions: 2, deletions: 0, status: 'modified'},
              {filename: 'src/c.ts', additions: 3, deletions: 0, status: 'modified'},
            ],
          }),
          listReviews: vi.fn().mockResolvedValue({data: reviews}),
          listRequestedReviewers: vi.fn().mockResolvedValue({data: {users: [], teams: []}}),
        },
        issues: {
          listComments: vi.fn().mockResolvedValue({data: comments}),
        },
      },
    } as unknown as Octokit
    const budget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxComments: 3,
      maxCommits: 3,
      maxFiles: 2,
      maxReviews: 3,
    }

    // #when
    const result = await fallbackPullRequestContext(mockOctokit, 'owner', 'repo', 1, budget, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.comments.map(comment => comment.id)).toEqual(['c8', 'c9', 'c10'])
    expect(result?.commits.map(commit => commit.oid)).toEqual(['commit-8', 'commit-9', 'commit-10'])
    expect(result?.reviews.map(review => review.body)).toEqual(['Review 8', 'Review 9', 'Review 10'])
    expect(result?.files.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result?.commentsTruncated).toBe(true)
    expect(result?.commitsTruncated).toBe(true)
    expect(result?.reviewsTruncated).toBe(true)
    expect(result?.filesTruncated).toBe(true)
  })

  it('paginates REST collections before taking their newest tail', async () => {
    // #given
    const comments = Array.from({length: 103}, (_, index) => ({
      id: index + 1,
      node_id: `c${index + 1}`,
      body: `Comment ${index + 1}`,
      created_at: `2024-01-01T00:${String(index + 1).padStart(3, '0')}:00Z`,
      user: {login: `commenter${index + 1}`},
      author_association: 'NONE',
    }))
    const commits = Array.from({length: 103}, (_, index) => ({
      sha: `commit-${index + 1}`,
      commit: {
        message: `Commit ${index + 1}`,
        author: {name: `author${index + 1}`},
      },
    }))
    const reviews = Array.from({length: 103}, (_, index) => ({
      state: 'COMMENTED',
      body: `Review ${index + 1}`,
      submitted_at: `2024-01-01T01:${String(index + 1).padStart(3, '0')}:00Z`,
      user: {login: `reviewer${index + 1}`},
    }))
    const page = <T>(items: readonly T[], pageNumber: number): readonly T[] =>
      items.slice((pageNumber - 1) * 100, pageNumber * 100)
    const mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 1,
              title: 'Paginated Evidence PR',
              body: 'Body',
              state: 'open',
              created_at: '2024-01-01T00:00:00Z',
              user: {login: 'user'},
              base: {ref: 'main', repo: {owner: {login: 'owner'}}},
              head: {ref: 'feature', repo: {owner: {login: 'owner'}}},
              labels: [],
              assignees: [],
              author_association: 'MEMBER',
            },
          }),
          listCommits: vi.fn().mockImplementation(async ({page: pageNumber = 1}: {readonly page?: number}) => ({
            data: page(commits, pageNumber),
          })),
          listFiles: vi.fn().mockResolvedValue({
            data: [{filename: 'src/a.ts', additions: 1, deletions: 0, status: 'modified'}],
          }),
          listReviews: vi.fn().mockImplementation(async ({page: pageNumber = 1}: {readonly page?: number}) => ({
            data: page(reviews, pageNumber),
          })),
          listRequestedReviewers: vi.fn().mockResolvedValue({data: {users: [], teams: []}}),
        },
        issues: {
          listComments: vi.fn().mockImplementation(async ({page: pageNumber = 1}: {readonly page?: number}) => ({
            data: page(comments, pageNumber),
          })),
        },
      },
    } as unknown as Octokit
    const budget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxComments: 3,
      maxCommits: 3,
      maxReviews: 3,
    }

    // #when
    const result = await fallbackPullRequestContext(mockOctokit, 'owner', 'repo', 1, budget, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.comments.map(comment => comment.id)).toEqual(['c101', 'c102', 'c103'])
    expect(result?.commits.map(commit => commit.oid)).toEqual(['commit-101', 'commit-102', 'commit-103'])
    expect(result?.reviews.map(review => review.body)).toEqual(['Review 101', 'Review 102', 'Review 103'])
    expect(result?.totalComments).toBe(103)
    expect(result?.totalCommits).toBe(103)
    expect(result?.totalReviews).toBe(103)
  })
})
