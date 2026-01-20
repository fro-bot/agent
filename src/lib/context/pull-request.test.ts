import type {Logger} from '../logger.js'
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
                body: 'Comment',
                createdAt: '2024-01-01T01:00:00Z',
                author: {login: 'user'},
                authorAssociation: 'MEMBER',
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
    expect(result?.commits).toHaveLength(2)
    expect(result?.files).toHaveLength(2)
    expect(result?.reviews).toHaveLength(1)
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
