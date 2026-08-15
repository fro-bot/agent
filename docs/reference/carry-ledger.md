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
- **Upstream status:** Open. Verified absent from stock through 1.18.18.
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
- **Surface:** Not clearly separated; likely the headless runtime session cleanup path.
- **Upstream status:** Open.
- **Evidence it is still needed:** **Unestablished in-repo, and the weakest of the set.** No test, consumer, or surface attribution.
- **Removal condition:** Stock surfaces or handles those background failures. This is the first carry to re-examine on the next bump.

## Scope and authority

This ledger is documentation. It is **not** enforcement, and it is explicitly non-authoritative for authentication, delivery, and retry policy. An entry never justifies weakening a guard, and removing a carry still goes through the normal review path.

It covers upstream carries only. Ordinary deadlines, safety gates, and race guards get no entry — they are not fork-delta and have no upstream exit path to track. Removal conditions for things like prose fallbacks live in comments beside the code that owns them, where they travel with the thing they describe.

Nothing asserts the carry count or set programmatically; the manifest is the single source of truth, and this document tracks it by hand. If the two disagree, the manifest is right and this file is stale.
