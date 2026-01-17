import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {TriggerContext} from '../triggers/types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {getCommentAuthor, getCommentTarget, parseGitHubContext} from '../github/context.js'
import {collectAgentContext} from './context.js'

vi.mock('../github/context.js', () => ({
  parseGitHubContext: vi.fn(),
  getCommentTarget: vi.fn(),
  getCommentAuthor: vi.fn(),
}))

vi.mock('../github/api.js', () => ({
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
}))

vi.mock('./diff-context.js', () => ({
  collectDiffContext: vi.fn().mockResolvedValue(null),
}))

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createMockOctokit(): Octokit {
  return {} as Octokit
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

function createMockGitHubContext(overrides: Record<string, unknown> = {}) {
  const eventType = (overrides.eventType as string) ?? 'issue_comment'
  const defaultPayload =
    eventType === 'issue_comment'
      ? {
          comment: {id: 1, body: 'test comment', user: {login: 'test-user'}},
          issue: {id: 1, title: 'Test Issue'},
        }
      : {}

  return {
    eventName: 'issue_comment',
    eventType: 'issue_comment' as const,
    repo: {owner: 'test-owner', repo: 'test-repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'test-actor',
    payload: defaultPayload,
    ...overrides,
  }
}

describe('collectAgentContext', () => {
  let mockLogger: Logger
  let mockOctokit: Octokit
  let mockTriggerContext: TriggerContext

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockOctokit = createMockOctokit()
    mockTriggerContext = createMockTriggerContext()
    vi.clearAllMocks()

    vi.mocked(parseGitHubContext).mockReturnValue(createMockGitHubContext())
    vi.mocked(getCommentTarget).mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('extracts basic context from GitHub Actions environment', async () => {
    // #given
    vi.mocked(parseGitHubContext).mockReturnValue(createMockGitHubContext())

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext: mockTriggerContext,
    })

    // #then
    expect(ctx.eventName).toBe('issue_comment')
    expect(ctx.repo).toBe('test-owner/test-repo')
    expect(ctx.actor).toBe('test-actor')
    expect(ctx.runId).toBe('12345')
  })

  it('extracts comment details from issue_comment payload', async () => {
    // #given
    const mockPayload = {
      comment: {
        id: 999,
        body: 'Please fix the bug',
        user: {login: 'reporter'},
      },
      issue: {id: 1, title: 'Test Issue'},
    }
    vi.mocked(parseGitHubContext).mockReturnValue(
      createMockGitHubContext({eventType: 'issue_comment', payload: mockPayload}),
    )
    vi.mocked(getCommentAuthor).mockReturnValue('reporter')

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext: mockTriggerContext,
    })

    // #then
    expect(ctx.commentBody).toBe('Please fix the bug')
    expect(ctx.commentAuthor).toBe('reporter')
    expect(ctx.commentId).toBe(999)
  })

  it('extracts issue number and title from payload', async () => {
    // #given
    const mockPayload = {
      issue: {id: 123, title: 'Found a bug'},
      comment: {id: 1, body: 'test', user: {login: 'user'}},
    }
    vi.mocked(parseGitHubContext).mockReturnValue(
      createMockGitHubContext({eventType: 'issue_comment', payload: mockPayload}),
    )
    vi.mocked(getCommentTarget).mockReturnValue({
      number: 123,
      type: 'issue',
      owner: 'test-owner',
      repo: 'test-repo',
    })

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext: mockTriggerContext,
    })

    // #then
    expect(ctx.issueNumber).toBe(123)
    expect(ctx.issueTitle).toBe('Found a bug')
    expect(ctx.issueType).toBe('issue')
  })

  it('detects PR type when pull_request field is present', async () => {
    // #given
    vi.mocked(parseGitHubContext).mockReturnValue(createMockGitHubContext())
    vi.mocked(getCommentTarget).mockReturnValue({
      number: 42,
      type: 'pr',
      owner: 'test-owner',
      repo: 'test-repo',
    })

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext: mockTriggerContext,
    })

    // #then
    expect(ctx.issueType).toBe('pr')
  })

  it('returns null for comment fields on non-comment events', async () => {
    // #given
    vi.mocked(parseGitHubContext).mockReturnValue(
      createMockGitHubContext({eventName: 'workflow_dispatch', eventType: 'workflow_dispatch'}),
    )
    vi.mocked(getCommentTarget).mockReturnValue(null)

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext: mockTriggerContext,
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
    const mockPayload = {
      comment: {id: 1, body: 'test', user: {login: 'user'}},
      issue: {id: 1, title: 'Test Issue'},
    }
    vi.mocked(parseGitHubContext).mockReturnValue(
      createMockGitHubContext({eventType: 'issue_comment', payload: mockPayload}),
    )

    // #when
    await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext: mockTriggerContext,
    })

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

  it('defaults to "main" for defaultBranch', async () => {
    // #given
    vi.mocked(parseGitHubContext).mockReturnValue(createMockGitHubContext())

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext: mockTriggerContext,
    })

    // #then
    expect(ctx.defaultBranch).toBe('main')
  })

  it('returns null for diffContext when collectDiffContext returns null', async () => {
    // #given
    vi.mocked(parseGitHubContext).mockReturnValue(createMockGitHubContext())

    // #when
    const ctx = await collectAgentContext({
      logger: mockLogger,
      octokit: mockOctokit,
      triggerContext: mockTriggerContext,
    })

    // #then
    expect(ctx.diffContext).toBeNull()
  })
})
