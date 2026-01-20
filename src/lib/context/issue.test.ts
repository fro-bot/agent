import type {Logger} from '../logger.js'
import type {ContextBudget} from './types.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {hydrateIssueContext} from './issue.js'
import {createFailingMockOctokit, createMockLogger, createMockOctokit} from './test-helpers.js'
import {DEFAULT_CONTEXT_BUDGET} from './types.js'

describe('hydrateIssueContext', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns hydrated issue context on success', async () => {
    // #given
    const mockResponse = {
      repository: {
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body text',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'testuser'},
          labels: {nodes: [{name: 'bug', color: 'ff0000'}]},
          assignees: {nodes: [{login: 'developer'}]},
          comments: {
            totalCount: 2,
            nodes: [
              {
                body: 'First comment',
                createdAt: '2024-01-01T01:00:00Z',
                author: {login: 'commenter1'},
                authorAssociation: 'MEMBER',
              },
              {
                body: 'Second comment',
                createdAt: '2024-01-01T02:00:00Z',
                author: {login: 'commenter2'},
                authorAssociation: 'CONTRIBUTOR',
              },
            ],
          },
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 123, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.type).toBe('issue')
    expect(result?.number).toBe(123)
    expect(result?.title).toBe('Test Issue')
    expect(result?.body).toBe('Issue body text')
    expect(result?.author).toBe('testuser')
    expect(result?.labels).toHaveLength(1)
    expect(result?.labels?.[0]?.name).toBe('bug')
    expect(result?.assignees).toHaveLength(1)
    expect(result?.comments).toHaveLength(2)
    expect(result?.bodyTruncated).toBe(false)
    expect(result?.commentsTruncated).toBe(false)
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
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 999, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).toBeNull()
  })

  it('returns null on GraphQL error', async () => {
    // #given
    const octokit = createFailingMockOctokit(new Error('GraphQL failed'))

    // #when
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 123, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('truncates body when exceeding maxBodyBytes', async () => {
    // #given
    const largeBody = 'x'.repeat(20 * 1024)
    const mockResponse = {
      repository: {
        issue: {
          number: 1,
          title: 'Large Body Issue',
          body: largeBody,
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'user'},
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: 0, nodes: []},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxBodyBytes: 1024}

    // #when
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 1, budget, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.bodyTruncated).toBe(true)
    expect(result?.body.length).toBeLessThan(largeBody.length)
    expect(result?.body).toContain('truncated')
  })

  it('handles null author gracefully', async () => {
    // #given
    const mockResponse = {
      repository: {
        issue: {
          number: 1,
          title: 'Deleted User Issue',
          body: 'Body',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: null,
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {
            totalCount: 1,
            nodes: [{body: 'Comment', createdAt: '2024-01-01T01:00:00Z', author: null, authorAssociation: 'NONE'}],
          },
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)

    // #when
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 1, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.author).toBeNull()
    expect(result?.comments?.[0]?.author).toBeNull()
  })

  it('marks comments as truncated when exceeding maxComments', async () => {
    // #given
    const manyComments = Array.from({length: 100}, (_, i) => ({
      body: `Comment ${i}`,
      createdAt: '2024-01-01T00:00:00Z',
      author: {login: `user${i}`},
      authorAssociation: 'NONE',
    }))
    const mockResponse = {
      repository: {
        issue: {
          number: 1,
          title: 'Many Comments Issue',
          body: 'Body',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'user'},
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: 500, nodes: manyComments},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxComments: 10}

    // #when
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 1, budget, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.comments.length).toBeLessThanOrEqual(10)
    expect(result?.commentsTruncated).toBe(true)
    expect(result?.totalComments).toBe(500)
  })
})
