/**
 * Binary verification logic — unit-testable assertions extracted from verify-binary.ts.
 *
 * These pure functions are tested in verify.test.ts against fake binary stubs.
 * The actual exec calls live in scripts/verify-binary.ts.
 *
 * Verification contract:
 *   1. --version output == expectedVersion (exact match, trimmed).
 *   2. Integration marker present in a STRUCTURED position in the probe output.
 *      The marker must appear on a dedicated line matching:
 *        "  integration commit: <sha>"
 *      This prevents a binary that merely mentions the SHA in unrelated output
 *      from passing the check.
 *   3. Binary is executable (exit code 0 on --version).
 */

/** Result of a single verification assertion. */
export interface VerifyResult {
  readonly ok: boolean
  readonly message: string
}

/**
 * Asserts that the binary's reported version matches the expected base version.
 *
 * @param actualVersion   - The trimmed stdout from `binary --version`.
 * @param expectedVersion - The base release version (e.g. '1.15.13').
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
 * Asserts that the integration commit marker is present in a STRUCTURED position
 * in the binary's probe output.
 *
 * The integration marker is the frozen integration commit SHA embedded in the
 * binary's provenance. We probe it via `binary info` which outputs the harness
 * provenance in a structured format. The marker must appear on a dedicated line:
 *
 *   "  integration commit: <sha>"
 *
 * This structured check prevents a binary that merely mentions the SHA in
 * unrelated output (e.g. error messages, help text) from passing the check.
 *
 * An empty integrationCommit is treated as "no marker required" (dev scaffold).
 *
 * @param probeOutput       - Combined output from the binary probe (--version + info).
 * @param integrationCommit - The frozen integration commit SHA to look for, or null/empty.
 */
export function assertIntegrationMarker(probeOutput: string, integrationCommit: string | null): VerifyResult {
  if (integrationCommit === null || integrationCommit.length === 0) {
    // Dev scaffold — no marker required.
    return {ok: true, message: 'integration marker: not required (dev scaffold)'}
  }

  // The marker must appear on a dedicated structured line in the probe output.
  // Format: "  integration commit: <sha>" (as emitted by `harness info` / formatProvenance).
  // This prevents substring matches in unrelated output from passing.
  const structuredMarkerPattern = new RegExp(
    String.raw`^\s*integration commit:\s+${escapeRegex(integrationCommit)}\s*$`,
    'm',
  )
  if (structuredMarkerPattern.test(probeOutput)) {
    return {ok: true, message: `integration marker present: ${integrationCommit}`}
  }

  return {
    ok: false,
    message: `integration marker missing: '${integrationCommit}' not found in structured position in binary output`,
  }
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
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
 * @param params - Verification inputs.
 * @param params.versionOutput      - Trimmed stdout from `binary --version`.
 * @param params.expectedVersion    - The base release version to assert.
 * @param params.probeOutput        - Combined probe output for marker check.
 * @param params.integrationCommit  - Frozen integration commit SHA, or null.
 * @param params.exitCode           - Exit code from the --version probe.
 */
export function runVerifications(params: {
  readonly versionOutput: string
  readonly expectedVersion: string
  readonly probeOutput: string
  readonly integrationCommit: string | null
  readonly exitCode: number
}): {readonly ok: boolean; readonly failures: readonly string[]} {
  const {versionOutput, expectedVersion, probeOutput, integrationCommit, exitCode} = params

  const results: VerifyResult[] = [
    assertExitZero(exitCode, '--version'),
    assertVersionMatch(versionOutput, expectedVersion),
    assertIntegrationMarker(probeOutput, integrationCommit),
  ]

  const failures = results.filter(r => !r.ok).map(r => r.message)
  return {ok: failures.length === 0, failures}
}
