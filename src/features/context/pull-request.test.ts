import type {Logger} from '../../shared/logger.js'
import type {ContextBudget} from './types.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {hydratePullRequestContext} from './pull-request.js'
import {createFailingMockOctokit, createMockLogger, createMockOctokit} from './test-helpers.js'
import {DEFAULT_CONTEXT_BUDGET} from './types.js'

describe('hydratePullRequestContext', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns hydrated PR context on success', async () => {
    // #given
    const mockResponse = {
      repository: {
        pullRequest: {
          number: 456,
          title: 'Add new feature',
          body: 'PR body text',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'contributor'},
          baseRefName: 'main',
          headRefName: 'feature-branch',
          baseRepository: {owner: {login: 'owner'}},
          headRepository: {owner: {login: 'owner'}},
          labels: {nodes: [{name: 'enhancement', color: '00ff00'}]},
          assignees: {nodes: [{login: 'reviewer'}]},
          comments: {
            totalCount: 1,
            nodes: [
              {
                id: 'comment-1',
                body: 'Comment',
                createdAt: '2024-01-01T01:00:00Z',
                author: {login: 'user'},
                authorAssociation: 'MEMBER',
                isMinimized: false,
              },
            ],
          },
          commits: {
            totalCount: 2,
            nodes: [
              {commit: {oid: 'abc1234', message: 'Initial commit', author: {name: 'Dev'}}},
              {commit: {oid: 'def5678', message: 'Fix typo', author: {name: 'Dev'}}},
            ],
          },
          files: {
            totalCount: 3,
            nodes: [
              {path: 'src/main.ts', additions: 10, deletions: 5},
              {path: 'src/test.ts', additions: 20, deletions: 0},
            ],
          },
          reviews: {
            totalCount: 1,
            nodes: [
              {
                state: 'APPROVED',
                body: 'LGTM!',
                createdAt: '2024-01-01T02:00:00Z',
                author: {login: 'reviewer'},
                comments: {nodes: []},
              },
            ],
          },
          authorAssociation: 'MEMBER',
          reviewRequests: {
            nodes: [
              {requestedReviewer: {login: 'reviewer1'}},
              {requestedReviewer: {login: 'reviewer2'}},
              {requestedReviewer: {name: 'team-a'}},
            ],
          },
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await hydratePullRequestContext(octokit, 'owner', 'repo', 456, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.type).toBe('pull_request')
    expect(result?.number).toBe(456)
    expect(result?.title).toBe('Add new feature')
    expect(result?.baseBranch).toBe('main')
    expect(result?.headBranch).toBe('feature-branch')
    expect(result?.isFork).toBe(false)
    expect(result?.comments).toHaveLength(1)
    expect(result?.comments[0]?.id).toBe('comment-1')
    expect(result?.comments[0]?.isMinimized).toBe(false)
    expect(result?.commits).toHaveLength(2)
    expect(result?.files).toHaveLength(2)
    expect(result?.reviews).toHaveLength(1)
    expect(result?.authorAssociation).toBe('MEMBER')
    expect(result?.requestedReviewers).toEqual(['reviewer1', 'reviewer2'])
    expect(result?.requestedReviewerTeams).toEqual(['team-a'])
  })

  it('detects fork PR correctly', async () => {
    // #given
    const mockResponse = {
      repository: {
        pullRequest: {
          number: 789,
          title: 'Fork PR',
          body: 'From fork',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'external'},
          baseRefName: 'main',
          headRefName: 'patch-1',
          baseRepository: {owner: {login: 'upstream'}},
          headRepository: {owner: {login: 'fork-owner'}},
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: 0, nodes: []},
          commits: {totalCount: 0, nodes: []},
          files: {totalCount: 0, nodes: []},
          reviews: {totalCount: 0, nodes: []},
          authorAssociation: 'NONE',
          reviewRequests: {nodes: []},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await hydratePullRequestContext(octokit, 'upstream', 'repo', 789, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.isFork).toBe(true)
  })

  it('returns null when PR not found', async () => {
    // #given
    const mockResponse = {
      repository: {
        pullRequest: null,
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await hydratePullRequestContext(octokit, 'owner', 'repo', 999, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).toBeNull()
  })

  it('returns null on GraphQL error', async () => {
    // #given
    const octokit = createFailingMockOctokit(new Error('GraphQL failed'))

    // #when
    const result = await hydratePullRequestContext(octokit, 'owner', 'repo', 456, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('marks files as truncated when exceeding maxFiles', async () => {
    // #given
    const manyFiles = Array.from({length: 200}, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: 10,
      deletions: 5,
    }))
    const mockResponse = {
      repository: {
        pullRequest: {
          number: 1,
          title: 'Large PR',
          body: 'Many files',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'user'},
          baseRefName: 'main',
          headRefName: 'feature',
          baseRepository: {owner: {login: 'owner'}},
          headRepository: {owner: {login: 'owner'}},
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: 0, nodes: []},
          commits: {totalCount: 0, nodes: []},
          files: {totalCount: 500, nodes: manyFiles},
          reviews: {totalCount: 0, nodes: []},
          authorAssociation: 'CONTRIBUTOR',
          reviewRequests: {nodes: []},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxFiles: 50}

    // #when
    const result = await hydratePullRequestContext(octokit, 'owner', 'repo', 1, budget, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.files.length).toBeLessThanOrEqual(50)
    expect(result?.filesTruncated).toBe(true)
    expect(result?.totalFiles).toBe(500)
  })

  it('keeps newest comments, commits, and reviews while leaving files path-ordered', async () => {
    // #given
    const comments = Array.from({length: 10}, (_, index) => ({
      id: `c${index + 1}`,
      body: `Comment ${index + 1}`,
      createdAt: `2024-01-01T00:${String(index + 1).padStart(2, '0')}:00Z`,
      author: {login: `commenter${index + 1}`},
      authorAssociation: 'NONE',
      isMinimized: false,
    }))
    const commits = Array.from({length: 10}, (_, index) => ({
      commit: {
        oid: `commit-${index + 1}`,
        message: `Commit ${index + 1}`,
        author: {name: `author${index + 1}`},
      },
    }))
    const reviews = Array.from({length: 10}, (_, index) => ({
      state: 'COMMENTED',
      body: `Review ${index + 1}`,
      createdAt: `2024-01-01T01:${String(index + 1).padStart(2, '0')}:00Z`,
      author: {login: `reviewer${index + 1}`},
      comments: {nodes: []},
    }))
    const mockResponse = {
      repository: {
        pullRequest: {
          number: 1,
          title: 'Recent Evidence PR',
          body: 'Body',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'user'},
          baseRefName: 'main',
          headRefName: 'feature',
          baseRepository: {owner: {login: 'owner'}},
          headRepository: {owner: {login: 'owner'}},
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: comments.length, nodes: comments},
          commits: {totalCount: commits.length, nodes: commits},
          files: {
            totalCount: 3,
            nodes: [
              {path: 'src/a.ts', additions: 1, deletions: 0},
              {path: 'src/b.ts', additions: 2, deletions: 0},
              {path: 'src/c.ts', additions: 3, deletions: 0},
            ],
          },
          reviews: {totalCount: reviews.length, nodes: reviews},
          authorAssociation: 'MEMBER',
          reviewRequests: {nodes: []},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)
    const budget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxComments: 3,
      maxCommits: 3,
      maxFiles: 2,
      maxReviews: 3,
    }

    // #when
    const result = await hydratePullRequestContext(octokit, 'owner', 'repo', 1, budget, logger)

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

  it('handles null headRepository for deleted fork', async () => {
    // #given
    const mockResponse = {
      repository: {
        pullRequest: {
          number: 1,
          title: 'Deleted Fork PR',
          body: 'Fork was deleted',
          state: 'CLOSED',
          createdAt: '2024-01-01T00:00:00Z',
          author: null,
          baseRefName: 'main',
          headRefName: 'patch-1',
          baseRepository: {owner: {login: 'owner'}},
          headRepository: null,
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: 0, nodes: []},
          commits: {totalCount: 0, nodes: []},
          files: {totalCount: 0, nodes: []},
          reviews: {totalCount: 0, nodes: []},
          authorAssociation: 'NONE',
          reviewRequests: {nodes: []},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await hydratePullRequestContext(octokit, 'owner', 'repo', 1, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.isFork).toBe(true)
    expect(result?.author).toBeNull()
  })
})
