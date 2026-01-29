import type {Octokit} from './github/types.js'
import type {Logger} from './logger.js'
import {Buffer} from 'node:buffer'
import {vi, type Mock} from 'vitest'

/**
 * Mock logger for tests. All methods are vi.fn() spies.
 */
export function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

export interface MockOctokitOverrides {
  readonly createComment?: Mock | {id: number; html_url: string}
  readonly updateComment?: Mock | {id: number; html_url: string}
  readonly listComments?: Mock | unknown[]
  readonly getIssue?: Mock | unknown
  readonly graphql?: Mock | unknown
  readonly createReaction?: Mock | {id: number}
  readonly listReactions?: Mock | unknown[]
  readonly deleteReaction?: Mock | void
  readonly addLabels?: Mock | void
  readonly removeLabel?: Mock | void
  readonly getContent?: Mock | unknown
  readonly createBlob?: Mock | {sha: string}
  readonly createTree?: Mock | {sha: string}
  readonly createCommit?: Mock | {sha: string}
  readonly updateRef?: Mock | void
  readonly getRef?: Mock | {object: {sha: string}}
  readonly createRef?: Mock | void
  readonly deleteRef?: Mock | void
  readonly getCommit?: Mock | unknown
  readonly create?: Mock | unknown
  readonly list?: Mock | unknown[]
  readonly update?: Mock | unknown
  readonly requestReviewers?: Mock | void
  readonly createLabel?: Mock | unknown
  readonly getRepo?: Mock | unknown
  readonly getUserByUsername?: Mock | unknown
  readonly getAuthenticatedUser?: Mock | unknown
  readonly listFiles?: Mock | unknown[]
  readonly createReview?: Mock | unknown
  readonly createReviewComment?: Mock | unknown
  readonly listReviewComments?: Mock | unknown[]
  readonly createReplyForReviewComment?: Mock | unknown
  readonly getPullRequest?: Mock | unknown
}

/**
 * Mock Octokit client for tests with configurable responses.
 */
export function createMockOctokit(overrides: MockOctokitOverrides = {}): Octokit {
  const mockPulls = {
    create:
      typeof overrides.create === 'function'
        ? overrides.create
        : vi.fn().mockResolvedValue({data: overrides.create ?? {}}),
    list:
      typeof overrides.list === 'function' ? overrides.list : vi.fn().mockResolvedValue({data: overrides.list ?? []}),
    update:
      typeof overrides.update === 'function'
        ? overrides.update
        : vi.fn().mockResolvedValue({data: overrides.update ?? {}}),
    requestReviewers:
      typeof overrides.requestReviewers === 'function'
        ? overrides.requestReviewers
        : vi.fn().mockResolvedValue({data: overrides.requestReviewers ?? {}}),
    listFiles:
      typeof overrides.listFiles === 'function'
        ? overrides.listFiles
        : vi.fn().mockResolvedValue({data: overrides.listFiles ?? []}),
    createReview:
      typeof overrides.createReview === 'function'
        ? overrides.createReview
        : vi.fn().mockResolvedValue({data: overrides.createReview ?? {id: 123, state: 'COMMENTED', html_url: ''}}),
    createReviewComment:
      typeof overrides.createReviewComment === 'function'
        ? overrides.createReviewComment
        : vi.fn().mockResolvedValue({data: overrides.createReviewComment ?? {id: 789}}),
    listReviewComments:
      typeof overrides.listReviewComments === 'function'
        ? overrides.listReviewComments
        : vi.fn().mockResolvedValue({data: overrides.listReviewComments ?? []}),
    createReplyForReviewComment:
      typeof overrides.createReplyForReviewComment === 'function'
        ? overrides.createReplyForReviewComment
        : vi.fn().mockResolvedValue({data: overrides.createReplyForReviewComment ?? {id: 999}}),
    get:
      typeof overrides.getPullRequest === 'function'
        ? overrides.getPullRequest
        : vi.fn().mockResolvedValue({
            data: overrides.getPullRequest ?? {
              number: 456,
              title: 'Test PR',
              body: 'PR body',
              user: {login: 'prauthor'},
            },
          }),
  }

  return {
    rest: {
      issues: {
        createComment:
          typeof overrides.createComment === 'function'
            ? overrides.createComment
            : vi.fn().mockResolvedValue({
                data: overrides.createComment ?? {
                  id: 999,
                  html_url: 'https://github.com/owner/repo/issues/1#issuecomment-999',
                },
              }),
        updateComment:
          typeof overrides.updateComment === 'function'
            ? overrides.updateComment
            : vi.fn().mockResolvedValue({
                data: overrides.updateComment ?? {
                  id: 123,
                  html_url: 'https://github.com/owner/repo/issues/1#issuecomment-123',
                },
              }),
        listComments:
          typeof overrides.listComments === 'function'
            ? overrides.listComments
            : vi.fn().mockResolvedValue({
                data: overrides.listComments ?? [],
              }),
        get:
          typeof overrides.getIssue === 'function'
            ? overrides.getIssue
            : vi.fn().mockResolvedValue({
                data: overrides.getIssue ?? {
                  number: 123,
                  title: 'Test Issue',
                  body: 'Issue body',
                  user: {login: 'testuser'},
                },
              }),
        addLabels:
          typeof overrides.addLabels === 'function'
            ? overrides.addLabels
            : vi.fn().mockResolvedValue({data: overrides.addLabels ?? undefined}),
        removeLabel:
          typeof overrides.removeLabel === 'function'
            ? overrides.removeLabel
            : vi.fn().mockResolvedValue({data: overrides.removeLabel ?? undefined}),
        createLabel:
          typeof overrides.createLabel === 'function'
            ? overrides.createLabel
            : vi.fn().mockResolvedValue({data: overrides.createLabel ?? {}}),
      },
      reactions: {
        createForIssueComment:
          typeof overrides.createReaction === 'function'
            ? overrides.createReaction
            : vi.fn().mockResolvedValue({
                data: overrides.createReaction ?? {id: 123},
              }),
        listForIssueComment:
          typeof overrides.listReactions === 'function'
            ? overrides.listReactions
            : vi.fn().mockResolvedValue({
                data: overrides.listReactions ?? [],
              }),
        deleteForIssueComment:
          typeof overrides.deleteReaction === 'function'
            ? overrides.deleteReaction
            : vi.fn().mockResolvedValue({data: overrides.deleteReaction ?? undefined}),
      },
      repos: {
        getContent:
          typeof overrides.getContent === 'function'
            ? overrides.getContent
            : vi.fn().mockResolvedValue({
                data: overrides.getContent ?? {content: Buffer.from('test').toString('base64')},
              }),
        get:
          typeof overrides.getRepo === 'function'
            ? overrides.getRepo
            : vi.fn().mockResolvedValue({data: overrides.getRepo ?? {default_branch: 'main'}}),
      },
      users: {
        getByUsername:
          typeof overrides.getUserByUsername === 'function'
            ? overrides.getUserByUsername
            : vi.fn().mockResolvedValue({data: overrides.getUserByUsername ?? {id: 456, login: 'test-user'}}),
        getAuthenticated:
          typeof overrides.getAuthenticatedUser === 'function'
            ? overrides.getAuthenticatedUser
            : vi.fn().mockResolvedValue({data: overrides.getAuthenticatedUser ?? {login: 'fro-bot[bot]', type: 'Bot'}}),
      },
      git: {
        createBlob:
          typeof overrides.createBlob === 'function'
            ? overrides.createBlob
            : vi.fn().mockResolvedValue({
                data: overrides.createBlob ?? {sha: 'blob-sha'},
              }),
        createTree:
          typeof overrides.createTree === 'function'
            ? overrides.createTree
            : vi.fn().mockResolvedValue({
                data: overrides.createTree ?? {sha: 'tree-sha'},
              }),
        createCommit:
          typeof overrides.createCommit === 'function'
            ? overrides.createCommit
            : vi.fn().mockResolvedValue({
                data: overrides.createCommit ?? {sha: 'commit-sha'},
              }),
        updateRef:
          typeof overrides.updateRef === 'function'
            ? overrides.updateRef
            : vi.fn().mockResolvedValue({data: overrides.updateRef ?? undefined}),
        getRef:
          typeof overrides.getRef === 'function'
            ? overrides.getRef
            : vi.fn().mockResolvedValue({
                data: overrides.getRef ?? {object: {sha: 'ref-sha'}},
              }),
        getCommit:
          typeof overrides.getCommit === 'function'
            ? overrides.getCommit
            : vi.fn().mockResolvedValue({data: overrides.getCommit ?? {sha: 'commit-sha'}}),
        createRef:
          typeof overrides.createRef === 'function'
            ? overrides.createRef
            : vi.fn().mockResolvedValue({data: overrides.createRef ?? undefined}),
        deleteRef:
          typeof overrides.deleteRef === 'function'
            ? overrides.deleteRef
            : vi.fn().mockResolvedValue({data: overrides.deleteRef ?? undefined}),
      },
      pulls: mockPulls,
    },
    graphql:
      typeof overrides.graphql === 'function'
        ? overrides.graphql
        : vi.fn().mockResolvedValue(
            overrides.graphql ?? {
              repository: {
                issue: null,
                pullRequest: null,
              },
              addDiscussionComment: {
                comment: {
                  id: 'DC_new123',
                  url: 'https://github.com/owner/repo/discussions/42#discussioncomment-new123',
                },
              },
            },
          ),
  } as unknown as Octokit
}
