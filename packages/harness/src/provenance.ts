/**
 * Provenance manifest for the harness binary.
 *
 * The manifest is the single source of truth written by the integration engine
 * and read by the CLI commands (info, patches, doctor).
 *
 * baseVersion       — the upstream OpenCode release tag this binary is based on.
 * integrationRefs   — ordered list of integration refs carried onto the base tag,
 *                     each with the resolved commit SHA and optional metadata.
 * integrationCommit — the frozen integration commit SHA produced by the LLM merge.
 * buildSha          — the git SHA of the harness build, or 'dev' in the scaffold.
 */
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

export interface IntegrationRefRecord {
  readonly ref: string
  readonly resolvedSha: string
  readonly reason?: string
  readonly upstreamStatus?: string
}

export interface Provenance {
  readonly baseVersion: string
  readonly integrationRefs: readonly IntegrationRefRecord[]
  readonly integrationCommit: string | null
  readonly buildSha: string
}

/** The repository that hosts the pushed `refs/harness-integrate/<base_version>` integration commits. */
const INTEGRATION_REPO_URL = 'https://github.com/fro-bot/agent'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Type guard: validates that an unknown value has the shape of a Provenance manifest.
 * Treats malformed JSON as an explicit error rather than silently returning partial data.
 */
export function isValidProvenance(value: unknown): value is Provenance {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.baseVersion !== 'string' || v.baseVersion.length === 0) return false
  if (!Array.isArray(v.integrationRefs)) return false
  if (v.integrationCommit !== null && typeof v.integrationCommit !== 'string') return false
  if (typeof v.buildSha !== 'string') return false
  return true
}

/**
 * Type guard: validates that an unknown value has the shape of a harness.config.json.
 */
function isValidHarnessConfig(value: unknown): value is {base_version?: string; integrationRefs?: string[]} {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.base_version !== undefined && typeof v.base_version !== 'string') return false
  if (v.integrationRefs !== undefined && !Array.isArray(v.integrationRefs)) return false
  return true
}

/**
 * Returns the provenance for the current harness binary.
 *
 * Resolution order:
 *   1. Bundled provenance.json (written by the integration engine at build time).
 *   2. harness.config.json (dev scaffold — shows configured refs without a frozen commit).
 *   3. Hardcoded dev placeholder (no config file present).
 *
 * The integration engine writes provenance.json at build time; this function reads
 * it at runtime, making the manifest available without additional filesystem reads
 * in production.
 */
export function getProvenance(): Provenance {
  // 1. Try bundled provenance.json (written by the integration engine).
  try {
    const manifestPath = path.join(packageRoot, 'provenance.json')
    const raw = readFileSync(manifestPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (isValidProvenance(parsed)) {
      return parsed
    }
    // Malformed manifest — fall through to dev scaffold.
  } catch {
    // No bundled manifest — fall through.
  }

  // 2. Fall back to harness.config.json for the dev scaffold.
  try {
    const configPath = path.join(packageRoot, 'harness.config.json')
    const raw = readFileSync(configPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isValidHarnessConfig(parsed)) {
      // Malformed config — fall through to the unknown-version placeholder.
      throw new Error('Invalid harness.config.json shape')
    }
    const baseVersion = parsed.base_version ?? 'unknown'
    const integrationRefs: IntegrationRefRecord[] = (parsed.integrationRefs ?? []).map(ref => ({
      ref,
      resolvedSha: 'dev',
    }))
    return {
      baseVersion,
      integrationRefs,
      integrationCommit: null,
      buildSha: 'dev',
    }
  } catch {
    // No config file — return hardcoded placeholder.
  }

  return {
    baseVersion: 'unknown',
    integrationRefs: [],
    integrationCommit: null,
    buildSha: 'dev',
  }
}

/**
 * Returns the commit page URL for a frozen integration commit.
 * The commit is pushed to `fro-bot/agent` under `refs/harness-integrate/<base_version>`.
 */
export function integrationCommitUrl(sha: string): string {
  return `${INTEGRATION_REPO_URL}/commit/${sha}`
}

/**
 * Formats the one-line `harness --version` output.
 */
export function formatVersionLine(p: Provenance): string {
  return `@fro.bot/harness base:${p.baseVersion} build:${p.buildSha} integration:${p.integrationCommit ?? 'dev'}`
}

/**
 * Formats provenance as a human-readable string for `harness info`.
 */
export function formatProvenance(p: Provenance): string {
  const lines: string[] = [
    `harness (patched OpenCode)`,
    `  base:               ${p.baseVersion}`,
    `  integration commit: ${p.integrationCommit === null ? '(unbuilt/dev scaffold)' : integrationCommitUrl(p.integrationCommit)}`,
    `  build sha:          ${p.buildSha}`,
  ]
  if (p.integrationRefs.length > 0) {
    lines.push(`  integration refs:`)
    for (const r of p.integrationRefs) {
      const meta = r.upstreamStatus === undefined ? '' : ` [${r.upstreamStatus}]`
      lines.push(`    - ${r.ref}${meta}`)
      if (r.reason !== undefined) {
        lines.push(`      reason: ${r.reason}`)
      }
    }
  } else {
    lines.push(`  integration refs:   (none — dev scaffold)`)
  }
  return lines.join('\n')
}

/**
 * Formats the integration refs and frozen commit for `harness patches`.
 */
export function formatPatches(p: Provenance): string {
  if (p.integrationRefs.length === 0) {
    return 'No integration refs configured (dev scaffold).'
  }
  const lines: string[] = ['Integration refs:']
  for (const r of p.integrationRefs) {
    const status = r.upstreamStatus === undefined ? '' : ` [${r.upstreamStatus}]`
    lines.push(`  - ${r.ref}${status}`)
    if (r.reason !== undefined) {
      lines.push(`    reason: ${r.reason}`)
    }
  }
  if (p.integrationCommit !== null) {
    lines.push(`\nFrozen integration commit: ${integrationCommitUrl(p.integrationCommit)}`)
  }
  return lines.join('\n')
}
