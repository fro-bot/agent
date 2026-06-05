/**
 * build-platform.test.ts — drift guard + enforceBunVersion coverage.
 *
 * Tests:
 *   1. Drift guard: all `bun-version: X.Y.Z` literals in harness-release.yaml
 *      must equal HARNESS_BUN_VERSION. Catches the original version-drift gap.
 *   2. enforceBunVersion: exact match → no throw/exit; mismatch → process.exit(1);
 *      bun not found → process.exit(1).
 */

import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {HARNESS_BUN_VERSION} from '../src/bun-version.js'
import {enforceBunVersion} from './build-platform.js'

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
// enforceBunVersion
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(),
  }
})

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
