/**
 * Per-repository operation mutex, shared by clone, update, recover, and backup delete.
 *
 * Extracted from clone.ts's private `withRepoLock`/`repoLocks` (same semantics, unchanged
 * behavior) so every workspace-agent operation that mutates a repository's checkout, its
 * protected bare mirror, or its quarantine generations serializes against every other operation
 * for that same repository — never against a different repository.
 *
 * checkout-update-recovery plan, Key Technical Decisions: "One per-repo operation mutex in the
 * workspace shared by clone, update, recover, and backup delete." The workspace is a single
 * container (a documented precondition of the #1661 migration; `deploy/validate-stack.sh`
 * refuses a `workspace` service declaring more than one replica), so this in-process mutex plus
 * the gateway's repo lock is sufficient — no cross-process coordination is needed here.
 *
 * A workspace restart drops this map along with the process; any journal an in-flight operation
 * had written survives on disk (journal.ts) for startup reconciliation to find.
 */

/** All in-flight per-repo locks, keyed by `repoMutexKey(owner, repo)`. */
const repoLocks = new Map<string, Promise<void>>()

/** Canonical mutex key for a repository — always `owner/repo`. */
export function repoMutexKey(owner: string, repo: string): string {
  return `${owner}/${repo}`
}

/**
 * Runs `fn` under the exclusive per-repo lock named by `key`. Callers queue in arrival order
 * (first-in-first-out via chained promise waits); a rejected `fn` still releases the lock in
 * `finally`, so one failed operation can never wedge every later operation on the same
 * repository. Different keys never contend with each other.
 */
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (repoLocks.has(key)) {
    await repoLocks.get(key)
  }
  let release!: () => void
  const lock = new Promise<void>(resolve => {
    release = resolve
  })
  repoLocks.set(key, lock)
  try {
    return await fn()
  } finally {
    repoLocks.delete(key)
    release()
  }
}

/** Reset mutex state — for testing only. */
export function resetRepoLocksForTesting(): void {
  repoLocks.clear()
}
