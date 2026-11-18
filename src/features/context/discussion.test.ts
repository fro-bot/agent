import type {Logger} from '../../shared/logger.js'
import type {ContextBudget} from './types.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {formatContextForPrompt} from './budget.js'
import {hydrateDiscussionContext} from './discussion.js'
import {createFailingMockOctokit, createMockLogger, createMockOctokit} from './test-helpers.js'
import {DEFAULT_CONTEXT_BUDGET} from './types.js'

function discussionResponse(body: string, commentCount: number, hasNextPage = false) {
  return {
    repository: {
      discussion: {
        id: 'D_node',
        title: 'How do I configure this?',
        body,
        author: {login: 'asker'},
        comments: {
          nodes: Array.from({length: commentCount}, (_, index) => ({
            id: `DC_${String(index + 1)}`,
            body: `comment ${String(index + 1)}`,
            author: {login: `user${String(index + 1)}`},
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          })),
          pageInfo: {hasNextPage, endCursor: null},
        },
      },
    },
  }
}

describe('hydrateDiscussionContext', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns the discussion body and its comments', async () => {
    // #given a discussion with a body and two comments
    const octokit = createMockOctokit(discussionResponse('The original question', 2))

    // #when hydrating
    const result = await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, DEFAULT_CONTEXT_BUDGET, logger)

    // #then the body and comments are carried, distinct from each other
    expect(result).toMatchObject({
      type: 'discussion',
      number: 9,
      title: 'How do I configure this?',
      body: 'The original question',
      bodyTruncated: false,
      author: 'asker',
      commentsTruncated: false,
      totalComments: 2,
    })
    expect(result?.comments.map(c => [c.author, c.body])).toEqual([
      ['user1', 'comment 1'],
      ['user2', 'comment 2'],
    ])
  })

  it('truncates a body over the budget and flags it', async () => {
    // #given a body larger than the body budget
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxBodyBytes: 64}
    const octokit = createMockOctokit(discussionResponse('x'.repeat(500), 0))

    // #when hydrating
    const result = await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, budget, logger)

    // #then the body fits the budget and carries the truncation flag
    expect(result?.bodyTruncated).toBe(true)
    expect(new TextEncoder().encode(result?.body ?? '').length).toBeLessThanOrEqual(64)
  })

  it('keeps only the most recent comments within the budget and reports the true total', async () => {
    // #given more comments than the budget allows
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxComments: 3}
    const octokit = createMockOctokit(discussionResponse('Question', 5))

    // #when hydrating
    const result = await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, budget, logger)

    // #then the last three are kept, flagged as truncated, with the full count
    expect(result?.comments.map(c => c.body)).toEqual(['comment 3', 'comment 4', 'comment 5'])
    expect(result?.commentsTruncated).toBe(true)
    expect(result?.totalComments).toBe(5)
  })

  it('returns null when the discussion is not found', async () => {
    // #given a repository with no such discussion
    const octokit = createMockOctokit({repository: {discussion: null}})

    // #when hydrating
    const result = await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, DEFAULT_CONTEXT_BUDGET, logger)

    // #then it degrades to null without throwing
    expect(result).toBeNull()
  })

  it('returns null and warns when the query fails', async () => {
    // #given a GraphQL failure
    const octokit = createFailingMockOctokit(new Error('Resource not accessible by integration'))

    // #when hydrating
    const result = await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, DEFAULT_CONTEXT_BUDGET, logger)

    // #then it degrades to null without throwing, and the failure is logged
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('formats the discussion with its body and comments', async () => {
    // #given a hydrated discussion
    const octokit = createMockOctokit(discussionResponse('The original question', 1))
    const result = await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, DEFAULT_CONTEXT_BUDGET, logger)

    // #when formatting it for a prompt
    const text = result == null ? '' : formatContextForPrompt(result)

    // #then it is labelled a discussion and carries the body and comment
    expect(text).toContain('## Discussion #9')
    expect(text).toContain('The original question')
    expect(text).toContain('**user1**')
  })
})
