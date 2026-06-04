/**
 * Binary verification logic — unit-testable assertions extracted from verify-binary.ts.
 *
 * These pure functions are tested in verify.test.ts against fake binary stubs.
 * The actual exec calls live in scripts/verify-binary.ts.
 *
 * Verification contract:
 *   1. Binary is executable (exit code 0 on --version).
 *   2. --version output == expectedVersion (exact match, trimmed).
 *      For a harness build, expectedVersion is "<base>+harness.<short8>" (from
 *      buildHarnessVersion). A stock upstream binary reports bare "<base>", which
 *      fails this check — proving the binary is a harness build for this exact
 *      base+commit. Full provenance (full SHA, refs) lives in the package's
 *      provenance.json manifest; npm provenance attestation is the cryptographic gate.
 *   3. Integration marker: when an integrationCommit is supplied, the --version output
 *      must contain "+harness.<short8>" where short8 is the first 8 chars of the commit.
 *      This is defense-in-depth on top of the exact version match — it explicitly
 *      confirms the harness segment encodes the expected integration commit.
 */

/** Result of a single verification assertion. */
export interface VerifyResult {
  readonly ok: boolean
  readonly message: string
}

/**
 * Asserts that the binary's reported version matches the expected version string.
 *
 * For a harness build with an integration commit, expectedVersion is
 * "<base>+harness.<short8>" (as produced by buildHarnessVersion). A stock upstream
 * binary reports bare "<base>", which fails this check.
 *
 * @param actualVersion   - The trimmed stdout from `binary --version`.
 * @param expectedVersion - The full expected version string (e.g. '1.15.13+harness.cafebabe').
 */
export function assertVersionMatch(actualVersion: string, expectedVersion: string): VerifyResult {
  const trimmed = actualVersion.trim()
  if (trimmed === expectedVersion) {
    return {ok: true, message: `version ok: ${trimmed}`}
  }
  return {
    ok: false,
    message: `version mismatch: got '${trimmed}', expected '${expectedVersion}'`,
  }
}

/**
 * Asserts that the binary's --version output contains the "+harness.<short8>" marker,
 * where short8 is the first 8 characters of the integration commit.
 *
 * This is defense-in-depth on top of assertVersionMatch: it explicitly confirms the
 * harness segment encodes the expected integration commit, catching any case where
 * the version string has the right format but the wrong commit embedded.
 *
 * A stock upstream binary reports bare "<base>" with no "+harness." segment — it fails.
 * A harness build of a DIFFERENT commit reports "+harness.<other8>" — it also fails.
 *
 * An empty or null integrationCommit is treated as "no marker required" (dev scaffold).
 *
 * @param versionOutput     - The trimmed stdout from `binary --version`.
 * @param integrationCommit - The frozen integration commit SHA to derive short8 from, or null/empty.
 */
export function assertIntegrationMarker(versionOutput: string, integrationCommit: string | null): VerifyResult {
  if (integrationCommit === null || integrationCommit.length === 0) {
    // Dev scaffold — no marker required.
    return {ok: true, message: 'integration marker: not required (dev scaffold)'}
  }

  const short8 = integrationCommit.slice(0, 8)
  const marker = `+harness.${short8}`

  if (versionOutput.includes(marker)) {
    return {ok: true, message: `integration marker present: ${marker}`}
  }

  return {
    ok: false,
    message: `integration marker missing: '${marker}' not found in --version output '${versionOutput}'`,
  }
}

/**
 * Asserts that the binary exited with code 0 on a probe invocation.
 *
 * @param exitCode - The exit code from the binary probe.
 * @param probe    - The probe command used (for error messages).
 */
export function assertExitZero(exitCode: number, probe: string): VerifyResult {
  if (exitCode === 0) {
    return {ok: true, message: `${probe}: exit 0`}
  }
  return {
    ok: false,
    message: `${probe}: non-zero exit code ${exitCode}`,
  }
}

/**
 * Runs all verification assertions and returns a combined result.
 *
 * The binary self-reports its version via --version. For a harness build, this is
 * "<base>+harness.<short8>". A stock upstream binary reports bare "<base>", which
 * fails the version match. Full provenance lives in the package's provenance.json.
 *
 * @param params - Verification inputs.
 * @param params.versionOutput      - Trimmed stdout from `binary --version`.
 * @param params.expectedVersion    - The full expected version string to assert.
 * @param params.integrationCommit  - Frozen integration commit SHA, or null.
 * @param params.exitCode           - Exit code from the --version probe.
 */
export function runVerifications(params: {
  readonly versionOutput: string
  readonly expectedVersion: string
  readonly integrationCommit: string | null
  readonly exitCode: number
}): {readonly ok: boolean; readonly failures: readonly string[]} {
  const {versionOutput, expectedVersion, integrationCommit, exitCode} = params

  const results: VerifyResult[] = [
    assertExitZero(exitCode, '--version'),
    assertVersionMatch(versionOutput, expectedVersion),
    assertIntegrationMarker(versionOutput, integrationCommit),
  ]

  const failures = results.filter(r => !r.ok).map(r => r.message)
  return {ok: failures.length === 0, failures}
}
