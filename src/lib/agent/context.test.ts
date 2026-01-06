import type {IssueCommentPayload} from '../github/types.js'
import type {Logger} from '../logger.js'
import * as exec from '@actions/exec'

// Import after mocks are set up
import * as github from '@actions/github'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {collectAgentContext, fetchDefaultBranch} from './context.js'

// Mock @actions/github before importing the module under test
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

// Mock @actions/exec for fetchDefaultBranch
vi.mock('@actions/exec', () => ({
  getExecOutput: vi.fn(),
}))

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createIssueCommentPayload(overrides: Partial<IssueCommentPayload> = {}): IssueCommentPayload {
  return {
    action: 'created',
    issue: {
      number: 42,
      title: 'Test Issue Title',
      body: 'Issue body',
      state: 'open',
      user: {login: 'issue-author'},
      locked: false,
      ...overrides.issue,
    },
    comment: {
      id: 123456,
      body: 'Hello agent, please help!',
      user: {login: 'commenter'},
      author_association: 'MEMBER',
      ...overrides.comment,
    },
    repository: {
      owner: {login: 'test-owner'},
      name: 'test-repo',
      full_name: 'test-owner/test-repo',
      ...overrides.repository,
    },
    sender: {login: 'commenter'},
    ...overrides,
  } as IssueCommentPayload
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
    const payload = createIssueCommentPayload()
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
    const payload = createIssueCommentPayload({
      comment: {
        id: 999,
        body: 'Please fix the bug',
        user: {login: 'reporter'},
        author_association: 'COLLABORATOR',
      },
    })
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.commentBody).toBe('Please fix the bug')
    expect(ctx.commentAuthor).toBe('reporter')
    expect(ctx.commentId).toBe(999)
  })

  it('extracts issue number and title from payload', () => {
    // #given
    const payload = createIssueCommentPayload({
      issue: {
        number: 123,
        title: 'Bug: Something is broken',
        body: 'Details here',
        state: 'open',
        user: {login: 'author'},
        locked: false,
      },
    })
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.issueNumber).toBe(123)
    expect(ctx.issueTitle).toBe('Bug: Something is broken')
    expect(ctx.issueType).toBe('issue')
  })

  it('detects PR type when pull_request field is present', () => {
    // #given
    const payload = createIssueCommentPayload()
    // Add pull_request field to indicate this is a PR
    ;(payload.issue as Record<string, unknown>).pull_request = {url: 'https://api.github.com/...'}
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
    const payload = createIssueCommentPayload()
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
    const payload = createIssueCommentPayload()
    vi.mocked(github.context).eventName = 'issue_comment'
    vi.mocked(github.context).payload = payload as unknown as typeof github.context.payload

    // #when
    const ctx = collectAgentContext(mockLogger)

    // #then
    expect(ctx.defaultBranch).toBe('main')
  })
})

describe('fetchDefaultBranch', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches default branch via gh CLI', async () => {
    // #given
    vi.mocked(exec.getExecOutput).mockResolvedValue({
      stdout: 'develop\n',
      stderr: '',
      exitCode: 0,
    })

    // #when
    const branch = await fetchDefaultBranch('owner/repo', mockLogger)

    // #then
    expect(branch).toBe('develop')
    expect(exec.getExecOutput).toHaveBeenCalledWith('gh', ['api', '/repos/owner/repo', '--jq', '.default_branch'], {
      silent: true,
    })
  })

  it('returns "main" on API failure', async () => {
    // #given
    vi.mocked(exec.getExecOutput).mockRejectedValue(new Error('API error'))

    // #when
    const branch = await fetchDefaultBranch('owner/repo', mockLogger)

    // #then
    expect(branch).toBe('main')
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to fetch default branch',
      expect.objectContaining({error: 'API error'}),
    )
  })

  it('returns "main" when stdout is empty', async () => {
    // #given
    vi.mocked(exec.getExecOutput).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    })

    // #when
    const branch = await fetchDefaultBranch('owner/repo', mockLogger)

    // #then
    expect(branch).toBe('main')
  })
})
