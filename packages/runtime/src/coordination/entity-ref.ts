import {parseRepoSlug} from '../repo/slug.js'

/**
 * Extract the owner/repo from an `entity_ref` string.
 *
 * The gateway writes `entity_ref` as the bare `owner/repo` (`execute/run.ts` and `discord/maintenance-run.ts`).
 * The strip of everything from the first `#` only guards legacy or malformed records that carry a `#...` suffix.
 * After the strip, the remainder must be a valid slug (`parseRepoSlug`: trimmed, exactly one `/`, non-empty
 * owner and repo, no whitespace, `?`, `\` or control characters). Anything else returns `null`, including extra
 * path segments (`a/b/c`), which are never folded into the repo name. Case is preserved.
 *
 * This parser gates repo access in the gateway, so there is exactly one definition of it; do not re-implement
 * it at call sites.
 */
export function parseEntityRefRepo(entityRef: string): {readonly owner: string; readonly repo: string} | null {
  const hashIdx = entityRef.indexOf('#')
  const repoPath = hashIdx === -1 ? entityRef : entityRef.slice(0, hashIdx)

  const parsed = parseRepoSlug(repoPath)
  return parsed.success ? parsed.data : null
}
