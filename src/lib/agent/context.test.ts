import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {TriggerContext, TriggerTarget} from '../triggers/types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createMockLogger, createMockOctokit} from '../test-helpers.js'
import {collectAgentContext} from './context.js'

vi.mock('../github/api.js', () => ({
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
}))

vi.mock('./diff-context.js', () => ({
  collectDiffContext: vi.fn().mockResolvedValue(null),
}))

function createMockTarget(overrides: Partial<TriggerTarget> = {}): TriggerTarget {
  return {
    kind: 'issue',
    number: 42,
    title: 'Test Issue',
    body: null,
    locked: false,
    ...overrides,
  }
}

function createMockTriggerContext(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    eventType: 'issue_comment',
    eventName: 'issue_comment',
    repo: {owner: 'test-owner', repo: 'test-repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'test-actor',
    action: 'created',
    author: {login: 'test-user', association: 'MEMBER', isBot: false},
    target: null,
    commentBody: null,
    commentId: null,
    hasMention: false,
    command: null,
    raw: {} as TriggerContext['raw'],
    ...overrides,
  }
}

describe('collectAgentContext', () => {
  let mockLogger: Logger
  let mockOctokit: Octokit

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockOctokit = createMockOctokit()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('extracts basic context from TriggerContext', async () => {
    // #given
    const triggerContext = createMockTriggerContext()

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
    })

    // #then
    expect(ctx.eventName).toBe('issue_comment')
    expect(ctx.repo).toBe('test-owner/test-repo')
    expect(ctx.actor).toBe('test-actor')
    expect(ctx.runId).toBe('12345')
  })

  it('extracts comment details from TriggerContext', async () => {
    // #given
    const triggerContext = createMockTriggerContext({
      commentBody: 'Please fix the bug',
      commentId: 999,
      author: {login: 'reporter', association: 'MEMBER', isBot: false},
    })

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
    })

    // #then
    expect(ctx.commentBody).toBe('Please fix the bug')
    expect(ctx.commentAuthor).toBe('reporter')
    expect(ctx.commentId).toBe(999)
  })

  it('extracts issue number and title from target', async () => {
    // #given
    const triggerContext = createMockTriggerContext({
      target: createMockTarget({
        kind: 'issue',
        number: 123,
        title: 'Found a bug',
      }),
    })

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
    })

    // #then
    expect(ctx.issueNumber).toBe(123)
    expect(ctx.issueTitle).toBe('Found a bug')
    expect(ctx.issueType).toBe('issue')
  })

  it('detects PR type from target.kind', async () => {
    // #given
    const triggerContext = createMockTriggerContext({
      target: createMockTarget({kind: 'pr', number: 42}),
    })

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
    })

    // #then
    expect(ctx.issueType).toBe('pr')
  })

  it('returns null for comment fields when TriggerContext has nulls', async () => {
    // #given
    const triggerContext = createMockTriggerContext({
      eventName: 'workflow_dispatch',
      eventType: 'workflow_dispatch',
      commentBody: null,
      commentId: null,
      author: null,
      target: null,
    })

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
    })

    // #then
    expect(ctx.commentBody).toBeNull()
    expect(ctx.commentAuthor).toBeNull()
    expect(ctx.commentId).toBeNull()
    expect(ctx.issueNumber).toBeNull()
    expect(ctx.issueType).toBeNull()
  })

  it('logs collected context info', async () => {
    // #given
    const triggerContext = createMockTriggerContext({
      commentBody: 'test comment',
      target: createMockTarget({kind: 'issue', number: 42}),
    })

    // #when
    await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
    })

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Collected agent context',
      expect.objectContaining({
        eventName: 'issue_comment',
        repo: 'test-owner/test-repo',
        hasComment: true,
        issueNumber: 42,
        issueType: 'issue',
      }),
    )
  })

  it('defaults to "main" for defaultBranch', async () => {
    // #given
    const triggerContext = createMockTriggerContext()

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
    })

    // #then
    expect(ctx.defaultBranch).toBe('main')
  })

  it('returns null for diffContext when collectDiffContext returns null', async () => {
    // #given
    const triggerContext = createMockTriggerContext()

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
    })

    // #then
    expect(ctx.diffContext).toBeNull()
  })
})
