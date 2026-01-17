import type {Logger} from '../logger.js'

import * as github from '@actions/github'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createIssueCommentCreatedEvent} from '../triggers/__fixtures__/payloads.js'
import {collectAgentContext} from './context.js'

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

describe('collectAgentContext', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('extracts basic context from GitHub Actions environment', () => {
    // #given
    const payload = createIssueCommentCreatedEvent()
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.eventName).toBe('issue_comment')
    expect(ctx.repo).toBe('test-owner/test-repo')
    expect(ctx.actor).toBe('test-actor')
    expect(ctx.runId).toBe('12345')
  })

  it('extracts comment details from issue_comment payload', () => {
    // #given
    const payload = createIssueCommentCreatedEvent({
      commentBody: 'Please fix the bug',
      authorLogin: 'reporter',
      authorAssociation: 'COLLABORATOR',
    })
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.commentBody).toBe('Please fix the bug')
    expect(ctx.commentAuthor).toBe('reporter')
    expect(ctx.commentId).toBe(1)
  })

  it('extracts issue number and title from payload', () => {
    // #given
    const payload = createIssueCommentCreatedEvent({issueNumber: 123})
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.issueNumber).toBe(123)
    expect(ctx.issueTitle).toBe('Found a bug')
    expect(ctx.issueType).toBe('issue')
  })

  it('detects PR type when pull_request field is present', () => {
    // #given
    const payload = createIssueCommentCreatedEvent({isPullRequest: true})
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.issueType).toBe('pr')
  })

  it('returns null for comment fields on non-comment events', () => {
    // #given
    vi.mocked(github.context).eventName = 'workflow_dispatch'
    vi.mocked(github.context).payload = {}

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.commentBody).toBeNull()
    expect(ctx.commentAuthor).toBeNull()
    expect(ctx.commentId).toBeNull()
    expect(ctx.issueNumber).toBeNull()
    expect(ctx.issueType).toBeNull()
  })

  it('logs collected context info', () => {
    // #given
    const payload = createIssueCommentCreatedEvent()
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    collectAgentContext(mockLogger)

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Collected agent context',
      expect.objectContaining({
        eventName: 'issue_comment',
        repo: 'test-owner/test-repo',
        hasComment: true,
      }),
    )
  })

  it('defaults to "main" for defaultBranch', () => {
    // #given
    const payload = createIssueCommentCreatedEvent()
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.defaultBranch).toBe('main')
  })
})
