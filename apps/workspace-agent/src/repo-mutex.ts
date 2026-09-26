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

/**
 * A sticky, in-process maintenance hold on a single repository — set when some operation for that
 * repository ended with an UNCONFIRMED subprocess termination (see git-safety.ts's/git-stream.ts's
 * `termination-unconfirmed`: SIGKILL was sent, but the child's exit was never observed within the
 * reap-grace window). An unconfirmed termination means the workspace-agent genuinely does not know
 * whether that subprocess (or a descendant it spawned) is still running, possibly still touching
 * the repository's checkout, protected bare mirror, or quarantine generations. A held repository
 * refuses every later mutating operation (clone, update, and — in Unit 5 — recovery) rather than
 * risk two operations touching the same on-disk state concurrently.
 *
 * Cleared ONLY by a process restart, never by a timer or a later successful operation: this
 * process is the container's own supervisor (see repo-mutex.ts's module header — the workspace is
 * always exactly one container), so a restart is the only event that can actually guarantee any
 * leaked subprocess (and everything it might still be doing) is gone. A hold that could clear
 * itself on a schedule would reintroduce exactly the race this exists to prevent.
 */
export type RepoHoldReason = 'termination-unconfirmed'

/** All currently-held repositories, keyed by `repoMutexKey(owner, repo)`, mapped to why they were held. */
const repoHolds = new Map<string, RepoHoldReason>()

/**
 * Marks `key` as held for `reason`. Idempotent — marking an already-held repository again (even
 * for a different reason) is a no-op; the FIRST hold reason recorded for a repository is
 * preserved, since it is the earliest evidence that something may still be running.
 */
export function markRepoHeld(key: string, reason: RepoHoldReason): void {
  if (repoHolds.has(key)) return
  repoHolds.set(key, reason)
}

/** The hold reason for `key`, or `undefined` if the repository is not currently held. */
export function repoHoldReason(key: string): RepoHoldReason | undefined {
  return repoHolds.get(key)
}

/** Reset hold state — for testing only. */
export function resetRepoHoldsForTesting(): void {
  repoHolds.clear()
}
