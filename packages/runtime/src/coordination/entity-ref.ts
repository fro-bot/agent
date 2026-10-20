/**
 * Extract the owner/repo from an `entity_ref` string.
 *
 * The gateway writes `entity_ref` as the bare `owner/repo` (`execute/run.ts` and `discord/maintenance-run.ts`).
 * The strip of everything from the first `#` only guards legacy or malformed records that carry a `#...` suffix.
 * After the strip, the parser splits on the first `/`. Returns
 * `null` when there is no slash or when owner or repo is empty. Extra path
 * segments stay in `repo` (`a/b/c` → `{owner: 'a', repo: 'b/c'}`).
 *
 * This parser gates repo access in the gateway, so there is exactly one
 * definition of it; do not re-implement it at call sites.
 */
export function parseEntityRefRepo(entityRef: string): {readonly owner: string; readonly repo: string} | null {
  const hashIdx = entityRef.indexOf('#')
  const repoPath = hashIdx === -1 ? entityRef : entityRef.slice(0, hashIdx)

  const slashIdx = repoPath.indexOf('/')
  if (slashIdx === -1) {
    return null
  }

  const owner = repoPath.slice(0, slashIdx)
  const repo = repoPath.slice(slashIdx + 1)
  if (owner.length === 0 || repo.length === 0) {
    return null
  }

  return {owner, repo}
}
