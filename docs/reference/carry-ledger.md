---
verifiedAgainstBaseVersion: "1.18.29"
---

# Harness carry ledger

The harness build merges a set of upstream OpenCode pull requests into a pinned base version. Those patches are listed in [`packages/harness/harness.config.json`](../../packages/harness/harness.config.json), which is the authoritative set — this document explains the entries, it does not define them.

The pinned version is not the liability. Carrying a patch whose justification exists only in someone's memory is. Without a written reason, every base bump re-derives it from source, and a carry that is still load-bearing can look droppable to a reader who was not there. That has already happened: `#33444` has been proposed for removal in two consecutive audits and kept both times, each round costing a source-level re-litigation of the same question.

## How to read an entry

Each carry records what it does, which surface it serves, its upstream status, the evidence it is still needed, and what would make it safe to drop.

**Two surfaces ship from this repo.** The **headless CI** path is the GitHub Action running agents in workflows. The **headed/local** path is the harness binary users install and run interactively. A carry can be load-bearing for one and irrelevant to the other, and conflating them has produced wrong drop verdicts before — "we don't use it in CI" is not grounds for removing it from a binary other people run locally.

**An unmerged upstream PR is not a reason to drop a carry.** Carries exist precisely because a fix has not landed upstream. Absence from stock plus value to a served surface is the KEEP case.

**Where the evidence is thin, this document says so.** Several carries have no in-repo test, consumer, or assertion establishing they are still needed — only a line in a prior bump note. Recording that honestly is the point: a fabricated justification would survive the next audit unchallenged, which is worse than a gap someone can see and close.

No carry has an in-repo record of the upstream version that would contain it, so no entry claims one.

## Carries

### #33444 — aggregate session summary diffs

- **Capability:** Populates `session.summary.diffs` at the session level. Stock builds compute per-message summaries but never fold them into the session-level row.
- **Surface:** Both, and load-bearing for headed/local consumers.
- **Upstream status:** Open. Verified absent from stock through 1.18.29.
- **Evidence it is still needed:** A downstream consumer (Space Bus) reads the aggregate summary as its preferred tier. Without this carry it falls back to fetching every message and aggregating per-turn diffs client-side.
- **Removal condition:** Stock exposes the aggregate fold — not merely a `summary.diffs` field in the schema, which stock already has while leaving it unpopulated. Verify the value is written, not just typed.

> [!IMPORTANT]
>
> This carry has twice been proposed for removal by audits that checked the schema and found `summary.diffs` present. The field exists in stock; nothing writes it at the session level. Check the write path, not the type.

### #33713 — idle instance memory eviction

- **Capability:** Adds opt-in idle/LRU eviction for per-directory OpenCode instances, bounding memory growth in a long-lived server.
- **Surface:** Headed/local only.
- **Upstream status:** Open. Absent from stock.
- **Evidence it is still needed:** The headed/local harness is a long-lived server where a user may serve several directories in one session. CI runs are short-lived and single-directory, so this buys nothing there — which is exactly why it was once proposed for removal.
- **Removal condition:** Stock includes equivalent idle-instance eviction and headed/local memory stays bounded without the patch.

### #36045 — batch streamed part deltas

- **Capability:** Batches streamed message-part deltas so the TUI does not re-render per delta under heavy output.
- **Surface:** Headed/local only.
- **Upstream status:** Open. Absent from stock.
- **Evidence it is still needed:** Protects interactive responsiveness during high-rate streaming. "UI-only" is the reason to keep it, not to drop it — the headed surface is where a user watches output arrive.
- **Removal condition:** Stock batches streamed deltas in the TUI render path.

### #19961 — session transform ordering

- **Capability:** Orders `system.transform` before `messages.transform` in the session pipeline.
- **Surface:** Headless CI and the shared session/compaction path.
- **Upstream status:** Open.
- **Evidence it is still needed:** Recorded across two prior bump cycles as still required. The integration diff is expected to touch the session prompt/transform files; their absence from a merge indicates the carry did not land.
- **Removal condition:** Stock applies the same transform ordering in the session pipeline.

### #31859 — shared plugin client runtime

- **Capability:** Reuses a shared client runtime for plugin bootstrap rather than constructing per-plugin clients.
- **Surface:** Headless CI and the plugin injection path.
- **Upstream status:** Open.
- **Evidence it is still needed:** Prior cycles require the integration diff to include the plugin index/client path; a merge that does not touch it has not applied the carry.
- **Removal condition:** Stock shares the plugin client runtime, and plugin injection works without the patch.

### #31638 — bounded history after compaction

- **Capability:** Avoids rehydrating full session history after compaction, keeping message pagination bounded.
- **Surface:** Headless CI and the session message storage path.
- **Upstream status:** Open.
- **Evidence it is still needed:** Prior cycles name the session message-v2 path as the required diff-scope target for this carry.
- **Removal condition:** Stock avoids the post-compaction hydration regression in the same path.

### #33134 — orphan part projection tolerance

- **Capability:** Guards against projecting a child row whose parent was already deleted.
- **Surface:** Headless CI, session event projection.
- **Upstream status:** Open.
- **Evidence it is still needed:** **Unestablished in-repo.** Listed as still-needed in a prior bump note, with no test, consumer, or assertion here that would regress without it.
- **Removal condition:** Stock contains an equivalent orphan-child projection guard. Establishing whether this carry is still load-bearing requires an upstream source check, not a repo search.

### #33159 — SQLite lock timeout retry

- **Capability:** Adds retry and busy-timeout handling for concurrent SQLite writers on durable commits.
- **Surface:** Headless CI, durable session commit path.
- **Upstream status:** Open.
- **Evidence it is still needed:** **Unestablished in-repo.** Carried forward from a prior bump note. Related to session durability, but nothing here fails without it.
- **Removal condition:** Stock includes equivalent retry/busy-timeout behavior for concurrent writers.

### #31922 — SSE backlog bounding

- **Capability:** Bounds the server-sent-event backlog so a slow consumer cannot grow it without limit.
- **Surface:** Headless CI, streaming event path.
- **Upstream status:** Open.
- **Evidence it is still needed:** **Unestablished in-repo.** Carry-list mention only.
- **Removal condition:** Stock bounds the SSE backlog in the same stream path.

### #34975 — AbortSignal listener leak

- **Capability:** Fixes an `AbortSignal` listener leak in runtime cleanup.
- **Surface:** Headless CI, runtime cleanup.
- **Upstream status:** Open.
- **Evidence it is still needed:** **Unestablished in-repo.** Carry-list mention only.
- **Removal condition:** Stock avoids the same listener leak.

### #34977 — queue resolver leak

- **Capability:** Fixes a resolver leak in the runtime queueing path.
- **Surface:** Headless CI, runtime queueing.
- **Upstream status:** Open.
- **Evidence it is still needed:** **Unestablished in-repo.** Carry-list mention only.
- **Removal condition:** Stock includes the equivalent fix.

### #36361 — surfaced background task failures

- **Capability:** Stops background summary/prune failures from being swallowed silently.
- **Surface:** `packages/opencode/src/session/prompt.ts` — the forked `summary.summarize(...)` and `compaction.prune(...)` calls after a turn, both `Effect.ignore`d in stock. The carry replaces the ignore with `Effect.logWarning` for non-interruption causes; failures are logged, not rethrown or written to session state.
- **Upstream status:** Open.
- **Evidence it is still needed:** Re-examined against 1.18.29 (2026-09-05): stock still swallows both (`prompt.ts:1252`, `:1338`); no upstream change in the bump range touches either path. **Nothing in this repository consumes what the carry surfaces** — no code matches the warning strings or reads a summary/prune failure state; the harness runs its own `pruneSessions` and logs its own failures. The value is operator log visibility only.
- **Removal condition:** Stock surfaces or handles those background failures — or, on value grounds, the set is trimmed toward the 1–3 target and this is the first to go: it has no consumer here and the weakest evidence of the set.

### #47430 — bounded npm install

- **Capability:** Bounds `Npm.reify()` with `OPENCODE_NPM_INSTALL_TIMEOUT` (default 300000 ms); a timeout surfaces as `InstallFailedError` instead of hanging instance bootstrap.
- **Surface:** `plugin.init()` during per-directory instance bootstrap — runs ahead of every service and ahead of the first request being answered, while the HTTP listener is already bound.
- **Upstream status:** Open. Port of #41936 (v2) to the v1 line; our PR.
- **Evidence it is still needed:** Measured 181–370 s stalls on the first instance-scoped request across ~60 headless runs in four repositories (2026-09-04); stock 1.18.29 `packages/core/src/npm.ts` still awaits `reify()` with no bound. The Action defends itself with a setup-time install (`installSystematicPlugin`) and a bounded readiness probe; this carry bounds the server-side install those sit in front of.
- **Removal condition:** Stock bounds `Npm.reify()` or `plugin.init()` — #47430 or #41936 merges, or an equivalent lands.

## Scope and authority

This ledger is documentation. It is **not** enforcement, and it is explicitly non-authoritative for authentication, delivery, and retry policy. An entry never justifies weakening a guard, and removing a carry still goes through the normal review path. The colocated static test at `packages/harness/src/carry-ledger.test.ts` checks that carry identities match `integrationRefs` in `packages/harness/harness.config.json` in both directions, that `verifiedAgainstBaseVersion` matches `base_version`, and that every entry has non-empty evidence and removal-condition fields. It performs no network checks.

It covers upstream carries only. Ordinary deadlines, safety gates, and race guards get no entry — they are not fork-delta and have no upstream exit path to track. Removal conditions for things like prose fallbacks live in comments beside the code that owns them, where they travel with the thing they describe.

The manifest remains the single source of truth for the carry set. If the static check finds a mismatch, the manifest is right and this file is stale until corrected.
