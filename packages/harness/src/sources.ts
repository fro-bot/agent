/**
 * Integration source resolution — maps each configured ref to git fetch refs.
 *
 * Ported from cortexkit/orw src/index.ts parseSource (MIT).
 * Adapted for CI/non-interactive use: no launchd, no desktop, no interactive prompts.
 *
 * Supported input forms:
 *   - Local branch name (no https:// prefix) → refs/heads/<b>
 *   - GitHub branch URL (https://github.com/owner/repo/tree/<branch>) → refs/heads/<branch>
 *   - GitHub PR URL (https://github.com/owner/repo/pull/N) → refs/pull/N/head
 *
 * Throws on empty input or unsupported URL forms.
 */

export interface IntegrationSource {
  /** Human-readable label for log output and the merge prompt. */
  readonly label: string
  /** Git remote URL for the source repository. */
  readonly repo: string
  /** The ref to fetch from the remote (e.g. refs/pull/N/head, refs/heads/<b>). */
  readonly fetchRef: string
  /** The local remote-tracking ref to store the fetched ref under. */
  readonly fetch: string
  /** The ref to merge (same as fetch; kept separate for prompt rendering). */
  readonly merge: string
}

export interface CarryManifestEntry {
  readonly ref: string
  readonly resolvedSha: string
}

/**
 * The immutable carry input shared by the authoritative and forward-shadow paths.
 * GitHub does not reliably serve arbitrary reachable commits by SHA, so consumers
 * fetch the configured ref and assert that it still resolves to this SHA.
 */
export interface CarryManifest {
  readonly base: string
  readonly carries: readonly CarryManifestEntry[]
}

export interface ResolvedIntegrationSource extends IntegrationSource {
  readonly resolvedSha: string
}

export type SourceShaResolver = (source: IntegrationSource) => Promise<string>

const SHA_PATTERN = /^[0-9a-f]{40}$/i

export function isValidCarryManifest(value: unknown): value is CarryManifest {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as {readonly base?: unknown; readonly carries?: unknown}
  if (typeof candidate.base !== 'string' || candidate.base.length === 0 || Array.isArray(candidate.carries) === false) {
    return false
  }
  return candidate.carries.every(entry => {
    if (entry === null || typeof entry !== 'object') return false
    const carry = entry as {readonly ref?: unknown; readonly resolvedSha?: unknown}
    return (
      typeof carry.ref === 'string' &&
      carry.ref.length > 0 &&
      typeof carry.resolvedSha === 'string' &&
      carry.resolvedSha === carry.resolvedSha.toLowerCase() &&
      SHA_PATTERN.test(carry.resolvedSha)
    )
  })
}

export function carrySourceResolutionError(source: Pick<IntegrationSource, 'label'>, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(
    `[CarrySourceResolutionError] failed to resolve carry ${source.label} to an immutable SHA: ${message}`,
  )
  error.name = 'CarrySourceResolutionError'
  return error
}

export function carrySourceChangedError(
  source: Pick<IntegrationSource, 'label'>,
  expectedSha: string,
  actualSha: string,
): Error {
  const error = new Error(
    `[CarrySourceChangedError] carry ${source.label} changed after resolution: expected ${expectedSha}, fetched ${actualSha}`,
  )
  error.name = 'CarrySourceChangedError'
  return error
}

export function carrySourceFetchError(source: Pick<IntegrationSource, 'label'>, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(`[CarrySourceFetchError] failed to fetch frozen carry ${source.label}: ${message}`)
  error.name = 'CarrySourceFetchError'
  return error
}

/**
 * Maps a single integration source input to a typed IntegrationSource.
 *
 * @param input      - A PR URL, branch URL, or local branch name from config.
 * @param sourceRepo - The default source repo URL (used for local branch names).
 */
export function parseSource(input: string, sourceRepo: string): IntegrationSource {
  const value = input.trim()
  if (value.length === 0) throw new Error('Empty integration source in config branches')

  if (!value.startsWith('https://github.com/')) {
    // Local branch name — fetch from the source repo.
    return {
      label: value,
      repo: sourceRepo,
      fetchRef: `refs/heads/${value}`,
      fetch: `refs/remotes/watch/local/${value}`,
      merge: `refs/remotes/watch/local/${value}`,
    }
  }

  const url = new URL(value)
  const parts = url.pathname.split('/').filter(Boolean)
  const owner = parts[0]
  const repo = parts[1]
  if (owner === undefined || repo === undefined) throw new Error(`Unsupported GitHub source URL: ${value}`)

  if (parts.length >= 4 && parts[2] === 'tree') {
    const branch = decodeURIComponent(parts.slice(3).join('/'))
    const slug = watchSlug(owner, repo)
    const ref = `refs/remotes/watch/${slug}/${branch}`
    return {
      label: `${owner}/${repo}:${branch}`,
      repo: `https://github.com/${owner}/${repo}.git`,
      fetchRef: `refs/heads/${branch}`,
      fetch: ref,
      merge: ref,
    }
  }

  if (parts.length >= 4 && parts[2] === 'pull') {
    const number = parts[3] ?? ''
    if (!/^\d+$/.test(number)) {
      throw new Error(`Unsupported GitHub pull request URL: ${value}`)
    }
    const slug = watchSlug(owner, repo)
    const ref = `refs/remotes/watch/${slug}/pr-${number}`
    return {
      label: `${owner}/${repo}#${number}`,
      repo: `https://github.com/${owner}/${repo}.git`,
      fetchRef: `refs/pull/${number}/head`,
      fetch: ref,
      merge: ref,
    }
  }

  throw new Error(`Unsupported GitHub integration source URL: ${value}`)
}

/**
 * Maps an array of integration source inputs to typed IntegrationSources.
 *
 * @param refs       - Array of PR URLs, branch URLs, or local branch names.
 * @param sourceRepo - The default source repo URL (used for local branch names).
 */
export function resolveSources(refs: readonly string[], sourceRepo: string): IntegrationSource[] {
  return refs.map(input => parseSource(input, sourceRepo))
}

export async function resolveCarryManifest(
  base: string,
  refs: readonly string[],
  sourceRepo: string,
  resolveSha: SourceShaResolver,
): Promise<CarryManifest> {
  if (base.trim().length === 0) throw new Error('Carry manifest base must not be empty')

  const sources = resolveSources(refs, sourceRepo)
  const carries: CarryManifestEntry[] = []
  for (const [index, source] of sources.entries()) {
    if (source === undefined) throw new Error(`Carry manifest source ${index} is missing`)
    let resolvedSha: string
    try {
      resolvedSha = (await resolveSha(source)).trim().toLowerCase()
    } catch (error) {
      throw carrySourceResolutionError(source, error)
    }
    if (SHA_PATTERN.test(resolvedSha) === false) {
      throw carrySourceResolutionError(source, new Error(`resolver returned invalid SHA ${resolvedSha}`))
    }
    carries.push(Object.freeze({ref: refs[index] ?? source.label, resolvedSha}))
  }

  return Object.freeze({base, carries: Object.freeze(carries)})
}

export function sourcesFromCarryManifest(manifest: CarryManifest, sourceRepo: string): ResolvedIntegrationSource[] {
  return manifest.carries.map(carry => {
    const source = parseSource(carry.ref, sourceRepo)
    return {...source, resolvedSha: carry.resolvedSha}
  })
}

function watchSlug(owner: string, repo: string): string {
  return `${owner}-${repo}`.replaceAll(/[^\w.-]/g, '-')
}
