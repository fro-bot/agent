---
title: A read-only Actions cache token broke session continuity, and a discarded return value hid it
date: 2026-08-11
category: integration-issues
module: ci-workflows
problem_type: integration_issue
component: development_workflow
symptoms:
  - "Mention-triggered runs log 'Session continuity: no existing session found' every time, on an unchanged logical key"
  - "A warning reads 'Unable to reserve cache ... cache write denied: token has no writable scopes'"
  - "The action logs 'Cache saved' immediately afterward anyway"
  - "The post-action reports 'Skipping post-action: cache already saved by main action'"
  - "Runs restore a cache written by an unrelated earlier run rather than their own predecessor"
root_cause: logic_error
resolution_type: code_fix
severity: critical
tags:
  - session-continuity
  - actions-cache
  - sentinel-return
  - restore-precedence
  - github-actions
---

# A read-only Actions cache token broke session continuity, and a discarded return value hid it

## Problem

Persistent session state across CI runs is this project's headline capability. It had been failing on every human-facing mention flow for over a month, and the logs said everything was fine.

Two runs answered two comments on the same issue eight minutes apart. Both derived the identical logical key `fro-bot: issue-1167`. Both logged `Session continuity: no existing session found` and minted a fresh session. Both restored a cache written by an unrelated `workflow_dispatch` run two hours earlier.

## Symptoms

The decisive evidence sits twenty-five milliseconds apart in run `31354048452`:

```
04:01:07.986Z ##[warning]Failed to save: Unable to reserve cache with key
  opencode-storage-... cache write denied: token has no writable scopes
04:01:07.986Z {"level":"info","message":"Cache saved","phase":"cache-save", ...}
```

The platform refused the write. The action reported success.

## What didn't work

**Reading the permissions block.** Both event types print byte-identical granted permissions:

```
##[group]GITHUB_TOKEN Permissions
Contents: read
Metadata: read
PullRequests: read
##[endgroup]
```

Yet `workflow_dispatch` could write the cache and `issue_comment` could not. That asymmetry looks impossible until you find the reason, and it is the single most misleading signal in this failure: no `permissions:` change of any kind affects the outcome.

**Suspecting a recent code change.** The denial reproduces identically on a rerun minutes later, and appears in `issue_comment` runs going back weeks. Nothing in the diff caused it.

## Root cause

Three independent things had to line up.

**1. The cache client does not use `GITHUB_TOKEN`.** It authenticates with the runner-injected `ACTIONS_RUNTIME_TOKEN`:

```js
// node_modules/@actions/cache/lib/internal/cacheHttpClient.js
const token = process.env['ACTIONS_RUNTIME_TOKEN'] || ''
```

GitHub scopes that JWT by event trust, independently of the workflow's declared permissions. Triggers a user without write access can initiate, resolving to the default-branch cache scope, receive a read-only token.

Be precise about what is directly evidenced here versus attributed. **Observed in our own logs:** `issue_comment` runs could not write the cache while `workflow_dispatch` runs could, under byte-identical printed permissions. **Attributed to a platform policy change** (reported as taking effect 2026-06-26, naming `issue_comment` and `issues` as affected and `workflow_dispatch`/`schedule` as not): the read-only token scoping that explains the asymmetry. The mechanism is corroborated by the library shipping a dedicated `CacheWriteDeniedError`, but the exact event-to-scope mapping is not verifiable from our repository — treat it as the current best explanation, and re-check it against live behavior before relying on it.

This is first-class, documented library behavior rather than an edge case — `@actions/cache` ships a stable prefix and a dedicated error subclass for it:

```ts
// node_modules/@actions/cache/lib/cache.d.ts
export declare const CACHE_WRITE_DENIED_PREFIX = "cache write denied:"
export declare class CacheWriteDeniedError extends ReserveCacheError
```

**2. The failure never reaches the caller.** `saveCache` catches the denial internally, logs a warning, and returns `-1`. Our three call sites awaited that value and discarded it, so the `catch` block never ran and `return true` was unconditional.

**3. The false success suppressed the retry.** `src/harness/phases/cleanup.ts` sets the `CACHE_SAVED` state only on a truthy result, and `src/harness/post.ts` skips the post-action when that state is set. The recovery path built for exactly this situation was switched off by the bug it was meant to recover from.

Durable storage was disabled (`s3-backup` defaults to `false`), so the Actions cache was the only persistence layer and there was nothing to fall back to. Each run accepted an ancestor cache through restore-key prefix matching and started cold.

## Solution

Branch on the sentinel rather than assuming a throw:

```ts
// src/services/cache/save.ts
const cacheId = await cacheAdapter.saveCache(cachePaths, saveKey)
if (cacheId === -1) {
  logger.warning('Cache save did not persist', {saveKey})
  return false
}
```

Applied at all three call sites — `save.ts`, `dedup.ts`, and `tools-cache.ts`. The last matters independently: a silently failed dedup save means duplicate-run protection was never actually written.

Then let durable storage outrank a stale cache:

```ts
// src/services/cache/restore.ts
const objectStoreResult = await restoreFromObjectStore(options)
if (objectStoreResult.hit === true) {
  return objectStoreResult
}
```

A hit requires the main session database. Sidecar files alone stay a miss, storage errors fall through to the cache, and a disabled store remains inert.

## Why this works

The sentinel fix is what stops the lie. The restore change is preventive rather than retroactive, and worth being precise about: durable storage was off during this incident, so no state was uploaded and none was recoverable after the fact.

It matters because of how the two paths were ordered. The write path already syncs durable storage *before* touching the cache, so once storage is enabled a denied cache write still persists session state. But the restore path returned on any cache hit, so that state would never have been read back — a run would hit the same stale ancestor cache and ignore the fresher copy sitting in storage. Enabling storage without inverting the restore order would have produced a system that wrote correctly and read wrongly.

One nuance worth knowing before writing a cleverer fix: the library distinguishes a policy denial from a reservation collision **internally** — a denial produces `CacheWriteDeniedError` and logs at warning level, a collision produces `ReserveCacheError` and logs at info — but both return `-1`. Both error types are publicly exported, so the distinction exists in the package's public surface — but it does not survive the `saveCache()` call boundary, so a collision is now reported as a failure too. That is the honest trade: the alternative is continuing to report real failures as success.

There is an early `isCacheWritable(cacheMode)` check inside the library that returns `-1` before attempting anything, but `getCacheMode` and `isCacheWritable` are not exported from the package root, so a pre-flight check is not available to consumers.

## Prevention

**Treat a sentinel return as a failure channel.** When wrapping a third-party API that returns `-1`, `null`, or `undefined` on failure instead of throwing, an awaited call with a discarded result is a bug that reads as correct code. Grep adapters for `await someCall(` where the value is dropped.

**Never let a success flag be set by an unchecked operation.** The `CACHE_SAVED` state disabled the retry designed for this exact failure. A flag derived from a lie propagates the lie.

**Investigate cross-system contradictions before trusting either subsystem.** Each system's own logs looked healthy. The asymmetry between `workflow_dispatch` and `issue_comment` under identical printed permissions is what located the real mechanism.

**Fix restore precedence before enabling durable storage.** Otherwise a run restores the stale cache, ignores fresher storage, and then overwrites storage with the stale copy — writing correctly while reading wrongly.

## Related

- [A check reports clean for the part of the world it cannot observe](../workflow-issues/checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — the same epistemic trap through a different mechanism: there, a check whose observable scope was narrower than its claimed scope; here, a write that failed and reported success.
- [A gate that cannot fail manufactures confidence](../workflow-issues/non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — adjacent shape, but that covers a gate with no reachable failing input rather than a swallowed library failure.
- [Tool binary caching on ephemeral runners](../performance-issues/tool-binary-caching-ephemeral-runners.md) — separates tool binaries from session state by cache key prefix; `tools-cache.ts` was one of the three call sites carrying this defect.
- [Repair on restore must precede capture on save](../logic-errors/repair-before-capture-sqlite-session-cache-loop-2026-09-02.md) — the inverse failure in the same subsystem: here the save genuinely failed and reported success; there the save genuinely succeeded and persisted state that poisoned every later run.
- [Repair before capture: the SQLite session-cache loop](../logic-errors/repair-before-capture-sqlite-session-cache-loop-2026-09-02.md) — the later silent loss of continuity (2026-09-02 to 09-05): there the save succeeded and was unrestorable because the cache version hash diverged; here the save was denied and reported as success.
