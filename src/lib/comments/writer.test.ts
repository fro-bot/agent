import type {CommentTarget, Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {BOT_COMMENT_MARKER} from '../github/types.js'
import {createMockLogger, createMockOctokit} from '../test-helpers.js'
import {isBotComment, postComment} from './writer.js'

describe('comments/writer', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  describe('isBotComment', () => {
    it('returns true when body contains bot marker', () => {
      // #given a body with the bot marker
      const body = `Some response\n${BOT_COMMENT_MARKER}`

      // #when checking if it's a bot comment
      const result = isBotComment(body)

      // #then it should return true
      expect(result).toBe(true)
    })

    it('returns false when body lacks marker', () => {
      // #given a body without the marker
      const body = 'Just a regular comment'

      // #when checking if it's a bot comment
      const result = isBotComment(body)

      // #then it should return false
      expect(result).toBe(false)
    })
  })

  describe('postComment', () => {
    it('creates new comment for issue', async () => {
      // #given an issue target and client
      const client = createMockOctokit()
      const target: CommentTarget = {type: 'issue', number: 123, owner: 'owner', repo: 'repo'}

      // #when posting a comment
      const result = await postComment(client, target, {body: 'Test comment'}, logger)

      // #then it should create the comment
      expect(result).not.toBeNull()
      expect(result?.created).toBe(true)
      expect(result?.updated).toBe(false)
      expect(result?.commentId).toBe(999)
    })

    it('creates new comment for PR', async () => {
      // #given a PR target
      const client = createMockOctokit()
      const target: CommentTarget = {type: 'pr', number: 456, owner: 'owner', repo: 'repo'}

      // #when posting a comment
      const result = await postComment(client, target, {body: 'PR comment'}, logger)

      // #then it should create the comment (PRs use issues API)
      expect(result?.created).toBe(true)
      expect(client.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 456,
        body: 'PR comment',
      })
    })

    it('updates existing bot comment when updateExisting is true', async () => {
      // #given an existing bot comment
      const client = createMockOctokit({
        listComments: [
          {
            id: 123,
            body: `Old response\n${BOT_COMMENT_MARKER}`,
            user: {login: 'fro-bot[bot]'},
            author_association: 'NONE',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
        getIssue: {number: 1, title: 'Test', body: 'Body', user: {login: 'user'}},
      })
      const target: CommentTarget = {type: 'issue', number: 1, owner: 'owner', repo: 'repo'}

      // #when posting with updateExisting
      const result = await postComment(
        client,
        target,
        {body: 'Updated response', updateExisting: true, botLogin: 'fro-bot'},
        logger,
      )

      // #then it should update the existing comment
      expect(result?.updated).toBe(true)
      expect(result?.created).toBe(false)
      expect(result?.commentId).toBe(123)
    })

    it('creates new comment when no existing bot comment found', async () => {
      // #given no existing bot comments
      const client = createMockOctokit({
        listComments: [
          {
            id: 456,
            body: 'User comment',
            user: {login: 'user1'},
            author_association: 'MEMBER',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
        getIssue: {number: 1, title: 'Test', body: 'Body', user: {login: 'user'}},
      })
      const target: CommentTarget = {type: 'issue', number: 1, owner: 'owner', repo: 'repo'}

      // #when posting with updateExisting but no bot comment exists
      const result = await postComment(
        client,
        target,
        {body: 'New response', updateExisting: true, botLogin: 'fro-bot'},
        logger,
      )

      // #then it should create a new comment
      expect(result?.created).toBe(true)
      expect(result?.updated).toBe(false)
    })

    it('posts discussion comment via GraphQL', async () => {
      // #given a discussion target
      const client = createMockOctokit({
        graphql: {
          repository: {
            discussion: {
              id: 'D_kwDO123',
              title: 'Test',
              body: 'Body',
              author: {login: 'user'},
              comments: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}},
            },
          },
          addDiscussionComment: {
            comment: {id: 'DC_new', url: 'https://github.com/o/r/discussions/42#c-new'},
          },
        },
      })
      const target: CommentTarget = {type: 'discussion', number: 42, owner: 'owner', repo: 'repo'}

      // #when posting a comment
      const result = await postComment(client, target, {body: 'Discussion reply'}, logger)

      // #then it should use GraphQL
      expect(result?.created).toBe(true)
      expect(typeof result?.commentId).toBe('string')
    })

    it('returns null on error', async () => {
      // #given a client that throws
      const client = {
        rest: {
          issues: {
            createComment: vi.fn().mockRejectedValue(new Error('API error')),
          },
        },
      } as unknown as Octokit
      const target: CommentTarget = {type: 'issue', number: 1, owner: 'owner', repo: 'repo'}

      // #when posting fails
      const result = await postComment(client, target, {body: 'Test'}, logger)

      // #then it should return null
      expect(result).toBeNull()
    })
  })
})
