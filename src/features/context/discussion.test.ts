import type {Logger} from '../../shared/logger.js'
import type {ContextBudget} from './types.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {formatContextForPrompt} from './budget.js'
import {hydrateDiscussionContext} from './discussion.js'
import {createFailingMockOctokit, createMockLogger, createMockOctokit} from './test-helpers.js'
import {DEFAULT_CONTEXT_BUDGET} from './types.js'

function discussionResponse(body: string, returned: number, totalCount = returned) {
  return {
    repository: {
      discussion: {
        number: 9,
        title: 'How do I configure this?',
        body,
        author: {login: 'asker'},
        comments: {
          totalCount,
          nodes: Array.from({length: returned}, (_, index) => ({
            id: `DC_${String(index + 1)}`,
            body: `comment ${String(index + 1)}`,
            author: {login: `user${String(index + 1)}`},
            createdAt: '2024-01-01T00:00:00Z',
          })),
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

  it('asks for the budgeted number of newest comments in one request', async () => {
    // #given a budget of three comments
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxComments: 3}
    const octokit = createMockOctokit(discussionResponse('Question', 3, 3))

    // #when hydrating
    await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, budget, logger)

    // #then one query asked for the last three comments
    expect(octokit.graphql).toHaveBeenCalledTimes(1)
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('comments(last: $maxComments)'),
      expect.objectContaining({owner: 'owner', repo: 'repo', number: 9, maxComments: 3}),
    )
  })

  it('takes the total and the truncated flag from totalCount', async () => {
    // #given the server returned the last three of seven comments
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxComments: 3}
    const octokit = createMockOctokit(discussionResponse('Question', 3, 7))

    // #when hydrating
    const result = await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, budget, logger)

    // #then the total is the server's count and the comments are flagged as truncated
    expect(result?.totalComments).toBe(7)
    expect(result?.commentsTruncated).toBe(true)
    expect(result?.comments).toHaveLength(3)
  })

  it('does not flag truncation when every comment was returned', async () => {
    // #given a discussion whose comments all fit
    const octokit = createMockOctokit(discussionResponse('Question', 2, 2))

    // #when hydrating
    const result = await hydrateDiscussionContext(octokit, 'owner', 'repo', 9, DEFAULT_CONTEXT_BUDGET, logger)

    // #then nothing is flagged
    expect(result?.commentsTruncated).toBe(false)
    expect(result?.totalComments).toBe(2)
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
