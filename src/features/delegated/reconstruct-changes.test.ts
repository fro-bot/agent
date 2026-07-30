import type {Stats} from 'node:fs'
import type {ExecAdapter} from '../../services/setup/types.js'

import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {reconstructChanges} from './reconstruct-changes.js'

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
}))

const TRUSTED_HEAD_SHA = 'a'.repeat(40)

function createMockExecAdapter(stdout = '', exitCode = 0): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({stdout, stderr: '', exitCode}),
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
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace')

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
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace')

    // #then the deletion is represented explicitly and the deleted path is not read
    expect(result).toEqual({success: true, data: {kind: 'changes', changes: [{path: 'src/removed.ts', deleted: true}]}})
    expect(fs.lstat).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('returns an explicit nothing-to-deliver outcome for an empty net diff', async () => {
    // #given a clean workspace relative to the trusted anchor
    const execAdapter = createMockExecAdapter()

    // #when the workspace is reconstructed
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace')

    // #then no empty change set is returned
    expect(result).toEqual({success: true, data: {kind: 'nothing-to-deliver'}})
  })

  it('encodes non-UTF-8 file content as base64', async () => {
    // #given an added regular file containing invalid UTF-8 bytes
    const execAdapter = createMockExecAdapter(rawDiffEntry('000000', '100644', 'A', 'src/binary.bin'))
    const binaryContent = Buffer.from([0xff, 0xfe, 0x00, 0x01])
    vi.mocked(fs.readFile).mockResolvedValue(binaryContent)

    // #when the workspace is reconstructed
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace')

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
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace')

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
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace')

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
    const result = await reconstructChanges(execAdapter, TRUSTED_HEAD_SHA, '/workspace')

    // #then the symlink is rejected without reading its target
    expect(result.success).toBe(false)
    expect(result.success === false && result.error.message).toContain('regular file')
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('returns bypass for a missing or malformed trusted anchor', async () => {
    // #given an absent anchor
    const execAdapter = createMockExecAdapter()

    // #when reconstruction is attempted
    const missingResult = await reconstructChanges(execAdapter, '', '/workspace')
    const malformedResult = await reconstructChanges(execAdapter, 'not-a-sha', '/workspace')

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
})
