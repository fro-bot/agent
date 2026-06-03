#!/usr/bin/env bun
/**
 * verify-binary.ts — spike: verify the built native binary before packaging.
 *
 * Asserts:
 *   1. --version == base version (exact match).
 *   2. Integration marker (frozen integration commit SHA) present in binary output.
 *   3. Minimal boot smoke: binary exits 0 on --version.
 *
 * Exits non-zero on any mismatch — this gates the publish step.
 *
 * The assertion LOGIC is extracted into src/verify.ts (unit-testable with stubs).
 * This script wires the real binary exec to those assertions.
 *
 * Usage:
 *   bun run packages/harness/scripts/verify-binary.ts \
 *     --binary <path> \
 *     --base-version <version> \
 *     [--integration-commit <sha>]
 *
 * The --integration-commit is optional: when absent (dev scaffold), the marker
 * check is skipped. When present, the marker must appear in the binary's output.
 */

import {execFileSync} from 'node:child_process'
import process from 'node:process'
import {runVerifications} from '../src/verify.js'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface VerifyArgs {
  readonly binaryPath: string
  readonly baseVersion: string
  readonly integrationCommit: string | null
}

function parseArgs(argv: string[]): VerifyArgs | null {
  const args = argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    process.exit(0)
  }

  function flag(name: string): string | null {
    const idx = args.indexOf(name)
    if (idx === -1) return null
    const val = args[idx + 1]
    return val !== undefined && !val.startsWith('--') ? val : null
  }

  const binaryPath = flag('--binary')
  const baseVersion = flag('--base-version')
  const integrationCommit = flag('--integration-commit')

  if (binaryPath === null || baseVersion === null) {
    console.error('[verify-binary] Missing required arguments.')
    console.error('  Required: --binary, --base-version')
    printHelp()
    process.exit(1)
  }

  return {binaryPath, baseVersion, integrationCommit}
}

function printHelp(): void {
  console.log(String.raw`
verify-binary.ts — verify the built native binary before packaging

Usage:
  bun run packages/harness/scripts/verify-binary.ts \
    --binary <path>                     Path to the built native binary
    --base-version <version>            Expected base version (e.g. 1.15.13)
    [--integration-commit <sha>]        Frozen integration commit SHA to assert as marker
    [--help]                            Print this help

Assertions:
  1. Binary exits 0 on --version.
  2. --version output == base-version (exact match, trimmed).
  3. Integration commit SHA present in binary output (when --integration-commit provided).

Exits non-zero on any assertion failure.
`)
}

// ---------------------------------------------------------------------------
// Binary probe
// ---------------------------------------------------------------------------

interface ProbeResult {
  readonly exitCode: number
  readonly versionOutput: string
  readonly probeOutput: string
}

function probeBinary(binaryPath: string): ProbeResult {
  let exitCode = 0
  let versionOutput = ''
  let probeOutput = ''

  // Probe 1: --version
  try {
    const out = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    versionOutput = out.trim()
    probeOutput += out
  } catch (error: unknown) {
    // Capture the exit code from the error if available.
    const spawnErr = error as {status?: number; message?: string}
    exitCode = spawnErr.status ?? 1
    console.error(`[verify-binary] --version probe failed: ${spawnErr.message ?? String(error)}`)
  }

  // Probe 2: info (for integration marker — harness-own subcommand)
  // Only attempt if the --version probe succeeded.
  if (exitCode === 0) {
    try {
      const infoOut = execFileSync(binaryPath, ['info'], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      probeOutput += `\n${infoOut}`
    } catch {
      // info subcommand may not be available on a stock opencode binary.
      // Not a fatal error — the marker check will fail if the commit is required.
    }
  }

  return {exitCode, versionOutput, probeOutput}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv)
  if (args === null) {
    process.exit(1)
  }

  const {binaryPath, baseVersion, integrationCommit} = args

  console.log(`[verify-binary] Verifying binary: ${binaryPath}`)
  console.log(`  expected version:   ${baseVersion}`)
  console.log(`  integration commit: ${integrationCommit ?? '(none — dev scaffold)'}`)

  const probe = probeBinary(binaryPath)

  console.log(`  --version output:   '${probe.versionOutput}'`)
  console.log(`  exit code:          ${probe.exitCode}`)

  const result = runVerifications({
    versionOutput: probe.versionOutput,
    expectedVersion: baseVersion,
    probeOutput: probe.probeOutput,
    integrationCommit,
    exitCode: probe.exitCode,
  })

  if (result.ok) {
    console.log(`[verify-binary] All assertions passed.`)
    process.exit(0)
  }

  console.error(`[verify-binary] Verification FAILED:`)
  for (const failure of result.failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

main()
