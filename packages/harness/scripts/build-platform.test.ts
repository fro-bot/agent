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
import {readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {HARNESS_BUN_VERSION} from '../src/bun-version.js'
import {buildHarnessVersion} from '../src/version.js'
import {
  assertMuslBinary,
  assertPatchLanded,
  cloneAndCheckout,
  enforceBunVersion,
  main,
  parseArgs,
  patchBuildTs,
  resolveTargetDirSuffix,
  runUpstreamBuild,
  verifyBuiltBinary,
} from './build-platform.js'

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

describe('drift guard: harness-release.yaml bun-version literals', () => {
  it('all bun-version occurrences in harness-release.yaml equal HARNESS_BUN_VERSION', async () => {
    // #given — resolve the workflow file relative to this test file (scripts/ → repo root)
    const thisDir = path.dirname(fileURLToPath(import.meta.url))
    const repoRoot = path.resolve(thisDir, '..', '..', '..')
    const workflowPath = path.join(repoRoot, '.github', 'workflows', 'harness-release.yaml')

    // #when — use the REAL readFileSync (not the vi.mock'd one) to read the workflow file.
    // vi.mock('node:fs') is hoisted and intercepts the module-level import, so we use
    // vi.importActual to get the real node:fs module and bypass the mock.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const content = realFs.readFileSync(workflowPath, 'utf8')
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
    readFileSync: vi.fn(),
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

    // #when — glibc default (abi=null, baseline=false)
    runUpstreamBuild('/some/source-tree', baseVersion, integrationCommit, null, false)

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
// resolveTargetDirSuffix — target-name/dir resolution
// ---------------------------------------------------------------------------

describe('resolveTargetDirSuffix: target dir suffix computation', () => {
  it('returns empty string for glibc default (no abi, no baseline)', () => {
    // #given / #when / #then
    expect(resolveTargetDirSuffix(null, false)).toBe('')
  })

  it('returns -musl for arm64 musl (no baseline)', () => {
    // #given / #when / #then — linux-arm64-musl
    expect(resolveTargetDirSuffix('musl', false)).toBe('-musl')
  })

  it('returns -baseline-musl for x64 baseline musl', () => {
    // #given / #when / #then — linux-x64-baseline-musl
    expect(resolveTargetDirSuffix('musl', true)).toBe('-baseline-musl')
  })

  it('returns -baseline for baseline-only (no abi)', () => {
    // #given / #when / #then — e.g. linux-x64-baseline (avx2=false, glibc)
    expect(resolveTargetDirSuffix(null, true)).toBe('-baseline')
  })
})

// ---------------------------------------------------------------------------
// parseArgs — abi and baseline flags
// ---------------------------------------------------------------------------

describe('parseArgs: --abi and --baseline flags', () => {
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

  it('parses --abi musl into BuildArgs.abi', () => {
    // #given
    const argv = [...BASE_ARGV, '--abi', 'musl']

    // #when
    const result = parseArgs(argv)

    // #then
    expect(result).not.toBeNull()
    expect((result as BuildArgs).abi).toBe('musl')
    expect((result as BuildArgs).baseline).toBe(false)
  })

  it('parses --baseline into BuildArgs.baseline', () => {
    // #given
    const argv = [...BASE_ARGV, '--abi', 'musl', '--baseline']

    // #when
    const result = parseArgs(argv)

    // #then
    expect(result).not.toBeNull()
    expect((result as BuildArgs).abi).toBe('musl')
    expect((result as BuildArgs).baseline).toBe(true)
  })

  it('defaults abi to null and baseline to false when flags are absent', () => {
    // #given — no --abi or --baseline
    const result = parseArgs(BASE_ARGV)

    // #then
    expect(result).not.toBeNull()
    expect((result as BuildArgs).abi).toBeNull()
    expect((result as BuildArgs).baseline).toBe(false)
  })

  it('rejects unknown abi values', () => {
    // #given — unsupported abi
    const argv = [...BASE_ARGV, '--abi', 'glibc']

    // #when
    const result = parseArgs(argv)

    // #then — must return null (unsupported abi)
    expect(result).toBeNull()
  })

  it('rejects abi value of "gnu"', () => {
    // #given — 'gnu' is not a valid --abi value (only 'musl' is accepted)
    const argv = [...BASE_ARGV, '--abi', 'gnu']

    // #when
    const result = parseArgs(argv)

    // #then
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// patchBuildTs + assertPatchLanded — patch mechanism
// ---------------------------------------------------------------------------

describe('patchBuildTs: build.ts patch mechanism', () => {
  // patchBuildTs and assertPatchLanded use readFileSync/writeFileSync from node:fs,
  // which are mocked globally. We control the mock to simulate file reads/writes
  // without touching the real filesystem.

  const mockedReadFileSync = vi.mocked(readFileSync)
  const mockedWriteFileSync = vi.mocked(writeFileSync)

  // The exact baseline+abi+return-true block from upstream build.ts (lines 122-133).
  // This is the NEW patch target — spans BOTH the baseline gate AND the abi gate.
  // Must match what patchBuildTs looks for exactly (whitespace included).
  const PATCH_TARGET = `      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true`

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('patches the singleFlag baseline+abi block and adds the OPENCODE_TARGET_ABI hook', () => {
    // #given — readFileSync returns a fake build.ts with the patch target
    const fakeContent = `// preamble\n${PATCH_TARGET}\n    })\n  : allTargets`
    mockedReadFileSync.mockImplementation(() => fakeContent)
    let writtenContent = ''
    mockedWriteFileSync.mockImplementation((_path, data) => {
      writtenContent = data as string
    })

    // #when
    patchBuildTs('/fake/build.ts')

    // #then — the hook marker is present in the written content
    expect(writtenContent).toContain('OPENCODE_TARGET_ABI')
    expect(writtenContent).toContain('process.env["OPENCODE_TARGET_ABI"]')
    // The original unconditional baseline gate is preserved in the fallback path
    expect(writtenContent).toContain('return baselineFlag')
    // The original unconditional abi skip is preserved in the fallback path
    expect(writtenContent).toContain('if (item.abi !== undefined)')
  })

  it('patched filter rejects default glibc target when OPENCODE_TARGET_ABI is set', () => {
    // #given — readFileSync returns a fake build.ts with the patch target
    const fakeContent = `// preamble\n${PATCH_TARGET}\n    })\n  : allTargets`
    mockedReadFileSync.mockImplementation(() => fakeContent)
    let writtenContent = ''
    mockedWriteFileSync.mockImplementation((_path, data) => {
      writtenContent = data as string
    })

    // #when
    patchBuildTs('/fake/build.ts')

    // #then — the patched content contains the explicit-target-mode block that:
    // 1. Checks item.abi !== _harnessTargetAbi (rejects glibc target with no abi)
    expect(writtenContent).toContain('if (item.abi !== _harnessTargetAbi)')
    // 2. Honors the baseline flag via avx2===false comparison
    expect(writtenContent).toContain('(item.avx2 === false) !== _harnessTargetBaseline')
    // 3. Returns true only when both abi and baseline match
    expect(writtenContent).toContain('return true')
    // 4. The original baseline gate is preserved in the fallback path (no env var set)
    expect(writtenContent).toContain('return baselineFlag')
  })

  it('patched filter honors OPENCODE_TARGET_BASELINE at the avx2 gate', () => {
    // #given — readFileSync returns a fake build.ts with the patch target
    const fakeContent = `// preamble\n${PATCH_TARGET}\n    })\n  : allTargets`
    mockedReadFileSync.mockImplementation(() => fakeContent)
    let writtenContent = ''
    mockedWriteFileSync.mockImplementation((_path, data) => {
      writtenContent = data as string
    })

    // #when
    patchBuildTs('/fake/build.ts')

    // #then — the patched content reads OPENCODE_TARGET_BASELINE and compares avx2===false
    expect(writtenContent).toContain('process.env["OPENCODE_TARGET_BASELINE"] === "true"')
    expect(writtenContent).toContain('item.avx2 === false')
  })

  it('throws when the patch target is not found in build.ts', () => {
    // #given — readFileSync returns content WITHOUT the expected patch target
    mockedReadFileSync.mockImplementation(() => '// no singleFlag filter here\nconsole.log("hello")')

    // #when / #then — must throw
    expect(() => patchBuildTs('/fake/build.ts')).toThrow('patch target not found')
  })

  it('assertPatchLanded passes when the hook marker is present', () => {
    // #given — readFileSync returns content with the hook marker
    mockedReadFileSync.mockImplementation(() => '// OPENCODE_TARGET_ABI hook is here\nconsole.log("patched")')

    // #when / #then — must not throw
    expect(() => assertPatchLanded('/fake/build.ts')).not.toThrow()
  })

  it('assertPatchLanded throws when the hook marker is absent', () => {
    // #given — readFileSync returns content without the hook marker
    mockedReadFileSync.mockImplementation(() => '// no hook here\nconsole.log("hello")')

    // #when / #then — must throw
    expect(() => assertPatchLanded('/fake/build.ts')).toThrow('patch hook')
  })
})

// ---------------------------------------------------------------------------
// assertMuslBinary — R11 musl linkage guard
// ---------------------------------------------------------------------------

describe('assertMuslBinary: R11 musl linkage guard', () => {
  const mockedExecFileSync = vi.mocked(execFileSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('does not throw when file output shows statically linked (musl)', () => {
    // #given — Bun musl compile produces a statically linked binary
    mockedExecFileSync.mockReturnValue(
      '/tmp/opencode: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, stripped\n',
    )

    // #when / #then — must not throw
    expect(() => assertMuslBinary('/tmp/opencode')).not.toThrow()
  })

  it('does not throw when file output shows musl linker', () => {
    // #given — binary references musl dynamic linker
    mockedExecFileSync.mockReturnValue(
      '/tmp/opencode: ELF 64-bit LSB executable, x86-64, interpreter /lib/ld-musl-x86_64.so.1, stripped\n',
    )

    // #when / #then — must not throw
    expect(() => assertMuslBinary('/tmp/opencode')).not.toThrow()
  })

  it('throws when file output shows glibc x86-64 interpreter', () => {
    // #given — glibc binary
    mockedExecFileSync.mockReturnValue(
      '/tmp/opencode: ELF 64-bit LSB executable, x86-64, interpreter /lib64/ld-linux-x86-64.so.2, stripped\n',
    )

    // #when / #then — must throw with clear message
    expect(() => assertMuslBinary('/tmp/opencode')).toThrow('glibc-linked')
  })

  it('throws when file output shows glibc aarch64 interpreter', () => {
    // #given — glibc arm64 binary
    mockedExecFileSync.mockReturnValue(
      '/tmp/opencode: ELF 64-bit LSB executable, ARM aarch64, interpreter /lib/ld-linux-aarch64.so.1, stripped\n',
    )

    // #when / #then — must throw
    expect(() => assertMuslBinary('/tmp/opencode')).toThrow('glibc-linked')
  })

  it('throws when file command itself fails', () => {
    // #given — file command throws
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('file: command not found')
    })

    // #when / #then — must throw
    expect(() => assertMuslBinary('/tmp/opencode')).toThrow("'file' command failed")
  })
})

// ---------------------------------------------------------------------------
// runUpstreamBuild — musl/baseline target selection
// ---------------------------------------------------------------------------

describe('runUpstreamBuild: musl/baseline target env vars', () => {
  const mockedSpawnSync = vi.mocked(spawnSync)
  const mockedReadFileSync = vi.mocked(readFileSync)
  const mockedWriteFileSync = vi.mocked(writeFileSync)

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

  it('does NOT set OPENCODE_TARGET_ABI when abi is null (glibc default)', () => {
    // #given — glibc build (no abi, no baseline)
    runUpstreamBuild('/some/source-tree', '1.15.13', 'deadbeef12345678', null, false)

    // #then — build.ts invoked without OPENCODE_TARGET_ABI
    const bunBuildCalls = mockedSpawnSync.mock.calls.filter(
      call =>
        call[0] === 'bun' &&
        Array.isArray(call[1]) &&
        call[1].some((a: unknown) => typeof a === 'string' && a.includes('build.ts')),
    )
    expect(bunBuildCalls.length).toBeGreaterThan(0)
    const buildEnv = (bunBuildCalls[0]?.[2] as {env?: Record<string, string>} | undefined)?.env
    expect(buildEnv?.OPENCODE_TARGET_ABI).toBeUndefined()
    expect(buildEnv?.OPENCODE_TARGET_BASELINE).toBeUndefined()
  })

  it('sets OPENCODE_TARGET_ABI=musl when abi is musl', () => {
    // #given — musl build; simulate the patch read/write cycle via stateful mocks.
    // patchBuildTs reads the file (gets PATCH_TARGET), writes the patched content.
    // assertPatchLanded reads the file again (must get the patched content with the hook).
    // PATCH_TARGET must match the NEW TARGET_ORIGINAL (the full baseline+abi+return-true block).
    const PATCH_TARGET = `      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true`
    // Stateful mock: tracks what was last written so assertPatchLanded sees the patched content.
    let fileContent = PATCH_TARGET
    mockedReadFileSync.mockImplementation(() => fileContent)
    mockedWriteFileSync.mockImplementation((_path, data) => {
      fileContent = data as string
    })

    // #when
    runUpstreamBuild('/some/source-tree', '1.15.13', 'deadbeef12345678', 'musl', false)

    // #then — build.ts invoked with OPENCODE_TARGET_ABI=musl
    const bunBuildCalls = mockedSpawnSync.mock.calls.filter(
      call =>
        call[0] === 'bun' &&
        Array.isArray(call[1]) &&
        call[1].some((a: unknown) => typeof a === 'string' && a.includes('build.ts')),
    )
    expect(bunBuildCalls.length).toBeGreaterThan(0)
    const buildEnv = (bunBuildCalls[0]?.[2] as {env?: Record<string, string>} | undefined)?.env
    expect(buildEnv?.OPENCODE_TARGET_ABI).toBe('musl')
    expect(buildEnv?.OPENCODE_TARGET_BASELINE).toBeUndefined()
  })

  it('sets OPENCODE_TARGET_ABI=musl and OPENCODE_TARGET_BASELINE=true when abi=musl and baseline=true', () => {
    // #given — musl baseline build; stateful mock simulates the patch read/write cycle.
    // PATCH_TARGET must match the NEW TARGET_ORIGINAL (the full baseline+abi+return-true block).
    const PATCH_TARGET = `      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true`
    let fileContent = PATCH_TARGET
    mockedReadFileSync.mockImplementation(() => fileContent)
    mockedWriteFileSync.mockImplementation((_path, data) => {
      fileContent = data as string
    })

    // #when
    runUpstreamBuild('/some/source-tree', '1.15.13', 'deadbeef12345678', 'musl', true)

    // #then
    const bunBuildCalls = mockedSpawnSync.mock.calls.filter(
      call =>
        call[0] === 'bun' &&
        Array.isArray(call[1]) &&
        call[1].some((a: unknown) => typeof a === 'string' && a.includes('build.ts')),
    )
    expect(bunBuildCalls.length).toBeGreaterThan(0)
    const buildEnv = (bunBuildCalls[0]?.[2] as {env?: Record<string, string>} | undefined)?.env
    expect(buildEnv?.OPENCODE_TARGET_ABI).toBe('musl')
    expect(buildEnv?.OPENCODE_TARGET_BASELINE).toBe('true')
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

// ---------------------------------------------------------------------------
// verifyBuiltBinary — musl execution skip + glibc execution
// ---------------------------------------------------------------------------

describe('verifyBuiltBinary: musl skip vs glibc execution', () => {
  const mockedExecFileSync = vi.mocked(execFileSync)
  const mockedSpawnSync = vi.mocked(spawnSync)

  const BINARY_PATH = '/tmp/dist/opencode-linux-x64-baseline-musl/bin/opencode'
  const EXPECTED_VERSION = '1.15.13+harness.abc12345'

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: binary exists (test -f returns 0)
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

  // -------------------------------------------------------------------------
  // musl target: existence checked, --version NOT executed
  // -------------------------------------------------------------------------

  it('musl target: does not call execFileSync (no --version execution)', () => {
    // #given — musl target; binary exists (spawnSync test -f returns 0)

    // #when
    verifyBuiltBinary(BINARY_PATH, EXPECTED_VERSION, 'musl')

    // #then — execFileSync was NOT called (no --version execution)
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })

  it('musl target: does not throw when binary exists', () => {
    // #given — musl target; binary exists

    // #when / #then — must not throw
    expect(() => verifyBuiltBinary(BINARY_PATH, EXPECTED_VERSION, 'musl')).not.toThrow()
  })

  it('musl target: throws when binary does not exist', () => {
    // #given — musl target; binary missing (test -f returns non-zero)
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    })

    // #when / #then — must throw with "not found" message
    expect(() => verifyBuiltBinary(BINARY_PATH, EXPECTED_VERSION, 'musl')).toThrow('Built binary not found at')
  })

  // -------------------------------------------------------------------------
  // glibc target: existence checked + --version executed + version asserted
  // -------------------------------------------------------------------------

  it('glibc target: calls execFileSync with --version', () => {
    // #given — glibc target (abi=null); binary exists; --version returns expected version
    mockedExecFileSync.mockReturnValue(`${EXPECTED_VERSION}\n`)

    // #when
    verifyBuiltBinary(BINARY_PATH, EXPECTED_VERSION, null)

    // #then — execFileSync was called with the binary and --version
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      BINARY_PATH,
      ['--version'],
      expect.objectContaining({encoding: 'utf8'}),
    )
  })

  it('glibc target: does not throw when --version matches expected version', () => {
    // #given — glibc target; --version returns exact expected version
    mockedExecFileSync.mockReturnValue(`${EXPECTED_VERSION}\n`)

    // #when / #then — must not throw
    expect(() => verifyBuiltBinary(BINARY_PATH, EXPECTED_VERSION, null)).not.toThrow()
  })

  it('glibc target: throws on version mismatch', () => {
    // #given — glibc target; --version returns wrong version
    mockedExecFileSync.mockReturnValue('1.0.0-wrong\n')

    // #when / #then — must throw with version mismatch message
    expect(() => verifyBuiltBinary(BINARY_PATH, EXPECTED_VERSION, null)).toThrow('Version mismatch')
  })

  it('glibc target: throws when --version execution fails (ENOENT)', () => {
    // #given — glibc target; execFileSync throws (binary not executable or missing loader)
    mockedExecFileSync.mockImplementation(() => {
      const err = new Error('ENOENT: no such file or directory, posix_spawn') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    // #when / #then — must throw with "Binary --version failed" message
    expect(() => verifyBuiltBinary(BINARY_PATH, EXPECTED_VERSION, null)).toThrow('Binary --version failed')
  })

  it('glibc target: throws when binary does not exist', () => {
    // #given — glibc target; binary missing (test -f returns non-zero)
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    })

    // #when / #then — must throw before attempting --version
    expect(() => verifyBuiltBinary(BINARY_PATH, EXPECTED_VERSION, null)).toThrow('Built binary not found at')
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })
})
