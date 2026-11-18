import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {TriggerContext, TriggerTarget} from '../triggers/types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createMockOctokit} from '../../services/github/test-helpers.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {collectAgentContext} from './context.js'

vi.mock('../../services/github/api.js', () => ({
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
    isBotReviewRequested: false,
    raw: {},
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
      botLogin: null,
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
      botLogin: null,
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
      botLogin: null,
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
      botLogin: null,
    })

    // #then
    expect(ctx.issueType).toBe('pr')
  })

  it('returns null issueNumber for manual targets (schedule/dispatch)', async () => {
    // #given — manual targets have kind='manual' and number=0
    const triggerContext = createMockTriggerContext({
      eventName: 'schedule',
      eventType: 'schedule',
      target: createMockTarget({kind: 'manual', number: 0, title: 'Scheduled workflow'}),
    })

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext,
      botLogin: null,
    })

    // #then — number=0 sentinel should become null
    expect(ctx.issueNumber).toBeNull()
    expect(ctx.issueType).toBeNull()
    expect(ctx.issueTitle).toBe('Scheduled workflow')
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
      botLogin: null,
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
      botLogin: null,
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
      botLogin: null,
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
      botLogin: null,
    })

    // #then
    expect(ctx.diffContext).toBeNull()
  })

  describe('discussion runs', () => {
    const discussionTarget = createMockTarget({kind: 'discussion', number: 9, title: 'Question'})

    it('hydrates the discussion body and comments through the Action client', async () => {
      // #given a discussion trigger and a client that serves the discussion
      const graphql = vi.fn().mockResolvedValue({
        repository: {
          discussion: {
            number: 9,
            title: 'Question',
            body: 'The original question',
            author: {login: 'asker'},
            comments: {
              nodes: [
                {
                  id: 'DC_1',
                  body: 'an earlier answer',
                  author: {login: 'helper'},
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ],
              totalCount: 1,
            },
          },
        },
      })
      const octokit = {graphql} as unknown as Octokit
      const triggerContext = createMockTriggerContext({
        eventType: 'discussion_comment',
        target: discussionTarget,
        commentBody: 'the triggering comment',
      })

      // #when collecting context
      const ctx = await collectAgentContext({logger: mockLogger, octokit, triggerContext, botLogin: null})

      // #then the discussion body and prior comments are carried, apart from the triggering comment
      expect(ctx.issueType).toBeNull()
      expect(ctx.commentBody).toBe('the triggering comment')
      expect(ctx.hydratedContext).toMatchObject({
        type: 'discussion',
        number: 9,
        body: 'The original question',
        comments: [{author: 'helper', body: 'an earlier answer'}],
      })
      expect(graphql).toHaveBeenCalledWith(
        expect.stringContaining('comments(last: $maxComments)'),
        expect.objectContaining({owner: 'test-owner', repo: 'test-repo', number: 9}),
      )
    })

    it('proceeds with no hydrated context when the discussion query fails', async () => {
      // #given a client whose GraphQL calls fail
      const octokit = {graphql: vi.fn().mockRejectedValue(new Error('Resource not accessible'))} as unknown as Octokit
      const triggerContext = createMockTriggerContext({eventType: 'discussion_comment', target: discussionTarget})

      // #when collecting context
      const ctx = await collectAgentContext({logger: mockLogger, octokit, triggerContext, botLogin: null})

      // #then it does not throw and carries what the event provided
      expect(ctx.hydratedContext).toBeNull()
      expect(ctx.issueNumber).toBe(9)
      expect(ctx.issueTitle).toBe('Question')
    })

    it('does not call the discussion query for an issue target', async () => {
      // #given an issue trigger
      const graphql = vi.fn().mockResolvedValue({repository: {issue: null}})
      const octokit = {
        graphql,
        rest: {issues: {get: vi.fn().mockRejectedValue(new Error('nope')), listComments: vi.fn()}},
      } as unknown as Octokit
      const triggerContext = createMockTriggerContext({target: createMockTarget({kind: 'issue', number: 5})})

      // #when collecting context
      await collectAgentContext({logger: mockLogger, octokit, triggerContext, botLogin: null})

      // #then only the issue query ran
      expect(graphql).toHaveBeenCalledTimes(1)
      expect(graphql).toHaveBeenCalledWith(expect.stringContaining('issue(number: $number)'), expect.anything())
    })
  })
})
