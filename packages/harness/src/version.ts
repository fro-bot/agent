/**
 * Builds the version string a harness-built OpenCode binary self-reports.
 * The integration commit is embedded so the binary's --version proves which
 * frozen integration produced it: "<baseVersion>+harness.<shortSha>".
 */
export function buildHarnessVersion(baseVersion: string, integrationCommit: string): string {
  const shortSha = integrationCommit.slice(0, 8)
  return `${baseVersion}+harness.${shortSha}`
}
