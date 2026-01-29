import type {Octokit} from './github/types.js'
import type {Logger} from './logger.js'
import {Buffer} from 'node:buffer'
import {vi} from 'vitest'

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
  readonly createComment?: {id: number; html_url: string}
  readonly updateComment?: {id: number; html_url: string}
  readonly listComments?: unknown[]
  readonly getIssue?: unknown
  readonly graphql?: unknown
  readonly createReaction?: {id: number}
  readonly listReactions?: unknown[]
  readonly deleteReaction?: void
  readonly addLabels?: void
  readonly removeLabel?: void
  readonly getContent?: unknown
  readonly createBlob?: {sha: string}
  readonly createTree?: {sha: string}
  readonly createCommit?: {sha: string}
  readonly updateRef?: void
  readonly getRef?: {object: {sha: string}}
  readonly createRef?: void
}

/**
 * Mock Octokit client for tests with configurable responses.
 */
export function createMockOctokit(overrides: MockOctokitOverrides = {}): Octokit {
  return {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue({
          data: overrides.createComment ?? {
            id: 999,
            html_url: 'https://github.com/owner/repo/issues/1#issuecomment-999',
          },
        }),
        updateComment: vi.fn().mockResolvedValue({
          data: overrides.updateComment ?? {
            id: 123,
            html_url: 'https://github.com/owner/repo/issues/1#issuecomment-123',
          },
        }),
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
        addLabels: vi.fn().mockResolvedValue({data: overrides.addLabels ?? undefined}),
        removeLabel: vi.fn().mockResolvedValue({data: overrides.removeLabel ?? undefined}),
      },
      reactions: {
        createForIssueComment: vi.fn().mockResolvedValue({
          data: overrides.createReaction ?? {id: 1},
        }),
        listForIssueComment: vi.fn().mockResolvedValue({
          data: overrides.listReactions ?? [],
        }),
        deleteForIssueComment: vi.fn().mockResolvedValue({data: overrides.deleteReaction ?? undefined}),
      },
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: overrides.getContent ?? {content: Buffer.from('test').toString('base64')},
        }),
      },
      git: {
        createBlob: vi.fn().mockResolvedValue({
          data: overrides.createBlob ?? {sha: 'blob-sha'},
        }),
        createTree: vi.fn().mockResolvedValue({
          data: overrides.createTree ?? {sha: 'tree-sha'},
        }),
        createCommit: vi.fn().mockResolvedValue({
          data: overrides.createCommit ?? {sha: 'commit-sha'},
        }),
        updateRef: vi.fn().mockResolvedValue({data: overrides.updateRef ?? undefined}),
        getRef: vi.fn().mockResolvedValue({
          data: overrides.getRef ?? {object: {sha: 'ref-sha'}},
        }),
        createRef: vi.fn().mockResolvedValue({data: overrides.createRef ?? undefined}),
      },
    },
    graphql: vi.fn().mockResolvedValue(
      overrides.graphql ?? {
        addDiscussionComment: {
          comment: {id: 'DC_new123', url: 'https://github.com/owner/repo/discussions/42#discussioncomment-new123'},
        },
      },
    ),
  } as unknown as Octokit
}
