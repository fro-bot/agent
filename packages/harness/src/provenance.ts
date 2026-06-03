/**
 * Provenance shape for the harness binary.
 *
 * baseVersion    — the upstream OpenCode release tag this binary is based on.
 * integrationRefs — ordered list of integration refs carried onto the base tag
 *                   (PR URLs, branch URLs, or local branch names).
 * integrationCommit — the frozen integration commit SHA produced by the LLM merge,
 *                     or null when running from a dev/unbuilt scaffold.
 * buildSha       — the git SHA of the harness build, or 'dev' in the scaffold.
 */
export interface Provenance {
  readonly baseVersion: string
  readonly integrationRefs: readonly string[]
  readonly integrationCommit: string | null
  readonly buildSha: string
}

/**
 * Returns the placeholder dev provenance used before Unit 2/3 wire the real manifest.
 * Unit 2 replaces this with a manifest read from a generated provenance.json at build time.
 */
export function getProvenance(): Provenance {
  return {
    baseVersion: '1.15.13',
    integrationRefs: [],
    integrationCommit: null,
    buildSha: 'dev',
  }
}

/**
 * Formats provenance as a human-readable string for `harness info`.
 */
export function formatProvenance(p: Provenance): string {
  const lines: string[] = [
    `harness (patched OpenCode)`,
    `  base:               ${p.baseVersion}`,
    `  integration commit: ${p.integrationCommit ?? '(unbuilt/dev scaffold)'}`,
    `  build sha:          ${p.buildSha}`,
  ]
  if (p.integrationRefs.length > 0) {
    lines.push(`  integration refs:`)
    for (const ref of p.integrationRefs) {
      lines.push(`    - ${ref}`)
    }
  } else {
    lines.push(`  integration refs:   (none — dev scaffold)`)
  }
  return lines.join('\n')
}
