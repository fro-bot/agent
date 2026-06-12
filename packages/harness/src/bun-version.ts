/**
 * Pinned Bun version required by the harness native build.
 *
 * This must match anomalyco/opencode's `packageManager` declaration at the
 * configured base release. It is kept in step with the `bun-version` input in
 * harness-release.yaml and is tracked by Renovate via a customManager regex
 * against oven-sh/bun releases.
 *
 * Do not change this value without also updating the workflow's bun-version
 * and verifying it matches upstream's packageManager field.
 */
export const HARNESS_BUN_VERSION = '1.3.14'
