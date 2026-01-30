import type {Logger} from '../logger.js'

import {Buffer} from 'node:buffer'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, createMockOctokit} from '../test-helpers.js'
import {
  createCommit,
  formatCommitMessage,
  getFileContent,
  validateFilePath,
  validateFiles,
  validateFileSize,
} from './commit.js'

describe('validateFilePath', () => {
  it('accepts valid paths', () => {
    // #given / #when / #then
    expect(validateFilePath('src/index.ts').valid).toBe(true)
    expect(validateFilePath('README.md').valid).toBe(true)
    expect(validateFilePath('packages/core/lib/utils.js').valid).toBe(true)
  })

  it('rejects path traversal', () => {
    // #given / #when / #then
    expect(validateFilePath('../secrets.txt').valid).toBe(false)
    expect(validateFilePath('foo/../../bar.txt').valid).toBe(false)
  })

  it('rejects .git paths', () => {
    // #given / #when / #then
    expect(validateFilePath('.git/config').valid).toBe(false)
    expect(validateFilePath('foo/.git/objects').valid).toBe(false)
  })

  it('rejects forbidden secret files', () => {
    // #given / #when / #then
    expect(validateFilePath('.env').valid).toBe(false)
    expect(validateFilePath('config/.env.local').valid).toBe(false)
    expect(validateFilePath('auth.json').valid).toBe(false)
  })

  it('rejects forbidden extensions', () => {
    // #given / #when / #then
    expect(validateFilePath('private.key').valid).toBe(false)
    expect(validateFilePath('cert.pem').valid).toBe(false)
    expect(validateFilePath('store.p12').valid).toBe(false)
  })
})

describe('validateFileSize', () => {
  it('accepts small files', () => {
    // #given / #when / #then
    expect(validateFileSize('hello world').valid).toBe(true)
    expect(validateFileSize('x'.repeat(1000)).valid).toBe(true)
  })

  it('rejects files exceeding limit', () => {
    // #given
    const largeContent = 'x'.repeat(6 * 1024 * 1024)

    // #when / #then
    expect(validateFileSize(largeContent).valid).toBe(false)
  })
})

describe('validateFiles', () => {
  it('validates multiple files', () => {
    // #given
    const files = [
      {path: 'src/index.ts', content: 'export {}'},
      {path: 'README.md', content: '# Hello'},
    ]

    // #when
    const result = validateFiles(files)

    // #then
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('collects all validation errors', () => {
    // #given
    const files = [
      {path: '.env', content: 'SECRET=value'},
      {path: '../escape.txt', content: 'data'},
    ]

    // #when
    const result = validateFiles(files)

    // #then
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('createCommit', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('creates atomic commit with multiple files', async () => {
    // #given
    const getRef = vi.fn().mockResolvedValue({data: {object: {sha: 'current-sha'}}})
    const getCommit = vi.fn().mockResolvedValue({data: {tree: {sha: 'base-tree-sha'}}})
    const createBlob = vi
      .fn()
      .mockResolvedValueOnce({data: {sha: 'blob1-sha'}})
      .mockResolvedValueOnce({data: {sha: 'blob2-sha'}})
    const createTree = vi.fn().mockResolvedValue({data: {sha: 'new-tree-sha'}})
    const createCommitFn = vi.fn().mockResolvedValue({
      data: {sha: 'new-commit-sha', html_url: 'https://github.com/...', message: 'feat: add files'},
    })
    const updateRef = vi.fn().mockResolvedValue({data: {}})

    const octokit = createMockOctokit({
      getRef,
      getCommit,
      createBlob,
      createTree,
      createCommit: createCommitFn,
      updateRef,
    })

    // #when
    const result = await createCommit(
      octokit,
      {
        owner: 'owner',
        repo: 'repo',
        branch: 'feature',
        message: 'feat: add files',
        files: [
          {path: 'src/a.ts', content: 'export const a = 1'},
          {path: 'src/b.ts', content: 'export const b = 2'},
        ],
      },
      logger,
    )

    // #then
    expect(result.sha).toBe('new-commit-sha')
    expect(createBlob).toHaveBeenCalledTimes(2)
    expect(createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        base_tree: 'base-tree-sha',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tree: expect.arrayContaining([
          expect.objectContaining({path: 'src/a.ts', sha: 'blob1-sha'}),
          expect.objectContaining({path: 'src/b.ts', sha: 'blob2-sha'}),
        ]),
      }),
    )
    expect(updateRef).toHaveBeenCalledWith(
      expect.objectContaining({
        force: false,
      }),
    )
  })

  it('uses custom author when provided', async () => {
    // #given
    const getRef = vi.fn().mockResolvedValue({data: {object: {sha: 'sha'}}})
    const getCommit = vi.fn().mockResolvedValue({data: {tree: {sha: 'tree'}}})
    const createBlob = vi.fn().mockResolvedValue({data: {sha: 'blob'}})
    const createTree = vi.fn().mockResolvedValue({data: {sha: 'tree'}})
    const createCommitFn = vi.fn().mockResolvedValue({
      data: {sha: 'commit', html_url: 'url', message: 'msg'},
    })
    const updateRef = vi.fn().mockResolvedValue({data: {}})

    const octokit = createMockOctokit({
      getRef,
      getCommit,
      createBlob,
      createTree,
      createCommit: createCommitFn,
      updateRef,
    })

    // #when
    await createCommit(
      octokit,
      {
        owner: 'owner',
        repo: 'repo',
        branch: 'main',
        message: 'fix: something',
        files: [{path: 'file.txt', content: 'data'}],
        author: {name: 'Custom Author', email: 'author@example.com'},
      },
      logger,
    )

    // #then
    expect(createCommitFn).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        author: expect.objectContaining({
          name: 'Custom Author',
          email: 'author@example.com',
        }),
      }),
    )
  })

  it('throws on file validation failure', async () => {
    // #given
    const octokit = createMockOctokit()

    // #when / #then
    await expect(
      createCommit(
        octokit,
        {
          owner: 'owner',
          repo: 'repo',
          branch: 'main',
          message: 'bad commit',
          files: [{path: '.env', content: 'SECRET=value'}],
        },
        logger,
      ),
    ).rejects.toThrow('File validation failed')
  })
})

describe('getFileContent', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns decoded content', async () => {
    // #given
    const content = Buffer.from('hello world').toString('base64')
    const getContent = vi.fn().mockResolvedValue({data: {content}})
    const octokit = createMockOctokit({getContent})

    // #when
    const result = await getFileContent(octokit, 'owner', 'repo', 'file.txt', 'main', logger)

    // #then
    expect(result).toBe('hello world')
  })

  it('returns null for missing files', async () => {
    // #given
    const getContent = vi.fn().mockRejectedValue({status: 404})
    const octokit = createMockOctokit({getContent})

    // #when
    const result = await getFileContent(octokit, 'owner', 'repo', 'missing.txt', 'main', logger)

    // #then
    expect(result).toBeNull()
  })
})

describe('formatCommitMessage', () => {
  it('formats with scope', () => {
    // #given / #when
    const result = formatCommitMessage('feat', 'auth', 'add login')

    // #then
    expect(result).toBe('feat(auth): add login')
  })

  it('formats without scope', () => {
    // #given / #when
    const result = formatCommitMessage('fix', null, 'typo')

    // #then
    expect(result).toBe('fix: typo')
  })

  it('includes body when provided', () => {
    // #given / #when
    const result = formatCommitMessage('feat', 'api', 'add endpoint', 'This adds the new /users endpoint.')

    // #then
    expect(result).toBe('feat(api): add endpoint\n\nThis adds the new /users endpoint.')
  })
})
