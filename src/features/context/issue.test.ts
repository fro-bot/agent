import type {Logger} from '../../shared/logger.js'
import type {ContextBudget} from './types.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {formatContextForPrompt} from './budget.js'
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
                id: 'comment-1',
                body: 'First comment',
                createdAt: '2024-01-01T01:00:00Z',
                author: {login: 'commenter1'},
                authorAssociation: 'MEMBER',
                isMinimized: false,
              },
              {
                id: 'comment-2',
                body: 'Second comment',
                createdAt: '2024-01-01T02:00:00Z',
                author: {login: 'commenter2'},
                authorAssociation: 'CONTRIBUTOR',
                isMinimized: true,
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
    expect(result?.comments[0]?.id).toBe('comment-1')
    expect(result?.comments[0]?.isMinimized).toBe(false)
    expect(result?.comments[1]?.id).toBe('comment-2')
    expect(result?.comments[1]?.isMinimized).toBe(true)
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
            nodes: [
              {
                id: 'comment-3',
                body: 'Comment',
                createdAt: '2024-01-01T01:00:00Z',
                author: null,
                authorAssociation: 'NONE',
                isMinimized: false,
              },
            ],
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
      id: `comment-${i}`,
      body: `Comment ${i}`,
      createdAt: '2024-01-01T00:00:00Z',
      author: {login: `user${i}`},
      authorAssociation: 'NONE',
      isMinimized: false,
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

  it('keeps the newest comments in chronological order when the thread exceeds the cap', async () => {
    // #given
    const comments = Array.from({length: 10}, (_, index) => ({
      id: `c${index + 1}`,
      body: `Comment ${index + 1}`,
      createdAt: `2024-01-01T00:${String(index + 1).padStart(2, '0')}:00Z`,
      author: {login: `user${index + 1}`},
      authorAssociation: 'NONE',
      isMinimized: false,
    }))
    const mockResponse = {
      repository: {
        issue: {
          number: 1,
          title: 'Recent Comments Issue',
          body: 'Body',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'user'},
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: comments.length, nodes: comments},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxComments: 3}

    // #when
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 1, budget, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.comments.map(comment => comment.id)).toEqual(['c8', 'c9', 'c10'])
    expect(result?.comments.map(comment => comment.createdAt)).toEqual([
      '2024-01-01T00:08:00Z',
      '2024-01-01T00:09:00Z',
      '2024-01-01T00:10:00Z',
    ])
    expect(result?.commentsTruncated).toBe(true)
    expect(result?.totalComments).toBe(10)
  })

  it('keeps a thread shorter than the cap unchanged', async () => {
    // #given
    const comments = [
      {
        id: 'c1',
        body: 'Comment 1',
        createdAt: '2024-01-01T00:01:00Z',
        author: {login: 'user1'},
        authorAssociation: 'NONE',
        isMinimized: false,
      },
      {
        id: 'c2',
        body: 'Comment 2',
        createdAt: '2024-01-01T00:02:00Z',
        author: {login: 'user2'},
        authorAssociation: 'NONE',
        isMinimized: false,
      },
    ]
    const mockResponse = {
      repository: {
        issue: {
          number: 1,
          title: 'Short Comments Issue',
          body: 'Body',
          state: 'OPEN',
          createdAt: '2024-01-01T00:00:00Z',
          author: {login: 'user'},
          labels: {nodes: []},
          assignees: {nodes: []},
          comments: {totalCount: comments.length, nodes: comments},
        },
      },
    }
    const octokit = createMockOctokit(mockResponse)
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxComments: 3}

    // #when
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 1, budget, logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.comments.map(comment => comment.id)).toEqual(['c1', 'c2'])
    expect(result?.commentsTruncated).toBe(false)
    expect(result?.totalComments).toBe(2)
  })

  it('does not report truncation for an empty comment set', async () => {
    // #given
    const mockResponse = {
      repository: {
        issue: {
          number: 1,
          title: 'Empty Comments Issue',
          body: 'Body',
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

    // #when
    const result = await hydrateIssueContext(octokit, 'owner', 'repo', 1, DEFAULT_CONTEXT_BUDGET, logger)

    // #then
    expect(result).not.toBeNull()
    if (result == null) throw new Error('Expected issue context')
    expect(result.comments).toEqual([])
    expect(result.commentsTruncated).toBe(false)
    expect(formatContextForPrompt(result)).not.toContain('Comments were truncated')
  })
})
