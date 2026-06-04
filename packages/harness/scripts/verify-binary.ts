#!/usr/bin/env bun
/**
 * verify-binary.ts — verify the built native binary before packaging.
 *
 * Asserts:
 *   1. Binary exits 0 on --version.
 *   2. --version == expected version (exact match, trimmed).
 *      For a harness build, the expected version is "<base>+harness.<short8>" (from
 *      buildHarnessVersion). A stock upstream binary reports bare "<base>", which
 *      fails this check — proving the binary is a harness build for this exact
 *      base+commit. Full provenance lives in the package's provenance.json manifest;
 *      npm provenance attestation is the cryptographic gate.
 *   3. Integration marker: when --integration-commit is supplied, the --version output
 *      must contain "+harness.<short8>" (defense-in-depth on top of the exact match).
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
 * check is skipped. When present, the binary's --version must contain
 * "+harness.<short8>" where short8 is the first 8 chars of the commit.
 */

import {execFileSync} from 'node:child_process'
import process from 'node:process'
import {runVerifications} from '../src/verify.js'
import {buildHarnessVersion} from '../src/version.js'

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
    return null
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
    [--integration-commit <sha>]        Frozen integration commit SHA; when supplied,
                                        the binary's --version must contain
                                        "+harness.<short8>" (first 8 chars of the SHA)
    [--help]                            Print this help

Assertions:
  1. Binary exits 0 on --version.
  2. --version output == expected version (exact match, trimmed).
     For a harness build: "<base>+harness.<short8>". A stock binary reports bare
     "<base>" and fails — proving this is a harness build for the expected commit.
  3. Integration marker "+harness.<short8>" present in --version (when --integration-commit
     supplied). Defense-in-depth on top of the exact version match.

Exits non-zero on any assertion failure.
`)
}

// ---------------------------------------------------------------------------
// Binary probe
// ---------------------------------------------------------------------------

interface ProbeResult {
  readonly exitCode: number
  readonly versionOutput: string
}

function probeBinary(binaryPath: string): ProbeResult {
  let exitCode = 0
  let versionOutput = ''

  // Probe: --version (the binary self-reports its version, including the
  // "+harness.<short8>" segment for harness builds).
  try {
    const out = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    versionOutput = out.trim()
  } catch (error: unknown) {
    // Capture the exit code from the error if available.
    const spawnErr = error as {status?: number; message?: string}
    exitCode = spawnErr.status ?? 1
    console.error(`[verify-binary] --version probe failed: ${spawnErr.message ?? String(error)}`)
  }

  return {exitCode, versionOutput}
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

  // Compute the full expected version string.
  // For a harness build, the binary self-reports "<base>+harness.<short8>".
  // For dev scaffold (no integration commit), the bare base version is used.
  const expectedVersion =
    integrationCommit !== null && integrationCommit.length > 0
      ? buildHarnessVersion(baseVersion, integrationCommit)
      : baseVersion

  console.log(`[verify-binary] Verifying binary: ${binaryPath}`)
  console.log(`  expected version:   ${expectedVersion}`)
  console.log(`  integration commit: ${integrationCommit ?? '(none — dev scaffold)'}`)

  const probe = probeBinary(binaryPath)

  console.log(`  --version output:   '${probe.versionOutput}'`)
  console.log(`  exit code:          ${probe.exitCode}`)

  const result = runVerifications({
    versionOutput: probe.versionOutput,
    expectedVersion,
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
