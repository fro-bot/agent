import type {ExecAdapter, Logger} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {assertNoPersistedGitCredentials} from './git-credential-check.js'

function createMockExecAdapter(overrides: Partial<ExecAdapter> = {}): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({exitCode: 1, stdout: '', stderr: ''}),
    ...overrides,
  }
}

describe('assertNoPersistedGitCredentials', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  it('errs naming persist-credentials when an extraheader credential is persisted', async () => {
    // #given a checkout that left persist-credentials at its default true
    const getExecOutput = vi.fn().mockImplementation(async (_cmd: string, args?: string[]) => {
      if (args?.includes('--get-regexp')) {
        return {
          exitCode: 0,
          stdout: 'http.https://github.com/.extraheader AUTHORIZATION: basic ***\n',
          stderr: '',
        }
      }
      return {exitCode: 0, stdout: 'https://github.com/owner/repo\n', stderr: ''}
    })
    const mockExec = createMockExecAdapter({getExecOutput})

    // #when
    const result = await assertNoPersistedGitCredentials(mockExec, '/workspace', mockLogger)

    // #then
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('persist-credentials: false') as string,
    })
    expect(result.success === false && result.error).toContain('http.https://github.com/.extraheader')
    // never log the credential value itself
    expect(result.success === false && result.error).not.toContain('AUTHORIZATION')
    expect(result.success === false && result.error).not.toContain('basic')
  })

  it('resolves ok for a clean repo with no persisted credentials', async () => {
    // #given
    const getExecOutput = vi.fn().mockImplementation(async (_cmd: string, args?: string[]) => {
      if (args?.includes('--get-regexp')) {
        return {exitCode: 1, stdout: '', stderr: ''}
      }
      return {exitCode: 0, stdout: 'https://github.com/owner/repo\n', stderr: ''}
    })
    const mockExec = createMockExecAdapter({getExecOutput})

    // #when
    const result = await assertNoPersistedGitCredentials(mockExec, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(true)
  })

  it('resolves ok when git is not on PATH (ENOENT)', async () => {
    // #given
    const getExecOutput = vi.fn().mockRejectedValue(Object.assign(new Error('spawn git ENOENT'), {code: 'ENOENT'}))
    const mockExec = createMockExecAdapter({getExecOutput})

    // #when
    const result = await assertNoPersistedGitCredentials(mockExec, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(true)
  })

  it('errs when the origin remote URL carries an embedded credential', async () => {
    // #given
    const getExecOutput = vi.fn().mockImplementation(async (_cmd: string, args?: string[]) => {
      if (args?.includes('--get-regexp')) {
        return {exitCode: 1, stdout: '', stderr: ''}
      }
      return {exitCode: 0, stdout: 'https://x-access-token:ghs_secrettoken@github.com/owner/repo\n', stderr: ''}
    })
    const mockExec = createMockExecAdapter({getExecOutput})

    // #when
    const result = await assertNoPersistedGitCredentials(mockExec, '/workspace', mockLogger)

    // #then
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('persist-credentials: false') as string,
    })
    expect(result.success === false && result.error).not.toContain('ghs_secrettoken')
  })

  it('resolves ok when the origin remote URL carries a bare username with no colon', async () => {
    // #given a remote URL with userinfo but no password (no colon, no secret)
    const getExecOutput = vi.fn().mockImplementation(async (_cmd: string, args?: string[]) => {
      if (args?.includes('--get-regexp')) {
        return {exitCode: 1, stdout: '', stderr: ''}
      }
      return {exitCode: 0, stdout: 'https://someuser@github.com/owner/repo\n', stderr: ''}
    })
    const mockExec = createMockExecAdapter({getExecOutput})

    // #when
    const result = await assertNoPersistedGitCredentials(mockExec, '/workspace', mockLogger)

    // #then a bare username carries no secret, so this is allowed
    expect(result.success).toBe(true)
  })

  it('errs when the origin remote URL carries a colon with an empty password', async () => {
    // #given a remote URL with a colon but an empty password segment
    const getExecOutput = vi.fn().mockImplementation(async (_cmd: string, args?: string[]) => {
      if (args?.includes('--get-regexp')) {
        return {exitCode: 1, stdout: '', stderr: ''}
      }
      return {exitCode: 0, stdout: 'https://user:@github.com/owner/repo\n', stderr: ''}
    })
    const mockExec = createMockExecAdapter({getExecOutput})

    // #when
    const result = await assertNoPersistedGitCredentials(mockExec, '/workspace', mockLogger)

    // #then the presence of a colon is treated as a credential boundary, deliberately broad
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('persist-credentials: false') as string,
    })
  })
})
