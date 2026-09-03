---
title: 'feat: Report what session persistence actually happened'
type: feat
status: active
date: 2026-09-02
---

# feat: Report what session persistence actually happened

## Overview

`saveCache` answers a question nobody asked. It returns one boolean across seven distinct outcomes, so its callers cannot tell a deliberate skip from a denied write, cannot avoid repeating an expensive save that already succeeded, and cannot tell an operator why the bot keeps forgetting.

This replaces that boolean with a structured result, gates the post-action retry on durable persistence rather than cache success, and surfaces the outcome where a repository owner will actually see it.

It does not make the failing write succeed. That is not possible from the affected trigger.

## Problem Frame

GitHub issues a **read-only** `ACTIONS_RUNTIME_TOKEN` cache JWT for triggers initiable by an actor without repo write access. `issue_comment` and `issues` are affected; `workflow_dispatch` and `schedule` are not. `@actions/cache` authenticates with that runner-injected token rather than `GITHUB_TOKEN`, so no `permissions:` block changes it and a workflow's printed token permissions are a red herring.

The mention flows are the primary way anyone interacts with this action, and they cannot write session state through the Actions cache at all. `s3-backup` defaults to `false` (`action.yaml`), so **the default configuration is exactly the configuration in which the most common trigger silently loses continuity.** Persistent session state across runs is the headline feature.

The only signal today is one `logger.warning` per run. No output, no summary line, no failure — nothing a repository owner would notice, and nothing that explains why.

Three defects follow from the same root, all verified against `main`:

1. **Both poles of the boolean are overloaded.** `false` spans a declined checkpoint, no cacheable content, a rejected cache write, and a thrown error. `true` spans a real write, a deliberate `SKIP_CACHE`, and a benign key collision. `post.ts:123` reports every falsey outcome as `"Post-action: no cache content to save"` — a stronger and more misleading claim than the warning it replaces.
2. **The boolean conflates two backends.** The object-store sync runs at `save.ts:171-188`, the cache write at `:189`. When the store succeeds and the cache write is rejected, the function returns `false`, `cleanup.ts:196` never sets `CACHE_SAVED`, and the post hook repeats the entire save — a second checkpoint, a **second full object-store upload**, and a second doomed cache write. State is durable; the run pays twice and reports failure.
3. **No queryable signal.** The existing output and job-summary machinery already carries `cache-status` for the restore side. Nothing carries the save side.

## Requirements Trace

- **R1.** A caller can distinguish every terminal outcome of a save without inspecting logs.
- **R2.** A save that achieved durable persistence through any backend is not repeated by the post-action hook.
- **R3.** A repository owner can see, without reading logs, whether their session state persisted and what to do if it did not.
- **R4.** Any reported cause that the code inferred rather than observed is presented as an inference.
- **R5.** The `s3-backup` requirement for mention-driven workflows is documented where a consumer will find it before hitting the failure.

## Scope Boundaries

- Does not attempt to make the Actions cache write succeed on affected triggers. It cannot be done from the comment trigger.
- Does not add a pre-flight writability probe. See Key Technical Decisions — it is provably incapable of detecting this condition.
- Does not change `s3-backup`'s default. Enabling it by default without a bucket fails input validation, so the default would become "enabled and unconfigured," which is worse.
- Does not change restore-side behavior, `CacheResult`, or the cache key scheme.

### Deferred to Separate Tasks

- **Splitting the write off the affected trigger** (persist from a trusted `push`/`schedule` workflow, restore read-only from the comment trigger): real, but it changes the consistency model — two comments minutes apart would both still read stale state, which is the original symptom. Narrows the window without closing it. Separate issue.
- **A save-side metrics seam.** The restore path records status and source through `MetricsCollector`; the save path has no equivalent. Worth adding, but not required by anything here.

## Context & Research

### Relevant Code and Patterns

- `src/services/cache/save.ts` — `saveCache`, all seven return paths.
- `src/services/cache/checkpoint.ts` — `CheckpointOutcome`, a three-state discriminated union added in #1519. **The closest existing convention** and the one to mirror: it exists precisely so a successful no-op is not collapsed into failure.
- `src/services/cache/restore.ts` — `CacheResult` (`hit`, `key`, `restoredPath`, `corrupted`, `source`). The restore-side shape a save-side result should rhyme with.
- `src/harness/config/outputs.ts` — `setActionOutputs`, the single seam from `ActionOutputs` to `core.setOutput`. `action.yaml` declares six outputs today, including `cache-status`.
- `src/features/observability/job-summary.ts` — `writeJobSummary` builds a fixed table via `core.summary.addTable`, already formatting cache status. Adding a row is isolated to this writer.
- `src/harness/phases/cleanup.ts:196` and `src/harness/post.ts:86` — the two call sites, communicating only through the `CACHE_SAVED` state key.

### Institutional Learnings

- [`read-only-actions-cache-token-broke-session-continuity`](../solutions/integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md) — the original incident. Records that `cacheId === -1` is the only observable boundary signal and that the library's internal denial-vs-collision distinction does not survive `saveCache()`. **Constraint:** do not present a diagnosis the boundary cannot supply.
- [`non-failing-gates-are-worse-than-no-gates`](../solutions/workflow-issues/non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — **Constraint:** a signal that cannot meaningfully fail manufactures false confidence. The new output must have a reachable red state and a reachable green one.
- [`verify-behavior-not-signal`](../solutions/workflow-issues/verify-behavior-not-signal-2026-08-23.md) — **Constraint:** the output and summary row report a *result*, not proof of durability. Wording that implies verification the code did not perform violates this.
- [`checks-report-clean-for-what-they-cannot-observe`](../solutions/workflow-issues/checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — **Constraint:** do not let summary text imply coverage that does not exist.
- [`repair-before-capture-sqlite-session-cache-loop`](../solutions/logic-errors/repair-before-capture-sqlite-session-cache-loop-2026-09-02.md) — the checkpoint-decline path is one of the outcomes being named here. **Constraint:** judge by external effect, not reported status.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/services/cache, src/harness, src/features/observability",
  "freshness": {
    "vcs_reference": "main"
  },
  "budget": {
    "max_search_passes": 1,
    "max_candidate_inspections": 3,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/services/cache/checkpoint.ts::CheckpointOutcome",
      "description": "Three-state discriminated outcome for WAL checkpointing; separates a successful no-op from a failure and carries a reason on failure.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/features/observability/job-summary.ts::writeJobSummary",
      "description": "Job-summary writer that already emits a cache-status row and surfaces operator-facing state without failing the run.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/harness/config/outputs.ts::setActionOutputs",
      "description": "Declared output seam moving runtime state into GitHub Actions outputs, including cache-status.",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **A discriminated result, not `Result<T, E>`.** Repo guidance prefers `Result<T, E>` for recoverable errors, but this is not error-versus-ok: a skip is a success that persisted nothing, and the two backends succeed independently. Mirror `CheckpointOutcome`.
- **The result type lives in `src/shared/`.** The 4-layer rule means a type shared between `services/cache/` and `harness/` cannot live in either.
- **`cacheId === -1` stays one outcome, never split into "denied" and "collision".** `@actions/cache` distinguishes `CacheWriteDeniedError` from `ReserveCacheError` internally and neither crosses the `saveCache()` boundary. Inferring denial from the event name is the dishonest version — a self-hosted runner or a customized environment can hold a writable token on a comment trigger. One honest outcome, with both possibilities named in the operator-facing text.
- **No pre-flight writability probe.** `@actions/cache@6.2.0` does not export `isCacheWritable`, but reimplementing it is pointless rather than merely blocked: its own source comments that *"Unset or unrecognized modes are permissive so behavior matches today,"* and `ACTIONS_CACHE_MODE` is unset in exactly the affected runs. A pre-flight would answer "writable" and detect nothing. Post-hoc observation of `-1` is the only detection path that exists.
- **`CACHE_SAVED` becomes an enum string, not a boolean.** It must carry enough to gate the retry without re-flattening the outcome it exists to communicate.
- **The retry is skipped because state is already durable — not because a retry would fail.** Both reach the same behavior here, and only the first is defensible: "the token is read-only so a retry is futile" is the same inference rejected above, and if `-1` was in fact a collision then the key is already written and the state is durable anyway. Durability is the observable justification; futility is a guess.
- **Type: `feat`.** This adds a public action output. Under the conventionalcommits preset, `fix` would ship a public contract addition as a patch.

## Open Questions

### Resolved During Planning

- *Can a pre-flight detect the read-only token?* No — see above. This removes a unit that would otherwise have looked obviously correct.
- *Should the reason distinguish denial from collision?* No. The boundary cannot supply it.
- *Can `finalize` set the new output?* No. `runFinalizeWithResult` runs at `run.ts:169` and `runCleanup` at `:213` inside the `finally` — the save has not happened when outputs are written. The output must be set from cleanup.

### Deferred to Implementation

- **Whether a post-action hook can set a main-step output.** GitHub seals step outputs when the main step completes, so the post-hook save path likely cannot populate the output — the job summary remains writable there and is the fallback surface. This needs to be confirmed empirically during Unit 3 rather than assumed; the plan should not encode a platform claim nobody tested.
- Exact wording of the summary remediation text. It must satisfy R4 without becoming a paragraph.
- Whether `already exists` should be its own outcome or fold into a persisted one. It is a collision where the key *is* written, so the state is durable either way; the distinction may not earn a name.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

The result carries two independent persistence axes plus one terminal outcome. Durability is `cachePersisted || storePersisted` — not either one alone.

| Store enabled | Store sync | Cache write | `SKIP_CACHE` | `cachePersisted` | `storePersisted` | `CACHE_SAVED` | Post hook |
|---|---|---|---|---|---|---|---|
| any | — | — | true | false | false | `skipped` | skip |
| no | — | ok | false | true | false | `true` | skip |
| no | — | `-1` | false | false | false | `false` | retry |
| yes | ok | ok | false | true | true | `true` | skip |
| yes | fail | ok | false | true | false | `true` | skip |
| yes | ok | `-1` | false | false | true | `store-only` | **skip** |
| yes | fail | `-1` | false | false | false | `false` | retry |

The bolded row is the double-sync bug: durable in the object store, reported as failure, repeated in full by the post hook.

`skipped` must be a distinct state value rather than folded into `false`. A `SKIP_CACHE` run persists nothing, so a durability-only gate would read it as unpersisted and trigger a retry that the operator explicitly disabled.

## Implementation Units

- [ ] **Unit 1: Structured save result**

**Goal:** `saveCache` reports which backends persisted and why it stopped.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Create: `src/shared/cache-save-result.ts`
- Modify: `src/services/cache/save.ts`
- Test: `src/shared/cache-save-result.test.ts`, `src/services/cache/cache.test.ts`

**Approach:**
- `{cachePersisted: boolean, storePersisted: boolean, outcome: <union>}`. Outcome names the terminal condition; the booleans carry the axes independently.
- One outcome per real condition: skipped-by-configuration, skipped-empty, checkpoint-declined, cache-rejected, cache-error, persisted. **`cache-rejected` covers both denial and collision and must be documented at the type as an inference.**
- Every one of the seven existing return paths maps to exactly one result. No path may be left returning a bare boolean.

**Patterns to follow:** `CheckpointOutcome` in `src/services/cache/checkpoint.ts`; `CacheResult` in `src/services/cache/restore.ts`.

**Test scenarios:**
- Happy path: cache write succeeds, store disabled → `cachePersisted: true`, `storePersisted: false`, outcome `persisted`.
- Happy path: both succeed → both true.
- Integration: store sync succeeds, cache write returns `-1` → `cachePersisted: false`, `storePersisted: true`. **This is the case the whole plan exists for.**
- Edge case: `SKIP_CACHE=true` → both false, outcome skipped-by-configuration, and *no* checkpoint or upload attempted.
- Edge case: no cacheable content → both false, outcome skipped-empty.
- Error path: checkpoint declines → both false, outcome checkpoint-declined, and neither backend is attempted.
- Error path: store sync throws, cache write succeeds → `cachePersisted: true`, `storePersisted: false`, run not failed.
- Error path: thrown save error → outcome cache-error, distinct from cache-rejected.
- Edge case: caught `already exists` → durable, not reported as failure.

**Verification:** Every return path in `save.ts` produces a distinct, asserted result. No caller can reach a state where durability is unknowable from the return value alone.

- [ ] **Unit 2: Call sites consume the result**

**Goal:** The post hook stops repeating saves that already persisted, and stops reporting every failure as "no cache content".

**Requirements:** R1, R2

**Dependencies:** Unit 1

**Files:**
- Modify: `src/harness/phases/cleanup.ts`, `src/harness/post.ts`
- Test: `src/harness/phases/cleanup-decline-retry.test.ts`, `src/harness/post.test.ts`

**Approach:**
- `CACHE_SAVED` becomes an enum string: durable, store-only, skipped, or not-persisted. The post hook skips on the first three.
- The skip on store-only is justified by **durability already achieved**, not by predicting a retry would fail. Record that reasoning at the branch — the futility argument is the same inference this plan rejects elsewhere.
- `post.ts:123` reports the actual outcome. "No cache content to save" is reserved for the one outcome that means it.
- An absent or unrecognized state key must retry, not skip. Fail toward doing the work.

**Patterns to follow:** the existing `CACHE_SAVED` gate at `post.ts:86`.

**Test scenarios:**
- Integration: store persisted, cache rejected → `CACHE_SAVED` is store-only, post hook skips, **no second store upload occurs**. Assert the upload call count, not just the log.
- Integration: cleanup declines on checkpoint → post hook retries and succeeds (the existing guarantee; must not regress).
- Edge case: `SKIP_CACHE=true` → post hook skips without attempting a save.
- Edge case: state key absent (main step crashed before cleanup) → post hook attempts the save.
- Error path: each falsey outcome produces its own log line; assert the checkpoint-declined case does **not** say "no cache content to save".
- Integration: agent step failed but save was requested → post hook still saves, so a failed run's session survives.

**Verification:** A run where the object store persists and the cache write is rejected performs exactly one store upload across both call sites.

- [ ] **Unit 3: Surface the outcome**

**Goal:** A repository owner can see whether state persisted, and what to do if it did not, without reading logs.

**Requirements:** R3, R4

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `action.yaml`, `src/harness/config/outputs.ts`, `src/harness/phases/cleanup.ts`, `src/features/observability/job-summary.ts`
- Test: `src/harness/config/outputs.test.ts`, `src/features/observability/job-summary.test.ts`

**Approach:**
- New declared output carrying the persistence outcome, set from cleanup — finalize runs before the save and structurally cannot carry it.
- One job-summary row. On a non-durable outcome, add remediation naming the actual cause honestly: the cache service rejected the write, which on a comment trigger usually means a read-only token but can also mean a key collision, and `s3-backup` is the fix.
- **Confirm empirically whether the post-hook path can set the output.** If it cannot, the summary is the only surface there, and that limitation belongs in a comment rather than silently producing an empty output.
- Wording reports a result, never proof of durability.

**Patterns to follow:** the `cache-status` output end to end; `formatCacheStatus` in `job-summary.ts`.

**Test scenarios:**
- Happy path: durable save → output reports persisted, summary row shows it, no remediation text.
- Error path: cache rejected with store disabled → output reports not persisted, summary carries remediation naming `s3-backup`.
- Edge case: store-only → output distinguishes it from both full success and failure.
- Edge case: `SKIP_CACHE` → output says skipped, and the summary does **not** advise enabling `s3-backup`.
- Integration: the output value is reachable in both a green and a red state — the reachable-red-state bar. Assert both.
- Edge case: summary write throws → run does not fail (existing observability rule).

**Verification:** On a comment-triggered run without `s3-backup`, the summary states the state did not persist and names the remedy. On a dispatch run, the same output reports success.

- [x] **Unit 4: Document the constraint**

**Goal:** The `s3-backup` requirement for mention-driven workflows is written where a consumer finds it before hitting the failure.

**Requirements:** R5

**Dependencies:** None — shippable independently

**Files:**
- Modify: `README.md`, `docs/wiki/Session Persistence.md`, `AGENTS.md`

**Approach:**
- README currently describes persistent memory without noting that the default configuration does not deliver it for `issue_comment`. Qualify it at the claim, not in a footnote.
- Lift the explanation from this repo's own `fro-bot.yaml` workflow comment — currently the only written record of the constraint — into user-facing docs.
- State the mechanism (a read-only runner-injected token, unaffected by `permissions:`) so a reader does not waste time on token permissions.

**Test scenarios:** Test expectation: none — documentation only. Markdown link check covers it.

**Verification:** A reader of the README learns the constraint before configuring the action.

## System-Wide Impact

- **Interaction graph:** `saveCache` has two call sites; both change. `SKIP_CACHE` short-circuits before either backend. No other caller exists.
- **Error propagation:** unchanged. A store failure stays non-fatal, a summary failure stays non-fatal, and a rejected cache write still does not fail the run. This plan changes what is *reported*, not what is *fatal*.
- **State lifecycle risks:** `CACHE_SAVED` widens from boolean to enum. An unrecognized value must retry rather than skip — the post hook is the last chance to persist, so ambiguity should cost a redundant save, never a lost session.
- **API surface parity:** a new declared output is a public contract addition. Additive only; no existing output changes shape.
- **Integration coverage:** the double-sync fix cannot be proven by unit tests on `saveCache` alone. It requires a test spanning both call sites asserting the store upload happens once.
- **Unchanged invariants:** restore-side behavior, `CacheResult`, the cache key scheme, and the response protocol are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| The new output reads as proof of durability, violating a documented constraint | Wording reports a result and names its inference; asserted in tests rather than left to review |
| A confident enum implies detection the boundary cannot perform | One `cache-rejected` outcome covering both causes, documented as an inference at the type |
| The signal is permanently red for default-configured comment runs, becoming ignorable | It has a reachable green state (dispatch runs, or S3 enabled), and the red state carries remediation rather than only a complaint |
| Widening `CACHE_SAVED` breaks the retry guarantee from #1519 | Existing decline-retry test must pass unchanged; unrecognized values retry |
| The post-hook path silently produces an empty output | Confirm the platform behavior during Unit 3 and record it, rather than assuming either way |
| Changing the return type breaks many existing test mocks | Expected and mechanical; Unit 1 lands the type and its call-site updates together |

## Documentation / Operational Notes

- The new output is additive; no consumer migration required.
- `session-retention` became functional in #1519 and is a no-op at its default — worth a release note alongside this, since both touch persistence behavior.
- Release notes should state plainly that mention-driven workflows need `s3-backup` for session continuity.

## Sources & References

- Issue: [#1514](https://github.com/fro-bot/agent/issues/1514) — including the triage comment, whose sequencing this plan follows
- Related: [#1504](https://github.com/fro-bot/agent/issues/1504) (same symptom, different fix), [#1407](https://github.com/fro-bot/agent/issues/1407) (unrelated cache bug), #1370 / #1373 / #1381 (the original `-1` incident)
- Prior art: `docs/solutions/integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md`
