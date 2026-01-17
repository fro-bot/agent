import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {TriggerContext} from '../triggers/types.js'
import {describe, expect, it, vi} from 'vitest'
import {getPRDiff} from '../reviews/index.js'
import {collectDiffContext, MAX_FILES_IN_CONTEXT} from './diff-context.js'

vi.mock('../reviews/index.js', () => ({
  getPRDiff: vi.fn(),
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

function createTriggerContext(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    eventType: 'pull_request',
    eventName: 'pull_request',
    repo: {owner: 'owner', repo: 'repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'testuser',
    author: {login: 'testuser', association: 'MEMBER', isBot: false},
    target: {kind: 'pr', number: 42, title: 'Test PR', body: null, locked: false},
    commentBody: null,
    commentId: null,
    hasMention: false,
    command: null,
    raw: {} as TriggerContext['raw'],
    ...overrides,
  }
}

describe('collectDiffContext', () => {
  it('returns null for non-pull_request events', async () => {
    // #given trigger context for issue_comment event
    const context = createTriggerContext({eventType: 'issue_comment'})
    const logger = createMockLogger()

    // #when collecting diff context
    const result = await collectDiffContext(context, createMockOctokit(), 'owner/repo', logger)

    // #then should return null without calling getPRDiff
    expect(result).toBeNull()
    expect(getPRDiff).not.toHaveBeenCalled()
  })

  it('returns null when PR number is missing', async () => {
    // #given trigger context without target number
    const context = createTriggerContext({target: undefined})
    const logger = createMockLogger()

    // #when collecting diff context
    const result = await collectDiffContext(context, createMockOctokit(), 'owner/repo', logger)

    // #then should return null and log debug message
    expect(result).toBeNull()
    expect(logger.debug).toHaveBeenCalledWith('No PR number in trigger context, skipping diff collection')
  })

  it('returns null for invalid repo format', async () => {
    // #given trigger context with valid PR but invalid repo format
    const context = createTriggerContext()
    const logger = createMockLogger()

    // #when collecting diff context with invalid repo
    const result = await collectDiffContext(context, createMockOctokit(), 'invalid-repo', logger)

    // #then should return null and log warning
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalledWith('Invalid repo format, skipping diff collection', {repo: 'invalid-repo'})
  })

  it('fetches and transforms PR diff on success', async () => {
    // #given mock PR diff data
    const mockDiff = {
      changedFiles: 3,
      additions: 100,
      deletions: 50,
      truncated: false,
      files: [
        {
          filename: 'src/a.ts',
          status: 'modified' as const,
          additions: 40,
          deletions: 20,
          patch: '...',
          previousFilename: null,
        },
        {
          filename: 'src/b.ts',
          status: 'added' as const,
          additions: 60,
          deletions: 0,
          patch: '...',
          previousFilename: null,
        },
        {
          filename: 'src/c.ts',
          status: 'removed' as const,
          additions: 0,
          deletions: 30,
          patch: '...',
          previousFilename: null,
        },
      ],
    }
    vi.mocked(getPRDiff).mockResolvedValue(mockDiff)

    const context = createTriggerContext()
    const logger = createMockLogger()

    // #when collecting diff context
    const result = await collectDiffContext(context, createMockOctokit(), 'owner/repo', logger)

    // #then should return transformed DiffContext
    expect(result).toEqual({
      changedFiles: 3,
      additions: 100,
      deletions: 50,
      truncated: false,
      files: [
        {filename: 'src/a.ts', status: 'modified', additions: 40, deletions: 20},
        {filename: 'src/b.ts', status: 'added', additions: 60, deletions: 0},
        {filename: 'src/c.ts', status: 'removed', additions: 0, deletions: 30},
      ],
    })
    expect(getPRDiff).toHaveBeenCalledWith(expect.anything(), 'owner', 'repo', 42, logger)
  })

  it('truncates files to MAX_FILES_IN_CONTEXT', async () => {
    // #given PR diff with more files than limit
    const manyFiles = Array.from({length: MAX_FILES_IN_CONTEXT + 10}, (_, i) => ({
      filename: `file${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      patch: '...',
      previousFilename: null,
    }))
    const mockDiff = {
      changedFiles: manyFiles.length,
      additions: manyFiles.length,
      deletions: 0,
      truncated: true,
      files: manyFiles,
    }
    vi.mocked(getPRDiff).mockResolvedValue(mockDiff)

    const context = createTriggerContext()
    const logger = createMockLogger()

    // #when collecting diff context
    const result = await collectDiffContext(context, createMockOctokit(), 'owner/repo', logger)

    // #then should truncate files to MAX_FILES_IN_CONTEXT
    expect(result?.files).toHaveLength(MAX_FILES_IN_CONTEXT)
    expect(result?.changedFiles).toBe(manyFiles.length) // Original count preserved
  })

  it('returns null and logs warning on getPRDiff error', async () => {
    // #given getPRDiff throws an error
    vi.mocked(getPRDiff).mockRejectedValue(new Error('API rate limit'))

    const context = createTriggerContext()
    const logger = createMockLogger()

    // #when collecting diff context
    const result = await collectDiffContext(context, createMockOctokit(), 'owner/repo', logger)

    // #then should return null and log warning
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalledWith('Failed to fetch PR diff', {error: 'API rate limit'})
  })

  it('logs debug info on successful collection', async () => {
    // #given successful diff fetch
    const mockDiff = {
      changedFiles: 5,
      additions: 200,
      deletions: 100,
      truncated: false,
      files: [],
    }
    vi.mocked(getPRDiff).mockResolvedValue(mockDiff)

    const context = createTriggerContext()
    const logger = createMockLogger()

    // #when collecting diff context
    await collectDiffContext(context, createMockOctokit(), 'owner/repo', logger)

    // #then should log debug with diff stats
    expect(logger.debug).toHaveBeenCalledWith('Collected diff context', {
      files: 5,
      additions: 200,
      deletions: 100,
      truncated: false,
    })
  })
})
