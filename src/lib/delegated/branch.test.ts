import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {branchExists, createBranch, deleteBranch, generateBranchName} from './branch.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createMockOctokit(
  overrides: {
    getRef?: ReturnType<typeof vi.fn>
    createRef?: ReturnType<typeof vi.fn>
    deleteRef?: ReturnType<typeof vi.fn>
  } = {},
): Octokit {
  return {
    rest: {
      git: {
        getRef: overrides.getRef ?? vi.fn(),
        createRef: overrides.createRef ?? vi.fn(),
        deleteRef: overrides.deleteRef ?? vi.fn(),
      },
    },
  } as unknown as Octokit
}

describe('createBranch', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('creates branch from base', async () => {
    // #given
    const getRef = vi.fn().mockResolvedValue({
      data: {object: {sha: 'abc123'}},
    })
    const createRef = vi.fn().mockResolvedValue({data: {}})
    const octokit = createMockOctokit({getRef, createRef})

    // #when
    const result = await createBranch(
      octokit,
      {
        owner: 'owner',
        repo: 'repo',
        branchName: 'feature/test',
        baseBranch: 'main',
      },
      logger,
    )

    // #then
    expect(result.created).toBe(true)
    expect(result.name).toBe('feature/test')
    expect(result.sha).toBe('abc123')
    expect(createRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/feature/test',
      sha: 'abc123',
    })
  })

  it('returns existing branch when already exists', async () => {
    // #given
    const getRef = vi
      .fn()
      .mockResolvedValueOnce({data: {object: {sha: 'base-sha'}}})
      .mockResolvedValueOnce({data: {object: {sha: 'existing-sha'}}})

    const createRef = vi.fn().mockRejectedValue(new Error('Reference already exists'))
    const octokit = createMockOctokit({getRef, createRef})

    // #when
    const result = await createBranch(
      octokit,
      {
        owner: 'owner',
        repo: 'repo',
        branchName: 'existing-branch',
        baseBranch: 'main',
      },
      logger,
    )

    // #then
    expect(result.created).toBe(false)
    expect(result.name).toBe('existing-branch')
    expect(result.sha).toBe('existing-sha')
  })

  it('throws for other errors', async () => {
    // #given
    const getRef = vi.fn().mockResolvedValue({data: {object: {sha: 'abc123'}}})
    const createRef = vi.fn().mockRejectedValue(new Error('Branch protection error'))
    const octokit = createMockOctokit({getRef, createRef})

    // #when / #then
    await expect(
      createBranch(
        octokit,
        {
          owner: 'owner',
          repo: 'repo',
          branchName: 'protected-branch',
          baseBranch: 'main',
        },
        logger,
      ),
    ).rejects.toThrow('Branch protection error')
  })
})

describe('branchExists', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns true when branch exists', async () => {
    // #given
    const getRef = vi.fn().mockResolvedValue({data: {object: {sha: 'abc123'}}})
    const octokit = createMockOctokit({getRef})

    // #when
    const result = await branchExists(octokit, 'owner', 'repo', 'main', logger)

    // #then
    expect(result).toBe(true)
  })

  it('returns false when branch does not exist', async () => {
    // #given
    const getRef = vi.fn().mockRejectedValue(new Error('Not found'))
    const octokit = createMockOctokit({getRef})

    // #when
    const result = await branchExists(octokit, 'owner', 'repo', 'nonexistent', logger)

    // #then
    expect(result).toBe(false)
  })
})

describe('deleteBranch', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('deletes existing branch', async () => {
    // #given
    const deleteRef = vi.fn().mockResolvedValue({data: {}})
    const octokit = createMockOctokit({deleteRef})

    // #when
    await deleteBranch(octokit, 'owner', 'repo', 'feature/done', logger)

    // #then
    expect(deleteRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'heads/feature/done',
    })
  })

  it('throws when branch does not exist', async () => {
    // #given
    const deleteRef = vi.fn().mockRejectedValue(new Error('Reference does not exist'))
    const octokit = createMockOctokit({deleteRef})

    // #when / #then
    await expect(deleteBranch(octokit, 'owner', 'repo', 'nonexistent', logger)).rejects.toThrow(
      'Reference does not exist',
    )
  })
})

describe('generateBranchName', () => {
  it('generates branch name with prefix and timestamp', () => {
    // #given
    const before = Date.now()

    // #when
    const result = generateBranchName('fro-bot')

    // #then
    expect(result).toMatch(/^fro-bot-\d+-[a-z0-9]+$/)
    const parts = result.split('-')
    const timestamp = Number(parts[2])
    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(Date.now())
  })

  it('appends suffix when provided', () => {
    // #given / #when
    const result = generateBranchName('fix', 'issue-123')

    // #then
    expect(result).toMatch(/^fix-\d+-[a-z0-9]+-issue-123$/)
  })

  it('generates unique names on successive calls', () => {
    // #given / #when
    const name1 = generateBranchName('feature')
    const name2 = generateBranchName('feature')

    // #then
    expect(name1).not.toBe(name2)
  })
})
