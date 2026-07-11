---
title: "fix: Remove the agent's GitHub credential for comment/review flows"
type: fix
status: active
date: 2026-07-11
deepened: 2026-07-11
origin: docs/brainstorms/2026-07-11-remove-agent-github-credential-requirements.md
issue: fro-bot/agent#1167
---

# fix: Remove the agent's GitHub credential for comment/review flows

## Overview

For `pull_request`, `issue_comment`, and `issues` triggers, the model no longer posts its own response via `gh`. Instead it writes the response to an action-created, run-scoped file **outside the checkout**; the action reads that file post-run, binds the target/surface/verdict-eligibility to the trusted `NormalizedEvent`, and posts via the existing Octokit writers. For those triggers the raw GitHub token is withheld from the child entirely (no `hosts.yml`, no `GH_TOKEN` env, no `GH_TOKEN` in `$GITHUB_ENV`), closing the #1167 same-UID on-disk residual. `workflow_dispatch` and `schedule` flows are untouched — they keep the credential and current posting because they need autonomous issue/PR creation agency that downstream repos depend on.

## Problem Frame

The model's bash posts via `gh`, which requires `configureGhAuth` to write the raw token to an on-disk `hosts.yml` (mode `0600`). #1147 closed the `${GH_TOKEN}` env-expansion vector, but the on-disk file remains readable by the same-UID process the model controls. Research confirms the model's *only* `gh` use is posting its terminal comment/review (one redundant `gh api .../files` read, already covered by action-injected context), so for comment/review flows the credential can be removed without breaking any read path. Resource creation (branches/commits/PRs) is already action-side Octokit. See origin for the full frame.

## Requirements Trace

- R1. For `pull_request`/`issue_comment`/`issues` runs, no Fro-Bot-provisioned GitHub token is readable from the child's disk, the parent process environment, or `$GITHUB_ENV` by the model's same-UID bash. (The action's own in-heap Octokit token is an accepted, pre-existing residual — see Scope Boundaries.)
- R2. Those flows still post exactly one comment or review per invocation, on the surface and target **derived from trusted event context**, with the correct verdict.
- R3. Response-file contents cannot change who or what the bot posts to. Target and surface come only from `NormalizedEvent`; **only a structured `verdict` enum drives the review event; the body is never parsed for a verdict**; the file lives outside the checkout so it cannot be attacker-preseeded.
- R4. A missing/malformed/invalid response file, or a failed post, → no partial post + a loud failed run (fail-closed). The run fails unless the action confirms a response was delivered (no green-but-silent, the #1154 class). The success path does not return 0 before the delivery assertion runs.
- R5. `workflow_dispatch`/`schedule` runs continue to post issues and open PRs exactly as before.
- R6. No regression to the #1147 env-scrub; no credential material in logs/artifacts; no change to how downstream repos consume the action (beyond a documented `persist-credentials: false` requirement they already satisfy).
- R7. A file-driven review `APPROVE`/`REQUEST_CHANGES` passes the **same fork / self-authored / head-SHA / TOCTOU guards** that `review-reconciliation` applies today — the change must not remove an approval guard that currently exists.

## Scope Boundaries

- In scope: `pull_request` (review), `issue_comment`, `issues` triggers.
- Non-goal: `workflow_dispatch`/`schedule` credential removal — they keep the credential and current `gh` posting (autonomous creation agency).
- Non-goal: separate-job / separate-runner posting — breaks the action-step consumption contract (see origin). The residual **in-heap** token co-residency it would address is accepted and documented: the action's own Octokit client holds the token in-process (used for context hydration, reactions, and error comments today, created in routing before model execution) and is not removable in-job. This plan closes the *disk + env* readability, not the in-heap co-residency.

### Deferred to Separate Tasks

- `pull_request_review_comment` (inline replies via `createReplyForReviewComment`) and `discussion_comment` (GraphQL): adjacent reactive surfaces not in the confirmed three; each uses a distinct writer. Until addressed they remain autonomous (keep `gh` posting).

## Context & Research

### Relevant Code and Patterns

- **Self-post instructions (to change):** `packages/runtime/src/agent/prompt.ts` (`buildResponseProtocolSection` ~678-709, `buildAgentContextSection` ~204-217, `pull_request` directive ~64-74, `<output_contract>` ~825-834); `packages/runtime/src/agent/prompt-thread.ts` (`buildHarnessRulesSection` line 8 one-comment rule, line 10 "Use `gh` CLI").
- **Credential provisioning — BOTH token-write sites:** `configureGhAuth` (`src/services/setup/gh-auth.ts`: `process.env.GH_TOKEN = token` ~28, `hosts.yml` write ~34-67, `GH_CONFIG_DIR` set ~67) AND the call site `src/services/setup/setup.ts:305` `core.exportVariable('GH_TOKEN', githubToken)` (writes to on-disk `$GITHUB_ENV`) plus `:307` `core.exportVariable('GH_CONFIG_DIR', ...)`. All are same-UID readable and must be gated together.
- **Setup seam:** `runSetup` (`src/services/setup/setup.ts:23`) ← `ensureOpenCodeAvailable` (`packages/runtime/src/agent/server.ts:85`) ← `runBootstrap` (`src/harness/phases/bootstrap.ts:39`) ← `src/harness/run.ts:53`. Bootstrap runs before routing (`run.ts:66`). `github.context.eventName` is available at bootstrap (`src/harness/config/inputs.ts:13` already imports `@actions/github`); `SetupInputs` (`src/services/setup/types.ts:12-26`) has no event field yet — the thread-through point.
- **The finalize post seam (template to reuse):** `src/harness/phases/finalize.ts:60-94` already builds a `CommentTarget` from `routing.agentContext` and posts an LLM-error comment via `postComment` — the shape the file-convention post reuses.
- **Trusted-target derivation:** `getCommentTarget` (`src/services/github/context.ts:232-254`); `routing.agentContext.{repo,issueNumber,issueType}` + `triggerResult.context.eventType` plumbed end-to-end (`src/features/agent/context.ts:39-88`).
- **Octokit writers:** `postComment` (`src/features/comments/writer.ts:193-214`, marker-aware update; **returns `null` on writer failure** — currently fails open); `submitReview` (`src/features/reviews/reviewer.ts:74-128`).
- **Review guards to reuse (R7):** `src/features/reviews/review-reconciliation.ts` — self-authored guard (:150), fork guard (:156), `alreadyApprovedAtHead` idempotency (:177-179), TOCTOU head re-fetch (:230-247), `submitReview` with `commitSha` (:252-264). These guards must wrap any file-driven `APPROVE`.
- **Canonical resolver to mirror:** `src/features/agent/output-mode.ts` (exhaustive `EventType` switch + `assertNever`).
- **Phase order (actual):** `src/harness/run.ts:114-170` runs `execute → review-reconciliation → finalize → cleanup` (the wiki `docs/wiki/Execution Lifecycle.md` is stale — fix in Unit 7). `saveDedupMarker` runs at `run.ts:140` (before finalize — see Risks).
- **Dead-after-change:** `detectArtifacts`/`commentsPosted` URL-scraping (`src/features/agent/streaming.ts:46-78,328-363`).

### Institutional Learnings

- `gh-auth-login-refuses-to-persist-when-gh-token-set-2026-07-10.md` — #1154: a green CI job is not proof the bot posted. Mandate an end-to-end test asserting the **body string + target** reached a real Octokit stub, not "writer called once."
- `thread-id-persistence-gap-in-run-state-2026-07-03.md` + `actions-core-input-env-hyphen-mapping-2026-07-01.md` — test fakes that pre-populate a field mask the real write path. Drive the **real** write path end-to-end; use **name-independent behavioral assertions** (scan child-env *values* for the secret; assert the file *body* reached the writer).
- `same-job-phase-split-not-a-security-boundary-2026-07-04.md` — same-job steps are not a boundary; treat the response file strictly as data passed verbatim to the writer (never `exec`/`eval`/path). Basis for the honest in-heap residual note.
- `comment-only-review-blocked-approval-2026-06-01.md` — the review-reconciliation backstop shape; verdict couples to the review event; re-verify head SHA (TOCTOU).
- `harness-base-version-source-of-truth-2026-06-12.md` + `centralize-s3-key-identity-construction-2026-06-09.md` — the response-file **path + schema are a coordination identity**: export one helper from a single module consumed by both the prompt builder and the reader.
- `effect-failure-channel-discipline-2026-06-10.md` — be explicit about polarity: fail-closed on missing/malformed/4xx, fail-soft (bounded retry) only on transient 5xx/network.

## Key Technical Decisions

- **A two-axis delivery decision object, not a single predicate.** `resolveResponseDelivery(eventName, responseMode)` returns `{ delivery: 'file-convention' | 'model-gh' | 'none', credential: 'withhold' | 'provision' }`. The axes are independent: `pull_request` + `responseMode:none` must still **withhold** the credential (delivery `none`, credential `withhold`) — keying credential suppression on `delivery === 'file-convention'` alone would re-provision the token for a no-post PR run. Credential `withhold` iff the event is an affected trigger (regardless of responseMode); delivery is `file-convention` for affected triggers with a posting responseMode, `none` when `responseMode:none`, `model-gh` for autonomous triggers.
- **Compute once at bootstrap, assert routing agrees.** The raw `eventName` is sufficient to resolve both axes (verified: no eventName maps to both affected and autonomous; `issue_comment` covers both issue and PR comments, both affected). Resolve in bootstrap before setup, thread the decision through `SetupInputs`; after routing, assert `routing.triggerResult.context.eventType` matches the bootstrap classification and fail loudly on divergence (control-plane inconsistency).
- **The decision module lives in `packages/runtime`.** The prompt builder (runtime) and the setup/finalize consumers (root `src/`) both need it; runtime cannot import root `src/*` (layer rule), but root `src/*` imports runtime freely. Place it at `packages/runtime/src/agent/response-delivery.ts`, exported from the runtime index.
- **Response file is outside the checkout, run-scoped, nonce-named, action-created.** Path `$RUNNER_TEMP/fro-bot-response/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/<nonce>.md`, created (and asserted empty) by the action before execution, its path passed to the model via the prompt. This kills the **workspace-preseed attack** (a fork PR committing `.fro-bot/response.md` with `verdict: approve` that finalize would otherwise read when the model writes nothing) and the stale-file-replay risk. The action reads exactly that path — never a workspace glob; fails if the file already exists before execution.
- **Strict allowlist schema, small parser, no YAML dep.** Frontmatter allows only `verdict` and `schemaVersion`; any other key (including `target`/`number`/`repo`/`surface`) is a hard parse error. A tiny purpose-built parser (no broad YAML/anchor/alias resolution) reads it; a body size cap is enforced before posting. Body is posted verbatim, never parsed for a verdict and never `exec`/`eval`/treated as a path.
- **Target/surface/verdict-eligibility bound to `NormalizedEvent`; verdict value from the file.** The reader takes `owner/repo/number/surface` from routing context; only `body` (+ a strict `approve|request-changes` for a PR-review surface) come from the file.
- **Finalize/response-delivery is the single owner of file-convention posting; review-reconciliation skips file-convention runs.** Under the current phase order (reconciliation before finalize) reconciliation already naturally no-ops for affected `pull_request` runs (the model posted no review, so `botReviewsThisRun` is empty → `no-bot-review`). Add an explicit early skip in reconciliation for `delivery==='file-convention'` (clarity + avoids wasted API calls) rather than teaching reconciliation to read the file. Reconciliation stays the legacy model-gh backstop.
- **File-driven `APPROVE`/`REQUEST_CHANGES` reuses the reconciliation guards (R7).** Extract the fork / self-authored / head-SHA / TOCTOU guard set into a shared helper that both the new finalize review-post and the legacy reconciliation call, so a file-driven approve on a fork PR is blocked exactly as today.
- **Fail-closed with a delivery assertion that replaces the `success→0` return.** For file-convention runs, finalize must read/validate/post/assert *before* returning success — the current `execution.success` early return in `finalize.ts` is bypassed for this path. Missing/malformed/invalid file, `postComment === null`, or a writer 4xx → `core.setFailed` naming the file; transient 5xx/network → bounded retry then fail. `responseMode:none` requires **zero** posts and skips the assertion.
- **Dedup marker saved only after confirmed delivery** for affected flows (today `saveDedupMarker` runs at `run.ts:140` before finalize; a failed post followed by a retry could dedup-skip and exit 0 with no post).
- **Consumer requirement:** `actions/checkout` with `persist-credentials: false` (this repo's `fro-bot.yaml:239` already sets it) — documented + asserted (no token in `.git/config` extraheader / remote URL for affected flows) so the checkout credential can't reintroduce a same-UID-readable token.
- **Hard cutover guarded by the delivery assertion**, with Units 3-5 landing atomically (see Implementation Units). Dual-path documented as the softer alternative.

## Open Questions

### Resolved During Planning (by deepening)

- **Credential seam location:** bootstrap, via `eventName` threaded through `SetupInputs` — no normalization needed, no dual-mapping.
- **Double-review risk:** structurally absent under the current phase order (reconciliation runs before finalize and finds no bot review for affected runs); an explicit skip guard is added for clarity.
- **Read timing:** finalize runs strictly after the model session exits; a **synchronously**-written file is guaranteed visible (the prompt must instruct synchronous writes, no backgrounding).
- **Verdict enum translation:** the file's `approve|request-changes` maps to the `submitReview` event directly; the legacy `PASS|CONDITIONAL|REJECT` body-verdict path is untouched (reconciliation-only).

### Deferred to Implementation

- **`CONDITIONAL`-equivalent handling:** the file enum is `approve|request-changes`; confirm a "comment-only review" (no approve/no block) is expressible or intentionally excluded.
- **Metrics source for `commentsPosted`** post-cutover (finalize sets it after the post lands vs retire).

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
bootstrap: resolveResponseDelivery(eventName, responseMode) -> { delivery, credential }
   │            (computed once; routing later asserts eventType agrees)
   ├─ credential === 'withhold'  ──► skip GH_TOKEN env, $GITHUB_ENV export, hosts.yml, GH_CONFIG_DIR
   │  (affected triggers, ANY responseMode)        autonomous triggers ─► provision as today
   │
   ├─ delivery === 'file-convention' ─► prompt: "write <RUNNER_TEMP nonce path> synchronously"
   │        model writes file (outside checkout) ─► finalize/response-delivery:
   │          read exact path (fail if pre-existing) → strict-parse (verdict+schemaVersion only)
   │          → target/surface from NormalizedEvent → body verbatim
   │          → comment: postComment │ review: shared-guards(fork/self/head/TOCTOU) → submitReview
   │          → assert exactly one delivered (else setFailed) → then save dedup → return
   ├─ delivery === 'none' ─► no file, no post, assert zero posts
   └─ delivery === 'model-gh' ─► unchanged (self-post via gh; reconciliation backstop)
```

## Implementation Units

- [ ] **Unit 1: Two-axis delivery resolver (single source of truth, in runtime)**

**Goal:** `resolveResponseDelivery(eventName, responseMode) → {delivery, credential}` — one decision consumed by the credential gate, prompt builder, and finalize.

**Requirements:** R1, R5, R7 (indirectly)

**Dependencies:** None

**Files:**
- Create: `packages/runtime/src/agent/response-delivery.ts` + export from runtime index
- Test: colocated `.test.ts`

**Approach:**
- Exhaustive `switch` on event name (mirror `output-mode.ts` + `assertNever`). `credential: 'withhold'` for `pull_request`/`issue_comment`/`issues` regardless of responseMode; `'provision'` otherwise. `delivery`: `'none'` when `responseMode === 'none'`; else `'file-convention'` for affected, `'model-gh'` for `workflow_dispatch`/`schedule`, `'model-gh'`/deferred for the out-of-scope surfaces.
- Pure; no IO. Must be importable by both runtime (prompt) and root `src/` (setup/finalize).

**Patterns to follow:** `src/features/agent/output-mode.ts`.

**Test scenarios:**
- Happy path: each affected trigger → `{delivery:'file-convention', credential:'withhold'}`; `workflow_dispatch`/`schedule` → `{delivery:'model-gh', credential:'provision'}`.
- Edge case (the trap): `pull_request` + `responseMode:'none'` → `{delivery:'none', credential:'withhold'}` (credential still withheld).
- Edge case: exhaustiveness guard trips for an unhandled event name (compile-time).

- [ ] **Unit 2: Response-file — out-of-checkout path helper, strict schema, validating reader**

**Goal:** One module owning the run-scoped `$RUNNER_TEMP` path and a strict parse/validate returning `{body, verdict?}`.

**Requirements:** R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Create: `packages/runtime/src/agent/response-file.ts` (path helper + `parseResponseFile`) + test

**Approach:**
- Path: `$RUNNER_TEMP/fro-bot-response/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/<nonce>.md`, single exported helper consumed by the prompt text and the reader. **Outside the checkout.**
- `parseResponseFile(raw, {surface})` → `Result`: allowlist frontmatter keys `{verdict?, schemaVersion}` only; **any other key is a hard error** (incl. target/number/repo/surface); `verdict` is a strict `'approve'|'request-changes'` present only for `pr-review` surface; body-size cap; small purpose-built parser (no YAML anchors/aliases/merge/type-resolution). Pure string→Result; no filesystem/network/exec.
- Body is opaque text — never scanned for a verdict.

**Patterns to follow:** existing `Result<T,E>` parse guards (operator-contract `parse.ts` shape).

**Test scenarios:**
- Happy path: body-only for a comment surface → `{body}`; body + `verdict: approve` for `pr-review` → `{body, verdict:'approve'}`.
- Security (R3): file with `number: 999` / `repo: other/x` / `surface:` / any unknown key → hard error; result never carries a target field; a body containing "PASS"/"approved" prose with `verdict: request-changes` → parsed verdict is `request-changes` (body never consulted).
- Error path: missing/empty → typed error; malformed frontmatter → error; verdict on a comment surface → error; unknown verdict value → error; oversize body → error.

- [ ] **Unit 3: Credential suppression (BOTH token-write sites) — [ATOMIC CUTOVER with Units 4-5]**

**Goal:** For affected triggers, withhold the token everywhere the child can read it; unchanged for autonomous triggers.

**Requirements:** R1, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/services/setup/gh-auth.ts` (`process.env.GH_TOKEN` ~28, `hosts.yml` ~34-67, `GH_CONFIG_DIR` ~67), `src/services/setup/setup.ts` (`core.exportVariable('GH_TOKEN')` :305 and `GH_CONFIG_DIR` :307), `src/services/setup/types.ts` (`SetupInputs` + `credential` axis), `packages/runtime/src/agent/server.ts` (thread the field)
- Test: `src/services/setup/gh-auth.test.ts`, `src/services/setup/setup.test.ts`

**Approach:**
- Thread `credential: 'withhold' | 'provision'` (from Unit 1, computed at bootstrap from `eventName`) into setup. On `withhold`: skip `process.env.GH_TOKEN`, skip **both** `core.exportVariable('GH_TOKEN')` (the `$GITHUB_ENV` write) and `GH_CONFIG_DIR`, and skip the `hosts.yml` write. The action's own in-process Octokit client (routing) is unaffected.
- Also: for affected flows, a **checkout-credential preflight/assert** — no `http.*.extraheader` or embedded-credential remote URL in `.git/config`/submodule configs (relies on the documented `persist-credentials: false`; assert to catch a consumer that omits it).

**Execution note:** Characterize the *current* provisioning first (what env/files/`$GITHUB_ENV` the child gets today), then gate — so the autonomous path is provably unchanged.

**Test scenarios:**
- Happy path (affected): after setup, a name-independent scan of the simulated child env **values** finds no token; no `hosts.yml`; `$GITHUB_ENV` (pointed at a temp file) contains no token value; no `GH_CONFIG_DIR` export.
- Happy path (autonomous): `workflow_dispatch`/`schedule` → token present, `hosts.yml` written, `$GITHUB_ENV` export present — characterization parity.
- Security: with `persist-credentials:false`, `.git/config` has no extraheader/embedded token for affected flows (assert); a fixture with an extraheader fails the preflight.
- Regression (R6): #1147 env-scrub still holds.

- [ ] **Unit 4: Response Protocol prompt rewrite (per-delivery) — [ATOMIC CUTOVER with Units 3, 5]**

**Goal:** For `file-convention` delivery, instruct the model to write the file **synchronously** at the exact path and state `gh` is unavailable; `model-gh` keeps current instructions; `none` renders neither.

**Requirements:** R2, R4

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `packages/runtime/src/agent/prompt.ts` (response-protocol, agent-context, `pull_request` directive, `<output_contract>`), `packages/runtime/src/agent/prompt-thread.ts`
- Test: `packages/runtime/src/agent/prompt.test.ts`

**Approach:**
- Gate the Response Protocol text on the Unit 1 `delivery` value. File-convention: the exact path (Unit 2 helper), the body/verdict schema, **write synchronously — do not background the write** (`&`/`nohup`/`disown` risk a partial read), and that `gh` is unavailable (a `gh` call will fail — write the file instead). Keep one-comment/one-review framing; the verdict becomes a `verdict:` frontmatter field. Reference Unit 2's schema (don't restate).

**Test scenarios:**
- Happy path: affected triggers → prompt contains the write-file+path+synchronous instruction and no `gh pr review`/`gh issue comment` posting instruction.
- Happy path: `workflow_dispatch`/`schedule` → `gh` posting instructions unchanged.
- Edge: `responseMode:none` → neither file nor `gh` posting instruction.
- Regression: `<!-- fro-bot-agent -->` marker + Run Summary guidance survive.

- [ ] **Unit 5: Finalize response-delivery — post, guard, assert, reconciliation skip — [ATOMIC CUTOVER with Units 3-4]**

**Goal:** Read/validate/post with trusted-context binding, apply review guards, fail-closed with a delivery assertion, and make reconciliation skip file-convention runs.

**Requirements:** R2, R3, R4, R7

**Dependencies:** Unit 1, Unit 2

**Files:**
- Create: `src/features/agent/response-post.ts` (read-validate-post orchestration) + test; extract shared review-guard helper (from `review-reconciliation.ts`) into a reusable module + test
- Modify: `src/harness/phases/finalize.ts` (or a new `runResponseDelivery` invoked before finalize's success return), `src/harness/run.ts` (dedup-after-delivery; assert routing agrees with bootstrap classification), `src/harness/phases/review-reconciliation.ts` (early skip on `delivery==='file-convention'`)
- Test: `src/harness/phases/finalize.test.ts`, `src/features/agent/response-post.test.ts`, shared-guard test

**Approach:**
- For `file-convention` runs: resolve the Unit 2 path, **fail if it pre-exists** before execution, read it, `parseResponseFile` with the surface from routing context. Build target from `routing.agentContext` (as `finalize.ts:60-74`). Append `<!-- fro-bot-agent -->`. Comment → `postComment`; PR-review verdict → **shared guards (fork/self/head-SHA/TOCTOU)** then `submitReview({event, commitSha: head})`.
- Fail-closed: missing/malformed/invalid, `postComment===null`, or writer 4xx → `core.setFailed` naming the file; transient 5xx/network → bounded retry then fail. **Replace the `execution.success → return 0` early path** for file-convention so the assertion always runs. Delivery assertion: exactly one response posted (zero for `none`); absence fails the run.
- Reconciliation: add an early skip for `delivery==='file-convention'` (reason `finalize-owns-response`); legacy `model-gh` path unchanged.
- Dedup: move `saveDedupMarker` for affected flows to after confirmed delivery.

**Execution note:** Start with a failing end-to-end test: real `parseResponseFile` + real `postComment`/`submitReview` (real shared-guard helper) against a stubbed Octokit asserting the **exact body + target + event**; a missing file must fail the run.

**Test scenarios:**
- Happy path: valid comment file → `postComment` with file body + routing target; valid `verdict: request-changes` → `submitReview({event:'REQUEST_CHANGES'})`.
- Security (R3/R7): embedded `number:999` rejected (Unit 2), post targets the routing number; a **fork PR + `verdict: approve`** does NOT submit an approve (shared fork guard); a valid file pre-existing before execution → run fails (preseed guard).
- Error path (R4): missing file → non-zero exit naming the file (#1154 guard); `postComment===null` → fail-closed; writer 5xx → retried then fail; `execution.success===true` + missing file → non-zero.
- Edge: `responseMode:none` → no read, no post, assertion expects zero; dedup marker not saved when delivery fails.
- Integration: real write-path (fixture file in a temp `$RUNNER_TEMP`, real finalize read → stubbed Octokit asserting body+target), not a pre-seeded parse result; re-review (second invocation, fresh nonce path) → one new review, reconciliation does not double-submit.

- [ ] **Unit 6: Retire dead artifact-scraping for affected flows + metrics**

**Goal:** Remove/neutralize the `gh`-output URL scraping that no longer fires for affected flows; re-source the posted-comment metric.

**Requirements:** R6

**Dependencies:** Unit 5

**Files:**
- Modify: `src/features/agent/streaming.ts` (comment-URL branches of `detectArtifacts`/`detectArtifactsFromMessageParts`), `src/features/agent/execution.ts` (metric wiring)
- Test: `src/features/agent/streaming.test.ts`

**Approach:** For affected flows there is no `gh` command to scrape; source `commentsPosted` from the finalize post (set after it lands) or retire it for those flows. Keep autonomous-flow scraping intact.

**Test scenarios:**
- Happy path: affected flow → metric reflects the finalize post.
- Regression: autonomous flow → scraping/counters unchanged (characterization parity).

- [ ] **Unit 7: End-to-end verification, docs, cutover**

**Goal:** Prove end-to-end posting on a real PR and real issue with the credential withheld; guard the #1154 class; fix stale docs. **The critical E2E/no-response tests ship in the atomic cutover, not later.**

**Requirements:** R1, R2, R4, R5, R7

**Dependencies:** Units 1-6

**Files:**
- Modify: `ARCHITECTURE.md` (Invariant 5 now action-enforced for affected flows), `docs/wiki/Execution Lifecycle.md` (phase-order fix), consumer docs (`persist-credentials: false` requirement)
- Test: an integration test exercising the full affected-flow path end-to-end

**Approach:** Hard cutover guarded by the delivery assertion. Verify a real `pull_request` review + a real `issue_comment`/`issues` comment post correctly with no child credential; verify a `workflow_dispatch` run still posts/creates as before; verify a fork PR is not auto-approved.

**Test scenarios:**
- Integration: affected run posts exactly one comment/review; child env has no token value.
- Integration: autonomous run unchanged; fork PR not approved.
- Error path: model writes nothing → run fails loudly (not green).

**Verification:** Real PR review + real issue comment posted by the action with the credential withheld; a real dispatch run unaffected; the delivery assertion fails a no-response run; a fork PR gets no auto-approve.

## System-Wide Impact

- **Interaction graph:** setup (credential, both write sites), prompt build, finalize/response-delivery, review-reconciliation (skip guard + shared guard helper), streaming metrics, dedup ordering. The resolved delivery decision is the shared seam — computed once at bootstrap, threaded, asserted against routing.
- **Error propagation:** fail-closed on missing/malformed/4xx/`postComment===null`; fail-soft (bounded retry) only on transient 5xx/network; `none` expects zero posts.
- **State lifecycle risks:** response file is action-created outside the checkout, run+attempt+nonce scoped, asserted-empty-before-execution (preseed + stale-replay closed); dedup marker saved only after confirmed delivery.
- **API surface parity:** `workflow_dispatch`/`schedule` and the deferred surfaces retain current behavior — regression-guarded. The shared review-guard helper must not change legacy reconciliation behavior.
- **Unchanged invariants:** the action's own in-process Octokit token (hydration, reactions, error comments) — the accepted in-heap residual; delegated branch/commit/PR Octokit path; the #1147 env-scrub and `filter-env` allowlist; bot-authored-event skip (loop prevention) — add a regression test.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **Workspace-preseeded response file → attacker-driven auto-approve/comment** | File lives in `$RUNNER_TEMP` (outside checkout), nonce-named, action-created, asserted-empty-before-run; action never reads from the workspace |
| **Second token copy in `$GITHUB_ENV` via `setup.ts:305`** | Unit 3 gates BOTH `gh-auth.ts` writes AND `core.exportVariable('GH_TOKEN')`/`GH_CONFIG_DIR`; value-scan test over `$GITHUB_ENV` |
| **File-driven `APPROVE` bypasses fork/self guards that exist today (R7)** | Shared guard helper (fork/self/head-SHA/TOCTOU) wraps the finalize review-post; fork-PR + `verdict:approve` → no approve test |
| **Checkout persists a same-UID-readable token in `.git/config`** | Documented `persist-credentials:false` consumer requirement (repo already sets it) + preflight assertion for affected flows |
| **Silent no-post (green job) — the #1154 class** | Delivery assertion replaces `success→0`; `postComment===null`/writer-error fail-closed; dedup-after-delivery; explicit no-response test |
| **Body as a second verdict channel / injection** | Only structured `verdict` drives the review event; body posted verbatim, never parsed/exec'd; allowlist schema rejects unknown keys |
| **Intermediate broken state during cutover** | Units 3-5 (+ critical E2E tests) land atomically; Units 1-2 land inertly first; Unit 6 follows |
| **Bootstrap vs routing classification drift** | Resolve once at bootstrap; assert `routing.eventType` agrees, fail loudly on mismatch |
| **Async/backgrounded model write → partial read** | Prompt mandates synchronous write; finalize reads only after session exit |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-11-remove-agent-github-credential-requirements.md](../brainstorms/2026-07-11-remove-agent-github-credential-requirements.md)
- Issue: fro-bot/agent#1167 (in-repo residual of #1147)
- Related code: `src/harness/phases/finalize.ts`, `src/harness/phases/review-reconciliation.ts`, `src/services/setup/gh-auth.ts`, `src/services/setup/setup.ts`, `packages/runtime/src/agent/prompt.ts`, `src/features/comments/writer.ts`, `src/features/reviews/reviewer.ts`, `src/features/agent/output-mode.ts`
- Learnings: `docs/solutions/workflow-issues/gh-auth-login-refuses-to-persist-when-gh-token-set-2026-07-10.md`, `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md`, `docs/solutions/workflow-issues/comment-only-review-blocked-approval-2026-06-01.md`
