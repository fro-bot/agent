---
verifiedAgainstBaseVersion: "1.18.34"
---

# Harness carry ledger

The harness build merges a set of upstream OpenCode pull requests into a pinned base version. Those patches are listed in [`packages/harness/harness.config.json`](../../packages/harness/harness.config.json), which is the authoritative set — this document explains the entries, it does not define them.

The pinned version is not the liability. Carrying a patch whose justification exists only in someone's memory is. Without a written reason, every base bump re-derives it from source, and a carry that is still load-bearing can look droppable to a reader who was not there. That has already happened: `#33444` has been proposed for removal in two consecutive audits and kept both times, each round costing a source-level re-litigation of the same question.

## Carry count

This set currently holds fifteen carries. `packages/harness/AGENTS.md` states a target of 1–3 carried refs max. The set has grown five times past that target by deliberate deferral, not oversight: each entry below still meets at least one criterion of the carry policy in that same file, and no bump cycle has yet forced the trim. This is not a claim that fifteen is fine — it isn't, against the stated target — only a record that no one has done the work of cutting it back. `#36361` already names itself as the weakest-evidence entry and the first candidate if and when that trim happens.

## How to read an entry

Each carry records what it does, which surface it serves, its upstream status, the evidence it is still needed, and what would make it safe to drop. Where the carry does not merge cleanly onto the pinned base, a merge-status line records the conflict.

**Two surfaces ship from this repo.** The **headless CI** path is the GitHub Action running agents in workflows. The **headed/local** path is the harness binary users install and run interactively. A carry can be load-bearing for one and irrelevant to the other, and conflating them has produced wrong drop verdicts before — "we don't use it in CI" is not grounds for removing it from a binary other people run locally.

**An unmerged upstream PR is not a reason to drop a carry.** Carries exist precisely because a fix has not landed upstream. Absence from stock plus value to a served surface is the KEEP case. This holds for closed PRs too: upstream runs a periodic stale-PR cleanup (`github-actions`, "Automated PR Cleanup") that closes PRs older than a month with fewer than two positive reactions. That is housekeeping, not a maintainer rejection, and the head stays fetchable through `pull/<n>/head`. Each entry records who closed the PR.

**Where the evidence is thin, this document says so.** Several carries have no in-repo test, consumer, or assertion establishing they are still needed — only a line in a prior bump note. Recording that honestly is the point: a fabricated justification would survive the next audit unchallenged, which is worse than a gap someone can see and close.

No carry has an in-repo record of the upstream version that would contain it, so no entry claims one.

## Carries

### #33444 — aggregate session summary diffs

- **Capability:** Populates `session.summary.diffs` at the session level. Stock builds compute per-message summaries but never fold them into the session-level row.
- **Surface:** Both, and load-bearing for headed/local consumers.
- **Upstream status:** Closed unmerged 2026-07-22 by upstream's stale-PR automation, not a maintainer decision; head still fetchable. Verified absent from stock through 1.18.34: `session/summary.ts` `summarize` still writes a zeroed session summary (`additions: 0, deletions: 0, files: 0`, no `diffs`) and publishes an empty `Session.Event.Diff`, storing diffs only on the user message. Upstream PR #49715 ("persist aggregated diff stats in session summary") is open and unmerged.
- **Evidence it is still needed:** A downstream consumer (Space Bus) reads the aggregate summary as its preferred tier. Without this carry it falls back to fetching every message and aggregating per-turn diffs client-side.
- **Removal condition:** Stock exposes the aggregate fold — not merely a `summary.diffs` field in the schema, which stock already has while leaving it unpopulated. Verify the value is written, not just typed.

> [!IMPORTANT]
>
> This carry has twice been proposed for removal by audits that checked the schema and found `summary.diffs` present. The field exists in stock; nothing writes it at the session level. Check the write path, not the type.

### #33713 — idle instance memory eviction

- **Capability:** Adds opt-in idle/LRU eviction for per-directory OpenCode instances, bounding memory growth in a long-lived server.
- **Surface:** Headed/local only.
- **Upstream status:** Open. Absent from stock through 1.18.34: no idle or LRU eviction of per-directory instances exists in `project/instance-store.ts`.
- **Merge status:** Conflicts with 1.18.34 in `project/instance-store.ts` (one hunk, the `layer` declaration: stock declares `const layer`, the PR `export const layer`); resolved by keeping stock's non-exported `layer` with the PR's eviction code. The same conflict exists at 1.18.30. The PR's test, `test/project/instance-eviction.test.ts`, builds its layer with `InstanceStore.defaultLayer`, which upstream removed in `451876b0b` (#34518, 2026-06-29); both eviction tests fail at the tag as written until ported to `InstanceStore.node`.
- **Evidence it is still needed:** The headed/local harness is a long-lived server where a user may serve several directories in one session. CI runs are short-lived and single-directory, so this buys nothing there — which is exactly why it was once proposed for removal.
- **Removal condition:** Stock includes equivalent idle-instance eviction and headed/local memory stays bounded without the patch.

### #36045 — batch streamed part deltas

- **Capability:** Batches streamed message-part deltas so the TUI does not re-render per delta under heavy output.
- **Surface:** Headed/local only.
- **Upstream status:** Closed unmerged 2026-07-15 by its author (YayoRazo), without comment; not an upstream automation or maintainer closure. Head still fetchable. Absent from stock through 1.18.34: `tui/src/context/sync.tsx` applies each `message.part.delta` to the store as it arrives and wraps only multi-write sections in Solid `batch()`.
- **Evidence it is still needed:** Protects interactive responsiveness during high-rate streaming. "UI-only" is the reason to keep it, not to drop it — the headed surface is where a user watches output arrive.
- **Removal condition:** Stock batches streamed deltas in the TUI render path.

### #19961 — session transform ordering

- **Capability:** Orders `system.transform` before `messages.transform` in the session pipeline.
- **Surface:** Headless CI and the shared session/compaction path.
- **Upstream status:** Open. Absent from stock through 1.18.34: `messages.transform` still fires in `session/prompt.ts` and `session/compaction.ts` before `system.transform` fires in `session/llm/request.ts`.
- **Merge status:** Conflicts with 1.18.34 in `session/compaction.ts` (two hunks) and `test/session/compaction.test.ts` (one hunk). Stock added the `experimental.session.compacting` hook and restructured the compaction prompt in `b7f936339` (#40800) and `dab263721` (#42045), both after the PR's merge-base; the same conflict exists at 1.18.30. The carry needs a manual or resolver-assisted merge in the compaction path.
- **Evidence it is still needed:** Recorded across two prior bump cycles as still required. The integration diff is expected to touch the session prompt/transform files; their absence from a merge indicates the carry did not land.
- **Removal condition:** Stock applies the same transform ordering in the session pipeline.

### #31859 — plugin client bootstrap re-entry guard

- **Capability:** While a plugin instance is still bootstrapping, requests made through the plugin `client` return `409 Conflict` ("Plugin client request cannot enter instance <dir> while its plugins are still loading") instead of routing back into the same instance load. Without it, a plugin that calls `input.client.*` from `server(input)` or a config hook can wait on the instance load that is itself waiting on that request. After bootstrap the client behaves as stock does.
- **Surface:** Headless CI and the plugin injection path.
- **Upstream status:** Open. Absent from stock through 1.18.34: `plugin/index.ts` builds the client with no bootstrap guard, forwarding to `Server.url` or `Server.Default().app.fetch`. The PR was narrowed after upstream `87c33b3d8` ("reuse active server for client requests") landed; the guard is the part that remains.
- **Evidence it is still needed:** Prior cycles require the integration diff to include the plugin index/client path; a merge that does not touch `plugin/index.ts` has not applied the carry. **Unestablished in-repo:** nothing here shows a plugin that calls the client during bootstrap.
- **Removal condition:** Stock rejects or otherwise handles plugin-client requests made during plugin bootstrap, so the request cannot wait on the instance load that is waiting on it.

### #31638 — bounded history after compaction

- **Capability:** Avoids rehydrating full session history after compaction, keeping message pagination bounded.
- **Surface:** Headless CI and the session message storage path.
- **Upstream status:** Open. Merges cleanly onto 1.18.34.
- **Evidence it is still needed:** Prior cycles name the session message-v2 path as the required diff-scope target for this carry.
- **Removal condition:** Stock avoids the post-compaction hydration regression in the same path.

### #33134 — orphan part projection tolerance

- **Capability:** Guards against projecting a child row whose parent was already deleted.
- **Surface:** Headless CI, session event projection.
- **Upstream status:** Closed unmerged 2026-07-20 by upstream's stale-PR automation, not a maintainer decision; head still fetchable. Absent from stock through 1.18.34: `core/src/session` has no orphan-parent or session-presence guard in its projection.
- **Merge status:** Conflicts with 1.18.34 in `core/src/session/projector.ts` (three hunks) and `core/test/session-projector.test.ts` (one hunk). Stock projectors now read `event.durable.seq` and call `SessionInput.projectPrompted`; the PR is written against `event.seq` and `projectLegacyPrompted`. The same conflict exists at 1.18.30. The carry needs a port to the current projector, not a mechanical resolve. Merges cleanly with #33159 on their shared base.
- **Evidence it is still needed:** **Unestablished in-repo.** Listed as still-needed in a prior bump note, with no test, consumer, or assertion here that would regress without it.
- **Removal condition:** Stock contains an equivalent orphan-child projection guard. Establishing whether this carry is still load-bearing requires an upstream source check, not a repo search.

### #33159 — SQLite lock timeout retry

- **Capability:** Adds retry and busy-timeout handling for concurrent SQLite writers on durable commits.
- **Surface:** Headless CI, durable session commit path.
- **Upstream status:** Closed unmerged 2026-07-21 by upstream's stale-PR automation, not a maintainer decision; head still fetchable. Absent from stock through 1.18.34: `core/src/database/database.ts` sets `PRAGMA busy_timeout = 5000` but nothing retries a lock timeout on durable event commits.
- **Merge status:** Conflicts with 1.18.34 in `core/src/event.ts` (three hunks: imports, and the event type block that moved to `@opencode-ai/schema`), `core/test/event.test.ts`, and `core/test/session-projector.test.ts`. The same conflict exists at 1.18.30. The retry (`Effect.retry` on `LockTimeoutError` around the durable commit) and the `database.ts`/`sqlite.*.ts` changes auto-merge but use imports from the conflicted hunk; the type and test hunks need a port.
- **Evidence it is still needed:** **Unestablished in-repo.** Carried forward from a prior bump note. Related to session durability, but nothing here fails without it.
- **Removal condition:** Stock includes equivalent retry/busy-timeout behavior for concurrent writers.

### #31922 — SSE backlog bounding

- **Capability:** Bounds the server-sent-event backlog so a slow consumer cannot grow it without limit.
- **Surface:** Headless CI, streaming event path.
- **Upstream status:** Closed unmerged 2026-07-11 by upstream's stale-PR automation, not a maintainer decision; head still fetchable. Absent from stock through 1.18.34: nothing under `server/` bounds a subscriber backlog.
- **Merge status:** Conflicts with 1.18.34 in `httpapi/handlers/global.ts`, one hunk, the `effect` import line only (stock dropped `HttpServerRequest`); resolved by taking the PR's `Cause, Effect, Queue, Schema` import. The same conflict exists at 1.18.30.
- **Evidence it is still needed:** **Unestablished in-repo.** Carry-list mention only.
- **Removal condition:** Stock bounds the SSE backlog in the same stream path.

### #34975 — AbortSignal listener leak

- **Capability:** Fixes an `AbortSignal` listener leak in runtime cleanup.
- **Surface:** Headless CI, runtime cleanup.
- **Upstream status:** Closed unmerged 2026-08-02 by upstream's stale-PR automation, not a maintainer decision; head still fetchable. Absent from stock through 1.18.34: `util/process.ts` `spawn` still registers its abort listener before checking `opts.abort.aborted`, so a pre-aborted signal keeps a listener that never fires.
- **Evidence it is still needed:** **Unestablished in-repo.** Carry-list mention only.
- **Removal condition:** Stock avoids the same listener leak.

### #34977 — queue resolver leak

- **Capability:** Fixes a resolver leak in the runtime queueing path.
- **Surface:** Headless CI, runtime queueing.
- **Upstream status:** Closed unmerged 2026-08-02 by upstream's stale-PR automation, not a maintainer decision; head still fetchable. Absent from stock through 1.18.34: `util/queue.ts` `AsyncQueue` still has no `close()`, so pending `resolvers` from an abandoned iteration are never released.
- **Evidence it is still needed:** **Unestablished in-repo.** Carry-list mention only.
- **Removal condition:** Stock includes the equivalent fix.

### #36361 — surfaced background task failures

- **Capability:** Stops background summary/prune failures from being swallowed silently.
- **Surface:** `packages/opencode/src/session/prompt.ts` — the forked `summary.summarize(...)` and `compaction.prune(...)` calls after a turn, both `Effect.ignore`d in stock. The carry replaces the ignore with `Effect.logWarning` for non-interruption causes; failures are logged, not rethrown or written to session state.
- **Upstream status:** Closed unmerged 2026-08-11 by upstream's stale-PR automation, not a maintainer decision; head still fetchable.
- **Evidence it is still needed:** Re-examined against 1.18.34 (2026-10-05): stock still swallows both (`prompt.ts:1253`, `:1338`); no upstream change in the bump range touches either path. **Nothing in this repository consumes what the carry surfaces** — no code matches the warning strings or reads a summary/prune failure state; the harness runs its own `pruneSessions` and logs its own failures. The value is operator log visibility only.
- **Removal condition:** Stock surfaces or handles those background failures — or, on value grounds, the set is trimmed toward the 1–3 target and this is the first to go: it has no consumer here and the weakest evidence of the set.

### #47430 — bounded npm install

- **Capability:** Bounds `Npm.reify()` with `OPENCODE_NPM_INSTALL_TIMEOUT` (default 300000 ms); a timeout surfaces as `InstallFailedError` instead of hanging instance bootstrap.
- **Surface:** `plugin.init()` during per-directory instance bootstrap — runs ahead of every service and ahead of the first request being answered, while the HTTP listener is already bound.
- **Upstream status:** Closed unmerged 2026-10-05 by upstream's stale-PR automation, not a maintainer decision; head still fetchable. Port of #41936 (v2) to the v1 line; our PR. #41936 is also closed.
- **Merge status:** Conflicts with 1.18.34 in `core/test/npm.test.ts` only: both sides add a test after the same `Npm.add` block (upstream `ba341c6ca`, #50413, in 1.18.32, adds a Node-runtime entrypoint test). Trivial; resolved by keeping both test blocks. `core/src/npm.ts` merges cleanly. At 1.18.30 the PR merged without conflict.
- **Evidence it is still needed:** Measured 181–370 s stalls on the first instance-scoped request across ~60 headless runs in four repositories (2026-09-04); stock 1.18.34 `packages/core/src/npm.ts` still awaits `reify()` with no bound (#50413 changed only entrypoint resolution). The Action defends itself with a setup-time install (`installSystematicPlugin`) and a bounded readiness probe; this carry bounds the server-side install those sit in front of.
- **Removal condition:** Stock bounds `Npm.reify()` or `plugin.init()` — #47430 or #41936 is reopened and merges, or an equivalent lands.

### #48267 — OpenAI explicit cache anchor

- **Capability:** Places an explicit prompt cache breakpoint (`promptCacheBreakpoint: { mode: "explicit" }`) on the last text part of the trailing messages `applyCaching()` already targets, and sets `promptCacheOptions: { mode: "explicit" }` in `options()` so implicit breakpoint selection stops overriding it. Stock applies explicit breakpoints to Anthropic-family models only; everything else runs on implicit prefix caching with no advancing anchor.
- **Surface:** Both, but narrowly: `@ai-sdk/openai` models at **GPT-5.6 or later**, and only on **API-key OpenAI auth** — never on the ChatGPT/Codex OAuth path. `@ai-sdk/openai@3.0.88`'s own documentation scopes explicit breakpoints to 5.6+ and states that in explicit mode "a request without any explicit breakpoint does not use prompt caching" — so forcing explicit mode on an older model would turn caching off rather than improve it. The version predicate also excludes `@ai-sdk/amazon-bedrock/mantle` in practice, whose ids carry no `gpt-N` version; nothing has established that endpoint accepts OpenAI-shaped body fields, and `prompt_cache_breakpoint` is forwarded verbatim into the request body rather than filtered. The auth gate exists because that same unresolved-endpoint concern turned out to apply closer to home: OpenCode's ChatGPT/Codex OAuth path never reaches `api.openai.com` at all — it routes to `https://chatgpt.com/backend-api/codex/responses` (`CODEX_API_ENDPOINT`, `packages/opencode/src/plugin/openai/codex.ts:12` in the pinned clone), and that relay rejects unknown top-level request parameters outright (observed: `Bad Request: {"detail":"Unsupported parameter: prompt_cache_options"}` — the `{"detail": ...}` envelope is FastAPI's, not OpenAI's `{"error": {...}}`). `model.api` is `{id, url, npm}` only (`provider/provider.ts:1058-1062`) and both auth modes share the same npm package and model ids, so the npm-based gate alone cannot tell them apart. The patch instead reuses the discriminator already established for this at `session/llm/request.ts:57` (`provider.id === "openai" && auth?.type === "oauth"`), plumbed into `transform.message()` and `transform.options()` as an `allowExplicitCache` parameter that **defaults to withholding permission** — a call site that forgets to pass it loses prompt caching rather than risking a request the relay rejects. Both halves are gated identically, so the OAuth/Codex request body stays byte-identical to stock.
- **Known limit:** For array content the marker only reaches the wire on a text part — Chat Completions reads it exclusively from text parts, and the Responses API's `output_text` serialization never emits it at all, so assistant turns contribute no anchor on that path. Placement targets the last text part for that reason, and falls back to message-level `providerOptions` for the system message, which is the one role both transports read it from. That fallback is what makes forcing explicit mode safe: measured across ~4,300 real turns from a local session store, 43% of applicable OpenAI-native turns have no text part in the last two non-system messages, and a request in explicit mode with no marker gets no caching at all. Anchoring the system prompt guarantees one marker per request in the common case, but not absolutely: `@ai-sdk/openai` computes `systemMessageMode` as `"developer"` or `"system"` by default, but an explicit `providerOptions.openai.systemMessageMode: "remove"` override drops the system message — and the marker on it — entirely rather than serializing it under another role.
- **Upstream status:** Open. Our PR. Absent from stock through 1.18.34. Merges cleanly onto 1.18.34.
- **Evidence it is still needed:** Measured over 10 days: ~32,000 Anthropic-family turns hold 100.0% cache reuse with essentially zero collapse, while `gpt-6-astra` sits at 92.1% with 8.5% of turns collapsed — roughly 39M tokens re-sent — and `gpt-5.6-sol` at 64.9%. The gate at `transform.ts:471-484` (re-checked at 1.18.34) admits Anthropic-family models only, so no OpenAI-native model reaches `applyCaching()` at all.
- **Removal condition:** Stock gives the OpenAI-native path an advancing cache anchor — either by widening the `applyCaching()` gate with an OpenAI-shaped marker, or by emitting `prompt_cache_breakpoint` some other way. Verify that reuse tracks a growing prompt across a compaction rather than pinning at a fixed offset; a `promptCacheKey` alone is not this, and stock already sets one.

### #48268 — dotless GPT major version parsing

- **Capability:** Parses a model's GPT major version without requiring a dotted minor, so `gpt-6-astra` satisfies the version gate in `transform.ts`. Restores `reasoningEffort`, `reasoningSummary`, the encrypted-reasoning include, and `textVerbosity: "low"` for GPT-6 models, and corrects the Azure completion-URL early return for them.
- **Surface:** Both. Any run on a GPT-6 model.
- **Upstream status:** Open. Our PR. Absent from stock through 1.18.34. Merges cleanly onto 1.18.34.
- **Evidence it is still needed:** At 1.18.34 two files disagree about the same model: `session/system.ts:36` routes `gpt-6` ids to a dedicated Astra prompt, while `transform.ts:1344` matches `/gpt-(\d+)\.(\d+)/` and cannot parse a dotless id at all. Evaluated against stock across `gpt-6-astra`, `gpt-5.6-luna`, `gpt-5.3-codex-spark`, `gpt-5-pro`, and `gpt-5-chat`, `gpt-6-astra` is the only id that fails both transform gates while being singled out by `system.ts`. The gate's own comment says it exists because versions above 5.4 do not support `reasoningEffort` — a GPT-6 evaluating false defeats that purpose. Fro Bot runs Astra. `plugin/openai/codex.ts:300` parses a dotless major (`/^gpt-(\d+)(?:\.(\d+))?/`) for its own gating, so a dotless parse exists in stock, but not in the `transform.ts` gate this carry fixes.
- **Removal condition:** Stock parses a dotless major — the regex gains an optional minor group, or the family gate stops using a substring test. Check the parse itself, not the presence of a `gpt-6` branch elsewhere: `session/system.ts` has had one since 1.18.30 while `transform.ts` still does not.

## Scope and authority

This ledger is documentation. It is **not** enforcement, and it is explicitly non-authoritative for authentication, delivery, and retry policy. An entry never justifies weakening a guard, and removing a carry still goes through the normal review path. The colocated static test at `packages/harness/src/carry-ledger.test.ts` checks that carry identities match `integrationRefs` in `packages/harness/harness.config.json` in both directions, that `verifiedAgainstBaseVersion` matches `base_version`, and that every entry has non-empty evidence and removal-condition fields. It performs no network checks.

It covers upstream carries only. Ordinary deadlines, safety gates, and race guards get no entry — they are not fork-delta and have no upstream exit path to track. Removal conditions for things like prose fallbacks live in comments beside the code that owns them, where they travel with the thing they describe.

The manifest remains the single source of truth for the carry set. If the static check finds a mismatch, the manifest is right and this file is stale until corrected.
