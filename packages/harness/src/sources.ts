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

/**
 * Maps a single integration source input to a typed IntegrationSource.
 *
 * @param input      - A PR URL, branch URL, or local branch name from config.
 * @param sourceRepo - The default source repo URL (used for local branch names).
 */
export function parseSource(input: string, sourceRepo: string): IntegrationSource {
  const value = input.trim()
  if (!value) throw new Error('Empty integration source in config branches')

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

function watchSlug(owner: string, repo: string): string {
  return `${owner}-${repo}`.replaceAll(/[^\w.-]/g, '-')
}
