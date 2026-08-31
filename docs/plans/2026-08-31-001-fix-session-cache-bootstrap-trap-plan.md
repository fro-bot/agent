---
title: 'fix: Break the session-cache bootstrap trap'
type: fix
status: active
date: 2026-08-31
deepened: 2026-08-31
---

# fix: Break the session-cache bootstrap trap

## Overview

A run whose OpenCode server fails to start persists session state that makes the next run fail the same way. Nothing in the codebase recovers from it — both reporters escaped only by deleting every `opencode-*` cache entry by hand. This makes the failure absorbing instead of re-runnable, and turns one unlucky run into a permanently red required check.

## Problem Frame

Reported in [#1407](https://github.com/fro-bot/agent/issues/1407) against `bfra-me/.github`, then hit independently on `fro-bot/dashboard` at a later version. Three findings from that thread and this plan's research, in order of how much they change the fix:

**The database is never checkpointed, on any run.** `src/services/cache/save.ts:35-37` states it plainly: `server.close()` sends `proc.kill()` without awaiting a checkpoint, so a valid session can have `opencode.db` at 0 bytes with all its data in `opencode.db-wal`. `serverHandle.shutdown()` (`src/harness/phases/cleanup.ts:114`) is synchronous — it calls `close()`, which calls `stop(proc)`, which sends SIGTERM and returns. Nothing awaits the child's exit before the cache is read off disk. The comment directly above it (`cleanup.ts:107-111`) claims "a clean shutdown triggers a SQLite WAL checkpoint"; that is the intent, not the behavior, and `save.ts` contradicts it in the same repository.

This matters more than the trap itself: **every** cached database is transported with a hot WAL, not just those from failed runs. So a fix phrased as "only persist state that was cleanly checkpointed" would block every save, because nothing is cleanly checkpointed today. The checkpoint has to be added, not gated on.

**Recovery cannot reach the database.** `cleanStorage` (`src/services/cache/restore.ts:45-50`) removes `storagePath`, but the database family lives at `path.dirname(storagePath)` (`src/services/cache/paths.ts:51-52`). When the harness declares corruption and proceeds "with clean state," the database survives untouched. That is exactly why manual deletion was the only escape, and why deleting one branch's entry did not help — the restore-key prefix falls back to another equally-affected entry.

**Both saves on the failure path are unguarded.** The issue's triage concluded that `runCleanup` never executes on bootstrap failure and that `src/harness/post.ts` is what persists the bad state. That is wrong, and it changes the target: `src/harness/run.ts:205` is a `finally`, so `runCleanup` runs even after the `return 1` at `:131`. `serverHandle` is still null (assigned at `:133`, after the check), so cleanup skips pruning and shutdown and then saves anyway at `cleanup.ts:172`. `post.ts:100` is a second unguarded save that fires when cleanup's did not set `CACHE_SAVED`. A fix that only gates the post hook misses the primary path.

## Requirements Trace

- R1. A run that cannot start its server must not leave the next run worse off than a cold start.
- R2. Session state that reaches the cache must be readable at normal speed by the next run, without that run paying recovery cost for an unfinished write.
- R3. When the harness declares storage corrupt and proceeds with clean state, the state it proceeds with must actually be clean.
- R4. A failure to persist must be visible and attributable, never a silent skip.
- R5. The bootstrap budget must be observable in logs and adjustable by a consumer.
- R6. `session-retention` must either control retention or stop claiming to.
- R7. Existing session continuity on healthy runs must not regress.
- R8. A repository already caught in the loop must recover without a human deleting cache entries.

## Scope Boundaries

- Not changing the cache key strategy, the restore-key fallback chain, or the S3 backend's role as canonical persistence.
- Not introducing a cache size cap. Size was investigated and disproven as the driver (below); a cap would be a proxy for a condition we can now detect directly.
- Not attempting to make pruning work without a live server. Pruning is inherently online (`packages/runtime/src/session/prune.ts:41,52,112`), and the fix does not need it to be offline.

### Deferred to Separate Tasks

- Reducing what the agent writes per run, if session growth turns out to be worth bounding on its own: separate issue, once R2 lands and the WAL stops being the growth surface.

## Context & Research

### The size hypothesis was raised and disproven

The original report correlated failures with cache size (189 MB coin-flip, 292 MB guaranteed loss). Marcus's `dashboard` data killed it: a run succeeded at 21,620,154 B with 1.88s of headroom, and runs an hour later timed out at 21,638,164 B — 18 KB apart, an order of magnitude below where the first repo saw trouble. The plan does not treat size as the mechanism.

### Measured: WAL recovery cost is real and scales

Probed directly rather than assumed. A SQLite database with an uncheckpointed 185 MB WAL, opened cold:

| State | Open + first read |
| --- | --- |
| Hot WAL + `-shm` | 2416.8 ms |
| Hot WAL, no `-shm` | 2095.6 ms |
| After `wal_checkpoint(TRUNCATE)` | 60.2 ms |

A 40× difference. Against a 5000 ms budget this is decisive at `bfra-me/.github`'s scale, and it explains why a fresh cache cleared the problem there.

**It does not explain `dashboard`.** That repo's entire cache was 21 MB, so its WAL recovery cost is plausibly in the low hundreds of milliseconds — not enough to turn 1.88s of headroom into a timeout. The honest reading is that the two incidents have different dominant causes: recovery cost for the large-cache case, runner variance for the small-cache case. Both are addressed here, and neither fix alone covers both reports.

### External findings that shaped the design

- `-shm` is a machine-local wal-index that SQLite never syncs. Transporting it between runners is at best useless and can interfere with recovery. It should leave the cached path set.
- `wal_checkpoint(TRUNCATE)` requires a writable connection, can be blocked by readers, and may partially progress. A separate process operating after a killed writer can hit `SQLITE_BUSY`. Checkpointing must be attempted and its outcome checked, never assumed.
- Established practice is to avoid caching a live database directory at all. We cannot adopt that wholesale — the database *is* the session state — but it argues for capturing a consistent snapshot rather than raw live files.

### Institutional learnings that constrain the fix

- `docs/solutions/integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md` — a save that fails silently cost a month of lost continuity. **Any gate added here must record why it declined and surface it, or it recreates that incident with a new cause.**
- `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md` — duplicate sources of truth drift silently. The two save paths must consult one authority, not each keep their own notion of whether the state is safe.
- `docs/solutions/workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md` — cleanup that must run cannot be chained behind a step whose failure skips it. The checkpoint is fallible; cleanup must still complete when it fails.
- `docs/solutions/best-practices/overflow-recovery-architecture-2026-08-03.md` — continuity is load-bearing. Declining to persist is a real cost, not a free safety measure.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/runtime, src/services/cache, src/harness",
  "freshness": {
    "vcs_reference": "d9a88dee8"
  },
  "budget": {
    "max_search_passes": 2,
    "max_candidate_inspections": 6,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/harness/phases/cleanup.ts shutdown sequence",
      "description": "Terminates the OpenCode child before the cache is saved, and is documented as the place a checkpoint would occur",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/services/cache/save.ts hasCacheableContent",
      "description": "Already inspects the database family before saving, and already documents that the WAL may hold all session data",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/services/cache/restore.ts cleanStorage",
      "description": "Owns the 'proceed with clean state' recovery path but deletes only storagePath",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/services/cache/paths.ts buildSaveCachePaths",
      "description": "Single definition of which database-family files cross the cache boundary",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/harness/config/state-keys.ts",
      "description": "Established mechanism for a phase to signal the post hook",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/session/prune.ts",
      "description": "Session retention logic; inherently online, requires a live SDK client",
      "disposition": "insufficient",
      "insufficiency_reason": "Cannot run when bootstrap failed, which is precisely the case that persists bad state"
    }
  ]
}
```

## Key Technical Decisions

- **Repair on restore, not only on save.** This is the decision the first draft missed, and it is what actually breaks the loop. Declining to persist bad state prevents *new* poisoning but cannot escape *existing* poisoning: save keys are unique per run (`src/services/cache/cache-key.ts:51`) and restore keys are prefixes returning the most recent match, so a run that declines to save leaves the poisoned entry as the newest one and the next run restores it again. Checkpointing the restored database *before* bootstrap recovers the session instead of discarding it, and heals a stuck repository in one run.
- **The repair happens outside the bootstrap budget.** `restoreCache` completes at `src/harness/phases/cache-restore.ts:37` and `bootstrapOpenCodeServer` is called at `:57`, with no timer spanning them. The 5000 ms budget covers only `createOpencode`. Doing the checkpoint between them moves the measured 2416.8 ms recovery cost out of the window that was failing.
- **Checkpoint in place; do not snapshot.** External guidance favours capturing a consistent snapshot (`VACUUM INTO`, backup API) over transporting a live database. Rejected here: the cache *is* the next run's live working set, not an archive. A snapshot would add a second representation that still has to be restored back into a live database, moving the "make it live" step to restore time and reintroducing the same hazard one run later. The hybrid we do adopt is normalising what gets transported — database plus `-wal`, never `-shm`.
- **The checkpoint belongs at the cache boundary, not in the session runtime.** `src/harness/phases/cleanup.ts:172` and `src/harness/post.ts:100` both call the same `saveCache` (`src/services/cache/save.ts:64`), which also owns the S3 sync at `:97`. Placing the checkpoint there means one definition serves every capture path structurally, instead of a flag two callers must agree to read. A `packages/runtime/src/session/` primitive would put a persistence-policy decision in a layer that has no persistence context.
- **Do not require observing the child's exit.** The first draft said to await it. The harness cannot: `shutdown()` returns `void` (`packages/runtime/src/agent/server.ts:74-76`) and the SDK owns the process handle. The checkpoint attempt is itself the liveness probe — a live writer surfaces as busy — so bounded retry on that signal replaces an unobservable wait.
- **Trust the observed effect, not the pragma's return row.** Verified on Node 24.20.0: `PRAGMA wal_checkpoint(TRUNCATE)` returned `{busy: 0, log: 0, checkpointed: 0}` while truncating a 1.1 MB write-ahead log to zero. The `checkpointed` count is not a success signal; the write-ahead log's size on disk is.
- **Stop transporting `-shm`.** It is machine-local by design. Removing it from the save set is not a behaviour trade — it is declining to move a file that was never valid to move.
- **Wire `session-retention` rather than remove it.** It is the one control that would have let either reporter bound the problem before hitting it, and removing a documented input breaks anyone who set it.

## Open Questions

### Resolved During Planning

- Does `runCleanup` execute on bootstrap failure? Yes — `run.ts:205` is a `finally`. The issue's triage says otherwise and is wrong; both save paths need addressing, not just the post hook.
- Is the WAL-recovery hypothesis physically plausible? Measured: 2416.8 ms versus 60.2 ms at 185 MB. Real, and scale-dependent — which is why it explains one reporter's data and not the other's.
- Can pruning be made offline? Not without reimplementing session discovery against the database. Out of scope, and unnecessary once the checkpoint and clean-state fixes land.
- Does S3 avoid the problem? No. `packages/runtime/src/object-store/content-sync.ts:10` carries the same database family, and a successful S3 restore returns before `cleanStorage` is ever reached (`restore.ts:76-99`).

- Can the action runtime checkpoint SQLite at all? Yes, with no new dependency. Verified on Node 24.20.0 (the runtime is `using: node24`, `action.yaml:165`): `node:sqlite` is available unflagged and `wal_checkpoint(TRUNCATE)` truncated a 1,104,192-byte write-ahead log to zero.
- Does declining to save escape an existing poisoned cache? No — see the first Key Technical Decision. This was the first draft's central error.
- Is a stale `-shm` safe to leave for future saves to age out? No. It is machine-local and a foreign copy can interfere with recovery, so restore should delete it rather than wait.

### Deferred to Implementation

- Retry shape for a busy checkpoint. The bootstrap-failure path is the hard case: the SDK has already called `stop(proc)`, so the writer may be dead, dying, or wedged, and only that path can show which bound is right.
- Whether the restore-side repair should also run on a cache miss, to sweep leftovers on self-hosted runners where the workspace is not guaranteed clean.

## Implementation Units

- [ ] **Unit 1: Normalize what crosses the cache boundary**

**Goal:** Stop capturing the machine-local wal-index, and delete any foreign copy a previous cache carried in.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/services/cache/paths.ts`
- Modify: `src/services/cache/save.ts` (the database-family basename set in `hasCacheableContent`)
- Modify: `src/services/cache/restore.ts`
- Modify: `packages/runtime/src/object-store/content-sync.ts`
- Test: `src/services/cache/cache.test.ts`
- Test: `src/services/cache/restore-save-flow.test.ts`

**Approach:**
- Keep `-shm` in the *restore* path set so caches written before this change still restore; only the save side stops capturing it. Confirm which direction each list governs before editing.
- After restoring, delete `opencode.db-shm`. SQLite rebuilds it locally, and a copy from another runner is stale by construction — waiting for old entries to age out leaves the hazard in place for as long as they survive.
- `hasCacheableContent` currently counts a non-empty `-shm` as evidence of cacheable content. Once `-shm` is not saved, that is a false positive: a workspace with only a `-shm` would claim content and persist nothing useful.

**Patterns to follow:**
- `src/services/cache/paths.ts` already distinguishes restore-mode from save-mode path construction.

**Test scenarios:**
- Happy path: save paths for a workspace with all three database files include `opencode.db` and `-wal`, and exclude `-shm`.
- Happy path: a restored `-shm` is deleted before bootstrap.
- Edge case: a workspace with only `opencode.db-shm` reports no cacheable content.
- Edge case: restore path construction still accepts an older cache containing `-shm`.

**Verification:**
- No save path set contains a `-shm` entry, and no `-shm` survives a restore.

- [ ] **Unit 2: Checkpoint at the cache-save boundary, and gate the save on the result**

**Goal:** Merge the write-ahead log into the database before anything captures it, and refuse to persist state that could not be merged.

**Requirements:** R2, R4, R7

**Dependencies:** Unit 1

**Files:**
- Create: `src/services/cache/checkpoint.ts`
- Modify: `src/services/cache/save.ts`
- Modify: `src/harness/phases/cleanup.ts` (comment correction only)
- Test: `src/services/cache/checkpoint.test.ts`
- Test: `src/services/cache/restore-save-flow.test.ts`

**Approach:**
- Run the checkpoint inside `saveCache`, before `hasCacheableContent` and before the S3 sync at `save.ts:97`. Both save paths and the object-store path then inherit it from one place, and no cross-phase flag is needed to keep them agreeing. Order matters: checkpointing moves bytes from the write-ahead log into the database, which changes which files are non-empty.
- Use `node:sqlite`. Verified available unflagged on Node 24.20.0, so this adds no dependency.
- Treat the attempt as the liveness probe rather than trying to observe the child's exit, which the harness cannot do. A live writer surfaces as busy; retry within a bound and then report.
- Report a three-state outcome — checkpointed, nothing to checkpoint, or could not checkpoint with a reason. Two states would collapse "already clean" into "failed" and decline saves that were always safe, which is how this unit could regress R7.
- Judge success by the write-ahead log's size on disk, not the pragma's `checkpointed` count. The count read zero on a verified-successful truncation.
- Declining to save must log a warning naming the reason and surface it in the job summary. A silent skip here reproduces the incident in `read-only-actions-cache-token-broke-session-continuity`, where a discarded signal hid lost continuity for a month.
- Do not fail the run on a failed checkpoint; cleanup must still finish.
- Correct the comment at `cleanup.ts:107-111`, which claims a clean shutdown checkpoints. It does not, and `save.ts:35-37` says the opposite in another file.

**Test scenarios:**
- Happy path: a database with a populated write-ahead log is checkpointed, the log empties, and the data is readable from the database alone.
- Happy path: an already-clean database returns "nothing to checkpoint" and the save proceeds.
- Error path: a busy database retries within the bound, then returns a reason without throwing.
- Error path: a missing or zero-byte database yields a definite outcome rather than an exception.
- Error path: an unsuccessful checkpoint declines the save and the reason appears in the log and job summary.
- Edge case: a checkpoint that truncates the log while reporting `checkpointed: 0` is treated as success.
- Integration: cleanup and the post hook both inherit the same decision through `saveCache`, with no separate flag.

**Verification:**
- After a healthy run the write-ahead log is empty or absent; after a failed checkpoint no cache entry is written for that run and the run output names why.

- [ ] **Unit 3: Repair a hot restored database before bootstrap**

**Goal:** Give a repository already stuck in the loop a way out that does not involve a human deleting cache entries.

**Requirements:** R1, R7, R8

**Dependencies:** Unit 2 (reuses its checkpoint helper)

**Files:**
- Modify: `src/harness/phases/cache-restore.ts`
- Test: `src/harness/phases/cache-restore.test.ts`

**Approach:**
- After the restore completes (`cache-restore.ts:37`) and before `bootstrapOpenCodeServer` (`:57`), checkpoint the restored database if its write-ahead log is non-empty. No timer spans those lines, so the cost lands outside the 5000 ms budget that was failing.
- This recovers the session rather than discarding it. Wiping the database would also break the loop, but it destroys history on every transient bootstrap failure — which is the second reporter's case exactly, and a direct R7 regression.
- Post-Unit-2, a healthy save always leaves an empty log, so a non-empty log on restore means the entry predates the fix or something went wrong. Either way it warrants repair, and a clean log means this unit does nothing.
- No writer exists yet at this point in the run, so this is the one checkpoint that should not contend.
- Log when a repair occurs. It is the signal that a stuck repository healed itself, and its absence in later runs is the evidence the fix held.

**Patterns to follow:**
- Unit 2's checkpoint helper, called with a different reason for the log.

**Test scenarios:**
- Happy path: a restored database with a populated write-ahead log is checkpointed before bootstrap and the repair is logged.
- Happy path: a restored database with an empty log is left untouched and nothing is logged.
- Edge case: a cache miss performs no repair.
- Edge case: a failed repair does not fail the run — bootstrap still proceeds and may still succeed.
- Integration: the sequence restore → repair → bootstrap holds, and the repair is not inside the bootstrap budget.

**Verification:**
- A cache entry containing a hot write-ahead log produces a successful bootstrap on the first run after this ships, with no manual purge.

- [ ] **Unit 4: Make "clean state" actually clean**

**Goal:** Extend corruption recovery to the database family, and give the object-store path the same checks as the cache path.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/services/cache/restore.ts`
- Test: `src/services/cache/restore-save-flow.test.ts`

**Approach:**
- `cleanStorage` removes `storagePath`; the database family sits at `path.dirname(storagePath)`. Remove `opencode.db` and its sidecars alongside it.
- Derive the file set from the same definition `paths.ts` uses. Two lists of database-family filenames in two files is the drift shape this repository has been bitten by before.
- Check every `cleanStorage` call site — object-store corruption fallback, cache corruption, and storage-version mismatch (`restore.ts:80-84,178-182,185-189`) — and confirm deleting the database is correct at each, not only the one that motivated it.
- A successful object-store restore returns at `restore.ts:163-165`, before `checkStorageCorruption` and `checkStorageVersion` ever run. So the path that is authoritative on restore is also the one with no integrity checks: a corrupt or version-mismatched database in the bucket is accepted without inspection. Give it the same two checks.

**Patterns to follow:**
- `src/services/cache/paths.ts` as the single owner of database-family filenames.

**Test scenarios:**
- Happy path: declaring corruption removes the database, `-wal`, and `-shm` along with the storage directory.
- Happy path: an object-store restore runs the corruption and version checks.
- Edge case: a missing database family is not an error.
- Edge case: a storage-version mismatch clears the database, so the next run starts genuinely fresh.
- Error path: a corrupt database from the object store is detected rather than accepted as a hit.
- Integration: after recovery, a subsequent restore does not find a stale database.

**Verification:**
- No `opencode.db*` file survives a declared-corrupt restore, by either source.

- [ ] **Unit 5: Give the bootstrap budget a knob and a log line**

**Goal:** Make the 5s budget visible and adjustable, since runner variance is the dominant cause for the small-cache case.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `action.yaml`
- Modify: `src/harness/config/inputs.ts`
- Modify: `packages/runtime/src/agent/server.ts`
- Modify: `src/harness/phases/cache-restore.ts`
- Test: `src/harness/config/inputs.test.ts`
- Test: `packages/runtime/src/agent/server.test.ts`

**Approach:**
- The SDK already accepts `timeout` as an ordinary option and defaults it to 5000 (`node_modules/@opencode-ai/sdk/dist/server.js`). `createOpencode({signal, hostname, port})` simply never passes it.
- Add a distinct input. The existing `timeout` input is scoped to agent execution and does not reach `createOpencode` — reusing its name would be a trap for anyone who already set it expecting broader effect.
- Log the budget alongside elapsed time at the bootstrap phase, so a run that lands 16 ms inside the limit is visible before it becomes a failure.
- Close the server on the bootstrap-failure path. The catch block at `server.ts:78-82` currently returns an error without calling `close()`, leaving the child's fate to the SDK's abort binding.

**Patterns to follow:**
- The execution `timeout` input's full path from `action.yaml` through `inputs.ts` to runtime behavior is the model for wiring.

**Test scenarios:**
- Happy path: a configured budget reaches `createOpencode`.
- Edge case: an unset input preserves the current 5000 ms behavior exactly.
- Error path: a non-numeric or non-positive value is rejected at parse time, matching sibling input validation.
- Happy path: the bootstrap log line reports both budget and elapsed.
- Error path: a failed bootstrap closes the server rather than leaking the child.

**Verification:**
- Bootstrap logs show budget and elapsed on both success and failure; a configured value changes the observed budget.

- [ ] **Unit 6: Make `session-retention` control retention**

**Goal:** Wire the input into pruning, or stop accepting it.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `src/harness/phases/cleanup.ts`
- Modify: `src/harness/run.ts`
- Test: `src/harness/phases/cleanup.test.ts`

**Approach:**
- `inputs.sessionRetention` already reaches bootstrap (`bootstrap.ts:59-67`); cleanup simply never receives it and passes `DEFAULT_PRUNING_CONFIG` literally (`cleanup.ts:96`).
- Thread it through `CleanupPhaseOptions` and override `maxSessions`, leaving `maxAgeDays` at its default.
- The current default is `50` in both the input declaration and `DEFAULT_PRUNING_CONFIG`, so wiring it changes nothing for a consumer who never set it — worth asserting, since it is what makes this safe to ship.

**Test scenarios:**
- Happy path: a configured retention value reaches the pruning config as `maxSessions`.
- Edge case: an unset input produces behavior identical to today's hardcoded config.
- Edge case: `maxAgeDays` is unaffected.
- Integration: cleanup on a healthy run prunes according to the configured value.

**Verification:**
- Setting the input to a small value visibly reduces retained sessions; leaving it unset changes nothing.

## System-Wide Impact

- **Interaction graph:** Both save paths, the restore corruption paths, the bootstrap phase, and the object-store sync all touch the database family. Units 1 and 4 must agree on one definition of which files that means, and Units 2 and 3 must share one checkpoint implementation.
- **Error propagation:** A failed checkpoint must not fail the run — cleanup has to finish, and a failed repair must still allow bootstrap to try. Both must be visible.
- **State lifecycle risks:** Declining to persist discards a run's session work. Unit 3 is what keeps that rare, by removing the recurring cause rather than repeatedly paying its price.
- **API surface parity:** The gateway also runs OpenCode and has its own session handling. This plan does not touch it; whether it shares the checkpoint gap is worth a separate look.
- **Unchanged invariants:** Cache key strategy, restore-key fallback, and object-store-before-Actions save ordering are unchanged. Healthy runs continue to persist session state; Units 2 and 3 make that state *more* restorable, not less.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| A declined save silently loses session continuity, recreating the read-only-token incident | Unit 2 requires a warning and job-summary line naming the reason; a test asserts the decline is reported, not merely that it happened |
| Declining to save is a deliberate discard of the run's session work, not a free safety measure | Unit 3 makes the common cause of that decline self-healing, so the discard is rare rather than routine; the trade is stated in the job summary so it is visible when it happens |
| A two-state checkpoint outcome collapses "already clean" into "failed" and declines safe saves | Unit 2 reports three states; a test pins the already-clean path proceeding to save |
| A busy or partially-progressed checkpoint is treated as success and persists half-merged state | Success is judged by the write-ahead log's size on disk, not the pragma's return row, which read zero on a verified-successful truncation |
| The object store holds older state than the Actions cache after a non-fatal upload failure (`save.ts:109-113`), and restore prefers the object store (`restore.ts:163-165`) | Not addressed here; recorded as a distinct defect, since it predates this plan and has its own fix |
| The checkpoint becomes a new bootstrap-time cost | Unit 3 runs between restore and bootstrap, outside the 5000 ms budget; measured effect on open is 2416.8 ms → 60.2 ms |
| Removing `-shm` breaks restore of existing caches | Unit 1 changes the save side only; restore still tolerates its presence and deletes it locally |
| The fix addresses recovery cost but `dashboard`'s failure was variance-driven | Unit 5 addresses variance directly; neither unit alone covers both reports, and the plan says so |
| `session-retention` wiring changes behaviour for existing consumers | Input default and hardcoded default are both 50, so an unset input is a no-op; asserted by test |
| Concurrent runs on one cache key still race | Unchanged by this plan; gating reduces poisoned writes but does not serialise healthy ones |

## Documentation / Operational Notes

- `action.yaml` gains a bootstrap-budget input; document that it is distinct from the execution `timeout`.
- With Unit 3, a repository stuck today recovers on its first run after the fix, with no manual purge. That is the claim to make when the issue closes, and the repair log line is the evidence for it.
- Both reporters offered live reproductions. Unit 5's budget logging is what would confirm the variance reading on `dashboard`; Unit 3's repair line is what would confirm the recovery reading on `bfra-me/.github`. Both are cheap to validate against a real runner.

## Sources & References

- Origin issue: [#1407](https://github.com/fro-bot/agent/issues/1407)
- Related: `docs/solutions/integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md`
- Related: `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md`
- Related: `docs/solutions/workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md`
- Related: `docs/solutions/best-practices/overflow-recovery-architecture-2026-08-03.md`
- SQLite write-ahead logging: https://www.sqlite.org/wal.html
- SQLite checkpoint pragma: https://www.sqlite.org/pragma.html#pragma_wal_checkpoint
