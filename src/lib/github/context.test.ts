import type {GitHubContext} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../test-helpers.js'
import {createIssueCommentCreatedEvent} from '../triggers/__fixtures__/payloads.js'
import {classifyEventType, getCommentTarget, isPullRequest, normalizeEvent, parseGitHubContext} from './context.js'

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'issue_comment',
    repo: {owner: 'test-owner', repo: 'test-repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'test-actor',
    payload: {
      action: 'created',
      issue: {
        number: 1,
        title: 'Test issue',
        body: 'Test body',
        locked: false,
      },
      comment: {
        id: 1,
        body: 'Test comment',
        user: {login: 'test-user'},
        author_association: 'MEMBER',
      },
      repository: {owner: {login: 'test-owner'}, name: 'test-repo'},
      sender: {login: 'test-user'},
    },
  },
}))

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
    expect(ctx.event.type).toBe('issue_comment')
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
    const event: GitHubContext['event'] = {
      type: 'issue_comment',
      action: 'created',
      issue: {
        number: 1,
        title: 'Test',
        body: null,
        locked: false,
        isPullRequest: true,
      },
      comment: {
        id: 1,
        body: 'test',
        author: 'user',
        authorAssociation: 'MEMBER',
      },
    }
    expect(isPullRequest(event)).toBe(true)
  })

  it('returns false for regular issues', () => {
    const event: GitHubContext['event'] = {
      type: 'issue_comment',
      action: 'created',
      issue: {
        number: 1,
        title: 'Test',
        body: null,
        locked: false,
        isPullRequest: false,
      },
      comment: {
        id: 1,
        body: 'test',
        author: 'user',
        authorAssociation: 'MEMBER',
      },
    }
    expect(isPullRequest(event)).toBe(false)
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
      event: normalizeEvent('issue_comment', payload),
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
      event: normalizeEvent('issue_comment', payload),
    }

    const target = getCommentTarget(context)

    expect(target).toEqual({
      type: 'pr',
      number: 42,
      owner: 'test-owner',
      repo: 'test-repo',
    })
  })

  it('returns discussion target for discussion_comment events', () => {
    const payload = {
      action: 'created',
      discussion: {
        number: 99,
        title: 'Test Discussion',
        body: null,
        locked: false,
      },
      comment: {
        id: 1,
        body: 'test',
        user: {login: 'user'},
        author_association: 'MEMBER',
      },
    }
    const context: GitHubContext = {
      eventName: 'discussion',
      eventType: 'discussion_comment',
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload,
      event: normalizeEvent('discussion_comment', payload),
    }

    const target = getCommentTarget(context)

    expect(target).toEqual({
      type: 'discussion',
      number: 99,
      owner: 'test-owner',
      repo: 'test-repo',
    })
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
      event: normalizeEvent('unsupported', {}),
    }

    const target = getCommentTarget(context)

    expect(target).toBeNull()
  })
})
