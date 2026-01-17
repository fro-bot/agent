import type {Logger} from '../logger.js'
import type {GitHubContext} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {createIssueCommentCreatedEvent} from '../triggers/__fixtures__/payloads.js'
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
  it('classifies issue_comment as issue_comment', () => {
    // #given an issue_comment event
    // #when classifying the event type
    const result = classifyEventType('issue_comment')

    // #then it should return issue_comment
    expect(result).toBe('issue_comment')
  })

  it('classifies discussion as discussion_comment', () => {
    // #given a discussion event
    // #when classifying the event type
    const result = classifyEventType('discussion')

    // #then it should return discussion_comment
    expect(result).toBe('discussion_comment')
  })

  it('classifies discussion_comment as discussion_comment', () => {
    // #given a discussion_comment event
    // #when classifying the event type
    const result = classifyEventType('discussion_comment')

    // #then it should return discussion_comment
    expect(result).toBe('discussion_comment')
  })

  it('classifies workflow_dispatch as workflow_dispatch', () => {
    // #given a workflow_dispatch event
    // #when classifying the event type
    const result = classifyEventType('workflow_dispatch')

    // #then it should return workflow_dispatch
    expect(result).toBe('workflow_dispatch')
  })

  it('classifies unknown events as unsupported', () => {
    // #given an unknown event
    // #when classifying the event type
    const result = classifyEventType('push')

    // #then it should return unsupported
    expect(result).toBe('unsupported')
  })

  it('classifies pull_request as pull_request', () => {
    // #given a pull_request event
    // #when classifying the event type
    const result = classifyEventType('pull_request')

    // #then it should return pull_request
    expect(result).toBe('pull_request')
  })

  it('classifies issues as issues', () => {
    // #given an issues event
    // #when classifying the event type
    const result = classifyEventType('issues')

    // #then it should return issues
    expect(result).toBe('issues')
  })

  it('classifies pull_request_review_comment as pull_request_review_comment', () => {
    // #given a pull_request_review_comment event
    // #when classifying the event type
    const result = classifyEventType('pull_request_review_comment')

    // #then it should return pull_request_review_comment
    expect(result).toBe('pull_request_review_comment')
  })

  it('classifies schedule as schedule', () => {
    // #given a schedule event
    // #when classifying the trigger
    const result = classifyEventType('schedule')

    // #then it should return schedule
    expect(result).toBe('schedule')
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
    const payload = createIssueCommentCreatedEvent({isPullRequest: true})
    expect(isPullRequest(payload)).toBe(true)
  })

  it('returns false for regular issues', () => {
    const payload = createIssueCommentCreatedEvent({isPullRequest: false})
    expect(isPullRequest(payload)).toBe(false)
  })
})

describe('getCommentTarget', () => {
  it('returns issue target for issue_comment on issue', () => {
    const payload = createIssueCommentCreatedEvent({issueNumber: 42})
    const context: GitHubContext = {
      eventName: 'issue_comment',
      eventType: 'issue_comment',
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload,
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
    const payload = createIssueCommentCreatedEvent({issueNumber: 42, isPullRequest: true})
    const context: GitHubContext = {
      eventName: 'issue_comment',
      eventType: 'issue_comment',
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload,
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
      eventType: 'discussion_comment',
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
      eventType: 'unsupported',
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
    const payload = createIssueCommentCreatedEvent({authorAssociation: 'MEMBER'})
    expect(getAuthorAssociation(payload)).toBe('MEMBER')
  })

  it('handles different association values', () => {
    const associations = ['OWNER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'] as const
    for (const assoc of associations) {
      const payload = createIssueCommentCreatedEvent({authorAssociation: assoc})
      expect(getAuthorAssociation(payload)).toBe(assoc)
    }
  })
})

describe('getCommentAuthor', () => {
  it('extracts comment author login from payload', () => {
    const payload = createIssueCommentCreatedEvent({authorLogin: 'test-user'})
    expect(getCommentAuthor(payload)).toBe('test-user')
  })
})

describe('isIssueLocked', () => {
  it('returns true when issue is locked', () => {
    const payload = createIssueCommentCreatedEvent({issueLocked: true})
    expect(isIssueLocked(payload)).toBe(true)
  })

  it('returns false when issue is not locked', () => {
    const payload = createIssueCommentCreatedEvent({issueLocked: false})
    expect(isIssueLocked(payload)).toBe(false)
  })
})
