import type {Stats} from 'node:fs'
import type {ExecAdapter} from '../../services/setup/types.js'

import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {reconstructChanges} from './reconstruct-changes.js'

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
}))

const TRUSTED_HEAD_SHA = 'a'.repeat(40)

function createMockExecAdapter(stdout = '', exitCode = 0, stderr = '', untrackedStdout = ''): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockImplementation(async (_command: string, args?: string[]) => {
      if (args?.includes('ls-files') === true) {
        return {stdout: untrackedStdout, stderr: '', exitCode: 0}
      }

      return {stdout, stderr, exitCode}
    }),
  }
}

function regularFileStats(): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
  } as Stats
}

function rawDiffEntry(oldMode: string, newMode: string, status: string, path: string): string {
  return `:${oldMode} ${newMode} ${'a'.repeat(40)} ${'b'.repeat(40)} ${status}\0${path}\0`
}

describe('reconstructChanges', () => {
  const logger = createMockLogger()

  beforeEach(() => {
    vi.mocked(fs.lstat).mockReset()
    vi.mocked(fs.readFile).mockReset()
    vi.mocked(fs.lstat).mockResolvedValue(regularFileStats())
  })

  it('maps added and modified workspace files to content changes', async () => {
    // #given a trusted anchor and a raw git diff containing an added and modified regular file
    const execAdapter = createMockExecAdapter(
      rawDiffEntry('000000', '100644', 'A', 'src/added.ts') + rawDiffEntry('100644', '100644', 'M', 'src/modified.ts'),
    )
    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const path = String(filePath)
      return path.endsWith('added.ts') ? Buffer.from('added content', 'utf8') : Buffer.from('modified content', 'utf8')
    })

    // #when the workspace is reconstructed against the trusted anchor
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then both file contents are returned without relying on the local branch or HEAD
    expect(result).toEqual({
      success: true,
      data: {
        kind: 'changes',
        changes: [
          {path: 'src/added.ts', content: 'added content'},
          {path: 'src/modified.ts', content: 'modified content'},
        ],
      },
    })
    expect(execAdapter.getExecOutput).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([TRUSTED_HEAD_SHA]),
      expect.objectContaining({cwd: '/workspace'}),
    )
    const args = vi.mocked(execAdapter.getExecOutput).mock.calls[0]?.[1] ?? []
    expect(args).not.toContain('HEAD')
    expect(args).not.toContain('origin')
  })

  it('represents deleted files without reading or dereferencing them', async () => {
    // #given a trusted anchor and a raw git diff containing a deleted regular file
    const execAdapter = createMockExecAdapter(rawDiffEntry('100644', '000000', 'D', 'src/removed.ts'))

    // #when the workspace is reconstructed
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then the deletion is represented explicitly and the deleted path is not read
    expect(result).toEqual({success: true, data: {kind: 'changes', changes: [{path: 'src/removed.ts', deleted: true}]}})
    expect(fs.lstat).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('returns an explicit nothing-to-deliver outcome for an empty net diff', async () => {
    // #given a clean workspace relative to the trusted anchor
    const execAdapter = createMockExecAdapter()

    // #when the workspace is reconstructed
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then no empty change set is returned
    expect(result).toEqual({success: true, data: {kind: 'nothing-to-deliver'}})
  })

  it('encodes non-UTF-8 file content as base64', async () => {
    // #given an added regular file containing invalid UTF-8 bytes
    const execAdapter = createMockExecAdapter(rawDiffEntry('000000', '100644', 'A', 'src/binary.bin'))
    const binaryContent = Buffer.from([0xff, 0xfe, 0x00, 0x01])
    vi.mocked(fs.readFile).mockResolvedValue(binaryContent)

    // #when the workspace is reconstructed
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then the content uses the Git Data API's base64 convention
    expect(result).toEqual({
      success: true,
      data: {
        kind: 'changes',
        changes: [{path: 'src/binary.bin', content: binaryContent.toString('base64'), encoding: 'base64'}],
      },
    })
  })

  it('uses the trusted anchor for detached or alternate local history', async () => {
    // #given a diff produced against the trusted anchor even though local history is unrelated
    const execAdapter = createMockExecAdapter(rawDiffEntry('000000', '100644', 'A', 'src/alternate-history.ts'))
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('workspace content', 'utf8'))

    // #when the workspace is reconstructed
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then the net difference is preserved without consulting HEAD, origin, or branch metadata
    expect(result).toEqual({
      success: true,
      data: {kind: 'changes', changes: [{path: 'src/alternate-history.ts', content: 'workspace content'}]},
    })
  })

  it('rejects symlink and gitlink entries before reading their paths', async () => {
    // #given a symlink and a gitlink represented by non-regular Git modes
    const execAdapter = createMockExecAdapter(
      rawDiffEntry('000000', '120000', 'A', 'src/link') + rawDiffEntry('000000', '160000', 'A', 'vendor/submodule'),
    )

    // #when the workspace is reconstructed
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then the untrusted entries are rejected and never dereferenced
    expect(result.success).toBe(false)
    expect(result.success === false && result.error.message).toContain('regular file')
    expect(fs.lstat).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('rejects symlinks reported by the filesystem instead of dereferencing them', async () => {
    // #given a regular Git mode whose workspace path is actually a symlink
    const execAdapter = createMockExecAdapter(rawDiffEntry('000000', '100644', 'A', 'src/link'))
    vi.mocked(fs.lstat).mockResolvedValue({
      isFile: () => false,
      isSymbolicLink: () => true,
    } as Stats)

    // #when the workspace is reconstructed
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then the symlink is rejected without reading its target
    expect(result.success).toBe(false)
    expect(result.success === false && result.error.message).toContain('regular file')
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('returns bypass for a missing or malformed trusted anchor', async () => {
    // #given an absent anchor
    const execAdapter = createMockExecAdapter()

    // #when reconstruction is attempted
    const missingResult = await reconstructChanges(execAdapter, '', '/workspace', logger)
    const malformedResult = await reconstructChanges(execAdapter, 'not-a-sha', '/workspace', logger)

    // #then both cases bypass without invoking Git
    expect(missingResult.success).toBe(true)
    expect(malformedResult.success).toBe(true)
    if (missingResult.success === false) throw new Error(missingResult.error.message)
    if (malformedResult.success === false) throw new Error(malformedResult.error.message)
    expect(missingResult.data.kind).toBe('bypass')
    expect(malformedResult.data.kind).toBe('bypass')
    if (missingResult.data.kind !== 'bypass') throw new Error('Expected missing anchor to bypass')
    if (malformedResult.data.kind !== 'bypass') throw new Error('Expected malformed anchor to bypass')
    expect(missingResult.data.reason.length).toBeGreaterThan(0)
    expect(malformedResult.data.reason.length).toBeGreaterThan(0)
    expect(execAdapter.getExecOutput).not.toHaveBeenCalled()
  })

  it('includes a workspace-only untracked allowlisted file as an addition', async () => {
    // #given a clean tracked diff and one untracked product file
    const execAdapter = createMockExecAdapter('', 0, '', 'src/new.ts\0')
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('new content', 'utf8'))

    // #when reconstruction runs against the trusted anchor
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then the untracked file is delivered as a normal content addition
    expect(result).toEqual({
      success: true,
      data: {kind: 'changes', changes: [{path: 'src/new.ts', content: 'new content'}]},
    })
  })

  it('includes both tracked and untracked changes without duplicating a path', async () => {
    // #given tracked changes from the anchor plus an untracked file
    const execAdapter = createMockExecAdapter(
      rawDiffEntry('100644', '100644', 'M', 'src/modified.ts'),
      0,
      '',
      'src/new.ts\0src/modified.ts\0',
    )
    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const filePathString = String(filePath)
      return filePathString.endsWith('new.ts') ? Buffer.from('new content') : Buffer.from('modified content')
    })

    // #when reconstruction runs
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then both paths are represented once, with the tracked path winning deduplication
    expect(result).toEqual({
      success: true,
      data: {
        kind: 'changes',
        changes: [
          {path: 'src/modified.ts', content: 'modified content'},
          {path: 'src/new.ts', content: 'new content'},
        ],
      },
    })
  })

  it('rejects an untracked executable before reading its contents', async () => {
    // #given an untracked file whose lstat mode is executable
    const execAdapter = createMockExecAdapter('', 0, '', 'src/executable.ts\0')
    vi.mocked(fs.lstat).mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100755,
    } as Stats)

    // #when reconstruction runs
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then the untracked executable is rejected before content reads
    expect(result.success).toBe(false)
    expect(result.success === false && result.error.message).toContain('regular files')
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing path',
      ':000000 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb A\0',
    ],
    ['unsupported status', 'X\0src/x.ts\0'],
    [
      'invalid raw-entry field count',
      ':100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\0src/x.ts\0',
    ],
    ['incomplete entry', ':100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0src/x.ts\0'],
  ])('returns an error for malformed raw diff output: %s without reading files', async (_label, stdout) => {
    // #given malformed raw diff output
    const execAdapter = createMockExecAdapter(stdout)

    // #when reconstruction parses the output
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then parsing fails before any workspace file is touched
    expect(result.success).toBe(false)
    expect(fs.lstat).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('returns an error for a nonzero git diff exit without reading files', async () => {
    // #given git reports a diff failure
    const execAdapter = createMockExecAdapter('', 128, 'fatal: bad object')

    // #when reconstruction runs
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace', logger)

    // #then the command failure is returned directly
    expect(result.success).toBe(false)
    expect(result.success === false && result.error.message).toContain('fatal: bad object')
    expect(fs.lstat).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('uses only the trusted anchor in a real repository with diverged local history', async () => {
    // #given a real repository whose current branch has diverged from the trusted anchor
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'reconstruct-changes-test-'))
    try {
      execFileSync('git', ['init', '-b', 'main'], {cwd: repoRoot})
      execFileSync('git', ['config', 'user.name', 'Reconstruction Test'], {cwd: repoRoot})
      execFileSync('git', ['config', 'user.email', 'reconstruction@example.test'], {cwd: repoRoot})
      mkdirSync(path.join(repoRoot, 'src'), {recursive: true})
      writeFileSync(path.join(repoRoot, 'src/tracked.ts'), 'anchor content\n', 'utf8')
      execFileSync('git', ['add', 'src/tracked.ts'], {cwd: repoRoot})
      execFileSync('git', ['commit', '-m', 'anchor'], {cwd: repoRoot})
      const anchorSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repoRoot, encoding: 'utf8'}).trim()

      execFileSync('git', ['switch', '-c', 'diverged'], {cwd: repoRoot})
      writeFileSync(path.join(repoRoot, 'src/tracked.ts'), 'diverged committed content\n', 'utf8')
      execFileSync('git', ['add', 'src/tracked.ts'], {cwd: repoRoot})
      execFileSync('git', ['commit', '-m', 'diverged'], {cwd: repoRoot})
      writeFileSync(path.join(repoRoot, 'src/untracked.ts'), 'workspace-only content\n', 'utf8')

      vi.mocked(fs.lstat).mockImplementation(async filePath => lstatSync(String(filePath)))
      vi.mocked(fs.readFile).mockImplementation(async filePath => readFileSync(String(filePath)))

      // #when reconstruction runs through the real Git exec adapter
      const result = await reconstructChanges(createExecAdapter(), anchorSha, repoRoot, logger)

      // #then only the net difference from the trusted anchor is returned
      expect(result).toEqual({
        success: true,
        data: {
          kind: 'changes',
          changes: [
            {path: 'src/tracked.ts', content: 'diverged committed content\n'},
            {path: 'src/untracked.ts', content: 'workspace-only content\n'},
          ],
        },
      })
    } finally {
      rmSync(repoRoot, {recursive: true, force: true})
    }
  })
})
