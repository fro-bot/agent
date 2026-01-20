import type {Logger} from '../logger.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {executeIssueQuery, executePullRequestQuery, ISSUE_QUERY, PULL_REQUEST_QUERY} from './graphql.js'
import {createFailingMockOctokit, createMockLogger, createMockOctokit} from './test-helpers.js'

describe('ISSUE_QUERY', () => {
  it('is a valid GraphQL query string', () => {
    // #then
    expect(ISSUE_QUERY).toContain('query')
    expect(ISSUE_QUERY).toContain('repository')
    expect(ISSUE_QUERY).toContain('issue')
    expect(ISSUE_QUERY).toContain('comments')
    expect(ISSUE_QUERY).toContain('labels')
    expect(ISSUE_QUERY).toContain('assignees')
  })
})

describe('PULL_REQUEST_QUERY', () => {
  it('is a valid GraphQL query string', () => {
    // #then
    expect(PULL_REQUEST_QUERY).toContain('query')
    expect(PULL_REQUEST_QUERY).toContain('repository')
    expect(PULL_REQUEST_QUERY).toContain('pullRequest')
    expect(PULL_REQUEST_QUERY).toContain('commits')
    expect(PULL_REQUEST_QUERY).toContain('files')
    expect(PULL_REQUEST_QUERY).toContain('reviews')
    expect(PULL_REQUEST_QUERY).toContain('baseRepository')
    expect(PULL_REQUEST_QUERY).toContain('headRepository')
  })
})

describe('executeIssueQuery', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns issue data on success', async () => {
    // #given
    const mockResponse = {
      repository: {
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'testuser'},
          labels: {nodes: [{name: 'bug', color: 'ff0000'}]},
          assignees: {nodes: [{login: 'dev'}]},
          comments: {
            totalCount: 1,
            nodes: [
              {
                body: 'Comment',
                createdAt: '2024-01-01T01:00:00Z',
                author: {login: 'commenter'},
                authorAssociation: 'MEMBER',
              },
            ],
          },
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await executeIssueQuery(octokit, 'owner', 'repo', 123, 50, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.repository.issue?.number).toBe(123)
    expect(result?.repository.issue?.title).toBe('Test Issue')
  })

  it('returns null on GraphQL error', async () => {
    // #given
    const octokit = createFailingMockOctokit(new Error('GraphQL failed'))

    // #when
    const result = await executeIssueQuery(octokit, 'owner', 'repo', 123, 50, logger)

    // #then
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('returns null when issue not found', async () => {
    // #given
    const mockResponse = {
      repository: {
        issue: null,
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await executeIssueQuery(octokit, 'owner', 'repo', 999, 50, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.repository.issue).toBeNull()
  })
})

describe('executePullRequestQuery', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns pull request data on success', async () => {
    // #given
    const mockResponse = {
      repository: {
        pullRequest: {
          number: 456,
          title: 'Test PR',
          body: 'PR body',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'prauthor'},
          baseRefName: 'main',
          headRefName: 'feature',
          baseRepository: {owner: {login: 'owner'}},
          headRepository: {owner: {login: 'owner'}},
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: 0, nodes: []},
          commits: {totalCount: 1, nodes: [{commit: {oid: 'abc123', message: 'Initial', author: {name: 'Dev'}}}]},
          files: {totalCount: 1, nodes: [{path: 'src/test.ts', additions: 10, deletions: 5}]},
          reviews: {totalCount: 0, nodes: []},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await executePullRequestQuery(octokit, 'owner', 'repo', 456, 50, 100, 100, 100, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.repository.pullRequest?.number).toBe(456)
    expect(result?.repository.pullRequest?.title).toBe('Test PR')
  })

  it('returns null on GraphQL error', async () => {
    // #given
    const octokit = createFailingMockOctokit(new Error('GraphQL failed'))

    // #when
    const result = await executePullRequestQuery(octokit, 'owner', 'repo', 456, 50, 100, 100, 100, logger)

    // #then
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('detects fork PR from different repository owners', async () => {
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
          baseRepository: {owner: {login: 'upstream-owner'}},
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
    const result = await executePullRequestQuery(octokit, 'upstream-owner', 'repo', 789, 50, 100, 100, 100, logger)

    // #then
    expect(result).not.toBeNull()
    const pr = result?.repository.pullRequest
    expect(pr?.baseRepository?.owner.login).toBe('upstream-owner')
    expect(pr?.headRepository?.owner.login).toBe('fork-owner')
  })
})
