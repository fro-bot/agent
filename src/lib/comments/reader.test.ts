import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {Thread} from './types.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {BOT_COMMENT_MARKER} from '../github/types.js'
import {findBotComment, readThread} from './reader.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  } as unknown as Logger
}

function createMockOctokit(
  overrides: {
    listComments?: unknown[]
    getIssue?: unknown
    graphql?: unknown
  } = {},
): Octokit {
  return {
    rest: {
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: overrides.listComments ?? [],
        }),
        get: vi.fn().mockResolvedValue({
          data: overrides.getIssue ?? {
            number: 123,
            title: 'Test Issue',
            body: 'Issue body',
            user: {login: 'testuser'},
          },
        }),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 456,
            title: 'Test PR',
            body: 'PR body',
            user: {login: 'prauthor'},
          },
        }),
      },
    },
    graphql: vi.fn().mockResolvedValue(
      overrides.graphql ?? {
        repository: {
          discussion: {
            id: 'D_kwDO123',
            title: 'Test Discussion',
            body: 'Discussion body',
            author: {login: 'discauthor'},
            comments: {
              nodes: [],
              pageInfo: {hasNextPage: false, endCursor: null},
            },
          },
        },
      },
    ),
  } as unknown as Octokit
}

describe('comments/reader', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  describe('readThread', () => {
    it('reads issue thread with comments', async () => {
      // #given an issue with comments
      const client = createMockOctokit({
        listComments: [
          {
            id: 1,
            body: 'First comment',
            user: {login: 'user1'},
            author_association: 'MEMBER',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      })
      const target = {type: 'issue' as const, number: 123, owner: 'owner', repo: 'repo'}

      // #when reading the thread
      const thread = await readThread(client, target, null, logger)

      // #then it should return the thread with comments
      expect(thread).not.toBeNull()
      expect(thread?.type).toBe('issue')
      expect(thread?.number).toBe(123)
      expect(thread?.comments).toHaveLength(1)
      expect(thread?.comments[0]?.author).toBe('user1')
    })

    it('reads PR thread', async () => {
      // #given a PR target
      const client = createMockOctokit()
      const target = {type: 'pr' as const, number: 456, owner: 'owner', repo: 'repo'}

      // #when reading the thread
      const thread = await readThread(client, target, null, logger)

      // #then it should return PR data
      expect(thread?.type).toBe('pr')
      expect(thread?.title).toBe('Test PR')
    })

    it('reads discussion thread via GraphQL', async () => {
      // #given a discussion target
      const client = createMockOctokit({
        graphql: {
          repository: {
            discussion: {
              id: 'D_kwDO123',
              title: 'Test Discussion',
              body: 'Discussion body',
              author: {login: 'discauthor'},
              comments: {
                nodes: [
                  {
                    id: 'DC_comment1',
                    body: 'Discussion comment',
                    author: {login: 'commenter'},
                    createdAt: '2024-01-01T00:00:00Z',
                    updatedAt: '2024-01-01T00:00:00Z',
                  },
                ],
                pageInfo: {hasNextPage: false, endCursor: null},
              },
            },
          },
        },
      })
      const target = {type: 'discussion' as const, number: 42, owner: 'owner', repo: 'repo'}

      // #when reading the thread
      const thread = await readThread(client, target, null, logger)

      // #then it should use GraphQL and return discussion data
      expect(thread?.type).toBe('discussion')
      expect(thread?.discussionId).toBe('D_kwDO123')
      expect(thread?.comments).toHaveLength(1)
      expect(thread?.comments[0]?.id).toBe('DC_comment1')
    })

    it('marks bot comments with isBot flag', async () => {
      // #given comments including one from the bot with marker
      const client = createMockOctokit({
        listComments: [
          {
            id: 1,
            body: 'User comment',
            user: {login: 'user1'},
            author_association: 'NONE',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
          {
            id: 2,
            body: `Bot response\n${BOT_COMMENT_MARKER}`,
            user: {login: 'fro-bot[bot]'},
            author_association: 'NONE',
            created_at: '2024-01-01T01:00:00Z',
            updated_at: '2024-01-01T01:00:00Z',
          },
        ],
      })
      const target = {type: 'issue' as const, number: 123, owner: 'owner', repo: 'repo'}

      // #when reading the thread with bot login
      const thread = await readThread(client, target, 'fro-bot', logger)

      // #then bot comment should have isBot = true
      expect(thread?.comments[0]?.isBot).toBe(false)
      expect(thread?.comments[1]?.isBot).toBe(true)
    })

    it('returns null when discussion not found', async () => {
      // #given a discussion that doesn't exist
      const client = createMockOctokit({
        graphql: {repository: {discussion: null}},
      })
      const target = {type: 'discussion' as const, number: 999, owner: 'owner', repo: 'repo'}

      // #when reading the thread
      const thread = await readThread(client, target, null, logger)

      // #then it should return null
      expect(thread).toBeNull()
    })

    it('handles pagination for many comments', async () => {
      // #given an issue with paginated comments
      const mockListComments = vi
        .fn()
        .mockResolvedValueOnce({
          data: Array.from({length: 100}, (_, i) => ({
            id: i + 1,
            body: `Comment ${i + 1}`,
            user: {login: 'user'},
            author_association: 'MEMBER',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          })),
        })
        .mockResolvedValueOnce({
          data: Array.from({length: 50}, (_, i) => ({
            id: i + 101,
            body: `Comment ${i + 101}`,
            user: {login: 'user'},
            author_association: 'MEMBER',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          })),
        })

      const client = {
        rest: {
          issues: {
            listComments: mockListComments,
            get: vi.fn().mockResolvedValue({
              data: {number: 123, title: 'Test', body: 'Body', user: {login: 'user'}},
            }),
          },
        },
      } as unknown as Octokit

      const target = {type: 'issue' as const, number: 123, owner: 'owner', repo: 'repo'}

      // #when reading the thread
      const thread = await readThread(client, target, null, logger)

      // #then it should fetch all pages
      expect(thread?.comments).toHaveLength(150)
      expect(mockListComments).toHaveBeenCalledTimes(2)
    })
  })

  describe('findBotComment', () => {
    it('finds bot comment by author and marker', () => {
      // #given a thread with bot comment
      const thread: Thread = {
        type: 'issue',
        number: 123,
        title: 'Test',
        body: 'Body',
        author: 'user',
        comments: [
          {
            id: 1,
            body: 'User comment',
            author: 'user1',
            authorAssociation: 'MEMBER',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            isBot: false,
          },
          {
            id: 2,
            body: `Bot response\n${BOT_COMMENT_MARKER}`,
            author: 'fro-bot[bot]',
            authorAssociation: 'NONE',
            createdAt: '2024-01-01T01:00:00Z',
            updatedAt: '2024-01-01T01:00:00Z',
            isBot: true,
          },
        ],
      }

      // #when finding bot comment
      const botComment = findBotComment(thread, 'fro-bot')

      // #then it should return the bot comment
      expect(botComment).not.toBeNull()
      expect(botComment?.id).toBe(2)
    })

    it('returns most recent bot comment when multiple exist', () => {
      // #given a thread with multiple bot comments
      const thread: Thread = {
        type: 'issue',
        number: 123,
        title: 'Test',
        body: 'Body',
        author: 'user',
        comments: [
          {
            id: 1,
            body: `Old bot comment\n${BOT_COMMENT_MARKER}`,
            author: 'fro-bot[bot]',
            authorAssociation: 'NONE',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            isBot: true,
          },
          {
            id: 2,
            body: `New bot comment\n${BOT_COMMENT_MARKER}`,
            author: 'fro-bot[bot]',
            authorAssociation: 'NONE',
            createdAt: '2024-01-02T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
            isBot: true,
          },
        ],
      }

      // #when finding bot comment
      const botComment = findBotComment(thread, 'fro-bot')

      // #then it should return the most recent one
      expect(botComment?.id).toBe(2)
    })

    it('returns null when no bot comment exists', () => {
      // #given a thread without bot comments
      const thread: Thread = {
        type: 'issue',
        number: 123,
        title: 'Test',
        body: 'Body',
        author: 'user',
        comments: [
          {
            id: 1,
            body: 'User comment',
            author: 'user1',
            authorAssociation: 'MEMBER',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            isBot: false,
          },
        ],
      }

      // #when finding bot comment
      const botComment = findBotComment(thread, 'fro-bot')

      // #then it should return null
      expect(botComment).toBeNull()
    })

    it('ignores marker-only comments from non-bot users', () => {
      // #given a thread where user copied the marker
      const thread: Thread = {
        type: 'issue',
        number: 123,
        title: 'Test',
        body: 'Body',
        author: 'user',
        comments: [
          {
            id: 1,
            body: `I copied the marker\n${BOT_COMMENT_MARKER}`,
            author: 'sneaky-user',
            authorAssociation: 'NONE',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            isBot: false,
          },
        ],
      }

      // #when finding bot comment
      const botComment = findBotComment(thread, 'fro-bot')

      // #then it should return null (security: author must match)
      expect(botComment).toBeNull()
    })
  })
})
