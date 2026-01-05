import type {Logger} from '../logger.js'
import type {ReactionContext} from './types.js'
import * as exec from '@actions/exec'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  acknowledgeReceipt,
  addEyesReaction,
  addWorkingLabel,
  completeAcknowledgment,
  removeWorkingLabel,
  updateReactionOnFailure,
  updateReactionOnSuccess,
} from './reactions.js'

// Mock @actions/exec
vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
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

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds eyes reaction to comment via gh API', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext({commentId: 99999})

    // #when
    const result = await addEyesReaction(ctx, mockLogger)

    // #then
    expect(result).toBe(true)
    expect(exec.exec).toHaveBeenCalledWith(
      'gh',
      ['api', '--method', 'POST', '/repos/owner/repo/issues/comments/99999/reactions', '-f', 'content=eyes'],
      {silent: true},
    )
  })

  it('returns false when commentId is null', async () => {
    // #given
    const ctx = createMockReactionContext({commentId: null})

    // #when
    const result = await addEyesReaction(ctx, mockLogger)

    // #then
    expect(result).toBe(false)
    expect(exec.exec).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalledWith('No comment ID, skipping eyes reaction')
  })

  it('returns false and logs warning on API failure', async () => {
    // #given
    vi.mocked(exec.exec).mockRejectedValue(new Error('API error'))
    const ctx = createMockReactionContext()

    // #when
    const result = await addEyesReaction(ctx, mockLogger)

    // #then
    expect(result).toBe(false)
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to add eyes reaction (non-fatal)',
      expect.objectContaining({error: 'API error'}),
    )
  })
})

describe('addWorkingLabel', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates label and adds it to issue', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext({issueNumber: 123, issueType: 'issue'})

    // #when
    const result = await addWorkingLabel(ctx, mockLogger)

    // #then
    expect(result).toBe(true)
    // First call creates/updates the label
    expect(exec.exec).toHaveBeenCalledWith(
      'gh',
      [
        'label',
        'create',
        'agent: working',
        '--color',
        'fcf2e1',
        '--description',
        'Agent is currently working on this',
        '--force',
      ],
      {silent: true},
    )
    // Second call adds label to issue
    expect(exec.exec).toHaveBeenCalledWith('gh', ['issue', 'edit', '123', '--add-label', 'agent: working'], {
      silent: true,
    })
  })

  it('uses pr command for PR type', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext({issueNumber: 456, issueType: 'pr'})

    // #when
    await addWorkingLabel(ctx, mockLogger)

    // #then
    expect(exec.exec).toHaveBeenCalledWith('gh', ['pr', 'edit', '456', '--add-label', 'agent: working'], {silent: true})
  })

  it('returns false when issueNumber is null', async () => {
    // #given
    const ctx = createMockReactionContext({issueNumber: null})

    // #when
    const result = await addWorkingLabel(ctx, mockLogger)

    // #then
    expect(result).toBe(false)
    expect(exec.exec).not.toHaveBeenCalled()
  })

  it('returns false and logs warning on failure', async () => {
    // #given
    vi.mocked(exec.exec).mockRejectedValue(new Error('Permission denied'))
    const ctx = createMockReactionContext()

    // #when
    const result = await addWorkingLabel(ctx, mockLogger)

    // #then
    expect(result).toBe(false)
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to add working label (non-fatal)',
      expect.objectContaining({error: 'Permission denied'}),
    )
  })
})

describe('acknowledgeReceipt', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('runs both reaction and label operations in parallel', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext()

    // #when
    await acknowledgeReceipt(ctx, mockLogger)

    // #then
    // Should have made calls for both eyes reaction and working label
    expect(exec.exec).toHaveBeenCalledTimes(3) // label create + label add + reaction
  })
})

describe('removeWorkingLabel', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('removes working label from issue', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext({issueNumber: 42, issueType: 'issue'})

    // #when
    await removeWorkingLabel(ctx, mockLogger)

    // #then
    expect(exec.exec).toHaveBeenCalledWith('gh', ['issue', 'edit', '42', '--remove-label', 'agent: working'], {
      silent: true,
    })
  })

  it('uses pr command for PR type', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext({issueNumber: 99, issueType: 'pr'})

    // #when
    await removeWorkingLabel(ctx, mockLogger)

    // #then
    expect(exec.exec).toHaveBeenCalledWith('gh', ['pr', 'edit', '99', '--remove-label', 'agent: working'], {
      silent: true,
    })
  })

  it('skips when issueNumber is null', async () => {
    // #given
    const ctx = createMockReactionContext({issueNumber: null})

    // #when
    await removeWorkingLabel(ctx, mockLogger)

    // #then
    expect(exec.exec).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalledWith('No issue number, skipping label removal')
  })
})

describe('updateReactionOnSuccess', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('removes eyes reaction and adds hooray reaction', async () => {
    // #given
    vi.mocked(exec.getExecOutput).mockResolvedValue({
      stdout: '777\n',
      stderr: '',
      exitCode: 0,
    })
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext({commentId: 123, botLogin: 'fro-bot[bot]'})

    // #when
    await updateReactionOnSuccess(ctx, mockLogger)

    // #then
    // Should query for eyes reaction
    expect(exec.getExecOutput).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['api', '/repos/owner/repo/issues/comments/123/reactions']),
      {silent: true},
    )
    // Should delete the eyes reaction
    expect(exec.exec).toHaveBeenCalledWith('gh', ['api', '--method', 'DELETE', '/repos/owner/repo/reactions/777'], {
      silent: true,
    })
    // Should add hooray reaction
    expect(exec.exec).toHaveBeenCalledWith('gh', expect.arrayContaining(['content=hooray']), {silent: true})
  })

  it('skips when commentId or botLogin is null', async () => {
    // #given
    const ctx = createMockReactionContext({commentId: null, botLogin: 'bot'})

    // #when
    await updateReactionOnSuccess(ctx, mockLogger)

    // #then
    expect(exec.getExecOutput).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalled()
  })
})

describe('updateReactionOnFailure', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('removes eyes reaction and adds confused reaction', async () => {
    // #given
    vi.mocked(exec.getExecOutput).mockResolvedValue({
      stdout: '888\n',
      stderr: '',
      exitCode: 0,
    })
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext({commentId: 456, botLogin: 'fro-bot[bot]'})

    // #when
    await updateReactionOnFailure(ctx, mockLogger)

    // #then
    // Should add confused reaction
    expect(exec.exec).toHaveBeenCalledWith('gh', expect.arrayContaining(['content=confused']), {silent: true})
  })
})

describe('completeAcknowledgment', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('updates reaction to success and removes label on success', async () => {
    // #given
    vi.mocked(exec.getExecOutput).mockResolvedValue({stdout: '123', stderr: '', exitCode: 0})
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext()

    // #when
    await completeAcknowledgment(ctx, true, mockLogger)

    // #then
    // Should have called for success reaction update and label removal
    expect(exec.exec).toHaveBeenCalled()
  })

  it('updates reaction to failure and removes label on failure', async () => {
    // #given
    vi.mocked(exec.getExecOutput).mockResolvedValue({stdout: '123', stderr: '', exitCode: 0})
    vi.mocked(exec.exec).mockResolvedValue(0)
    const ctx = createMockReactionContext()

    // #when
    await completeAcknowledgment(ctx, false, mockLogger)

    // #then
    expect(exec.exec).toHaveBeenCalled()
  })
})
