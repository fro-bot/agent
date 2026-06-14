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
 * musl targets: when --abi musl is passed, --version execution is SKIPPED because a
 * musl binary cannot execute on a glibc GitHub Actions runner (posix_spawn ENOENT —
 * no compatible dynamic linker). Upstream build.ts guards its own smoke test the same
 * way (only runs --version when os===platform && arch===arch && !abi). For musl, this
 * script only verifies that the binary FILE EXISTS (and is non-empty). The musl linkage
 * assertion (that it is actually musl, not glibc) is handled separately by the
 * release-binaries job's `file`-based assertion.
 *
 * Usage:
 *   bun run packages/harness/scripts/verify-binary.ts \
 *     --binary <path> \
 *     --base-version <version> \
 *     [--integration-commit <sha>] \
 *     [--abi musl]
 *
 * The --integration-commit is optional: when absent (dev scaffold), the marker
 * check is skipped. When present, the binary's --version must contain
 * "+harness.<short8>" where short8 is the first 8 chars of the commit.
 *
 * The --abi is optional: when 'musl', execution-based verification is skipped.
 */

import {execFileSync} from 'node:child_process'
import {statSync} from 'node:fs'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {runVerifications} from '../src/verify.js'
import {buildHarnessVersion} from '../src/version.js'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface VerifyArgs {
  readonly binaryPath: string
  readonly baseVersion: string
  readonly integrationCommit: string | null
  /** musl ABI variant — when set to 'musl', execution-based verification is skipped */
  readonly abi: 'musl' | null
}

export function parseArgs(argv: string[]): VerifyArgs | null {
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

  // Presence-without-value check: if --abi is in args but flag() returned null, the value is missing.
  const abiPresent = args.includes('--abi')
  const abiRaw = flag('--abi')
  if (abiPresent && (abiRaw === null || abiRaw === '')) {
    console.error('[verify-binary] --abi requires a value: --abi musl')
    console.error('Run with --help for usage.')
    return null
  }

  if (binaryPath === null || baseVersion === null) {
    console.error('[verify-binary] Missing required arguments.')
    console.error('  Required: --binary, --base-version')
    printHelp()
    return null
  }

  if (abiRaw !== null && abiRaw !== 'musl') {
    console.error(`[verify-binary] --abi '${abiRaw}' is not supported. Only 'musl' is accepted.`)
    return null
  }

  const abi: 'musl' | null = abiRaw === 'musl' ? 'musl' : null

  return {binaryPath, baseVersion, integrationCommit, abi}
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
    [--abi musl]                        ABI variant; when 'musl', execution-based
                                        verification is skipped (musl binary cannot run
                                        on a glibc runner). Only file existence is checked.
    [--help]                            Print this help

Assertions (glibc / darwin-native):
  1. Binary exits 0 on --version.
  2. --version output == expected version (exact match, trimmed).
     For a harness build: "<base>+harness.<short8>". A stock binary reports bare
     "<base>" and fails — proving this is a harness build for the expected commit.
  3. Integration marker "+harness.<short8>" present in --version (when --integration-commit
     supplied). Defense-in-depth on top of the exact version match.

Assertions (musl — execution skipped):
  1. Binary file exists and is non-empty.
  (--version cannot run on a glibc host; musl linkage is verified separately by the
   release-binaries job's file-based assertion.)

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

export function main(): void {
  const args = parseArgs(process.argv)
  if (args === null) {
    process.exit(1)
  }

  const {binaryPath, baseVersion, integrationCommit, abi} = args

  console.log(`[verify-binary] Verifying binary: ${binaryPath}`)
  console.log(`  abi:                ${abi ?? '(glibc / native)'}`)

  if (abi === 'musl') {
    // musl binaries cannot execute on a glibc runner (posix_spawn ENOENT — no compatible
    // dynamic linker). Upstream build.ts guards its own smoke test the same way:
    //   if (item.os === process.platform && item.arch === process.arch && !item.abi)
    // Skip --version execution for musl; only verify the binary file exists and is non-empty.
    // The musl linkage assertion (that it is actually musl, not glibc) is handled separately
    // by the release-binaries job's `file`-based assertion.
    console.log(
      `[verify-binary] Skipping --version execution for musl target ` +
        `(cannot run musl binary on glibc runner). Checking file existence only.`,
    )

    let fileSize: number
    try {
      const st = statSync(binaryPath)
      fileSize = st.size
    } catch {
      console.error(`[verify-binary] Binary file not found or inaccessible: ${binaryPath}`)
      process.exit(1)
    }

    if (fileSize === 0) {
      console.error(`[verify-binary] Binary file is empty: ${binaryPath}`)
      process.exit(1)
    }

    console.log(`[verify-binary] musl binary exists (${fileSize} bytes). Execution-based verification skipped.`)
    process.exit(0)
  }

  // Compute the full expected version string.
  // For a harness build, the binary self-reports "<base>+harness.<short8>".
  // For dev scaffold (no integration commit), the bare base version is used.
  const expectedVersion =
    integrationCommit !== null && integrationCommit.length > 0
      ? buildHarnessVersion(baseVersion, integrationCommit)
      : baseVersion

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

// Only run when executed directly (not when imported by tests or other modules).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
