/**
 * Builds the version string a harness-built OpenCode binary self-reports.
 * The integration commit is embedded so the binary's --version proves which
 * frozen integration produced it: "<baseVersion>+harness.<shortSha>".
 */
export function buildHarnessVersion(baseVersion: string, integrationCommit: string): string {
  const shortSha = integrationCommit.slice(0, 8)
  return `${baseVersion}+harness.${shortSha}`
}

/**
 * Builds the npm-compatible prerelease version string for a harness-built OpenCode package.
 * npm strips SemVer build metadata (§10), so we use a prerelease identifier with a hyphen
 * instead of the plus sign used by the binary's self-reported version.
 * Format: "<baseVersion>-harness.<shortSha>" (e.g. "1.17.3-harness.ed359558").
 */
export function buildHarnessNpmVersion(baseVersion: string, integrationCommit: string): string {
  const shortSha = integrationCommit.slice(0, 8)
  return `${baseVersion}-harness.${shortSha}`
}

/**
 * Builds the GitHub Release tag for a harness-built OpenCode release.
 * Uses SemVer build metadata (plus sign) to match the binary's self-reported version.
 * Deliberately NOT "v"-prefixed: product releases use semantic-release's default
 * `v${version}` tag format, and a "v"-prefixed harness tag (e.g. "v1.17.3+harness.<sha>")
 * matches that and outranks the product `v0.x` tags, poisoning the next-version
 * computation. The non-"v" form keeps harness tags out of the product tag space.
 * Format: "<baseVersion>+harness.<shortSha>" (e.g. "1.17.3+harness.ed359558").
 */
export function buildHarnessReleaseTag(baseVersion: string, integrationCommit: string): string {
  const shortSha = integrationCommit.slice(0, 8)
  return `${baseVersion}+harness.${shortSha}`
}
