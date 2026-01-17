import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {TriggerContext} from './types.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {handleIssueComment} from './issue-comment.js'

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
    },
  } as unknown as Octokit
}

function createMockContext(
  eventType: 'issue_comment' | 'discussion_comment',
  options: {
    issueNumber?: number
    payload?: unknown
  } = {},
): TriggerContext {
  const issueNumber = options.issueNumber ?? 123

  return {
    eventType,
    eventName: eventType,
    repo: {owner: 'test-owner', repo: 'test-repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'test-actor',
    author: {login: 'commenter', association: 'MEMBER', isBot: false},
    target: {kind: 'issue', number: issueNumber, title: 'Test Issue', body: null, locked: false},
    commentBody: 'Test comment',
    commentId: 456,
    hasMention: true,
    command: null,
    raw: {
      eventName: eventType,
      eventType,
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload: options.payload ?? {issue: {number: issueNumber}},
    },
  } as TriggerContext
}

describe('triggers/issue-comment', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  describe('handleIssueComment', () => {
    it('reads thread for issue_comment event', async () => {
      // #given an issue_comment event with comments
      const client = createMockOctokit({
        listComments: [
          {
            id: 1,
            body: 'A comment',
            user: {login: 'user1'},
            author_association: 'MEMBER',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      })
      const context = createMockContext('issue_comment')

      // #when handling the comment
      const result = await handleIssueComment(context, client, null, logger)

      // #then it should read the thread successfully
      expect(result.handled).toBe(true)
      expect(result.thread).not.toBeNull()
      expect(result.thread?.type).toBe('issue')
      expect(result.thread?.comments).toHaveLength(1)
    })

    it('returns handled false when thread read fails', async () => {
      // #given a client that returns no issue data
      const client = {
        rest: {
          issues: {
            get: vi.fn().mockRejectedValue(new Error('Not found')),
            listComments: vi.fn().mockResolvedValue({data: []}),
          },
        },
      } as unknown as Octokit
      const context = createMockContext('issue_comment')

      // #when handling the comment
      const result = await handleIssueComment(context, client, null, logger)

      // #then it should return handled false
      expect(result.handled).toBe(false)
      expect(result.thread).toBeNull()
    })

    it('returns handled false for unsupported event types', async () => {
      // #given an unsupported event type
      const client = createMockOctokit()
      const context = {
        ...createMockContext('issue_comment'),
        eventType: 'unsupported',
        raw: {
          eventName: 'push',
          eventType: 'unsupported',
          repo: {owner: 'test-owner', repo: 'test-repo'},
          ref: 'refs/heads/main',
          sha: 'abc123',
          runId: 12345,
          actor: 'test-actor',
          payload: {},
        },
      } as TriggerContext

      // #when handling the event
      const result = await handleIssueComment(context, client, null, logger)

      // #then it should return handled false
      expect(result.handled).toBe(false)
    })

    it('logs thread details on success', async () => {
      // #given a successful thread read
      const client = createMockOctokit()
      const context = createMockContext('issue_comment')

      // #when handling the comment
      await handleIssueComment(context, client, null, logger)

      // #then it should log thread details
      expect(logger.debug).toHaveBeenCalledWith(
        'Read thread successfully',
        expect.objectContaining({
          type: 'issue',
          number: 123,
        }),
      )
    })
  })
})
