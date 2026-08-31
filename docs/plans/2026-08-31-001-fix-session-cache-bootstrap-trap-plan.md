---
title: 'fix: Break the session-cache bootstrap trap'
type: fix
status: active
date: 2026-08-31
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

- **Checkpoint before capture, rather than refuse to capture.** Refusing would be simpler, but nothing is checkpointed today, so a refusal gate would block every save and trade an absorbing failure for a total loss of continuity (violating R7). Adding an explicit checkpoint fixes the cause instead of declining to carry its symptom.
- **The checkpoint is fallible and its outcome is the gate.** Attempt it; if it cannot complete, that is the signal to decline the save — with a reason. This satisfies R4 without inventing a second notion of "clean."
- **One authority for whether state is safe to persist.** Both save paths consult the same recorded outcome. Neither re-derives it.
- **Stop transporting `-shm`.** It is machine-local by design. Removing it from the save path set is not a behavior trade — it is deleting a file that was never valid to move.
- **Extend `cleanStorage` to the database family.** "Proceed with clean state" must mean it. This is the in-code equivalent of the manual purge both reporters ran.
- **Wire `session-retention` rather than remove it.** It is the one control that would have let either reporter bound the problem before hitting it, and removing a documented input is a breaking change for anyone who set it.

## Open Questions

### Resolved During Planning

- Does `runCleanup` execute on bootstrap failure? Yes — `run.ts:205` is a `finally`. The issue's triage says otherwise and is wrong; both save paths need addressing, not just the post hook.
- Is the WAL-recovery hypothesis physically plausible? Measured: 2416.8 ms versus 60.2 ms at 185 MB. Real, and scale-dependent — which is why it explains one reporter's data and not the other's.
- Can pruning be made offline? Not without reimplementing session discovery against the database. Out of scope, and unnecessary once the checkpoint and clean-state fixes land.
- Does S3 avoid the problem? No. `packages/runtime/src/object-store/content-sync.ts:10` carries the same database family, and a successful S3 restore returns before `cleanStorage` is ever reached (`restore.ts:76-99`).

### Deferred to Implementation

- Whether the checkpoint runs in-process against the database file or by invoking a SQLite binary. Depends on what is available in the action runtime without adding a dependency.
- Exact backoff for a `SQLITE_BUSY` checkpoint attempt.
- Whether existing caches carrying a stale `-shm` need explicit deletion on restore, or whether omitting it from future saves is sufficient as they age out.

## Implementation Units

- [ ] **Unit 1: Stop transporting the machine-local wal-index**

**Goal:** Remove `-shm` from the saved path set so a foreign wal-index is never restored onto another runner.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/services/cache/paths.ts`
- Modify: `src/services/cache/save.ts` (the database-family basename set in `hasCacheableContent`)
- Modify: `packages/runtime/src/object-store/content-sync.ts`
- Test: `src/services/cache/cache.test.ts`

**Approach:**
- Keep `-shm` in the *restore* path set if its absence would break restoring older caches; it is only the save side that must stop capturing it. Confirm which direction each list governs before editing.
- `hasCacheableContent` currently counts a non-empty `-shm` as evidence of cacheable content. Once `-shm` is not saved, that is a false positive — a run with only a `-shm` would report content and save nothing useful.

**Patterns to follow:**
- `src/services/cache/paths.ts` already distinguishes restore-mode from save-mode path construction.

**Test scenarios:**
- Happy path: save paths for a workspace with all three database files include `opencode.db` and `-wal` and exclude `-shm`.
- Edge case: a workspace with only `opencode.db-shm` present reports no cacheable content.
- Edge case: restore path construction is unchanged, so an older cache containing `-shm` still restores.

**Verification:**
- No save path set includes a `-shm` entry; restoring a cache saved before this change still succeeds.

- [ ] **Unit 2: Checkpoint the database before it is captured**

**Goal:** Merge the write-ahead log into the main database before the cache is read, and record whether that succeeded.

**Requirements:** R2, R4

**Dependencies:** Unit 1

**Files:**
- Create: `packages/runtime/src/session/checkpoint.ts`
- Modify: `src/harness/phases/cleanup.ts`
- Test: `packages/runtime/src/session/checkpoint.test.ts`
- Test: `src/harness/phases/cleanup.test.ts`

**Approach:**
- Await the OpenCode child's exit before touching its database. `shutdown()` currently returns immediately after SIGTERM (`packages/runtime/src/agent/server.ts:74-76`); the harness needs to know the writer is gone before it checkpoints. Bound the wait.
- Then run `PRAGMA wal_checkpoint(TRUNCATE)` against the database and report a definite outcome: checkpointed, or not, with a reason.
- Correct the misleading comment at `cleanup.ts:107-111` — it currently asserts behavior the code does not have, and `save.ts:35-37` says the opposite twenty lines away in another file.
- Do not fail the run when a checkpoint fails. Cleanup must still complete (`build-pipeline-fallible-preflight-and-finally-cleanup`); the outcome is a signal, not a fatal error.

**Test scenarios:**
- Happy path: a database with a populated WAL is checkpointed; the WAL is emptied and the main database contains the data.
- Error path: a database locked by another reader yields a not-checkpointed outcome with a reason, and does not throw.
- Error path: a missing or zero-byte database yields a definite outcome rather than an exception.
- Edge case: the child process does not exit within the bounded wait — the outcome reflects that, and the run continues.
- Integration: cleanup on a healthy run reaches the checkpoint and records success.

**Verification:**
- After a healthy run, `opencode.db-wal` is empty or absent and the session data is readable from `opencode.db` alone.

- [ ] **Unit 3: One authority for whether state may be persisted**

**Goal:** Make both save paths consult a single recorded outcome, and make a declined save loud.

**Requirements:** R1, R4

**Dependencies:** Unit 2

**Files:**
- Modify: `src/harness/config/state-keys.ts`
- Modify: `src/harness/phases/cleanup.ts`
- Modify: `src/harness/post.ts`
- Test: `src/harness/phases/cleanup.test.ts`
- Test: `src/harness/post.test.ts`

**Approach:**
- Record the checkpoint outcome from Unit 2 through the established state-key mechanism (`routing.ts:67` and `post.ts:65` are the model).
- Both `cleanup.ts:172` and `post.ts:100` read that one value. Neither re-derives it — the duplicate-source-of-truth failure is documented and this is the shape that causes it.
- A declined save must log at warning level with the reason and appear in the job summary. A silent skip here reproduces the read-only-cache-token incident with a new cause; that doc is explicit that a discarded signal hid the failure for a month.
- Bootstrap failure means no checkpoint ran, so no persist. That is the change that makes the failure re-runnable.

**Test scenarios:**
- Happy path: a checkpointed run saves from cleanup and the post hook does not save again.
- Error path: a run whose checkpoint failed declines both saves and logs the reason.
- Error path: a bootstrap-failed run declines both saves; the previous cache entry is left intact rather than overwritten.
- Edge case: cleanup saved successfully, so the post hook skips — the existing `CACHE_SAVED` behavior is unchanged.
- Integration: the post hook's decision matches cleanup's, driven by the same recorded value rather than an independent check.

**Verification:**
- A simulated bootstrap failure leaves the prior cache entry unmodified and reports why in the run's output.

- [ ] **Unit 4: Make "clean state" actually clean**

**Goal:** Extend corruption recovery to the database family so the declared clean state is real.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/services/cache/restore.ts`
- Test: `src/services/cache/restore-save-flow.test.ts`

**Approach:**
- `cleanStorage` removes `storagePath`; the database family sits at `path.dirname(storagePath)`. Remove `opencode.db` and its sidecars alongside it.
- Derive the file set from the same definition `paths.ts` uses. Two lists of database-family filenames in two files is the drift shape this repo has been bitten by before.
- Check every `cleanStorage` call site — object-store corruption fallback, regular cache corruption, and storage-version mismatch (`restore.ts:80-84,178-182,185-189`) — and confirm deleting the database is correct at each, not just the one that motivated it.

**Patterns to follow:**
- `src/services/cache/paths.ts` as the single owner of database-family filenames.

**Test scenarios:**
- Happy path: declaring corruption removes the database, `-wal`, and `-shm` along with the storage directory.
- Edge case: a missing database family is not an error.
- Edge case: a storage-version mismatch also clears the database, so the next run starts genuinely fresh.
- Integration: after recovery, a subsequent restore does not find a stale database.

**Verification:**
- Following a declared-corrupt restore, no `opencode.db*` file remains in the workspace.

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

- **Interaction graph:** Both save paths, the restore corruption paths, the bootstrap phase, and the S3 sync all touch the database family. Unit 1's path-set change and Unit 4's clean-state change must agree on one definition of which files that means.
- **Error propagation:** A failed checkpoint must not fail the run — cleanup has to finish. It must, however, prevent the save and say so.
- **State lifecycle risks:** Declining to persist has a real cost: a run's session work is lost. That is the correct trade against poisoning every subsequent run, but it must be visible rather than silent.
- **API surface parity:** The gateway also runs OpenCode and has its own session handling. This plan does not touch it; whether it shares the checkpoint gap is worth a separate look.
- **Unchanged invariants:** The cache key strategy, restore-key fallback, and S3-before-Actions save ordering are unchanged. Healthy runs continue to persist session state; Unit 2 makes that state *more* restorable, not less.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| A declined save silently loses session continuity, recreating the read-only-token incident | Unit 3 requires a warning and job-summary line naming the reason; a test asserts the decline is reported, not just that it happened |
| The checkpoint itself becomes a new bootstrap-time cost | Checkpointing happens at cleanup, not at startup; the measured effect on the next run's open is 2416.8 ms → 60.2 ms |
| Awaiting child exit adds latency or hangs cleanup | The wait is bounded and its expiry is a recorded outcome, not a stall |
| Removing `-shm` breaks restore of existing caches | Unit 1 changes the save side only; restore continues to tolerate its presence |
| The fix addresses recovery cost but `dashboard`'s failure was variance-driven | Unit 5 addresses the variance case directly; the plan states plainly that neither unit alone covers both reports |
| `session-retention` wiring changes behavior for existing consumers | Input default and hardcoded default are both 50, so an unset input is a no-op; asserted by test |

## Documentation / Operational Notes

- `action.yaml` gains a bootstrap-budget input; document that it is distinct from the execution `timeout`.
- Once Unit 3 ships, a repo stuck in the loop today still needs one manual cache purge to escape — the fix prevents recurrence, it does not retroactively clean a poisoned entry. Worth saying in the issue when it closes.
- Both reporters offered live reproductions. Unit 5's budget logging is what would confirm the variance reading on `dashboard`, and is the cheapest thing to validate against a real runner.

## Sources & References

- Origin issue: [#1407](https://github.com/fro-bot/agent/issues/1407)
- Related: `docs/solutions/integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md`
- Related: `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md`
- Related: `docs/solutions/workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md`
- Related: `docs/solutions/best-practices/overflow-recovery-architecture-2026-08-03.md`
- SQLite write-ahead logging: https://www.sqlite.org/wal.html
- SQLite checkpoint pragma: https://www.sqlite.org/pragma.html#pragma_wal_checkpoint
