/**
 * build-platform.test.ts — drift guard + enforceBunVersion coverage + source-tree mode.
 *
 * Tests:
 *   1. Drift guard: all `bun-version: X.Y.Z` literals in harness-release.yaml
 *      must equal HARNESS_BUN_VERSION. Catches the original version-drift gap.
 *   2. enforceBunVersion: exact match → no throw/exit; mismatch → process.exit(1);
 *      bun not found → process.exit(1).
 *   3. parseArgs: --source-tree parsed into BuildArgs; --integration-commit still required.
 *   4. source-tree mode: --source-tree supplied (dir exists, non-empty) → cloneAndCheckout
 *      bypassed; build runs against the supplied dir.
 *   5. backward-compat: no --source-tree → existing clone path unchanged.
 *   6. fail-closed: --source-tree supplied but dir missing/empty → clean error, non-zero exit,
 *      no fallback to clone.
 *   7. version pure-from-arg: source-tree mode with no .git present still produces the correct
 *      <base>+harness.<short8> version (buildHarnessVersion derives from --integration-commit,
 *      never shells to git).
 */

import type {BuildArgs} from './build-platform.js'
import {execFileSync, spawnSync} from 'node:child_process'
import {readdirSync, readFileSync, statSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {HARNESS_BUN_VERSION} from '../src/bun-version.js'
import {buildHarnessVersion} from '../src/version.js'
import {cloneAndCheckout, enforceBunVersion, main, parseArgs, runUpstreamBuild} from './build-platform.js'

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

describe('drift guard: harness-release.yaml bun-version literals', () => {
  it('all bun-version occurrences in harness-release.yaml equal HARNESS_BUN_VERSION', () => {
    // #given — resolve the workflow file relative to this test file (scripts/ → repo root)
    const thisDir = path.dirname(fileURLToPath(import.meta.url))
    const repoRoot = path.resolve(thisDir, '..', '..', '..')
    const workflowPath = path.join(repoRoot, '.github', 'workflows', 'harness-release.yaml')

    // #when
    const content = readFileSync(workflowPath, 'utf8')
    const matches = [...content.matchAll(/bun-version:\s*(\d+\.\d+\.\d+)/g)]

    // #then — there must be at least one occurrence (sanity check)
    expect(matches.length).toBeGreaterThan(0)

    // Every occurrence must equal the pinned constant
    for (const match of matches) {
      const workflowVersion = match[1]
      expect(
        workflowVersion,
        `bun-version literal '${workflowVersion}' in harness-release.yaml does not match HARNESS_BUN_VERSION '${HARNESS_BUN_VERSION}'`,
      ).toBe(HARNESS_BUN_VERSION)
    }
  })
})

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: vi.fn(),
  }
})

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: vi.fn(),
    readdirSync: vi.fn(),
    mkdirSync: vi.fn(),
    cpSync: vi.fn(),
    writeFileSync: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// enforceBunVersion
// ---------------------------------------------------------------------------

describe('enforceBunVersion', () => {
  const mockedExecFileSync = vi.mocked(execFileSync)
  // Capture the spy so we can assert on it without triggering the unbound-method lint rule.
  // Typed as a minimal structural interface so we can inspect mock.calls without
  // triggering the unbound-method rule that fires on `expect(process.exit).*`.
  let exitSpy: {mock: {calls: unknown[][]}}

  beforeEach(() => {
    // Spy on process.exit and prevent it from actually terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      throw new Error(`process.exit called with code ${_code}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('does not exit when bun version matches exactly', () => {
    // #given — bun reports the exact pinned version
    mockedExecFileSync.mockReturnValue(`${HARNESS_BUN_VERSION}\n`)

    // #when / #then — must not throw or call process.exit
    expect(() => enforceBunVersion()).not.toThrow()
    expect(exitSpy.mock.calls).toHaveLength(0)
  })

  it('calls process.exit(1) when bun version mismatches', () => {
    // #given — bun reports a different version
    mockedExecFileSync.mockReturnValue('9.9.9\n')

    // #when / #then — must call process.exit(1) (which our spy turns into a throw)
    expect(() => enforceBunVersion()).toThrow('process.exit called with code 1')
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1)
  })

  it('calls process.exit(1) when bun is not found on PATH', () => {
    // #given — execFileSync throws (bun not found)
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('spawn bun ENOENT')
    })

    // #when / #then — must call process.exit(1)
    expect(() => enforceBunVersion()).toThrow('process.exit called with code 1')
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// parseArgs — source-tree flag
// ---------------------------------------------------------------------------

describe('parseArgs: --source-tree flag', () => {
  const BASE_ARGV = [
    'bun',
    'build-platform.ts',
    '--integration-commit',
    'abc12345def67890',
    '--base-version',
    '1.15.13',
    '--platform',
    'linux',
    '--arch',
    'x64',
  ]

  it('parses --source-tree into BuildArgs.sourceTree', () => {
    // #given
    const argv = [...BASE_ARGV, '--source-tree', '/tmp/merged-source']

    // #when
    const result = parseArgs(argv)

    // #then
    expect(result).not.toBeNull()
    expect((result as BuildArgs).sourceTree).toBe('/tmp/merged-source')
  })

  it('sets sourceTree to null when --source-tree is absent', () => {
    // #given — no --source-tree flag
    const result = parseArgs(BASE_ARGV)

    // #then
    expect(result).not.toBeNull()
    expect((result as BuildArgs).sourceTree).toBeNull()
  })

  it('still requires --integration-commit even in source-tree mode', () => {
    // #given — --source-tree present but --integration-commit missing
    const argv = [
      'bun',
      'build-platform.ts',
      '--base-version',
      '1.15.13',
      '--platform',
      'linux',
      '--arch',
      'x64',
      '--source-tree',
      '/tmp/merged-source',
    ]

    // #when
    const result = parseArgs(argv)

    // #then — must return null (missing required arg)
    expect(result).toBeNull()
  })

  it('fIX 4: returns null when --source-tree is present but has no value (last arg)', () => {
    // #given — --source-tree is the last arg with no following value
    const argv = [...BASE_ARGV, '--source-tree']

    // #when
    const result = parseArgs(argv)

    // #then — must fail-closed, not fall back to clone
    expect(result).toBeNull()
  })

  it('fIX 4: returns null when --source-tree is followed by another flag token', () => {
    // #given — --source-tree is followed by another flag (no value)
    const argv = [...BASE_ARGV, '--source-tree', '--out-dir', '/some/out']

    // #when
    const result = parseArgs(argv)

    // #then — must fail-closed
    expect(result).toBeNull()
  })

  it('includes all other fields correctly when --source-tree is present', () => {
    // #given
    const argv = [...BASE_ARGV, '--source-tree', '/some/tree', '--out-dir', '/some/out']

    // #when
    const result = parseArgs(argv) as BuildArgs

    // #then
    expect(result.integrationCommit).toBe('abc12345def67890')
    expect(result.baseVersion).toBe('1.15.13')
    expect(result.platform).toBe('linux')
    expect(result.arch).toBe('x64')
    expect(result.sourceTree).toBe('/some/tree')
    expect(result.outDir).toBe('/some/out')
  })
})

// ---------------------------------------------------------------------------
// main() — source-tree mode integration tests
// ---------------------------------------------------------------------------

describe('main(): source-tree mode', () => {
  const mockedExecFileSync = vi.mocked(execFileSync)
  const mockedSpawnSync = vi.mocked(spawnSync)
  const mockedStatSync = vi.mocked(statSync)
  const mockedReaddirSync = vi.mocked(readdirSync)

  let exitSpy: {mock: {calls: unknown[][]}}

  // Minimal argv that exercises source-tree mode
  const SOURCE_TREE_DIR = '/tmp/merged-source-tree'
  const INTEGRATION_COMMIT = 'abc12345def67890'
  const BASE_VERSION = '1.15.13'

  const SOURCE_TREE_ARGV = [
    'bun',
    'build-platform.ts',
    '--integration-commit',
    INTEGRATION_COMMIT,
    '--base-version',
    BASE_VERSION,
    '--platform',
    'linux',
    '--arch',
    'x64',
    '--source-tree',
    SOURCE_TREE_DIR,
    '--out-dir',
    '/tmp/out',
  ]

  const CLONE_ARGV = [
    'bun',
    'build-platform.ts',
    '--integration-commit',
    INTEGRATION_COMMIT,
    '--base-version',
    BASE_VERSION,
    '--platform',
    'linux',
    '--arch',
    'x64',
    '--out-dir',
    '/tmp/out',
  ]

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      throw new Error(`process.exit called with code ${_code}`)
    })

    // Default: bun version check passes
    mockedExecFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'bun' && Array.isArray(args) && args[0] === '--version') {
        return `${HARNESS_BUN_VERSION}\n`
      }
      // binary --version check: return the expected harness version
      return `${buildHarnessVersion(BASE_VERSION, INTEGRATION_COMMIT)}\n`
    })

    // Default: spawnSync succeeds for all calls
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    })

    // Default: statSync returns a directory stat
    mockedStatSync.mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
    } as ReturnType<typeof statSync>)

    // Default: readdirSync returns non-empty listing
    mockedReaddirSync.mockReturnValue(['package.json', 'packages'] as unknown as ReturnType<typeof readdirSync>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Happy path: source-tree mode bypasses cloneAndCheckout
  // -------------------------------------------------------------------------

  it('bypasses cloneAndCheckout when --source-tree is supplied and dir is valid', async () => {
    // #given — source tree dir exists and is non-empty (mocked above)
    // Override process.argv for main()
    const origArgv = process.argv
    process.argv = SOURCE_TREE_ARGV

    try {
      // #when — main() should complete without calling git clone
      await main()
    } catch (error) {
      // process.exit throws in our spy; re-throw only if it's not a normal exit
      if (error instanceof Error && error.message.startsWith('process.exit')) {
        throw error
      }
    } finally {
      process.argv = origArgv
    }

    // #then — git clone was NOT called (no spawnSync call with 'git' and 'clone')
    const gitCloneCalls = mockedSpawnSync.mock.calls.filter(
      call => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('clone'),
    )
    expect(gitCloneCalls).toHaveLength(0)

    // statSync was called with the source tree dir (validation step)
    const statCalls = mockedStatSync.mock.calls.filter(call => call[0] === SOURCE_TREE_DIR)
    expect(statCalls.length).toBeGreaterThan(0)
  })

  it('runs bun install and build.ts against the source tree dir (not workDir)', async () => {
    // #given — source tree mode
    const origArgv = process.argv
    process.argv = SOURCE_TREE_ARGV

    try {
      await main()
    } catch {
      // ignore process.exit throws from non-critical paths
    } finally {
      process.argv = origArgv
    }

    // #then — bun install was called with cwd = SOURCE_TREE_DIR
    const bunInstallCalls = mockedSpawnSync.mock.calls.filter(
      call => call[0] === 'bun' && Array.isArray(call[1]) && call[1].includes('install'),
    )
    expect(bunInstallCalls.length).toBeGreaterThan(0)
    expect((bunInstallCalls[0]?.[2] as {cwd?: string} | undefined)?.cwd).toBe(SOURCE_TREE_DIR)

    // bun build.ts was called with cwd = SOURCE_TREE_DIR
    const bunBuildCalls = mockedSpawnSync.mock.calls.filter(
      call =>
        call[0] === 'bun' &&
        Array.isArray(call[1]) &&
        call[1].some((a: unknown) => typeof a === 'string' && a.includes('build.ts')),
    )
    expect(bunBuildCalls.length).toBeGreaterThan(0)
    expect((bunBuildCalls[0]?.[2] as {cwd?: string} | undefined)?.cwd).toBe(SOURCE_TREE_DIR)
  })

  // -------------------------------------------------------------------------
  // Backward-compat: no --source-tree → clone path unchanged
  // -------------------------------------------------------------------------

  it('calls cloneAndCheckout (git operations) when --source-tree is absent', async () => {
    // #given — no --source-tree flag; git operations succeed
    // spawnSync('test', ['-d', ...]) returns status 1 so cloneAndCheckout takes the clone branch
    mockedSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'test' && Array.isArray(args) && args[0] === '-d') {
        return {status: 1, stdout: '', stderr: '', pid: 1, output: [], signal: null}
      }
      return {status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null}
    })

    const origArgv = process.argv
    process.argv = CLONE_ARGV

    try {
      await main()
    } catch {
      // ignore process.exit throws
    } finally {
      process.argv = origArgv
    }

    // #then — git clone WAS called (clone path taken because work dir did not exist)
    const gitCloneCalls = mockedSpawnSync.mock.calls.filter(
      call => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('clone'),
    )
    expect(gitCloneCalls.length).toBeGreaterThan(0)

    // statSync was NOT called with a source-tree path (no source-tree validation)
    const statCalls = mockedStatSync.mock.calls.filter(call => call[0] === SOURCE_TREE_DIR)
    expect(statCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Fail-closed: missing source tree dir
  // -------------------------------------------------------------------------

  it('exits non-zero and does NOT fall back to clone when --source-tree dir is missing', async () => {
    // #given — statSync throws ENOENT
    mockedStatSync.mockImplementation(() => {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    const origArgv = process.argv
    process.argv = SOURCE_TREE_ARGV

    // #when / #then — must call process.exit(1)
    await expect(async () => {
      process.argv = SOURCE_TREE_ARGV
      await main()
    }).rejects.toThrow('process.exit called with code 1')

    process.argv = origArgv

    // git clone was NOT called (no silent fallback)
    const gitCloneCalls = mockedSpawnSync.mock.calls.filter(
      call => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('clone'),
    )
    expect(gitCloneCalls).toHaveLength(0)

    // process.exit(1) was called
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1)
  })

  it('exits non-zero and does NOT fall back to clone when --source-tree dir is empty', async () => {
    // #given — dir exists but is empty
    mockedStatSync.mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
    } as ReturnType<typeof statSync>)
    mockedReaddirSync.mockReturnValue([])

    const origArgv = process.argv
    process.argv = SOURCE_TREE_ARGV

    // #when / #then — must call process.exit(1)
    await expect(async () => {
      process.argv = SOURCE_TREE_ARGV
      await main()
    }).rejects.toThrow('process.exit called with code 1')

    process.argv = origArgv

    // git clone was NOT called
    const gitCloneCalls = mockedSpawnSync.mock.calls.filter(
      call => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('clone'),
    )
    expect(gitCloneCalls).toHaveLength(0)

    expect(exitSpy.mock.calls[0]?.[0]).toBe(1)
  })

  it('exits non-zero when --source-tree path exists but is not a directory', async () => {
    // #given — path is a file, not a directory
    mockedStatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
    } as ReturnType<typeof statSync>)

    const origArgv = process.argv
    process.argv = SOURCE_TREE_ARGV

    await expect(async () => {
      process.argv = SOURCE_TREE_ARGV
      await main()
    }).rejects.toThrow('process.exit called with code 1')

    process.argv = origArgv
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Version pure-from-arg: no .git needed
  // -------------------------------------------------------------------------

  it('produces the correct +harness.<short8> version from --integration-commit without any git rev-parse', async () => {
    // #given — source tree mode; no .git present (statSync/readdirSync mocked, no git calls)
    const origArgv = process.argv
    process.argv = SOURCE_TREE_ARGV

    try {
      await main()
    } catch {
      // ignore process.exit throws from non-critical paths
    } finally {
      process.argv = origArgv
    }

    // #then — no git rev-parse was called
    const gitRevParseCalls = mockedSpawnSync.mock.calls.filter(
      call => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('rev-parse'),
    )
    expect(gitRevParseCalls).toHaveLength(0)

    // The expected version is derived purely from the --integration-commit arg
    const expectedVersion = buildHarnessVersion(BASE_VERSION, INTEGRATION_COMMIT)
    expect(expectedVersion).toBe(`${BASE_VERSION}+harness.${INTEGRATION_COMMIT.slice(0, 8)}`)

    // bun build.ts was invoked with OPENCODE_VERSION = expectedVersion
    const bunBuildCalls = mockedSpawnSync.mock.calls.filter(
      call =>
        call[0] === 'bun' &&
        Array.isArray(call[1]) &&
        call[1].some((a: unknown) => typeof a === 'string' && a.includes('build.ts')),
    )
    expect(bunBuildCalls.length).toBeGreaterThan(0)
    const buildEnv = (bunBuildCalls[0]?.[2] as {env?: Record<string, string>} | undefined)?.env
    expect(buildEnv?.OPENCODE_VERSION).toBe(expectedVersion)
  })
})

// ---------------------------------------------------------------------------
// runUpstreamBuild — version env is pure-from-arg (unit-level)
// ---------------------------------------------------------------------------

describe('runUpstreamBuild: version derivation is pure-from-arg', () => {
  const mockedSpawnSync = vi.mocked(spawnSync)

  beforeEach(() => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('sets OPENCODE_VERSION to buildHarnessVersion(baseVersion, integrationCommit) — no git rev-parse', () => {
    // #given
    const baseVersion = '1.15.13'
    const integrationCommit = 'deadbeef12345678'
    const expectedVersion = buildHarnessVersion(baseVersion, integrationCommit)

    // #when
    runUpstreamBuild('/some/source-tree', baseVersion, integrationCommit)

    // #then — no git rev-parse call
    const gitRevParseCalls = mockedSpawnSync.mock.calls.filter(
      call => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('rev-parse'),
    )
    expect(gitRevParseCalls).toHaveLength(0)

    // OPENCODE_VERSION was set to the pure-from-arg value
    const bunBuildCalls = mockedSpawnSync.mock.calls.filter(
      call =>
        call[0] === 'bun' &&
        Array.isArray(call[1]) &&
        call[1].some((a: unknown) => typeof a === 'string' && a.includes('build.ts')),
    )
    expect(bunBuildCalls.length).toBeGreaterThan(0)
    const buildEnv = (bunBuildCalls[0]?.[2] as {env?: Record<string, string>} | undefined)?.env
    expect(buildEnv?.OPENCODE_VERSION).toBe(expectedVersion)
    expect(expectedVersion).toBe(`${baseVersion}+harness.${integrationCommit.slice(0, 8)}`)
  })
})

// ---------------------------------------------------------------------------
// cloneAndCheckout — backward-compat: still calls git clone
// ---------------------------------------------------------------------------

describe('cloneAndCheckout: backward-compat', () => {
  const mockedSpawnSync = vi.mocked(spawnSync)

  beforeEach(() => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('calls git clone when work dir does not exist', () => {
    // #given — test -d returns non-zero (dir does not exist)
    mockedSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'test' && Array.isArray(args) && args[0] === '-d') {
        return {status: 1, stdout: '', stderr: '', pid: 1, output: [], signal: null}
      }
      return {status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null}
    })

    // #when
    cloneAndCheckout('https://github.com/anomalyco/opencode.git', '/tmp/work', 'abc12345')

    // #then — git clone was called
    const gitCloneCalls = mockedSpawnSync.mock.calls.filter(
      call => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('clone'),
    )
    expect(gitCloneCalls.length).toBeGreaterThan(0)
  })
})
