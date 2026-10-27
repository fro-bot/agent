---
type: convention
last-updated: "2026-10-25"
updated-by: "fe7f6bda"
sources:
  - action.yaml
  - src/harness/phases/routing.ts
  - src/features/triggers/router.ts
  - src/features/triggers/skip-conditions-pr.ts
  - src/features/triggers/context-builders-pr-issues.ts
  - src/services/github/api.ts
  - src/features/reviews/review-guards.ts
  - src/features/agent/response-post.ts
  - src/harness/outcome.ts
  - src/features/observability/job-summary.ts
  - packages/runtime/src/agent/error-format/format.ts
  - src/features/agent/execution.ts
  - docs/solutions/integration-issues/permission-ask-dropped-by-ownership-filter-2026-09-19.md
  - src/services/cache/save.ts
  - src/shared/cache-save-result.ts
  - src/services/cache/cache-key.ts
  - src/services/setup/opencode.ts
  - src/services/setup/systematic-plugin.ts
  - src/shared/brokered-push-paths.ts
  - src/features/delegated/brokered-push.ts
  - src/features/delegated/brokered-push-validation.ts
  - packages/gateway/src/web/operator-route.ts
  - packages/gateway/src/execute/run.ts
  - packages/gateway/src/execute/stale-etag-transition.ts
  - packages/gateway/src/execute/stranded-run-sweep.ts
  - packages/gateway/src/execute/live-run-registry.ts
  - packages/gateway/src/execute/recovery.ts
  - packages/gateway/src/execute/checkout-recovery.ts
  - packages/gateway/src/execute/settle-owned-sessions.ts
  - packages/gateway/src/execute/root-stop.ts
  - packages/gateway/src/execute/run-core.ts
  - apps/workspace-agent/src/server.ts
  - apps/workspace-agent/src/recover.ts
  - apps/workspace-agent/src/opencode-instance.ts
  - apps/workspace-agent/src/opencode-proxy.ts
  - packages/runtime/src/shared/errors.ts
  - packages/gateway/src/github/app-client.ts
  - docs/solutions/test-failures/gateway-operator-route-health-timeout-flake-2026-07-30.md
  - src/harness/post.ts
summary: "Common failure symptoms and their causes across action execution, persistence, setup, and gateway runs"
---

# Troubleshooting

Common failure modes when running the Fro Bot Agent GitHub Action, and how to diagnose them. For configuration inputs see [`action.yaml`](../../action.yaml); for the execution model see [[Execution Lifecycle]].

## Agent Not Responding

If the agent does not react to a mention or event:

- **Check permissions** — the workflow needs `contents`, `issues`, and `pull-requests` write permissions for the triggers it handles.
- **Verify credentials** — the `OPENCODE_AUTH_JSON` secret must be well-formed JSON mapping provider IDs to credentials.
- **Check the trigger condition** — for comment triggers, `@fro-bot` must appear in the comment body, and the workflow `if:` guard must match the event.
- **Confirm mention identity** — `@fro-bot` mentions require a token whose login matches the mention. `GITHUB_TOKEN` posts as `@github-actions`, so a PAT or GitHub App token is required to answer `@fro-bot`.
- **Review access control** — only `OWNER`, `MEMBER`, and `COLLABORATOR` authors are processed; bot accounts and fork pull requests are skipped by design. A skipped run names its reason in a `Fro Bot skipped this event (<reason>)` notice and in the job summary's Invocation Outcome section. For a pull request from an unauthorized or bot author, see [Review Access and the Review-Request Path](#review-access-and-the-review-request-path).

## Review Access and the Review-Request Path

A skipped run reports its reason in two places besides the log: a `core.notice` annotation (`Fro Bot skipped this event (<reason>): <message>`) and the **Skip reason** line under Invocation Outcome in the job summary. The skip posts no comment and no reaction.

**Who is authorized.** `pull_request` events are processed only when the author association is `OWNER`, `MEMBER`, or `COLLABORATOR`. Anything else is skipped with `unauthorized_author`.

**Bot authors.** For `opened`, `synchronize`, and `reopened`, a bot sender (a login ending in `[bot]`) is skipped with `self_comment`. That covers PRs opened by bot accounts, including a repository's own first-party GitHub App. The check reads the webhook _sender_, not the PR author field, so a bot that pushes to a human's PR is skipped too.

**The review-request override.** `review_requested` and `ready_for_review` are the exception. For these two actions the action resolves the webhook sender's repository permission through the collaborator-permission API and maps it to an association: `admin` → `OWNER`, `maintain` → `MEMBER`, `write` or `triage` → `COLLABORATOR`. That value replaces the PR author's association before the authorization check, so an unauthorized PR author is admitted when the person who requested the review is authorized. The bot-sender skip does not apply to these two actions. A `read`/`none` permission or a failed lookup resolves to nothing, and the PR author's own association applies.

The review must also be requested from the bot, or the event is skipped with `bot_not_requested`. For `review_requested` the requested reviewer must match the bot's login; for `ready_for_review` the bot must already be among the PR's requested reviewers. Matching is case-insensitive and ignores a trailing `[bot]`, so `fro-bot` and `fro-bot[bot]` are equivalent.

**Recipe.** To have the bot review a PR from an author the guard skips, such as a first-party App:

1. Add `review_requested` to `on.pull_request.types`.
2. Request the review from the identity behind the action's `github-token`. If that token authenticates as something other than `fro-bot`, request that identity.
3. Make the request with a human account's credentials that hold `write` or higher on the repository. The App's own token will not work: it is not a collaborator, so its permission resolves to nothing. `GITHUB_TOKEN` will not work either: events it creates do not start new workflow runs.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, review_requested]
```

In the workflow that opens the PR, request the review as the human account:

```yaml
- run: gh pr edit "$PR_NUMBER" --add-reviewer fro-bot
  env:
    GH_TOKEN: ${{ secrets.MAINTAINER_PAT }} # a human account with write or admin on this repository
    PR_NUMBER: ${{ steps.create-pr.outputs.pull-request-number }}
```

**Limits.**

- The review guard (`checkForkOrSelfGuard` in `src/features/reviews/review-guards.ts`) never posts `APPROVE` on a PR whose author matches the reviewing identity after lowercasing and stripping `[bot]`, and never on a fork PR. `REQUEST_CHANGES` is still posted. On a `pull_request` event an approving verdict that the guard refuses posts no review and the delivery fails as `review-guard-blocked`, so the override cannot produce an approval in that case.
- A review request made by the App or by `GITHUB_TOKEN` does not admit the PR. The first resolves to no permission; the second starts no run.

## Cache Issues

If sessions are not persisting between runs:

1. Check which trigger the run used. On GitHub-hosted runners, `issue_comment` and `issues` runs cannot write the Actions cache at all — GitHub scopes the cache token by trigger class, so this applies regardless of who triggered the run, and no `permissions:` change affects it. If the bot forgets between mentions while `workflow_dispatch` runs remember fine, this is the cause; enable `s3-backup` for continuity on GitHub-hosted runners. See [[Session Persistence]].
2. Check the GitHub Actions cache size (Settings → Actions → Cache). The cache has a 10 GB per-repository limit and entries expire after 7 days of inactivity.
3. Enable S3 backup (`s3-backup: true`) for durable persistence that outlives cache eviction, and for continuity on the mention triggers above.
4. Verify `skip-cache` is not set to `true`.
5. Review run logs for cache-corruption warnings — a corrupted restore falls back to S3 when configured.

Before guessing, read what the run actually reported. The `cache-save-result` output and the job summary name the persistence outcome directly: `durable` (the Actions cache write landed), `store-only` (the object store landed but the cache write did not), `skipped` (`skip-cache` was set), `declined-for-safety` (the save was refused before either backend was attempted), or `not-persisted` (nothing durable happened). A `store-only` result on a mention trigger is the expected, healthy shape once `s3-backup` is enabled — not a failure. A `not-persisted` result is the one worth investigating, and the job summary distinguishes its causes: a rejected write, a declined SQLite checkpoint, or no cacheable content found. The post-action retry writes the Actions cache only. With `s3-backup` enabled, its job-summary row also reads `Object Store Publish: withheld (lease released)` and the log carries `Post-action withheld the object-store session publish`: the main step already released the coordination lease, so the retry does not upload the session to the object store. A run whose main step did not reach the object store therefore leaves the store at the previous run's session. The main step withholds the same publish, with the row reading `withheld (no lease acquired)`, when the run never took the coordination lock, as for a dedup-skipped or routing-skipped event.

A `declined-for-safety` result is a different investigation than `not-persisted`, and re-running the job will not clear it on its own. It means cleanup could not confirm no other writer was still touching session state — unresolved background-subagent work, an OpenCode server shutdown that never confirmed the writer had stopped, or a failed coordination lease renewal — and the post-action hook deliberately does not retry it: it runs with less information than the step that declined, so it honors the refusal rather than guessing. A recurring `declined-for-safety` result points at one of those three causes, not at cache configuration.

Note what `not-persisted` cannot tell you. A rejected write surfaces as a single `-1` from `@actions/cache` with no detail, so the action cannot distinguish a policy denial from a reservation collision, a server error, or an upload failure. Do not infer the cause from the trigger type — the mapping is a strong prior, not a fact about the individual run.

Re-runs and multi-job runs are a separate case. Each run attempt of each job writes its own cache entry, keyed by run ID, run attempt, _and_ the job (`GITHUB_JOB`, plus a matrix-leg hash), so neither a re-run nor a sibling job in the same run collides with another entry and silently discards its own state. A thrown "already exists" collision is reported as `not-persisted`, not as success. The log artifact is named the same way — `opencode-logs-<run-id>-<attempt>-<job>` (for example `opencode-logs-38026680860-1-fro-bot-observe`) — so `gh run download` returns one job's logs per name.

See [[Session Persistence]] for how memory survives across runs.

## Setup and Install Failures

If the run fails during setup rather than during agent execution:

- **`Unsupported platform: <platform>/<arch>`** — the action supports Linux and macOS on x64 or arm64 only. This is now rejected by name before any download is attempted. Windows runners are not supported, and neither is an architecture outside that matrix; the harness build the action defaults to publishes assets for those four combinations and no others. See [[Setup and Configuration]].
- **`EACCES` when spawning OpenCode** — historically caused by handing a consumer the install _directory_ where an executable path was required. If this recurs, the auto-setup log line records both the directory and the resolved binary path, which is enough to tell which one was exported as `OPENCODE_PATH`.
- **`Skipping tools cache save because Systematic plugin install did not complete`** — setup continues without the plugin rather than failing the run, so this is a warning, not a fatal error. Two hints accompany it. If the parent environment carries `NPM_CONFIG_*` variables, the warning names them and notes that the install child deliberately does not inherit them; that scrub is intentional and should not be worked around by allowlisting those keys. If the failure was a spawn error, the warning carries a path diagnosis stating what was actually found at the binary path — absent, a dangling symlink, a directory, or present-but-not-executable — along with the tail of the child's stderr.

Stock fallback and pinned-harness failure have different meanings. The current stock `FALLBACK_VERSION` in `src/services/setup/opencode.ts` is `1.19.0`; it covers failed `latest` resolution and eligible stock-install retries. An explicitly requested harness build never silently falls back to that stock release after a download or checksum failure. [[Setup and Configuration]] explains the version identity and verification boundaries.

## Model Resolution Failures

SDK failures now retain readable envelope details in diagnostics rather than collapsing to `[object Object]`. The shared `formatSdkError` helper prefers the nested SDK message and bounds the result to 500 characters; an unreadable or unserializable value becomes `[unprintable error]`. These strings are diagnostic descriptions, while retry and terminal-failure decisions retain their structured evidence (`packages/runtime/src/shared/errors.ts`).

`model_not_found` means OpenCode could not resolve the configured provider/model identifier, not that a network request to the model timed out. The Action stops immediately and reports a sanitized model ID and any validated suggestions, plus a suggested action in the job summary (`packages/runtime/src/agent/error-format/format.ts`, `src/features/agent/execution.ts`). The two usual causes are an incorrect identifier and a model catalog that did not load; the latter can occur when the job cannot reach `models.opencode.ai` and the model is not defined explicitly in OpenCode config. Repeating the same turn or increasing its timeout does not repair either configuration problem.

## Timeout Errors

If the agent times out before completing:

- Increase the `timeout` input (default `1800000` ms / 30 minutes; `0` disables the limit).
- Check the run logs for stuck operations or loops.
- Break large tasks into smaller, focused steps.

One timeout shape is worth recognizing on sight, because it produces no error at all: the run simply stops at its wall-clock limit having delivered nothing, with no exception and no classified failure in the logs. That pattern means something was waiting on a reply that never came. It was the signature of a permission ask being dropped by an event filter (see [[Background Subagents and Ownership]]), and it generalizes — when a run dies by clock with no error, look for the last event that expected a response rather than for the slowest step.

## Incomplete Invocations

A run reporting `invocation-outcome: incomplete` is a distinct diagnosis from a failure, and it will show a non-zero exit code despite possibly having produced a perfectly good result. `incomplete` means the harness could not _certify_ that the invocation finished cleanly, for one of four reasons it names in the job summary: the event stream ended without a terminal signal (an observation gap), background subagent work this run owned never resolved, the OpenCode server never confirmed it had stopped writing, or the coordination lease could not be verified.

Two consequences follow directly and are intentional. No dedup marker is written and no success reaction is posted, so a re-run is not dedup-skipped into a silent success — re-running is the correct first response. And the job summary's "Background Work" section names any unfinished subagent work by label rather than by count, so the specific outstanding work is identifiable rather than merely tallied.

A single `incomplete` after a long or heavily parallel run is usually a dropped event rather than a defect. A repeated `incomplete` on the same workload points at background work that consistently outlives the drain budget — the remedy is a longer `timeout`, not a retry, since drain draws from the same wall-clock budget as execution.

## Brokered Push Not Landing

When an authorized `@fro-bot` PR comment produces workspace edits but no commit appears on the PR head branch, the [[Execution Lifecycle|brokered push]] step suppressed itself. It is fail-closed by design, so a missing push almost always means one of its trust gates declined rather than a bug:

- **Missing trust anchor** — the workflow must pass `trusted-head-sha` (from the PR head SHA) for the push to be eligible. Without it the step bypasses silently. See [[Setup and Configuration]].
- **Path outside the allowlist** — brokered pushes are limited to `src/`, package `src/`, `docs/`, and the top-level `README.md`, `ARCHITECTURE.md`, and `STRUCTURE.md`, capped at 100 files. Edits to config, scripts, or CI files are rejected and the run fails loudly. A consumer can widen the set with the `brokered-push-extra-paths` input (comma-separated prefixes), but protected surfaces stay denied no matter what is listed, and a malformed or overlapping entry fails the run at parse time on _every_ trigger rather than waiting until a push is attempted. To see what the run actually resolved, read the `brokered-push-allowlist` output — it reports the effective `defaultPaths`, `rootFiles`, and `extraPrefixes` as JSON (empty when the run exits before finalize).
- **Live re-check failed** — the actor's write permission, the PR's open state, and the head branch and SHA are all re-verified immediately before the commit. A moved head, a renamed branch, a closed PR, or a permission lookup error all abort the push.
- **Not a same-repo PR comment** — the step only runs for `issue_comment` events on a pull request in the same repository from an `OWNER`, `MEMBER`, or `COLLABORATOR`. Fork PRs and other event types never broker a push.
- **Timed out** — the push has a 120-second ceiling. If it fires after the commit already landed server-side, the run reports failure but the commit exists; a re-run reconstructs a clean workspace and does nothing rather than double-committing.

Since the failure paths above are hard to tell apart from a reason string alone, the brokered-push outcome now carries a closed `failureClass` discriminant — `validation`, `reconstruction`, `moved-head`, `identity`, `permission`, `commit`, `timeout`, or `unknown` — and validation rejections additionally list the offending paths. That is the field to read in the logs when diagnosing a suppressed push; the human-readable reason strings are unchanged and no caller branches on their text.

## Lock Held After a Run Ended

The coordination lock normally disappears when a run finishes. If a repo stays blocked, look at the lease-renewal log lines for the run (gateway logs or the Action step log):

- **`Coordination lease ETag adopted after a renewal outcome was lost`** (info) means a renewal reached S3 but the response was lost, and the next failed tick or the stop recovered by taking the stored ETag. Nothing is wrong; the release used the adopted ETag.
- **`Coordination lease renewal failed`** / **`threw`** (warning) is logged for every failed renewal, with an adoption line after it when the stored ETag was recovered. No adoption line does not prove the PUT failed to commit: the read may also have failed or exhausted its budget. If ownership cannot be recovered, the lease is left to its TTL (15 minutes by default). `Lock record not adopted` at debug names a record mismatch: another holder or run, a different acquisition token, or no token.
- A record without an `acquisition_token` was written by an older gateway build and is never adopted; it falls back to its TTL. This lasts only while old and new builds overlap during a deploy.
- A tick that was still pending when the 5 s stop budget ran out leaves no budget to look for a committed renewal, so the ETag stop reports may be stale. The gateway's release then retries once by ownership (`run: lock released by ownership after a stale ETag`, info): it reads the lock and deletes it only if the holder, run and `acquisition_token` are this run's. A `lock now belongs to another acquisition` line means a successor holds the lock and it was left alone. The retry is bounded at 5 s: if the store stalls, `ownership release did not finish within 5000ms — lock left to its TTL` is logged (warning), then `releaseLock failed`, and the lock lapses by TTL. Only a failure of the retry logs `releaseLock failed`.

To clear a stuck gateway lock sooner, use `/fro-bot force-release-lock`; it deletes the lock only when the lease has expired and the repo's workspace reports `clear`.

## A Gateway Run Was Refused or Cancelled

When a gateway run ends before the agent starts, or a cancel does not seem to stop the agent, the logs carry the reason without any repository content. Join the lines on `runId` (gateway) and `sessionId` (workspace).

- **`run: checkout preparation refused`** / **`run: checkout preparation failed`** (gateway, warning) fires once when `/update` refuses or fails the checkout. It carries `repo`, `runId`, and the closed `reason` (`dirty`, `ahead`, `diverged`, `detached`, `maintenance-hold`, `fetch-timeout`, and so on). A `dirty` refusal adds `changedPathCount`, capped at 20 by the workspace sample; a failure adds `mutationStarted` and `permanent`. Path, config-key, submodule and branch names are never logged; the capped names are in the run's persisted `checkoutPreparation` record.
- **`workspace-agent: update refused`** / **`workspace-agent: update failed`** (workspace, warning) is the same decision seen from the workspace, with `owner`, `repo`, `reason`, `durationMs`, and `changedPathCount` for `dirty`. If the gateway line is present and this one is not, the request never completed in the workspace.
- **`GATEWAY_RUN_TIMEOUT_MS (…ms) is below the …ms that automatic checkout recovery needs, so automatic checkout recovery can never run …`** (gateway startup, warning) is logged once at load when the run timeout is below the time one automatic recovery needs (574000 ms with the default time limits). The gateway starts normally and a dirty checkout is refused as before; raise `GATEWAY_RUN_TIMEOUT_MS` to at least the value in the message to enable recovery.
- **`run: installation token mint failed before update`** (gateway, warning) fires once when the GitHub installation token for a run's `/update` cannot be minted: GitHub did not answer within 30 s, the call failed, or it threw. It carries `owner`, `repo`, `cause` (an error class such as `AuthTimeoutError`, `AuthError` or `AppNotInstalledError`, or `timeout`; never a message) and, for a permanent installation failure, `status` `401`. No `/update` request is sent. The run ends as unreachable (retry later), or as workspace-unavailable for the `401`.
- **`run: dirty checkout recovered automatically`** / **`run: automatic checkout recovery declined`** / **`run: automatic checkout recovery ambiguous`** (gateway, warning) fires once when a `dirty` refusal triggers the automatic recovery, which runs only while the run holds the repo lock, has budget for the quiet check, two token mints, preview, recover, backup lookup and update ceilings (574 s by default), and OpenCode reports the workspace quiet. All three carry `repo`, `runId` and `outcome`. `recovered` adds `backupId`: the previous checkout is preserved under that id, and the run continues or replies from a second `update`. `declined` adds `reason` and means nothing moved, so the usual `dirty` refusal follows (`budget-insufficient`, `token-unavailable`, `workspace-busy`, `workspace-unknown`, `preview-unavailable`, `preview-not-ok`, `size-incomplete`, `quota-exceeded`, `insufficient-disk-space`, `checkout-changed`, `inspection-failed`, `maintenance-hold`, `journal-in-progress`, `fetch-failed`, `build-failed`). `token-unavailable` means the GitHub installation token could not be minted within 30 s (or the mint failed), so no `/recover` request was sent and nothing moved; that line also carries `cause`, an error class name such as `AuthTimeoutError` or `timeout`, never a message. A `quota-exceeded` or `insufficient-disk-space` reply names the cause and has no Recover button; free space with `/fro-bot checkout-backup delete <id>`. `ambiguous` adds `reason` (`timeout`, `transport-error`, `unexpected-result`, `rollback-failed`, `quarantine-failed`, `install-failed`, `verification-failed`, `termination-unconfirmed`) and `lookup`, and means something may have moved, so the reply comes from what the second `update` observed. `lookup` is the result of the run's search for its own backup by run id. The search runs after the follow-up `update` has returned (that update waits for any swap in progress), and this line is written once the search is done: `found` (with `backupId`), `not-found` or `failed`. The reply names a found backup, and says a fresh checkout was installed only when the checkout is ready; with `not-found` or `failed` it says a recovery was attempted and points at `/fro-bot checkout-backup list`. `rollback-failed` means a pre-quarantine failure could not clean up after itself: the original checkout is untouched, but the next `/update` refuses `needs-recovery` until the workspace restarts and retries the cleanup, and the reply says so without a Recover button. If the journal is still there after a restart, an admin needs to clear it. `/fro-bot checkout-backup list` shows the `runId` of the run that triggered each backup. Paths are never logged.
- **`workspace-agent: OpenCode instance dispose failed after recovery`** (workspace, warning) means a recovery succeeded but the best-effort `POST /instance/dispose` to OpenCode did not. It carries `owner`, `repo`, `reason` (`timeout`, `network-error`, `http-error`, `threw`) and `status` for `http-error`. The checkout on disk is correct; OpenCode may keep listing the old files until its instance is disposed, which a restart of the workspace does.
- **`opencode-proxy: session abort forwarded`** (workspace, info) is the only workspace-side trace of an operator cancel, since the gateway aborts through the proxy. It carries `sessionId`, the `status` the gateway saw, and `durationMs`. `session delete`, `instance dispose` and `global dispose` requests are logged the same way. Request bodies, headers and the query string are never logged.
- **`run: terminal transition failed — retrying with the stored ETag`** (gateway, warning) fires before each retry of a terminal RunState write that lost its conditional write or hit a store error. It carries `repo`, `runId`, `phase`, `retry`, `attempts` and `err`. Every terminal write makes up to three attempts, 500 ms then 1 s apart, each bounded to 5 s. **`run: terminal transition failed and the stored run is terminal or not this run — skipping retry`** means the record was already finished (or is another run's) and was left alone. **`run: terminal transition failed but the stored run is already terminal — adopting the stored record`** (gateway, info) means a write that timed out had committed: the stored record, with its own phase, is what observers receive. **`run: transitionRun <PHASE> failed`** (gateway, error) means every attempt failed: the failure reply and the operator push still went out, and the record stays in its last phase for the next recovery to repair; search by `runId`.
- **`recovery: recovering stale run`** / **`recovery: run transitioned to FAILED`** (gateway) appear at startup and now also from the periodic stranded-run sweep, which repairs an `EXECUTING` record left behind by a failed terminal write or a dead process. **`recovery: run is owned by this process — skipping`** means the sweep saw a stale-looking record for a run still in the abort registry or an in-flight maintenance run and left it alone. **`stranded-run sweep: pass exceeded its bound — aborting it`** (warning) means a pass ran 4 minutes: its signal is aborted and the pass is abandoned, so the next tick starts a new one. **`stranded-run sweep: pass failed`** (error, with `err`) means a pass threw. **`run: operator cancel landed during the FAILED write — skipping the failure reply`** (info) means a cancel arrived while the terminal write was retrying; the cancel notice is the user's only message.
- **`run-core: event stream did not connect before the prompt`** (gateway, error) means the OpenCode event stream did not announce itself with `server.connected` within 10 s, ended or failed first, or opened with some other frame. It carries `sessionId` and `detail` (`timeout`, `ended`, the transport error's message, or `first frame was <type>`). The prompt was never sent, so the run ends as `unreachable` with the transport error as its cause. A run that owns no other sessions sends no abort and is not quarantined; sessions it already owns from an earlier turn are settled through the termination barrier first, and the run is quarantined if they cannot be confirmed settled.
- **`run-core: event stream closed before session.idle`** (gateway, error) means the OpenCode event stream ended without the root going idle. It carries `sessionId`, `totalEvents`, `activityEvents`, `lastEventType` and, when the transport reported a failure, `streamError` (the transport error's message, for example `fetch failed`). The stream is not reconnected; the run ends as `stream-ended` after the root is aborted and confirmed quiescent.
- **`run-core: event stream silent — failing the run`** (gateway, error) means no event at all, heartbeats included, arrived for `silenceMs` (30000). It carries `sessionId`, the event counters and `lastEventType`. The run ends as `stream-ended` ("Event stream silent for 30s") even while an approval or question is pending, and the pending request is rejected when the termination barrier starts.
- **`run-core: event stream announced itself again — stream was replaced`** (gateway, error) means a second `server.connected` arrived on one stream. Events between the two connections were never delivered, so the run ends as `stream-ended`.
- **`settle-owned-sessions: ...`** and **`run-core: owned work could not be confirmed settled`** (gateway) carry `runId` as well as `rootSessionId`, so an abort that did not confirm, and the quarantine that follows, join to their run. Match the `rootSessionId` to the `sessionId` on the workspace's abort line to see whether the abort request reached OpenCode.
- **`settle-owned-sessions: the root is running after the abort`** (gateway, warn) means the root session showed up live after the barrier's first abort, so the abort had been sent before the prompt was running and did nothing. The barrier aborts it again on every poll until its terminal reply exists. **`root-watch: the root is running during the quarantine hold`** (warn) is the same observation during the quarantine hold, with `aborts` counting the extra aborts; **`root-watch: the root is confirmed stopped`** (info) and **`root-watch: quarantine hold ended without confirming the root stopped`** (warn) end the watch. All carry `runId` and `rootSessionId` and never message content.

## Workspace Stream Disconnects

The workspace OpenCode proxy closes its downstream response when the upstream errors or closes incompletely. A workspace restart during an SSE stream therefore surfaces as a closed or failed stream rather than an indefinitely open connection. Conversely, a disconnected SSE client releases its upstream event request. SSE has no ordinary inactivity timeout, so silence alone still does not prove a failed connection (`apps/workspace-agent/src/opencode-proxy.ts`).

## Known Gateway Test Flake

A lone timeout in `packages/gateway/src/web/operator-route.test.ts` during a full `bun run test` is a known, non-blocking flake, not a regression. The suite only exercises static route-classification guards with no timing-sensitive logic; under peak parallel load its tasks can be starved past the default 5-second budget. Confirm the flake by checking that the failure is a **timeout** (not an assertion), that it is the only failure in an otherwise-green run, and that the file passes in isolation:

```bash
bunx vitest run packages/gateway/src/web/operator-route.test.ts
```

If all three hold, re-run rather than treating it as a signal. An assertion failure, or a timeout that reproduces in isolation, is a different problem and should be investigated normally.

The isolation check is what separates this flake from an ordinary slow test. A test that legitimately costs more than the default budget on _every_ run — for example one that builds several temporary git repositories — fails deterministically when run alone, not just under parallel load. That kind of timeout wants an explicit per-test budget, not a re-run. The rule of thumb: passing in isolation points back to this scheduler-contention flake; failing in isolation points at the test's own cost.
