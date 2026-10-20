---
date: 2026-10-18
topic: action-gateway-consolidation-inventory
---

# Action vs gateway: consolidation inventory

Snapshot of main at `7267362c6`. Read-only research. No repo files were edited, and no tests or builds were run. Later changes appear only as short `Update:` notes; the findings themselves are unchanged.

Scope notes:

- LOC are `wc -l` on non-test files plus outline spans. Treat them as rough.
- "Shared" means exported from `packages/runtime` and imported by the consumer. Verified by grep unless marked.
- `[unverified]` marks a claim I did not confirm by reading or running code.

## Headline findings

1. The gateway never spawns OpenCode. Server lifecycle has three implementations: runtime `bootstrapOpenCodeServer` (Action), `apps/workspace-agent/src/opencode-server.ts` (workspace, with its own supervisor and env allowlist), and `opencode-attach.ts` (gateway, attach only).
2. Provider fail-fast: the Action has equivalents for auth, quota, model-not-found, and context overflow. They predate #1854, the gateway's run-level fail-fast. The real gateway gap is quota on the `session.status` retry path. #1836 appears only in a source header; no local commit has that number.
3. Event streaming: `run-core.ts` says it mirrors `streaming.ts` "exactly" and replicates the accessors by hand. Fixes have landed on one side only in both directions.
4. Security: the Action's env allowlist admits `NODE_OPTIONS` (see Callout A).
5. Config: the two surfaces share almost no config. The overlaps are a default value, two S3 env names, and an AWS env-name convention. See the config divergence section.

---

## Table

| # | Concern | Action impl | Gateway impl | Shared today | Divergence | Fix-skew evidence | ~LOC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | OpenCode server lifecycle, SDK client, env scrub, config injection, `no-task-reuse` guard, question-tool pin | `src/features/agent/server-adapter.ts:20-77` → runtime `bootstrapOpenCodeServer` (`packages/runtime/src/agent/server.ts:299-485`), `pinQuestionToolOff` (`:247-286`), `ensureOpenCodeAvailable` (`:522-588`), `waitForServerQuiescence` (`:96-151`). SDK `createOpencode` inside `withScrubbedEnv` (`:383`). Guard config: `src/services/setup/no-task-reuse-config.ts`. | No spawn. `packages/gateway/src/execute/opencode-attach.ts:18-32` attaches to `workspace:9200` with bearer auth. Third impl: `apps/workspace-agent/src/opencode-server.ts` (`buildOpencodeLaunchSpec`, `buildOpencodeEnv`, `startOpencodeServer`, `runSupervisedOpencode` with respawn budget). | `createRemoteOpenCodeHandle` (`packages/runtime/src/agent/remote-client.ts`), `createRemoteQuestionClient`, `NON_INTERACTIVE_OPENCODE_CLIENT`, `filterAgentEnv`, `withScrubbedEnv`. Workspace imports no runtime (grep empty). | Spawn owner differs: SDK in-process, direct child, or attach. Question tool is off on the Action and not operator-overridable, and on for the gateway. Env policy differs (row 13). Only the workspace has a respawn supervisor. | `no-task-reuse` guard: gateway `725deb691` (#1759, 2026-10-09), Action `3258eb02d` (#1769, 2026-10-10), a one-day lag. Question-off: `303aedbb7` (#1768), Action only. Port probe `f6c95a65a` (#1537), runtime. | Action ~930; gateway 32 (+37 shared); workspace ~790+ (read truncated) |
| 2 | Event-stream consumption: SSE, activity/inactivity, idle/terminal detection, delivery fences, background drain | `src/features/agent/streaming.ts:661-1282` (`processEventStream`), `:57-266` (`ActivityTracker`, root freshness). `session-poll.ts:485-1130` (REST completion, grace cycles). `retry.ts:426-721` (`runPromptAttempt`). `attempt-outcome.ts`. | `packages/gateway/src/execute/run-core.ts:477-1491` (`runOpenCodeCore`; SSE subscribe `:771` with `query: {directory}`). `drain-completion.ts`, `reply-delivery.ts`, `text-boundary.ts`, `settle-owned-sessions.ts`. Header at `run-core.ts:14-21`: "mirror … exactly … accessors are replicated locally." | `createInactivityTimer` (gateway only, `run-core.ts:524`), `createOwnershipLedger`, `reconcileLedgerOnce`, `createLedgerReconciler`, `createSdkLedgerReconcileAdapter` (both). | Action: poll plus SSE with grace cycles and generation-scoped root freshness. Auto-rejects permissions (`execution.ts:284`). Buffers to a file. Gateway: SSE-first with coalesced REST validation and a delivery fence. Routes permissions to approvals. Streams to a sink. Action `event.subscribe` calls (`retry.ts:464`, `prompt-sender.ts:85`) carry no `query.directory`; the gateway's does. Whether this matters is [unverified]. | Gateway-only: `5cbb0e41e` (#1752, wait for parent follow-up), `28b9fbcd1` (#1771, separate text parts). Action-only: `a94a10e0f` (#1715, settle children from injected completion), `9aed087c9` (#1457, answer permission asks). No test found that enforces the "mirror exactly" claim [unverified]. | Action ~2,400; gateway ~3,100; overlapping concepts ~600–800 (estimate) |
| 3 | Provider/session error classification (#1836 question) | `streaming.ts:282-311` (`classifyRetryStatusError`, `isTerminalProviderError`), `:547-574` (`normalizeSessionError`), `:1029` (retry-status call site). `session-poll.ts:412-460` (`classifyAssistantMessageError`). | `packages/gateway/src/execute/provider-failure.ts` (166 lines; closed 4-value `ProviderFailureReason`; message-text fallbacks `:67-68`). Hooks at `run-core.ts:1298-1413`; `failFromProvider` `:754-764`; `isAuthError` `:1556-1568`. | `packages/runtime/src/agent/error-format/format.ts`: `classifyProviderAuthError` (`:245`), `classifyQuotaError` (`:294`), `classifyModelNotFoundError` (`:198`), `classifyContextOverflowError` (`:275`). Gateway imports only auth and model (`provider-failure.ts:25`). | Quota: the Action fails fast on `session.status` retry with `account_rate_limit`. Gateway `classifyRetryStatus` returns null for it (`provider-failure.ts:112-122`), so the run waits out OpenCode's retry budget. Context overflow: gateway hardcodes `ContextOverflowError` on `session.idle` (`run-core.ts:1307`) with reason `session error`, not the shared classifier. Auth: gateway adds message-text patterns on terminal payloads (`:67`). Runtime says messages are not auth evidence (`format.ts:245-248`). | Action first: quota `9461cb65f` (#1227), auth `71d7aae5e` (#1283), outcomes `f08f92399` (#1343) and `cbab866b5` (#1345), model `ce91420a3` (#1770). Gateway: `b0c8d9b6d` (#739, boot self-test), `90a31c4ca` (#1854, run-level fail-fast). #1836 appears only at `provider-failure.ts:2`; no local commit has that number [unverified mapping]. | Action ~200 glue; gateway ~230; shared classifiers ~180 |
| 4 | Session persistence and continuity: S3/object store, Actions cache, session lookup and continuation, pruning | `src/services/cache/{restore,save,checkpoint,integrity,sqlite-errors,paths,dedup,cache-key}.ts` (~1,240). `src/harness/phases/cache-restore.ts`, `cleanup.ts`. Runtime `session/*` (~1,630) and `object-store/content-sync.ts` (266). | None wired. `packages/gateway/src/runtime-effect.ts:189-215` wraps `syncSessionsToStore`/`FromStore`; no non-test caller (grep). `packages/gateway/AGENTS.md:328` says persistence is "planned but not yet wired." `web/auth/session-persistence.ts` is operator sign-in, an unrelated name collision. | `syncSessions*`, prune, logical-key, `createS3Adapter`, `buildObjectStoreKey`. | Action continuity comes from the cache plus S3; `issue_comment` requires S3. Gateway has no continuity: every mention is a fresh session. | Action-only: `9d795de66` (#1519, cache bootstrap trap, WAL repair), `4e93498a2` (#1373, durable beats stale cache), `a57829d8f` (#1389, skip sync without run identity). Wiring the gateway's existing wrappers would bypass all three. | Action ~2,800; gateway ~30 (dead wrappers) |
| 5 | Locking and coordination: repo lock, lease renewal, takeover, heartbeat | `src/harness/phases/acquire-lock.ts` (562; `LeaseController`, `runAcquireLock` `:480`, design note `:466-478`), `post.ts` (lock delete), `cleanup.ts` (release), `coordination-clear.ts` (144), `coordination-decline.ts` (223). Lock key `action.json`. | `packages/gateway/src/execute/run.ts` (acquire `:897`, `createHeartbeatController` `:975`, releases `:955`, `:1996`), `execute/recovery.ts`, `execute/repo-quiescence.ts`, `discord/commands/fro-bot.ts` (force-release). Lock key `repo.json`. | Runtime `coordination/lock.ts` (626: `acquireLock`, `renewLease`, `releaseLock`, `releaseLockIfHolder`, `getLockKey`), `lock-audit.ts`, `adapter-guards.ts`. `heartbeat.ts` is gateway-only in practice. | Action: no `RunState` (`acquire-lock.ts:473-478`). Its own `LeaseController` renews the lock record only and does not use `createHeartbeatController`. It reclaims expired Action-holder leases without workspace corroboration. Gateway: heartbeat renews `RunState` and lock. Takeover requires `ConfirmExpiredHolder` corroboration via repo-quiescence. | `4f13e66c0` (#1852) touched shared `lock.ts`, `s3-adapter.ts`, and `types.ts`, so both sides benefit. `49a7f9f5e` (#1713) split the Action lock. `7fdec3d95` (#1704, corroborate expired lease takeover): the stat is truncated, so the exact files are [unverified]. | Action ~1,000; gateway ~500; runtime ~1,100 (`heartbeat.ts` 175) |
| 6 | Run state and records | No `RunState`, by design. `src/harness/outcome.ts` (138), `src/features/observability/run-summary.ts` (186), `job-summary.ts` (444), `metrics.ts` (138), `src/harness/config/state-keys.ts`. | Runtime `coordination/run-state.ts` (334) via `createRun`/`transitionRun`. `execute/run-index.ts` (588, in memory). Operator DTOs in `operator-contract/`. Terminal phases at `execute/cancel.ts:152`. | Run-state types (gateway in practice). | By design. Both have a terminal-outcome taxonomy (`outcome.ts` vs `TERMINAL_PHASES`) with no shared code. | None found. | Action ~900; gateway ~1,000 plus contract |
| 7 | Prompt building | Runtime `packages/runtime/src/agent/prompt.ts` (997) and `prompt-thread.ts` (73), re-exported via `src/features/agent/prompt.ts`. Plus `features/agent/context.ts` (117), `diff-context.ts` (73), `harness/phases/session-prep.ts` (183). | `packages/gateway/src/execute/prompt.ts:90-137` (`buildDiscordPrompt`). No runtime import. | None in code. Concept overlap only (mechanical guidance, mention stripping). | Action: XML-tagged, `<harness_rules>` (`prompt-thread.ts`), authority hierarchy, output contract, one-response rule (ARCH invariant 5). Gateway: plain sections (persona, guidance, repo, message), no harness-rules block. | `444336023` (#1781) changed the runtime prompt; Action-only. `c8687772` (#1700) gateway cleanup. | Action ~1,300; gateway 137 |
| 8 | Setup and config: CI OpenCode config, Systematic and oMo plugin injection, version pins | `src/services/setup/` (~3,370 non-test): `ci-config.ts` (525), `opencode.ts` (418), `setup.ts` (408), `systematic-plugin.ts` (220), `omo.ts` (120), `omo-slim.ts` (73), `omo-config.ts` (46), `no-task-reuse-config.ts` (96). Inputs: `src/harness/config/inputs.ts:361-404`. | None. No OpenCode config build. | Pins in `packages/runtime/src/shared/constants.ts:59` (`DEFAULT_OPENCODE_VERSION`) and `:66` (`DEFAULT_SYSTEMATIC_VERSION`). `no-task-reuse.mjs` is built into `dist/` and copied by the Action, and COPYed into the image. | Action injects plugins per run at setup. Workspace bakes them at image build (`deploy/workspace.Dockerfile:284-298`). Version pins are mirrored as Dockerfile `ARG`s (`:155-156`) and synced by `.github/workflows/harness-release.yaml:1114-1314` and checked in `ci.yaml:858`. oMo appears only on the Action side [unverified for workspace]. | `725deb691` → `3258eb02d` guard lag (row 1). `d531945d5` (#1404) removed legacy oMo wiring from CI. `303aedbb7` (#1768) question tool, Action only. | Action ~3,400; workspace Dockerfile ~150 relevant |
| 9 | Logging, redaction, error-name policy | `src/shared/logger.ts` (52): wraps runtime `createLogger` through `@actions/core`. Redaction via runtime `redactSensitiveFields`. | Runtime `createLogger` (`packages/gateway/src/program.ts`, `discord/client.ts`). Operator redaction (`packages/gateway/src/redaction/`, ~1,000) is a different concern: repo denylist, not log redaction. | `packages/runtime/src/shared/logger.ts` (140): `redactSensitiveFields`, `DEFAULT_SENSITIVE_FIELDS`, `EXEMPT_FIELD_NAMES`. This is the strongest shared piece, and both sides use it. | Other redactors: `packages/harness/src/format-error.ts` `redactSecrets` (consumers are `evals/` only, per grep). Wrappers at `evals/diagnostics.ts:29-39` and `evals/runner.ts:803-812`. Release script has its own regex at `scripts/release/dispatch-release-notes.ts:128`. Error-name policy: `packages/gateway/AGENTS.md:85` says error logs on prompt-bearing paths record a name, not `error.message`. Runtime `formatLogEntry` writes `error.message` and `stack` for any `Error` in context (`logger.ts:104-111`). Compliance is per call site [unverified audit]. | `965352926` (#1361) gateway-only wiring. `e093a1e72` (#1773) harness-only linear rewrite. `a81de143c` (#873) harness redaction. | Action 52 + runtime 140 + redactors ~250 |
| 10 | Response and reply posting | `src/features/agent/response-post.ts` (650; `runResponsePost` `:461-650`, `postCommentWithRetry` `:413-459`), `response-file.ts` (72), `src/features/comments/writer.ts` (214), `reader.ts` (257), `src/harness/phases/finalize.ts` (559). | `discord/io.ts` (379; `allowedMentions` safe sends), `discord/streaming.ts` (214; `flush` `:163-211`), `discord/status-message.ts` (480), `execute/reply-delivery.ts` (101), `text-boundary.ts` (125), `preparation-reply.ts` (106), `web/operator/web-sinks.ts`. | Runtime `response-file.ts` (355) and `response-delivery.ts` (99), Action-only. `formatErrorComment` (runtime, Action). No shared delivery code. | Action: one comment or review per run, enforced by the action (ARCH invariant 5). Gateway: append-only sink, live status, mention-safe Discord sends, coarse error text. | Gateway `28b9fbcd1` (#1771, separate text parts). Action equivalent [unverified]. Doc conflict: `packages/gateway/AGENTS.md:332` says output is posted only at completion; `discord/streaming.ts` flushes during execution. Which is current is [unverified]. | Action ~1,400; gateway ~1,400 |
| 11 | Timeouts, budgets, cancellation | `src/harness/config/inputs.ts:360-361` (`timeoutMs`, default 1800000; 0 = no deadline). `retry.ts:44-128` (`createExecutionDeadline`). `execution.ts:97-126` (`abortRemoteSession`, bounded by race). `:47-95` (`replyToPermissionAsk`, bounded retries). `harness/phases/execute.ts:552-709` (`computeDrainDeadlineMs` with a 30s teardown reserve, `runDrain`, `cancelOutstanding`). `acquire-lock.ts:382-393` (`withBound`). No operator cancel. | `execute/run.ts` budget math (`:1123`, `:1319`, `:1453`), approval deadline ≤13 min (`:532+`). `run-core.ts:516-551` (`createInactivityTimer`). `settle-owned-sessions.ts:161-307` (bounded settle, then quarantine). `cancel.ts:297-400` (operator cancel, rendezvous `:230-291`). `abort-registry.ts` (117). | `createInactivityTimer` (`packages/runtime/src/agent/inactivity-timer.ts`), `reconcileLedgerOnce`. | Action: wall-clock race plus a fixed reserve. Gateway: activity-aware run timeout and quarantine semantics. Operator cancel is gateway-only. Action's inactivity uses `INITIAL_ACTIVITY_TIMEOUT_MS` (`session-poll.ts:55`), not the shared timer. | `5892e0915` (#1189) extracted the timer to runtime; Action did not adopt it (no `createInactivityTimer` in `src/`, grep). `093623154` (#1068) gateway activity-aware. `6d938e185` (#1277) Action bound execution. `9aed087c9` (#1457) Action permission bound. | Action ~600; gateway ~900 |
| 12 | Permission and question handling | `execution.ts:47-95` (`replyToPermissionAsk`, reject only), `:284` (`onPermissionAsked`). Question tool off: `server.ts:247-286`. | `packages/gateway/src/approvals/` (~3,350: `registry.ts` 632, `request-gate.ts` 708, `coordinator.ts` 378, `discord-transport.ts` 349, `question-registry.ts` 591, `question-coordinator.ts` 341, others). Permission reply at `execute/run.ts:1346-1349`. | Runtime `remote-question-client.ts` (58), used by `execute/question-client.ts:19`. | Action auto-denies. Gateway routes to human approve or deny. Question tool on the gateway, off on the Action. | Action `9aed087c9` (#1457). Gateway `826a38469` (#1751, deny a claimed approval after teardown). | Action ~150; gateway ~3,350 |
| 13 | Env scrub and child env policy | `packages/runtime/src/agent/filter-env.ts` (118): `EXACT_ALLOW_KEYS` (`:7-59`), `ALLOW_PREFIXES` (`:61`), `DENY_SUFFIXES` (`:63-74`), `DENY_EXACT_KEYS` (`:79`), `DENY_PREFIXES` (`:81`). `with-scrubbed-env.ts` (51). | `apps/workspace-agent/src/opencode-server.ts:110-148` (`buildOpencodeEnv`, explicit allowlist, no prefixes; comment `:123-127` names `NODE_OPTIONS` as never present). | None. | Action: deny-by-default with prefix admit and suffix deny. Workspace: allow by exact name only. See Callout A. | None. Diverged by design in two files. | ~170 plus tests (`filter-env.test.ts`, workspace `opencode-server.test.ts`) |
| 14 | GitHub App auth and API client | `src/services/github/client.ts:73-75` (dynamic `createAppAuth`), `api.ts` (422), `context.ts` (258). | `packages/gateway/src/github/app-client.ts:231,275` (`createAppAuth`), `dispatch.ts` (225), `errors.ts` (47). | None. `@octokit/auth-app` in both. | Action uses the runner token and an app token in some paths. Gateway mints installation tokens per repo [partially verified]. | `7ab02e218` (#1388, short-lived tokens for autonomous runs). Side [unverified]. | ~150 overlapping |
| 15 | Small duplicates, "anything else" | Six `getStringProperty`-family copies: `streaming.ts:444-469`, `session-poll.ts:218-239`, `retry.ts:136-151`. Two GitHub comment writers: `comments/writer.ts` and `response-post.ts:413-459`. `createAgentError` redeclared in `src/features/comments/error-format.ts:16` (runtime at `format.ts:180`). Raw permission-reply call at `execution.ts:71`. Action wrapper `createExecuteLedgerReconciler` over runtime reconciler (`session-poll.ts:308-410`). | Six `getXProperty` copies: `run-core.ts:268-283`, `provider-failure.ts:73-82`, `drain-completion.ts:63-84`. Raw permission reply at `execute/run.ts:1349`. `wrapLedgerWithHooks` (`run-core.ts:317-395`). `abortSession` (`settle-owned-sessions.ts:117-140`) duplicates Action `abortRemoteSession`. | Runtime has no payload-accessor module. | Identical `TASK_NOTICE_PATTERN` on both sides (`streaming.ts:634`, `drain-completion.ts:47`). | Gateway-only `1752` and `1771`; Action-only `1715`. | ~150 |

Update: the accessor copies and the task-notice pattern in row 15 were removed in #1872. Small duplicates this table does not list (entity-ref parser, sleep, gateway logger adapter, SHA validator, byte formatter) were removed in the small-helpers rung (#NNNN).

---

## Top 5 consolidation candidates (ranked by bug-skew risk × duplicated LOC × ease)

### 1. Provider-failure classification and terminal policy

Bug-skew risk is high. The gateway lacks the Action's quota fail-fast and context-overflow reason, and it uses a different text-fallback policy for auth. The classifiers already live in `packages/runtime/src/agent/error-format/format.ts` (`:198-324`), and the gateway already imports two of them (`provider-failure.ts:25`). Duplicated glue is about 200–250 LOC across `streaming.ts:282-311`, `session-poll.ts:412-460`, `provider-failure.ts`, and `run-core.ts:1298-1413`. Ease is high. Move the composition into runtime as one function, `classifyProviderFailure`, returning the `ErrorInfo` shape. The gateway maps that to its closed wire enum (`operator-contract/provider-failure-reason.ts`). The quota change alters gateway behavior: it turns a retry-wait into a fast fail on `account_rate_limit`. That is a product decision, so it needs your sign-off before it lands.

### 2. Event-stream leaves: payload accessors, task-notice parser, REST message facts

The gateway's `run-core.ts:14-21` says it mirrors `streaming.ts` "exactly" but can only do so by copying, because of the layering rule. The copies have already diverged in both directions (#1715 and #1752). The leaves are pure functions with no state: six accessor families (about 90 LOC), the identical `TASK_NOTICE_PATTERN` plus `parseTaskNotice`, and REST message readers (`retry.ts:190-268` vs `drain-completion.ts:108-146`). Extracting them to `packages/runtime/src/agent/` (for example `payload.ts` and `task-notice.ts`) takes about 150–200 LOC out of two surfaces and turns the "mirror" comment into a shared import. Do not try to share the stream loop itself yet. Its policy differs (poll versus SSE, auto-deny versus approvals).

Update: delivered in #1872.

### 3. Teardown and ownership-drain ladder

The Action's `runDrain` and `cancelOutstanding` (`execute.ts:572-709`) and the gateway's `settleOwnedSessions` (`settle-owned-sessions.ts:161-307`) run the same ladder: reconcile, poll, cancel, mark unknown, confirm. A missed ledger semantic here becomes quarantine or "ownership-declined," so bug-skew risk is medium-high. The two abort functions are near duplicates: the Action's `abortRemoteSession` races its own timeout, and the gateway's `abortSession` relies on a caller-supplied signal. Extract `abortSessionBounded` and the confirm-settled step to runtime. Keep the root-quiescence policy per surface, since only the gateway needs it. Ease is medium because the ledger and reconciler are already shared.

### 4. Lock lease renewal and takeover

The Action's `LeaseController` (`acquire-lock.ts`, design note `:466-478`) and runtime `heartbeat.ts` each run a renewal loop. The lease-expiry path is correctness-critical, and #1852 already touched the shared lock code. The Action deliberately avoids `RunState`, so the lock-only renewal loop is the right extraction point: a `createLeaseController` in runtime that the gateway's heartbeat composes. That is about 150–200 LOC. Ease is medium. Both sides need tests for takeover (the Action's same-run takeover after about 3 heartbeat intervals, and the gateway's corroboration path), so this change needs a plan and not just a move.

### 5. Env scrub and child env policy

This is security-relevant and ranks here for bug-skew risk. The Action's `filterAgentEnv` (runtime `filter-env.ts`) is deny-by-default with prefix admit. The workspace's `buildOpencodeEnv` uses an explicit exact-name allowlist. They disagree on `NODE_OPTIONS` (Callout A) and on unknown `OPENCODE_*` secrets that do not match a deny suffix. Ease is low to medium. The workspace is a separate uid and trust boundary, and it deliberately does not import runtime. The precedent is the checkout-types drift guard (`scripts/checkout-types-drift-guard.test.ts`), not a shared import. The lower-risk path is one shared policy data file, built into both sides the way `no-task-reuse.mjs` already is, plus a drift test. Start by fixing the `NODE_OPTIONS` gap, which is ask-first because it is security posture.

Lower-ranked quick wins, not in the top 5:

- GitHub App token minting duplicated across `src/services/github/client.ts:73-75` and `app-client.ts:231,275`. Low bug-skew, easy.
- `createAgentError` redeclared in `src/features/comments/error-format.ts:16`. Trivial.
- Redactor wrappers in `evals/` and the release script. Low risk.

---

## Callout A: the Action env allowlist admits `NODE_OPTIONS`

Verified by reading `packages/runtime/src/agent/filter-env.ts`. Not executed.

Mechanism:

- `filterAgentEnv` (`:104-118`) keeps a key when `isAllowed(key) && !isDenied(key)`.
- `isAllowed` (`:95-97`) is true for `EXACT_ALLOW_KEYS` or any `ALLOW_PREFIXES` entry (`:61`): `OPENCODE_`, `RUNNER_`, `XDG_`, `LC_`, `NODE_`.
- `NODE_OPTIONS` matches the `NODE_` prefix.
- `isDenied` (`:83-93`) checks `DENY_EXACT_KEYS` (`:79`: `GITHUB_TOKEN`, `GH_TOKEN`, `OPENCODE_PURE`), `DENY_PREFIXES` (`:81`: `AWS_`, `INPUT_`), and `DENY_SUFFIXES` (`:63-74`: `_TOKEN`, `_SECRET`, `_PASSWORD`, `_KEY`, and so on).
- None of the deny lists match `NODE_OPTIONS`, so it passes.

Where it lands:

- `withScrubbedEnv` (`with-scrubbed-env.ts:21-25`) wraps the `createOpencode` call (`server.ts:383`), so the OpenCode child inherits the filtered env.
- The `with-scrubbed-env.ts` header comment says the same scrub applies to the model's bash child.

Impact:

- Any `NODE_OPTIONS` value present in the runner environment (set by a workflow `env:` block or a prior step's `GITHUB_ENV`) reaches the OpenCode server and its tool children, for example `--require` or `--import` of a file in the workspace.
- The Action process itself already runs under that value, so the new exposure is the agent-side server and its children.
- Whether the model can already run arbitrary shell limits the marginal capability. The policy failure is still real: the file's own header says "deny-by-default," and this key violates it.

Contrast:

- `apps/workspace-agent/src/opencode-server.ts:129-148` builds the child env from an explicit list. Lines `:123-127` say `NODE_OPTIONS` "can never appear in the output, by construction."

Not verified:

- Whether `filter-env.test.ts` covers `NODE_OPTIONS` (I did not check).
- Whether any Action step sets `NODE_OPTIONS` in practice.

Remediation options (not applied; ask first, since this is security posture):

- Add `NODE_OPTIONS` to `DENY_EXACT_KEYS`.
- Narrow the `NODE_` prefix to an explicit list. `NODE_EXTRA_CA_CERTS` is needed for CA trust and is currently admitted only by the prefix, so it must be added to `EXACT_ALLOW_KEYS` in the same change.
- Add a test pinning `NODE_OPTIONS` as denied on both sides.

---

## Callout B: the gateway replicates `streaming.ts` by comment

Evidence:

- `packages/gateway/src/execute/run-core.ts:14-21` says: "Event-stream semantics mirror `src/features/agent/streaming.ts` exactly. Cannot import from that module (backwards-dependency ban); accessors are replicated locally."
- The layering rule that forces this is ARCH invariant 1 (`src/` layers shared → services → features → harness). The gateway cannot import `src/`, and runtime cannot import `src/` or `apps/` (both grepped, empty).

Replicated pieces:

- Six accessor families: `run-core.ts:268-283`, `provider-failure.ts:73-82`, `drain-completion.ts:63-84` (and `streaming.ts:444-469`, `session-poll.ts:218-239`, `retry.ts:136-151` on the Action side).
- `TASK_NOTICE_PATTERN` is byte-identical: `drain-completion.ts:47` and `streaming.ts:634`.
- Classification of `session.error`, `message.updated`, and `session.status` (`run-core.ts:1365-1413`) against the Action's `streaming.ts:1029` and `:282-311`.
- Ledger wrapping: `run-core.ts:317-395` (`wrapLedgerWithHooks`).
- Abort handling: `ABORTED_FAILURE` (`run-core.ts:746`), `isAbortedError`.

Update: the accessor copies and `TASK_NOTICE_PATTERN` were removed in #1872, and the "exactly" comment is gone. Provider classification moved to runtime in #1869.

Why it matters:

- The "exactly" claim is already false. The gateway classifies `session.status` retry without quota, while `streaming.ts:1029` classifies it with quota (row 3).
- Fixes have diverged in both directions with no shared test: gateway-only #1752 and #1771; Action-only #1715 and #1457.
- The only guard is the comment. No test I found pins the two copies together [unverified that none exists; I searched for test names and found only per-side coverage].

Remediation:

- Extract the leaves to runtime (candidate 2) and delete the copies.
- Until then, add a drift test that pins `TASK_NOTICE_PATTERN` and the classifier outputs on both sides, the way `scripts/checkout-types-drift-guard.test.ts` pins the checkout types.

---

## Config divergence

The owner's read is right. The two surfaces share almost no config. The overlaps are a default value, the S3 env names, the AWS env-name convention, and the Systematic and OpenCode version pins, which are mirrored rather than shared.

Legend: **O** = overlap (same concept, same name or default). **C** = conflict (same concept, different names, defaults, or semantics). **—** = not present on that side.

| Axis | Action source | Gateway source | Mark | Notes |
| --- | --- | --- | --- | --- |
| Model selection | `model` input (`action.yaml:75-77`, `inputs.ts:357`). Per run. | No gateway knob in `config.ts`. Workspace: deployer selects provider, baseURL, and model via `WORKSPACE_OPENCODE_CONFIG` in the workspace entrypoint (`deploy/workspace.Dockerfile:285-288`, which says it mirrors the Action's `model` and `opencode-config`). | **C** | Per-run on one side, per-deployment on the other. The Dockerfile comment is the only explicit mirror. |
| Agent selection | `agent` input (`action.yaml:64-66`, `inputs.ts:354`). Must be a primary agent. | No gateway agent knob found in `config.ts` [unverified for per-run agent selection elsewhere]. | **C** | Action-only. |
| Run timeout | `timeout` input, default `1800000` ms, `0` = no Action deadline (`action.yaml:78-81`, `inputs.ts:360-361`). | `GATEWAY_RUN_TIMEOUT_MS`, default `1800000` ms, must be a positive integer (`config.ts:657-663`). | **O** on default, **C** on semantics | Same default. `0` means "disabled" on the Action and is rejected by the gateway. |
| Inactivity timeout | None as an input. `INITIAL_ACTIVITY_TIMEOUT_MS` constant (`session-poll.ts:55`). | `GATEWAY_RUN_INACTIVITY_TIMEOUT_MS`, default `300000` ms (`config.ts:666`). Validated against the run timeout (`:689`). | **C** | Gateway-only knob. Action has no equivalent input. |
| Server bootstrap timeout | `server-bootstrap-timeout`, default `5000`, clamped to `120000` (`action.yaml:82-95`, `inputs.ts:363`). | Workspace and gateway deadlines hardcoded (clone 300 s, inspect 25 s per the workspace client doc, readyz 5 s). | **—** | No gateway config knob. |
| Dedup and retention | `dedup-window` default `600000` (`action.yaml:129-137`). `session-retention` default `50` (`action.yaml:27-30`). | `GATEWAY_MAX_CONCURRENT_RUNS` default `3` (`config.ts:644`). No dedup or retention knob. | **—** | Concurrency is gateway-only. Dedup is Action-only. |
| Plugins: Systematic | `systematic-version` (`action.yaml:102-104`), `systematic-config` (`:126-128`), default `DEFAULT_SYSTEMATIC_VERSION` (`constants.ts:66`). Injected per run at setup. | None in `config.ts`. Baked into the image: `deploy/workspace.Dockerfile:156` (`ARG SYSTEMATIC_VERSION`) and `:298` (`plugin: ["@fro.bot/systematic@%s"]`). | **O** on version value (mirrored), **C** on mechanism | Same version, two sources, two mechanisms. Operator-overridable on the Action only. |
| Plugins: oMo and oMo Slim | `enable-omo`, `enable-omo-slim` (mutually exclusive), `omo-version`, `omo-providers`, `omo-slim-preset` (`action.yaml:67-120`). | None found. | **—** | oMo is Action-only [unverified for workspace]. |
| Plugins: no-task-reuse guard | Built into `dist/no-task-reuse.js`, copied into the CI config dir at server start (`no-task-reuse-config.ts`). | `deploy/plugins/no-task-reuse.mjs` COPY'd into the image and loaded by the root-owned managed config (`workspace.Dockerfile:303-314`, `deploy/managed-config/opencode.json`). | **O** | Same source file, two load paths. Shared by construction. |
| Operator config merge | `opencode-config` JSON, merged over the `autoupdate: false` baseline, user wins (`action.yaml:121-125`). | Root-owned managed config merges last and concatenates plugin arrays (`workspace.Dockerfile:303-305`). | **C** | Precedence differs: Action user values win, managed config wins on the workspace. |
| OpenCode version | `opencode-version` input, default `DEFAULT_OPENCODE_VERSION` (`constants.ts:59`, `inputs.ts:377`). Reuse only on exact match. | `ARG OPENCODE_VERSION=1.19.0+harness.caa47272` (`workspace.Dockerfile:155`), set at build time. CI sync bumps both (`harness-release.yaml:1114-1314`). | **O** on value, **C** on override | Identical default string, two sources. Operator-overridable at runtime on the Action only. |
| S3 enablement | `s3-backup` input, `false` default. Enables Action coordination (`action.yaml:31-37`, `inputs.ts:276`). | Always on. `S3_BUCKET` required (`config.ts:530`). | **C** | Gateway has no off switch. |
| S3 bucket | `s3-bucket` input (`action.yaml:38-40`, `inputs.ts:279`). | `S3_BUCKET` env or `_FILE` (`config.ts:530`). | **O** on concept, **C** on source | Input vs env var. |
| S3 region | `aws-region` input (`action.yaml:41-43`, `inputs.ts:282`). | `S3_REGION` (`config.ts:531`). The gateway `AGENTS.md:47` table says `AWS_REGION`. | **C** | Code and doc disagree on the gateway name. Verified both by reading. |
| S3 endpoint | `s3-endpoint` input, HTTPS required unless `s3-allow-insecure-endpoint` (`action.yaml:44-57`). | `S3_ENDPOINT` (`config.ts:532`). No insecure-endpoint flag found. | **C** | Gateway has no insecure-endpoint escape hatch [grep-based; not exhaustive]. |
| S3 prefix | `s3-prefix` input, default `fro-bot-state` (`action.yaml:47-50`). | `S3_PREFIX`, default `fro-bot-state` (`config.ts:533`). | **O** | Same default and key layout; this is the one shared key-layout contract. |
| S3 SSE and bucket owner | `s3-sse-kms-key-id`, `s3-sse-encryption` (default `aws:kms` on AWS, `AES256` on custom endpoints), `s3-expected-bucket-owner` (`action.yaml:51-63`). | `S3_SSE` (`config.ts:534`). No expected-bucket-owner found. | **C** | Gateway has no bucket-owner guard [grep-based; not exhaustive]. |
| Gateway identity namespace | None (keys are per repo and surface). | `GATEWAY_IDENTITY`, default `discord-gateway` (`config.ts:536`). | **—** | Gateway-only namespace. |
| GitHub credentials | `github-token` input, App token or PAT (`action.yaml:7-9`, `inputs.ts:225`). Input env copy deleted (`inputs.ts:237`). | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (`config.ts:632-633`), `_FILE` variants. | **C** | Different credential types and delivery. |
| Provider and LLM auth | `auth-json` input, required (`action.yaml:10-12`, `inputs.ts:239`). Input env copy deleted (`inputs.ts:249`). | Deployer-managed auth in the workspace (`commit 0597ac13c`, #728). Not in `config.ts`. | **C** | Action secret is a per-run input. Gateway's is provisioned into the workspace. |
| AWS access keys | Not an Action input. Default SDK chain from the runner env [unverified]. | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (`config.ts:588-617`), `_FILE` variants. | **O** on env names | Same env var names, different delivery. |
| Workspace-to-gateway auth | None. | `WORKSPACE_OPENCODE_TOKEN` (`config.ts:640`, required). | **—** | Gateway-only bearer. |
| Operator web auth | None. | `GATEWAY_OPERATOR_GITHUB_CLIENT_ID` and `_SECRET` (`config.ts:972-973`), CSRF secret, allowlist file, trusted proxies (`:920`). | **—** | Gateway-only. |
| Logging | None as an input. Logs go through `@actions/core`; debug gated on the runner's debug flag [unverified]. | `LOG_LEVEL`, validated, default `info` (`config.ts:538-540`). | **C** | Action has no level knob. |
| Persona and prompt | `prompt` input (`action.yaml:17-19`). No persona input. | `GATEWAY_PERSONA` or `GATEWAY_PERSONA_FILE` (`config.ts:132`, `:701`). | **C** | Different concepts. The gateway persona is prepended by `buildDiscordPrompt`; the Action has no equivalent. |
| Response surface | `response-mode` input (`action.yaml:138-146`), `output-mode`, `review-skip-label`, `brokered-push-extra-paths`. | Discord and web sinks, `GATEWAY_STATUS_MODE` (`config.ts`, documented in `packages/gateway/AGENTS.md`). | **—** | No overlap. |
| Approval mode | None (permission asks auto-denied). | `GATEWAY_APPROVAL_MODE`, default `approval-required`; `autonomous-low-risk` is rejected (`config.ts:544-552`). | **—** | Gateway-only. |

Config takeaways:

- Real overlap is limited to: the `1800000` ms default, the `fro-bot-state` S3 prefix, the AWS env-name convention, and the Systematic and OpenCode version pins (mirrored in code and synced by CI, not shared).
- Real conflicts: the S3 region name (`S3_REGION` vs `aws-region`, and the doc says a third name), the timeout `0` semantics, model and agent selection timing, plugin injection mechanism, and precedence of operator config.
- Any consolidation of config should start with a shared schema for the S3 and object-store block (region, endpoint, prefix, SSE, bucket owner). That is the one axis where both sides consume the same runtime `object-store` code, so drift there is pure bug surface.

---

## Constraints and blockers

1. **Layering.** ARCH invariant 1 forbids gateway → `src/` (`run-core.ts:19-21` cites this). Runtime imports neither `src/` nor `apps/`. Any shared code must land in `packages/runtime` (or a new package), and the Action's `src/` layers consume it from above.
2. **Runtime dependency surface.** `packages/runtime/package.json` deps are `@bfra.me/es`, `@opencode-ai/sdk`, and `zod`. There is no `@actions/*` and no `effect`. The gateway's Effect is confined to `runtime-effect.ts` (ARCH: "Effect / Result boundary"). New runtime exports must return `Result<T, E>` or plain values, not Effect.
3. **The `@actions/*` rule is convention, not lint.** `eslint.config.ts:56-99` (phantom-dependency guard) unions the root and every package manifest, per its own comment. The root `package.json` declares `@actions/core`, `@actions/cache`, and others. So a runtime import of `@actions/core` would likely pass lint [unverified: config read, not run]. Recommend a guard test in the style of `scripts/action-input-defaults-guard.test.ts`.
4. **Cold start.** `packages/gateway/AGENTS.md` keeps Effect out of runtime to avoid bloating the Action bundle on cold start. Keep shared code lean.
5. **Committed `dist/`.** Any change under `src/` or to a runtime file bundled into the Action requires `bun run build` and a `dist/` diff (ARCH invariant 2). Batch changes into one rebuild per PR. Past commits show large binary churn (`9461cb65f`).
6. **Workspace trust boundary.** The workspace runs OpenCode under a different uid (`identity.ts`). `apps/workspace-agent` does not import runtime. Its checkout types are duplicated on purpose and pinned by `scripts/checkout-types-drift-guard.test.ts` (ARCH: "change both sides together"). Sharing env or spawn policy changes the container's dependency graph and the trust boundary. That is ask-first.
7. **One-response contract.** ARCH invariant 5 (one comment or review per Action run, action-enforced) cannot be shared with the gateway's multi-message stream. Consolidate leaves only, not delivery.
8. **Tests encode policy.** Gateway tests assert `classifyRetryStatus` returns null for transient retries. Action tests assert quota fails fast. Any shared classifier breaks one side's tests by design. Write the policy tests once, in runtime.
9. **Upstream coupling.** The injected `<task id state>` text and event shapes come from OpenCode v1.19.0 (`packages/gateway/AGENTS.md` and `.slim/clonedeps/`). Both sides depend on the same text format, so an OpenCode bump must move both.
10. **Ask-first items.** Changes to CI/CD (version sync workflows), dependencies, auth, and security posture (env policy, `NODE_OPTIONS`) need explicit approval under the safety rules.
11. **Doc drift.** `packages/gateway/AGENTS.md:47` says `AWS_REGION`; `config.ts:531` reads `S3_REGION`. Fix the doc or the code before any S3 config consolidation.

---

## Tests duplicated across the two sides

Test file line counts are from `wc -l`. Overlap is by concept; individual test names were not compared.

- **Injected task-notice parsing and fencing.** `src/features/agent/streaming.test.ts` (2,215) and `packages/gateway/src/execute/drain-completion.test.ts` (325), `run-core.drain-completion.test.ts` (2,115). Likely overlapping [unverified at test-name level].
- **Provider classification.** Runtime `error-format/format.test.ts` (833: auth, quota, model, overflow). Gateway `provider-failure.test.ts` (195) and `run-core.provider-failure.test.ts` (916). Action `opencode.test.ts` and `session-poll.test.ts` (3,951). Shared classifiers are tested in runtime and again through each caller.
- **Ledger reconcile and settle.** Runtime `ledger-reconcile.test.ts` (528). Gateway `settle-owned-sessions.test.ts` (432). Action `execute.test.ts` drain cases (about lines 1279–1421).
- **Permission reply.** Action `execution.test.ts` (959). Gateway `run.approvals.test.ts:577-644` and `run-core.provider-failure.test.ts:110`.
- **Log redaction.** Gateway `discord/client.test.ts:140-190` duplicates the `token` and `clientSecret` fixtures that runtime logger tests already cover.
- **Env scrub.** Runtime `filter-env.test.ts` (~190) and workspace `opencode-server.test.ts`. Both pin "secret does not leak," with different allowlists.
- **Lock acquire, renew, release.** Action `acquire-lock` tests (3,548 across acquire and cleanup). Runtime `lock-scope.test.ts` (597).
- **`no-task-reuse` guard.** Tested in `deploy/scripts/no-task-reuse.test.mjs` (141), the Action config path, and gateway `run-core` tests (`postPermissionReply`). Three places.

---

## Unverified claims

- #1836 mapping to any commit. Only the `provider-failure.ts:2` header cites it.
- Workspace `opencode-server.ts` total length (the read truncated at line 788).
- Whether the Action's text assembly has the #1771 multi-part-text bug.
- Equivalence of Action permission handling and gateway approvals beyond the auto-deny finding.
- Gateway logger compliance with "record name, not message" on prompt-bearing paths.
- Whether the Action's `event.subscribe` without `query.directory` matters in practice.
- Whether oMo is installed in the workspace image.
- The `@actions/*` lint gap (config read, not run).
- Which of `packages/gateway/AGENTS.md:332` and `discord/streaming.ts` is current about streaming output.
- Side of `#1388` (short-lived token minting), and the exact files touched by `#1704`.
- Whether `filter-env.test.ts` covers `NODE_OPTIONS`, and whether any Action step sets it.
- Whether the gateway supports a per-run agent selection outside `config.ts`.
- Absence of an S3 insecure-endpoint flag and of a bucket-owner guard on the gateway. These come from grep of `config.ts`, which is not exhaustive.
- Test-name overlap in the duplicated-tests section.
