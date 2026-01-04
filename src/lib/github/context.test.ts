import type {Logger} from '../logger.js'
import type {GitHubContext, IssueCommentPayload} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {
  classifyEventType,
  getAuthorAssociation,
  getCommentAuthor,
  getCommentTarget,
  isIssueLocked,
  isPullRequest,
  parseGitHubContext,
} from './context.js'

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'issue_comment',
    repo: {owner: 'test-owner', repo: 'test-repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'test-actor',
    payload: {},
  },
}))

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

describe('classifyEventType', () => {
  it('classifies issue_comment event correctly', () => {
    expect(classifyEventType('issue_comment')).toBe('issue_comment')
  })

  it('classifies discussion event correctly', () => {
    expect(classifyEventType('discussion')).toBe('discussion')
  })

  it('classifies discussion_comment event as discussion', () => {
    expect(classifyEventType('discussion_comment')).toBe('discussion')
  })

  it('classifies workflow_dispatch event correctly', () => {
    expect(classifyEventType('workflow_dispatch')).toBe('workflow_dispatch')
  })

  it('classifies unknown events as unknown', () => {
    expect(classifyEventType('push')).toBe('unknown')
    expect(classifyEventType('pull_request')).toBe('unknown')
    expect(classifyEventType('random_event')).toBe('unknown')
  })
})

describe('parseGitHubContext', () => {
  it('parses GitHub Actions context into typed structure', () => {
    const logger = createMockLogger()
    const ctx = parseGitHubContext(logger)

    expect(ctx.eventName).toBe('issue_comment')
    expect(ctx.eventType).toBe('issue_comment')
    expect(ctx.repo).toEqual({owner: 'test-owner', repo: 'test-repo'})
    expect(ctx.ref).toBe('refs/heads/main')
    expect(ctx.sha).toBe('abc123')
    expect(ctx.runId).toBe(12345)
    expect(ctx.actor).toBe('test-actor')
  })

  it('logs debug message with context info', () => {
    const logger = createMockLogger()
    parseGitHubContext(logger)

    expect(logger.debug).toHaveBeenCalledWith('Parsed GitHub context', {
      eventName: 'issue_comment',
      eventType: 'issue_comment',
      repo: 'test-owner/test-repo',
    })
  })
})

describe('isPullRequest', () => {
  it('returns true when pull_request field exists', () => {
    const payload = {
      issue: {pull_request: {url: 'https://api.github.com/repos/owner/repo/pulls/1'}},
    } as unknown as IssueCommentPayload

    expect(isPullRequest(payload)).toBe(true)
  })

  it('returns false for regular issues', () => {
    const payload = {
      issue: {number: 1, title: 'Test issue'},
    } as unknown as IssueCommentPayload

    expect(isPullRequest(payload)).toBe(false)
  })
})

describe('getCommentTarget', () => {
  it('returns issue target for issue_comment on issue', () => {
    const context: GitHubContext = {
      eventName: 'issue_comment',
      eventType: 'issue_comment',
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload: {
        issue: {number: 42},
      },
    }

    const target = getCommentTarget(context)

    expect(target).toEqual({
      type: 'issue',
      number: 42,
      owner: 'test-owner',
      repo: 'test-repo',
    })
  })

  it('returns pr target for issue_comment on PR', () => {
    const context: GitHubContext = {
      eventName: 'issue_comment',
      eventType: 'issue_comment',
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload: {
        issue: {
          number: 42,
          pull_request: {url: 'https://api.github.com/repos/owner/repo/pulls/42'},
        },
      },
    }

    const target = getCommentTarget(context)

    expect(target).toEqual({
      type: 'pr',
      number: 42,
      owner: 'test-owner',
      repo: 'test-repo',
    })
  })

  it('returns null for discussion events (not yet implemented)', () => {
    const context: GitHubContext = {
      eventName: 'discussion',
      eventType: 'discussion',
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload: {},
    }

    const target = getCommentTarget(context)

    expect(target).toBeNull()
  })

  it('returns null for unknown events', () => {
    const context: GitHubContext = {
      eventName: 'push',
      eventType: 'unknown',
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload: {},
    }

    const target = getCommentTarget(context)

    expect(target).toBeNull()
  })
})

describe('getAuthorAssociation', () => {
  it('extracts author association from payload', () => {
    const payload = {
      comment: {author_association: 'MEMBER'},
    } as unknown as IssueCommentPayload

    expect(getAuthorAssociation(payload)).toBe('MEMBER')
  })
})

describe('getCommentAuthor', () => {
  it('extracts comment author login from payload', () => {
    const payload = {
      comment: {user: {login: 'test-user'}},
    } as unknown as IssueCommentPayload

    expect(getCommentAuthor(payload)).toBe('test-user')
  })
})

describe('isIssueLocked', () => {
  it('returns true when issue is locked', () => {
    const payload = {
      issue: {locked: true},
    } as unknown as IssueCommentPayload

    expect(isIssueLocked(payload)).toBe(true)
  })

  it('returns false when issue is not locked', () => {
    const payload = {
      issue: {locked: false},
    } as unknown as IssueCommentPayload

    expect(isIssueLocked(payload)).toBe(false)
  })
})
