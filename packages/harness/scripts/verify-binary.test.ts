/**
 * verify-binary.test.ts — unit tests for the verify-binary.ts script layer.
 *
 * Tests:
 *   1. parseArgs: --abi musl parsed correctly; absent → null; invalid → null.
 *   2. main() musl path: skips --version execution, checks file existence only.
 *   3. main() glibc path: runs --version + marker assertions (existing behavior).
 *   4. main() musl path: exits non-zero when binary file is missing.
 *   5. main() musl path: exits non-zero when binary file is empty.
 */

import {execFileSync} from 'node:child_process'
import {statSync} from 'node:fs'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {main, parseArgs} from './verify-binary.js'

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(),
  }
})

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// parseArgs — --abi flag
// ---------------------------------------------------------------------------

describe('parseArgs: --abi flag', () => {
  const BASE_ARGV = [
    'bun',
    'verify-binary.ts',
    '--binary',
    '/tmp/opencode',
    '--base-version',
    '1.17.3',
    '--integration-commit',
    'cafebabe1234abcd',
  ]

  let exitSpy: {mock: {calls: unknown[][]}}

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      throw new Error(`process.exit called with code ${_code}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('parses --abi musl into VerifyArgs.abi === "musl"', () => {
    // #given
    const argv = [...BASE_ARGV, '--abi', 'musl']

    // #when
    const result = parseArgs(argv)

    // #then
    expect(result).not.toBeNull()
    expect(result?.abi).toBe('musl')
    expect(exitSpy.mock.calls).toHaveLength(0)
  })

  it('sets abi to null when --abi is absent', () => {
    // #given — no --abi flag
    const result = parseArgs(BASE_ARGV)

    // #then
    expect(result).not.toBeNull()
    expect(result?.abi).toBeNull()
  })

  it('returns null and does not exit(0) for unsupported --abi value', () => {
    // #given — unsupported ABI
    const argv = [...BASE_ARGV, '--abi', 'glibc']

    // #when
    const result = parseArgs(argv)

    // #then — returns null (caller will exit(1))
    expect(result).toBeNull()
    // process.exit was NOT called by parseArgs itself for invalid abi (returns null, main exits)
    expect(exitSpy.mock.calls).toHaveLength(0)
  })

  it('returns null when --binary is missing', () => {
    // #given
    const argv = ['bun', 'verify-binary.ts', '--base-version', '1.17.3']

    // #when
    const result = parseArgs(argv)

    // #then
    expect(result).toBeNull()
  })

  it('returns null when --abi is present but has no value (last arg)', () => {
    // #given — --abi is the last arg with no following value
    const argv = [...BASE_ARGV, '--abi']

    // #when
    const result = parseArgs(argv)

    // #then — must fail with clear error, not silently treat as glibc
    expect(result).toBeNull()
  })

  it('returns null when --abi is present but followed by another flag (no value)', () => {
    // #given — --abi is followed by another flag token (no value)
    const argv = [...BASE_ARGV, '--abi', '--binary']

    // #when
    const result = parseArgs(argv)

    // #then — must fail-closed
    expect(result).toBeNull()
  })

  it('parses all fields correctly with --abi musl', () => {
    // #given
    const argv = [...BASE_ARGV, '--abi', 'musl']

    // #when
    const result = parseArgs(argv)

    // #then
    expect(result).not.toBeNull()
    expect(result?.binaryPath).toBe('/tmp/opencode')
    expect(result?.baseVersion).toBe('1.17.3')
    expect(result?.integrationCommit).toBe('cafebabe1234abcd')
    expect(result?.abi).toBe('musl')
  })
})

// ---------------------------------------------------------------------------
// main() — musl path: skips --version, checks file existence
// ---------------------------------------------------------------------------

describe('main(): musl path', () => {
  const mockedExecFileSync = vi.mocked(execFileSync)
  const mockedStatSync = vi.mocked(statSync)
  let exitSpy: {mock: {calls: unknown[][]}}

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      throw new Error(`process.exit called with code ${_code}`)
    })
    // Default: binary exists and is non-empty
    mockedStatSync.mockReturnValue({size: 12_345_678} as ReturnType<typeof statSync>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('exits 0 without calling execFileSync when --abi musl and binary exists', () => {
    // #given — musl binary exists (12 MB)
    process.argv = [
      'bun',
      'verify-binary.ts',
      '--binary',
      '/tmp/opencode-linux-x64-baseline-musl/bin/opencode',
      '--base-version',
      '1.17.3',
      '--integration-commit',
      'cafebabe1234abcd',
      '--abi',
      'musl',
    ]

    // #when
    expect(() => main()).toThrow('process.exit called with code 0')

    // #then — execFileSync must NOT have been called (no --version probe)
    expect(mockedExecFileSync).not.toHaveBeenCalled()
    // statSync must have been called to check existence
    expect(mockedStatSync).toHaveBeenCalledWith('/tmp/opencode-linux-x64-baseline-musl/bin/opencode')
    expect(exitSpy.mock.calls[0]?.[0]).toBe(0)
  })

  it('exits 1 when --abi musl but binary file is missing', () => {
    // #given — statSync throws ENOENT
    mockedStatSync.mockImplementation(() => {
      const err = new Error('ENOENT: no such file or directory')
      ;(err as NodeJS.ErrnoException).code = 'ENOENT'
      throw err
    })
    process.argv = [
      'bun',
      'verify-binary.ts',
      '--binary',
      '/tmp/missing-binary',
      '--base-version',
      '1.17.3',
      '--abi',
      'musl',
    ]

    // #when / #then
    expect(() => main()).toThrow('process.exit called with code 1')
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1)
    // execFileSync must NOT have been called
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })

  it('exits 1 when --abi musl but binary file is empty (size === 0)', () => {
    // #given — statSync returns size 0
    mockedStatSync.mockReturnValue({size: 0} as ReturnType<typeof statSync>)
    process.argv = [
      'bun',
      'verify-binary.ts',
      '--binary',
      '/tmp/empty-binary',
      '--base-version',
      '1.17.3',
      '--abi',
      'musl',
    ]

    // #when / #then
    expect(() => main()).toThrow('process.exit called with code 1')
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1)
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// main() — glibc / native path: runs --version + marker assertions
// ---------------------------------------------------------------------------

describe('main(): glibc / native path', () => {
  const mockedExecFileSync = vi.mocked(execFileSync)
  let exitSpy: {mock: {calls: unknown[][]}}

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      throw new Error(`process.exit called with code ${_code}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('exits 0 when --version matches expected harness version (no --abi)', () => {
    // #given — glibc binary self-reports the correct harness version
    const commit = 'cafebabe1234abcd'
    const expectedVersion = `1.17.3+harness.${commit.slice(0, 8)}`
    mockedExecFileSync.mockReturnValue(`${expectedVersion}\n`)
    process.argv = [
      'bun',
      'verify-binary.ts',
      '--binary',
      '/tmp/opencode-linux-x64/bin/opencode',
      '--base-version',
      '1.17.3',
      '--integration-commit',
      commit,
    ]

    // #when
    expect(() => main()).toThrow('process.exit called with code 0')

    // #then — execFileSync was called for --version
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      '/tmp/opencode-linux-x64/bin/opencode',
      ['--version'],
      expect.objectContaining({encoding: 'utf8'}),
    )
    expect(exitSpy.mock.calls[0]?.[0]).toBe(0)
  })

  it('exits 1 when --version output does not match expected version (no --abi)', () => {
    // #given — binary reports wrong version (stock upstream, no harness marker)
    mockedExecFileSync.mockReturnValue('1.17.3\n')
    process.argv = [
      'bun',
      'verify-binary.ts',
      '--binary',
      '/tmp/opencode-linux-x64/bin/opencode',
      '--base-version',
      '1.17.3',
      '--integration-commit',
      'cafebabe1234abcd',
    ]

    // #when / #then
    expect(() => main()).toThrow('process.exit called with code 1')
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1)
  })
})
