import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {ReactionContext} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, createMockOctokit} from '../test-helpers.js'
import {
  acknowledgeReceipt,
  addEyesReaction,
  addWorkingLabel,
  completeAcknowledgment,
  removeWorkingLabel,
  updateReactionOnFailure,
  updateReactionOnSuccess,
} from './reactions.js'

function createMockReactionContext(overrides: Partial<ReactionContext> = {}): ReactionContext {
  return {
    repo: 'owner/repo',
    commentId: 12345,
    issueNumber: 42,
    issueType: 'issue',
    botLogin: 'fro-bot[bot]',
    ...overrides,
  }
}

describe('addEyesReaction', () => {
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

  it('adds eyes reaction to comment via Octokit API', async () => {
    // #given
    const ctx = createMockReactionContext({commentId: 99999})

    // #when
    const result = await addEyesReaction(mockOctokit, ctx, mockLogger)

    // #then
    expect(result).toBe(true)
    expect(mockOctokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 99999,
      content: 'eyes',
    })
  })

  it('returns false when commentId is null', async () => {
    // #given
    const ctx = createMockReactionContext({commentId: null})

    // #when
    const result = await addEyesReaction(mockOctokit, ctx, mockLogger)

    // #then
    expect(result).toBe(false)
    expect(mockOctokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalledWith('No comment ID, skipping eyes reaction')
  })

  it('returns false on API failure', async () => {
    // #given
    vi.mocked(mockOctokit.rest.reactions.createForIssueComment).mockRejectedValue(new Error('API error'))
    const ctx = createMockReactionContext()

    // #when
    const result = await addEyesReaction(mockOctokit, ctx, mockLogger)

    // #then
    expect(result).toBe(false)
  })
})

describe('addWorkingLabel', () => {
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

  it('creates label and adds it to issue', async () => {
    // #given
    const ctx = createMockReactionContext({issueNumber: 123, issueType: 'issue'})

    // #when
    const result = await addWorkingLabel(mockOctokit, ctx, mockLogger)

    // #then
    expect(result).toBe(true)
    expect(mockOctokit.rest.issues.createLabel).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      name: 'agent: working',
      color: 'fcf2e1',
      description: 'Agent is currently working on this',
    })
    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      labels: ['agent: working'],
    })
  })

  it('returns false when issueNumber is null', async () => {
    // #given
    const ctx = createMockReactionContext({issueNumber: null})

    // #when
    const result = await addWorkingLabel(mockOctokit, ctx, mockLogger)

    // #then
    expect(result).toBe(false)
    expect(mockOctokit.rest.issues.createLabel).not.toHaveBeenCalled()
  })

  it('returns false on failure', async () => {
    // #given
    vi.mocked(mockOctokit.rest.issues.createLabel).mockRejectedValue(new Error('Permission denied'))
    const ctx = createMockReactionContext()

    // #when
    const result = await addWorkingLabel(mockOctokit, ctx, mockLogger)

    // #then
    expect(result).toBe(false)
  })
})

describe('acknowledgeReceipt', () => {
  let mockLogger: Logger
  let mockOctokit: Octokit

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockOctokit = createMockOctokit()
    vi.clearAllMocks()
  })

  it('runs both reaction and label operations in parallel', async () => {
    // #given
    const ctx = createMockReactionContext()

    // #when
    await acknowledgeReceipt(mockOctokit, ctx, mockLogger)

    // #then
    expect(mockOctokit.rest.reactions.createForIssueComment).toHaveBeenCalled()
    expect(mockOctokit.rest.issues.createLabel).toHaveBeenCalled()
    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalled()
  })
})

describe('removeWorkingLabel', () => {
  let mockLogger: Logger
  let mockOctokit: Octokit

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockOctokit = createMockOctokit()
    vi.clearAllMocks()
  })

  it('removes working label from issue', async () => {
    // #given
    const ctx = createMockReactionContext({issueNumber: 42, issueType: 'issue'})

    // #when
    await removeWorkingLabel(mockOctokit, ctx, mockLogger)

    // #then
    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      name: 'agent: working',
    })
  })

  it('skips when issueNumber is null', async () => {
    // #given
    const ctx = createMockReactionContext({issueNumber: null})

    // #when
    await removeWorkingLabel(mockOctokit, ctx, mockLogger)

    // #then
    expect(mockOctokit.rest.issues.removeLabel).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalledWith('No issue number, skipping label removal')
  })
})

describe('updateReactionOnSuccess', () => {
  let mockLogger: Logger
  let mockOctokit: Octokit

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockOctokit = createMockOctokit()
    vi.clearAllMocks()
  })

  it('removes eyes reaction and adds hooray reaction', async () => {
    // #given
    vi.mocked(mockOctokit.rest.reactions.listForIssueComment).mockResolvedValue({
      data: [{id: 777, content: 'eyes', user: {login: 'fro-bot[bot]'}}],
    } as never)
    const ctx = createMockReactionContext({commentId: 123, botLogin: 'fro-bot[bot]'})

    // #when
    await updateReactionOnSuccess(mockOctokit, ctx, mockLogger)

    // #then
    expect(mockOctokit.rest.reactions.listForIssueComment).toHaveBeenCalled()
    expect(mockOctokit.rest.reactions.deleteForIssueComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 123,
      reaction_id: 777,
    })
    expect(mockOctokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 123,
      content: 'hooray',
    })
  })

  it('skips when commentId or botLogin is null', async () => {
    // #given
    const ctx = createMockReactionContext({commentId: null, botLogin: 'bot'})

    // #when
    await updateReactionOnSuccess(mockOctokit, ctx, mockLogger)

    // #then
    expect(mockOctokit.rest.reactions.listForIssueComment).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalled()
  })
})

describe('updateReactionOnFailure', () => {
  let mockLogger: Logger
  let mockOctokit: Octokit

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockOctokit = createMockOctokit()
    vi.clearAllMocks()
  })

  it('removes eyes reaction and adds confused reaction', async () => {
    // #given
    vi.mocked(mockOctokit.rest.reactions.listForIssueComment).mockResolvedValue({
      data: [{id: 888, content: 'eyes', user: {login: 'fro-bot[bot]'}}],
    } as never)
    const ctx = createMockReactionContext({commentId: 456, botLogin: 'fro-bot[bot]'})

    // #when
    await updateReactionOnFailure(mockOctokit, ctx, mockLogger)

    // #then
    expect(mockOctokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 456,
      content: 'confused',
    })
  })
})

describe('completeAcknowledgment', () => {
  let mockLogger: Logger
  let mockOctokit: Octokit

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockOctokit = createMockOctokit()
    vi.clearAllMocks()
  })

  it('updates reaction to success and removes label on success', async () => {
    // #given
    vi.mocked(mockOctokit.rest.reactions.listForIssueComment).mockResolvedValue({data: []} as never)
    const ctx = createMockReactionContext()

    // #when
    await completeAcknowledgment(mockOctokit, ctx, true, mockLogger)

    // #then
    expect(mockOctokit.rest.reactions.createForIssueComment).toHaveBeenCalled()
    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalled()
  })

  it('updates reaction to failure and removes label on failure', async () => {
    // #given
    vi.mocked(mockOctokit.rest.reactions.listForIssueComment).mockResolvedValue({data: []} as never)
    const ctx = createMockReactionContext()

    // #when
    await completeAcknowledgment(mockOctokit, ctx, false, mockLogger)

    // #then
    expect(mockOctokit.rest.reactions.createForIssueComment).toHaveBeenCalled()
    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalled()
  })
})
