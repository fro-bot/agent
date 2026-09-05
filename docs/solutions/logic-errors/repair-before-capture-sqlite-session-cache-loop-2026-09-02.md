---
title: Repair on restore must precede capture on save, or a transient failure becomes permanent
date: 2026-09-02
last_updated: 2026-09-04
category: logic-errors
module: runtime
problem_type: logic_error
component: service_object
symptoms:
  - One OpenCode bootstrap timeout made every subsequent run fail identically
  - Manually purging every cache entry was the only known escape
  - A restored database could silently replay stale WAL content instead of reporting an error
root_cause: async_timing
resolution_type: code_fix
severity: critical
tags:
  - sqlite
  - wal
  - session-cache
  - absorbing-loop
  - fail-closed
  - object-store
---

# Repair on restore must precede capture on save, or a transient failure becomes permanent

## Problem

An OpenCode server bootstrap timed out. The run then persisted session state that made the _next_ run fail the same way, and the one after that. The only known escape was manually deleting every cache entry.

## Symptoms

- A repeating bootstrap timeout that survived reruns, new commits, and unrelated changes.
- Session continuity silently lost — runs kept succeeding at everything except remembering anything.
- Manual cache purge across two repositories as the only recovery.

## What Didn't Work

This section is the useful one. Seven plausible fixes were tried and refuted, each by evidence rather than argument.

**"Only persist cleanly-checkpointed state."** Inverted by reality. `server.close()` sends `proc.kill()` without awaiting a checkpoint, so nothing had _ever_ produced a checkpointed database. This rule would have blocked every save in the repository's history.

**"Decline to save when the checkpoint fails — that breaks the loop."** False, and this one is subtle. GitHub Actions save keys are unique per run while restore keys are prefixes matching the _most recent_ entry. Declining to save prevents new poisoning but leaves the already-poisoned entry newest, so the next run restores it again. Declining forever is a stable state, not a recovery. This is what moved the repair to the restore side.

**"Wipe the database and save empty state."** Rejected: it destroys session history on every transient bootstrap failure, punishing exactly the conditions the design exists to tolerate.

**"The write-ahead log is provably empty on every path that reaches transport, so stop transporting it."** Correct destination, false premise. Reproduced on real `node:sqlite`:

```text
wal before checkpoint                                    2068272
checkpoint returns {busy:0, log:0, checkpointed:0}, wal        0   ← reported SUCCESS
one late INSERT from a still-live idle writer                4152
```

SQLite's checkpoint writer lock applies while the checkpoint is _pending_, not after it returns. Since `shutdown()` never awaited the child's exit, a live connection could append immediately after success was reported.

**"Recreate a zero-byte log so the stale object gets overwritten."** Races the same live writer that made the checkpoint untrustworthy in the first place.

**"Route non-retryable checkpoint failures into the clean-slate path."** Wrong polarity, and dangerous. `isRetryableError` is an allowlist of _retryable_ conditions, so negating it hands everything unrecognized — a full disk, an I/O fault, exhausted descriptors — to the branch that deletes session history. Reproduced: `unable to open database file` from a permissions fault classified as non-retryable and triggered a wipe.

**"Hoist the untrusted-log deletion up into `restoreCache`."** Would have deleted a locally-present log on a self-hosted runner with the object store disabled, because that guard returns before the `try` — live session data, unrelated to any download.

## Solution

The root cause was one defect wearing two masks: `shutdown()` signalled the OpenCode child and returned without awaiting exit. That is _why_ nothing ever checkpointed, and _why_ a checkpoint that succeeded did not stay true.

**Wait for the writer before trusting anything.** The SDK exposes no handle — `createOpencode` returns only `{client, server: {url, close}}`, and `close()` calls `proc.kill()` on a child it never surfaces. So `waitForServerQuiescence` (`packages/runtime/src/agent/server.ts`) polls the server's own port until connections are refused. The pinned upstream server registers no `SIGTERM`/`SIGINT` handler, so termination is immediate rather than drained, which is what makes socket release a usable proxy for process death. It is a boundary, not a proof, and both the code and its caller say so: a timeout means the child's fate is _unknown_, and cleanup warns that the checkpoint may have raced a writer.

**Checkpoint at the save boundary** (`src/services/cache/checkpoint.ts`), before any file is sized or transported. Success is judged by the log's on-disk size, never by the pragma's own `checkpointed` count — that count was verified to report `0` on a fully successful truncation.

**Repair between restore and bootstrap** (`src/harness/phases/cache-restore.ts`), outside the timed budget, so a poisoned entry heals in place instead of looping.

**Probe for corruption a hot log would mask** (`src/services/cache/integrity.ts`). A structurally corrupt database with nothing pending reports `nothing-to-checkpoint` and would otherwise pass unexamined. The probe reads one schema page (`SELECT count(*) FROM sqlite_master`), not a full `PRAGMA integrity_check`.

**Classify corruption positively** (`src/services/cache/sqlite-errors.ts`), matching only SQLite's own "file is not a database" and "database disk image is malformed". Anything unrecognized defaults to leave-alone.

**Stop transporting the log** — from _both_ `DB_TRANSPORTABLE_BASENAMES` (object store) and `buildSaveCachePaths` (Actions cache), which are independent producers of the same rule.

**Handle legacy state per source**, because the two transports differ in kind. An Actions cache entry is one atomic archive, so a legacy database+log pair genuinely came from the same save and its log may hold real committed transactions — it is checkpointed, never discarded. An object-store prefix has no generation marker across independently-overwritten keys, so its log is untrusted and deleted before anything opens the database.

That split covers what each transport *delivers*. It also settles what to do about a log that was already on disk before restore, which only a persistent runner can have — and the answer is the same: leave it. A fix that deleted such a log when the archive did not supply it was built, reviewed, and abandoned on 2026-09-04, because its premise was inverted for the common case. On one persistent runner, run N checkpoints and saves the database, the server commits more after the quiescence poll gives up, and run N+1 restores *that same database*; the leftover log is the same generation and **ahead** of it, holding the only copy of those commits. The log is behind the database only when the database came from a different runner's later save — a pool sharing one cache. Nothing at open time can tell those apart: SQLite validates write-ahead frames against the log's own header salt, not against the database file, which is why the silent-replay reproduction above is possible at all. A stat fingerprint cannot tell either — `@actions/cache` extracts with a bare `tar -xf`, so an in-place overwrite keeps the inode. The object-store deletion is the right trade *there* because that log is never trustworthy; transplanting it to this path trades a rare cross-runner hazard for common single-runner data loss. When a cleanup proposes to delete a "stale" sidecar at a restore boundary, the first question is which artifact is newer, and if the answer depends on topology the code cannot observe, the cleanup is wrong. See item 11 of [A check written from inside its own premise cannot fail](../workflow-issues/a-check-written-from-inside-its-own-premise-cannot-fail-2026-09-04.md) for how the abandoned fix's own proof-of-bite passed.

## Why This Works

Repair must precede capture, and capture must be blocked unless the database is checkpoint-clean — otherwise a transient failure gets encoded into durable state, and durable state is what the next run trusts.

The ordering is what matters. Restore finishes before bootstrap starts with no timer between them, so a checkpoint placed there costs nothing against the budget it protects and heals a stuck repository in one run without destroying anything.

A note on the Actions-cache change, stated at the strength the evidence supports: in WAL mode the main database file is mutated only during a checkpoint, so archiving `opencode.db` alone beside a live writer generally yields a consistent, slightly-stale database — strictly better than copying a concurrently-appended log, which is the torn-read shape that produces `malformed`. This is not unconditional. SQLite's default `wal_autocheckpoint` is 1000 pages, and a live writer crossing that threshold mutates the main file with no explicit checkpoint at all — measured going from 4096 to 860160 bytes mid-write. The claim is "much safer", not "safe".

## The Regression the Fix Introduced

Worth recording, because it was caused by the fix and found only in review.

`syncSessionsToStore` uploads a file only if it exists locally and never deletes. Before this work the log was always hot at save time, so its object was refreshed on every upload. Once healthy saves started checkpointing, SQLite unlinked the log, `opencode.db-wal` stopped being uploaded — and `opencode.db` kept being overwritten at the same prefix. A later restore then paired a fresh database with a log from an older generation.

Two outcomes, both reproduced:

- `database disk image is malformed` — detected, wipes history, then re-saves without overwriting the orphan, so it wipes again every run.
- The checkpoint **succeeded and silently replayed the stale log**: a database holding 3000 rows came back with 2000. No error, no warning, nothing.

Which one occurs depends on whether SQLite's WAL header salt matches. The silent variant is worse and has no second line of defense, since the usability probe only runs when the checkpoint reports nothing to do.

This is fixed, not outstanding. The pairing is unreachable by construction now: the log is gone from both transports (see Solution), and any log arriving from an object store is deleted before anything opens the database (see the source-specific split).

## Prevention

- **Judge an operation by its external effect, not its reported status.** The pragma's `checkpointed` count says `0` on a fully successful truncation; the log's size on disk is the truth.
- **When the recovery path is destructive, match the dangerous condition positively.** Never derive it by negating a safe one — an allowlist of "retryable" inverted into "everything else is corrupt" hands every unrecognized fault to the delete branch.
- **A comment asserting a control-flow property is a claim, not documentation.** Four comments on this change stated rules their own code did not follow, including one that a test cited by name as its guard.
- **When a value has multiple producers, changing one is not changing the rule.** The write-ahead log had to be removed from two independent lists.
- **Verify what a construction actually validates.** `new DatabaseSync(path)` against a file of plain text does _not_ throw; only the schema read surfaces the corruption. A construction-only probe would have passed its own tests and detected nothing.
- **Ask what a change stops producing, not just what it starts producing.** The orphaned object arose entirely because a file that used to always exist stopped existing, on a transport that only ever uploads what it finds.

## Related

- Issue [#1407](https://github.com/fro-bot/agent/issues/1407), PR [#1519](https://github.com/fro-bot/agent/pull/1519)
- [A read-only Actions cache token broke session continuity](../integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md) — same subsystem, different cause: there the save genuinely failed and reported success; here the save genuinely succeeded and persisted the wrong thing.
- [S3 restore needs ListBucket and prefix scope](../security-issues/s3-restore-needs-listbucket-and-prefix-scope-2026-08-12.md) — restore capability cannot be inferred from the save path. The same asymmetry appears here as the source-specific legacy split.
- [A present signal is not evidence of the effect it implies](../workflow-issues/verify-behavior-not-signal-2026-08-23.md) — the general form of the checkpoint-count and construction-probe traps above.
- [Terminal outcomes must survive deadline cleanup](terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md) — adjacent: teardown semantics deciding what a run is allowed to record.
