---
title: "feat: Brokered push for trusted same-repo mention runs"
type: feat
status: active
date: 2026-07-30
deepened: 2026-07-30
origin: docs/brainstorms/2026-07-30-brokered-push-trusted-mention-requirements.md
---

# feat: Brokered push for trusted same-repo mention runs

## Overview

On a trusted same-repo PR mention (`issue_comment` on a PR by an `OWNER`/`MEMBER`/`COLLABORATOR`) the agent runs with its GitHub credential withheld, so it can make a fix but has no way to deliver it. This plan adds a post-run brokered push: the action reconstructs the model's file changes from the checked-out workspace (net difference against a trusted head SHA), validates them against an allowlist, and writes them to the PR head branch as a fresh bot-authored commit through the existing Git Data API path. No push credential ever reaches the model's shell. Ineligible contexts bypass silently to normal comment delivery; a genuine delivery attempt that fails is fail-loud with a single error comment.

## Problem Frame

Since PR #1170 / issue #1167, affected-trigger runs withhold the credential from the agent child and fail-close at bootstrap if the checkout carries a persisted git credential (see origin: `docs/brainstorms/2026-07-30-brokered-push-trusted-mention-requirements.md`). This is correct for untrusted comment input, but it also strands the trusted case: an `OWNER`/`MEMBER`/`COLLABORATOR` mentioning the bot on a same-repo non-fork PR gets a local change the run cannot push. The safe write primitive (`src/features/delegated/commit.ts`) already exists and never shells out; it is simply not wired to the mention path.

**Eligible surface (verified against source):** `.github/workflows/fro-bot.yaml` subscribes to `issue_comment`, `pull_request_review_comment`, `discussion_comment`, `issues`, `schedule`, `workflow_dispatch` — not `pull_request`. `classifyEvent` (`packages/runtime/src/agent/response-delivery.ts:30-44`) withholds the credential only for `issue_comment`/`issues`/`pull_request`. Of those, only `issue_comment` where `issue.pull_request != null` has both a withheld credential and a PR head branch. So brokered push is scoped to exactly that one surface. `issues` has no PR head; `pull_request` is not subscribed; `pull_request_review_comment` is credential-provisioned (`deferred-or-unknown`), so it already pushes via `gh` and is not stranded.

## Requirements Trace

- R1. A trusted same-repo PR mention run delivers file changes to the PR head branch with no push credential in the model's shell or environment.
- R2. The push is performed by the action after the run via the Git Data API (build tree, create commit, update ref) as a fresh bot-authored commit rebuilt from the model's changes — not by the model process.
- R3. The push target (owner, repo, head branch) is derived from trusted event context and live GitHub state, never from model output or model-controlled workspace metadata.
- R4. Delivery is allowed only when same-repo, non-fork, PR-context, and the actor's association is `OWNER`/`MEMBER`/`COLLABORATOR`, confirmed by a live collaborator-permission check at delivery time (event-time association is an early gate only).
- R5. The change set is validated before push against a path allowlist (product/docs/test paths only); everything else is denied. Only regular files may be written or deleted. Validation is path/type/size integrity only, not semantic content safety. Never force-push.
- R6. An ineligible context (non-PR, fork, unauthorized actor, missing trusted head SHA, `responseMode: none`, non-`file-convention` delivery) bypasses the push and delivers normally — it is not a failed run. `workflow_dispatch`/`schedule` behavior is unchanged.
- R7. Delivery rebuilds one commit from the net file difference between the checked-out workspace and the trusted head SHA. No net difference is the only "nothing to deliver" case.
- R8. An eligible change whose branch write is rejected or partially fails reports delivery failure and fails loud — never downgraded to "nothing to deliver" or success. A created commit object is never reported as delivered unless the ref update succeeds.
- R9. If the PR head advanced so the write cannot apply without force, the run fails with a clear reason rather than force-pushing or rebasing.
- R10. The run's single response states whether a push occurred and what branch it targeted, consistent with one-response-per-invocation.
- R11. Immediately before writing, the action re-resolves full PR identity from live GitHub state — PR open, same base repo, same head repo full name, same head branch, head SHA equal to the trusted anchor, not forked/retargeted/renamed/closed. Any mismatch fails with a clear reason.

## Scope Boundaries

- Option 2 from #1297 (opt-in on-disk push credential) is rejected — it reopens the same-UID disk/env residual #1167 removed.
- No agent-invokable push tool in v1 (RFC-018 is a later evolution); the model uses ordinary edits and the action reconstructs and pushes.
- Push targets the existing same-repo PR head branch only.
- No auto-rebase, auto-retry, or conflict resolution when the head moves mid-run; v1 fails loud.
- v1 pushes only to allowlisted product/docs/test paths. Config, scripts, CI, and execution-surface files are out of scope for brokered push.
- Content-level trust of the model's changes is out of scope: the authorization gate is a human trust decision, not a code-safety guarantee; R5 is path/type/size integrity only.

### Deferred to Separate Tasks

- Maintainer-reviewed per-path opt-in to widen the allowlist (config/script fixes): future iteration.
- Opening a new PR from a fresh branch, and acting on non-PR mentions: future iteration.
- Agent-invokable delegated-work tool (RFC-018): future iteration.

## Context & Research

### Relevant Code and Patterns

- `src/features/delegated/commit.ts` — `createCommit(octokit, {owner, repo, branch, message, files, author?}, logger)`: `validateFiles` → `getRef(heads/${branch})` → `getCommit` → `createBlob` per file → `createTree({base_tree, tree})` → `createCommit({parents:[tip]})` → `updateRef(force:false)`. Derives base tree + parent from the branch tip. Handles add/modify only, hardcodes tree mode `100644` (`:122-126`) — no deletion path, no mode/type handling.
- `src/features/delegated/commit.ts:173-202` — `getFileContent`: base64 decode convention (`Buffer.from(data.content, 'base64')`). Reuse for content encoding, not a second shape.
- `src/features/delegated/types.ts:11-17,122-135` — `FileChange {path, content, encoding?}`, `FILE_VALIDATION` (5 MiB cap, forbidden files/exts). No deletion field.
- `src/harness/phases/finalize.ts:94-224` — delivery coordinator: outputs/summary → quota branch (`:113-134`, skips response post) → provider-auth branch (`:136-157`, skips response post) → `file-convention` branch (`:163-197`, asserts `responseFilePath`, `runResponsePost`, fallback gated on `execution.success===false && commentsPosted===0`) → primary-failure preservation (`:202-220`). `resolveCommentTarget` (`:30-46`) derives target from `routing.agentContext` + event type. `resolveResponseDelivery` returns `delivery:'none'` for `responseMode:none` even on affected triggers (`response-delivery.ts:90-98`).
- `src/features/reviews/review-guards.ts` — `checkForkOrSelfGuard` (`:59-88`, reads `head.repo.full_name`/`base.repo.full_name`/`head.sha`/`user.login`), `submitReviewWithHeadGuard` (`:122-138`, re-fetches head SHA before write). Partial precedent for R11 — head-SHA only; the push gate needs the fuller identity check.
- `src/features/triggers/author-utils.ts:3-5` — `isAuthorizedAssociation(association, allowed)`, the shared association inclusion check (early gate only).
- `src/services/github/context.ts` — `normalizeEvent`: `authorAssociation` from `comment.author_association` (`issue_comment`), etc.
- `src/services/setup/types.ts:144-146`, `src/services/setup/adapters.ts:15-19` — `ExecAdapter` (`exec`/`getExecOutput`) + `createExecAdapter()`. Tests fake it via a local `createMockExecAdapter` (`git-credential-check.test.ts:7-12`). No project-wide FS adapter; tests mock `node:fs/promises` directly.
- `src/harness/phases/bootstrap.ts:121-127` / `execute.ts:45-62` / `finalize.ts:163-176` — `responseFilePath` threaded on `BootstrapPhaseResult`: the exact pattern for threading the trusted head SHA.
- `src/harness/config/inputs.ts:203-443`, `packages/runtime/src/shared/types.ts:72-106` — `parseActionInputs` + `ActionInputs`: the input seam for a new `trusted-head-sha`.
- `.github/workflows/fro-bot.yaml` (prehead step, ~207-237) — computes a same-repo PR head ref for `issue_comment`/`pull_request_review_comment` with `persist-credentials:false`. Source of the trusted head SHA.
- `src/harness/phases/routing.ts` / `src/harness/run.ts` — `routing.githubClient = createClient({token: bootstrap.inputs.githubToken})`; the action retains an in-heap Octokit even when the child env is scrubbed.

### Institutional Learnings

- `docs/solutions/best-practices/response-file-is-untrusted-input-2026-07-11.md` — target/surface from trusted event context only, never model output; delivery mode separate from credential provisioning; fail closed on missing/malformed. Governs R3/R10.
- `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md` — earlier untrusted model steps can poison env/files/git-config in the same job; the reconstruction reads a workspace the model just controlled, so it must not trust local git config/HEAD/origin/hooks and must derive the target from live API only.
- `docs/solutions/logic-errors/injected-deny-blocks-own-delivery-path-2026-07-13.md` — security controls compose; the new write path must be proven against existing deny rules and on consumer-like config, not just the home repo.
- `docs/solutions/workflow-issues/fork-review-guard-gates-approve-only-2026-07-11.md` — gate the risky outcome precisely; fork/self precedent for the authorization gate.

## Key Technical Decisions

- **Eligible surface is `issue_comment`-on-PR only:** the sole event that is both credential-withheld and PR-bound. Reconstruction/push never runs for `issues`, `pull_request_review_comment`, `discussion_comment`, dispatch, or schedule.
- **Path allowlist, not denylist:** brokered push permits only product/docs/test paths (`src/**`, `packages/*/src/**`, `docs/**`, top-level `README.md`/`ARCHITECTURE.md`/`STRUCTURE.md`, package test paths). Everything else — root dotfiles/configs, `.github/**`, `scripts/**`, `deploy/**`, `.husky/**`, `Dockerfile*`, `Makefile`, `*.sh`, manifests/lockfiles, build/lint/release configs — is denied by default. A denylist can't enumerate every execution surface; the allowlist closes the whole class.
- **Regular files only:** only mode `100644` blobs may be added/modified and only regular tracked files deleted. Reject `120000` symlinks, `160000` gitlinks/submodules, `100755` executables, mode-only changes, and type changes. Prevents symlink dereference, submodule tricks, and privilege-escalation via mode bits.
- **Net-tree-diff over commit parsing:** reconstruct `FileChange[]` from the net difference between the checked-out workspace and the trusted head SHA, not the model's commit graph. Immune to the model committing on another branch, amending, rebasing, or detached HEAD. The trusted head SHA (a captured input, not model output) anchors the diff; reconstruction neutralizes local git config and never uses local `origin`/HEAD/branch for the target.
- **One aggregate commit:** fold the net difference into a single fresh bot-authored commit; do not replay multiple model commits.
- **Reuse `createCommit`, extend for deletions + mode policy:** delivery calls the existing primitive; it gains a deletion path (`sha:null` tree entries) and enforces regular-file mode.
- **Brokered-push-specific validation, never global:** the allowlist + regular-file rules live in a brokered-push validation wrapper used only by the push path. Global `validateFiles` is unchanged, so dispatch/schedule delegated commits keep today's behavior.
- **Finalize sequencing is precise:** the push runs only inside the `bootstrap.delivery === 'file-convention'` branch, after the quota and provider-auth branches have returned, after `responseFilePath` is verified, and only when `execution.success === true` and `execution.commentsPosted === 0`. It is skipped entirely for quota/auth/failed-execution/non-file-convention/`responseMode:none`/already-posted states.
- **Ineligible = silent bypass; only attempts fail loud:** unauthorized/fork/non-PR/missing-anchor/nothing-to-deliver bypass the push and deliver the model reply normally. Only a genuine eligible delivery attempt that fails (validation-rejected, target-invalid, head-moved, push-rejected, partial-failure) suppresses the reply, posts one error comment, and fails the run.
- **Trusted head SHA is an explicit action input:** added to `action.yaml`/`ActionInputs`/`parseActionInputs` and threaded on `BootstrapPhaseResult` like `responseFilePath`. Empty for fork/non-PR → push bypassed by construction.
- **Delivery-time live permission re-check:** before reconstruction, verify the triggering actor currently has write/collaborator permission via the GitHub API. Event-time association is an early filter; a maintainer can lose access between trigger and finalize. Unavailable/403/ambiguous → fail loud, no push.
- **Full pre-write live gate + `force:false` backstop:** re-resolve PR open/base/head/branch/SHA immediately before write; `force:false` is the authoritative race backstop. Live re-resolve reduces stale-target writes but cannot eliminate the create-commit→ref-update window; treat `updateRef` rejection as expected and fail loud.

## Open Questions

### Resolved During Planning

- Change reconstruction (origin deferred): net-tree-diff of the workspace against the trusted head SHA; contents read from disk, UTF-8 or base64 by detection; regular files only.
- Multi-commit handling (origin deferred): folded into one aggregate commit for v1.
- Author-association source (origin deferred): normalized `authorAssociation` as an early gate, plus a live collaborator-permission check at delivery time.
- Path policy (origin security decision): allowlist (confirmed with the user), superseding the earlier denylist framing.
- Trusted head SHA wiring (origin deferred): explicit `trusted-head-sha` action input parsed in bootstrap and threaded on `BootstrapPhaseResult`.
- Delivery sequencing (origin deferred): push inside the `file-convention` branch, after quota/auth, before `runResponsePost`, gated on success + no prior comment; result folded into the single response.

### Deferred to Implementation

- Exact conventional commit message text for the aggregate commit.
- Exact format of the push-result footer folded into the response body, and the composition seam (augment `runResponsePost` input vs wrap the response-body read).
- Exact git invocation/flags used to compute the net diff while neutralizing local config.

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

Delivery decision inside the finalize `file-convention` branch (eligible surface only):

```
finalize: after outputs/summary
  quota-exceeded / provider-auth error → skip push entirely (existing behavior)
  delivery !== 'file-convention'        → skip push (normal path)
  execution.success === false           → skip push, preserve primary failure
  commentsPosted > 0                     → skip push (one-response invariant)
  file-convention + success + no comment:
     eligibility gate (issue_comment-on-PR, same-repo, non-fork,
       trusted association, live collaborator permission, anchor present)
         not eligible → BYPASS: post model reply normally (not a failure)
     net diff (workspace vs trusted head SHA)
         empty → nothing-to-deliver → post model reply normally
     brokered-push validation (allowlist + regular-file + size)
         reject → FAIL-LOUD (one error comment, setFailed)
     live pre-write gate (PR open/base/head/branch/SHA==anchor)
         mismatch → FAIL-LOUD
     createCommit (aggregate tree incl. deletions) + updateRef(force:false)
         422 / partial → FAIL-LOUD (never report unreachable commit as delivered)
         ok → push-success → fold footer into model reply → runResponsePost once
```

## Implementation Units

- [ ] **Unit 1: Extend the delegated commit primitive for deletions and regular-file mode policy**

**Goal:** `createCommit` can remove files and enforces regular-file-only entries, so a reconstructed change set writes a correct, safe tree.

**Requirements:** R2, R5, R7

**Dependencies:** None

**Files:**

- Modify: `src/features/delegated/types.ts` (deletion representation on `FileChange`/sibling)
- Modify: `src/features/delegated/commit.ts` (deletion tree entries `sha:null`; enforce mode `100644`; reject non-regular)
- Test: `src/features/delegated/commit.test.ts`

**Approach:**

- Represent a deletion distinctly (implementer picks the cleanest type shape). Deletion paths still run through validation.
- Tree assembly: deletions pass `{path, mode:'100644', type:'blob', sha:null}`; content entries keep the blob-create flow at mode `100644`. Reject any entry that would require `120000`/`160000`/`100755`.

**Patterns to follow:** existing `createTree`/`createBlob` flow; `validateFiles`.

**Test scenarios:**

- Happy path: modify + delete in one change set → tree has a blob entry and a `sha:null` entry; `updateRef` `force:false`.
- Edge case: delete-only change set → valid non-empty tree and commit.
- Edge case: deletion whose path hits a forbidden pattern → rejected.
- Error path: an entry marked symlink/gitlink/executable/mode-change → rejected before any API call.
- Error path: deletion of a path absent from the base tree → surfaces the API error, not silent success.

**Verification:** deletions and modifications co-exist in one commit; non-regular entries rejected; existing add/modify tests still pass; `force:false` preserved.

- [ ] **Unit 2: Change-reconstruction bridge (workspace → FileChange[])**

**Goal:** Turn the net difference between the checked-out workspace and the trusted head SHA into a validated `FileChange[]` (adds, modifies, deletes), branch- and history-agnostic, trusting no local git metadata.

**Requirements:** R7, R2, R3

**Dependencies:** Unit 1

**Files:**

- Create: `src/features/delegated/reconstruct-changes.ts`
- Test: `src/features/delegated/reconstruct-changes.test.ts`

**Approach:**

- Take an injected `ExecAdapter` (do not instantiate it internally — harness passes `createExecAdapter()`), the trusted head SHA anchor, and a repo root. Compute the net path-status set (added/modified/deleted) of the working tree against the anchor SHA using git invocation that neutralizes repo-local config; do not read local `origin`/HEAD/branch for target or base.
- Read added/modified contents from disk; detect non-UTF-8 → base64 (reuse the `getFileContent` decode convention). Reject symlinks/gitlinks/non-regular entries here too (defense-in-depth with Unit 1).
- Empty net difference → explicit "nothing to deliver" signal (no empty commit). Missing/malformed anchor → explicit bypass signal.

**Execution note:** Start with a failing test for the diff→FileChange[] mapping (add/modify/delete + base64 + non-regular rejection) using a faked `ExecAdapter` and mocked `node:fs/promises`.

**Patterns to follow:** `ExecAdapter` seam (`src/services/setup/adapters.ts`, faked via `createMockExecAdapter`); `FileChange`/base64 from `commit.ts`/`types.ts`.

**Test scenarios:**

- Happy path: one added + one modified file vs anchor → two `FileChange` entries, correct encoding.
- Happy path: a deleted file vs anchor → one deletion entry.
- Edge case: no difference → "nothing to deliver", no entries.
- Edge case: binary/non-UTF-8 added file → `encoding:'base64'`.
- Edge case: model committed on another branch / amended / detached HEAD → net diff vs anchor still reflects the true workspace difference.
- Edge case: a symlink or submodule/gitlink change → rejected, not dereferenced.
- Error path: malformed/missing anchor SHA → bypass signal surfaced to caller.

**Verification:** correct `FileChange[]` for add/modify/delete regardless of the model's local git state; non-regular entries rejected; clean "nothing to deliver" on no difference; no reliance on local git config for target/base.

- [ ] **Unit 3: Brokered-push allowlist validation**

**Goal:** A brokered-push-specific validation that admits only allowlisted product/docs/test paths, on top of the existing size/sensitive rules — without touching global `validateFiles`.

**Requirements:** R5

**Dependencies:** None

**Files:**

- Create: `src/features/delegated/brokered-push-validation.ts`
- Test: `src/features/delegated/brokered-push-validation.test.ts`

**Approach:**

- Compose `validateFiles` (path traversal, size, sensitive files) with an allowlist gate: permit `src/**`, `packages/*/src/**`, `docs/**`, top-level `README.md`/`ARCHITECTURE.md`/`STRUCTURE.md`, and package test paths; deny everything else. Applies to both added/modified and deleted paths.
- This wrapper is called only by the brokered-push finalize path; global `validateFiles` is unchanged.

**Execution note:** Test-first — pin allowed and denied path classes before implementing.

**Patterns to follow:** forbidden-pattern arrays in `types.ts`; `validateFilePath` structure.

**Test scenarios:**

- Happy path: `src/foo.ts`, `packages/runtime/src/x.ts`, `docs/y.md`, `README.md` pass.
- Error path: `.github/workflows/ci.yaml`, `Makefile`, `Dockerfile`, `scripts/x.sh`, `.husky/pre-commit`, `.npmrc`, `.mise.toml`, `deploy/x`, `package.json`, `bun.lock`, `tsconfig.json` rejected.
- Error path: a deletion of a denied path rejected.
- Edge case: a path traversal / sensitive file still rejected by the composed `validateFiles`.
- Integration: existing dispatch/schedule delegated-commit callers unaffected (they never call this wrapper).

**Verification:** only allowlisted paths pass; global delegated-commit behavior unchanged.

- [ ] **Unit 4: Brokered-push authorization + target derivation gate**

**Goal:** A gate that decides, from trusted event context and live GitHub state only, whether a brokered push is allowed and what branch it targets — with an event-time early filter and a delivery-time live check.

**Requirements:** R3, R4, R6, R11

**Dependencies:** None

**Files:**

- Create: `src/features/delegated/brokered-push-gate.ts`
- Test: `src/features/delegated/brokered-push-gate.test.ts`

**Approach:**

- **Early gate (event-derived):** eligible only when `issue_comment` with `issue.pull_request != null`, same-repo, non-fork, `authorAssociation` in OWNER/MEMBER/COLLABORATOR (via `isAuthorizedAssociation`), and a trusted head SHA anchor is present. Any miss → not eligible (bypass, not failure).
- **Delivery-time live check:** verify the actor currently has write/collaborator permission (`repos.getCollaboratorPermissionLevel` or equivalent); unavailable/403/ambiguous → fail loud.
- **Pre-write live gate:** re-fetch the PR immediately before write; require open, same base repo, same head repo full name, same head branch, head SHA == anchor, not fork/retargeted/renamed/closed. Validate `head.ref` against git refname rules and use it only after confirming same-repo. No value derived from model output or workspace metadata.

**Patterns to follow:** `checkForkOrSelfGuard`/`submitReviewWithHeadGuard` (head-SHA precedent, extended); `isAuthorizedAssociation`; event derivation in `context.ts`.

**Test scenarios:**

- Happy path: `COLLABORATOR` on same-repo non-fork PR, anchor present, live permission write → eligible, target = PR head branch.
- Bypass: association `NONE` / non-PR `issue_comment` / `issues` / fork head / missing anchor → not eligible (no push, no failure).
- Fail-loud: event-time association allowed but live collaborator permission removed/unknown → fail loud.
- Fail-loud: live re-resolve finds head advanced (SHA != anchor) / PR closed / retargeted / renamed / fork-changed → invalid.
- Error path: malformed/ambiguous `head.ref` → rejected.
- Integration: association read only from normalized event, never a model-supplied field; target never from workspace `origin`/HEAD.

**Verification:** admits exactly the trusted same-repo PR case with live write permission and a matching live head; every other context bypasses or fails per policy, using only event-derived + live GitHub state.

- [ ] **Unit 5a: Brokered-push finalize state machine**

**Goal:** finalize runs the brokered-push decision for the eligible surface and returns a typed outcome, with precise sequencing against existing branches and no response mutation yet.

**Requirements:** R1, R2, R6, R8, R9

**Dependencies:** Units 1-4

**Files:**

- Modify: `src/harness/phases/finalize.ts`
- Modify: `src/harness/phases/bootstrap.ts`, `src/harness/config/inputs.ts`, `packages/runtime/src/shared/types.ts`, `action.yaml` (thread `trusted-head-sha`)
- Test: `src/harness/phases/finalize.test.ts`

**Approach:**

- Add the push step only inside the `file-convention` branch, after quota/provider-auth branches return, after `responseFilePath` is verified, and only when `execution.success === true` and `execution.commentsPosted === 0`. Skip entirely for every other state (quota, auth, failed execution, non-file-convention, `responseMode:none`, already-posted).
- Sequence: gate (Unit 4 early + live permission) → reconstruct (Unit 2) → validate (Unit 3) → pre-write live gate (Unit 4) → `createCommit`+`updateRef` (Unit 1) via `routing.githubClient`.
- Return a typed outcome: `skipped` / `bypass` / `nothing-to-deliver` / `pushed{commit,branch}` / `fail-loud{reason}`. No response-body mutation here.

**Execution note:** Test-first for the transitions; extend the existing `createBootstrap`/`createRouting`/`createExecution` factories and module mocks.

**Patterns to follow:** existing finalize branch structure, quota/auth skip branches, `resolveCommentTarget`, primary-failure preservation.

**Test scenarios:**

- Happy path: eligible PR mention with reconstructed changes → `pushed`, `force:false`, exit path continues to response.
- Bypass: ineligible (non-collaborator/non-PR/fork/missing anchor) → `bypass`, no push, no failure.
- Nothing-to-deliver: empty net diff → `nothing-to-deliver`, no push.
- Skip: quota/auth/failed-execution/`responseMode:none`/`commentsPosted>0` → push never attempted.
- Fail-loud: validation reject / live head moved / `updateRef` 422 / partial failure → `fail-loud` with reason; created commit never reported delivered.
- Integration: no credential present in the model env (scrub invariant); push uses in-heap Octokit.

**Verification:** each state yields the correct typed outcome and the push is attempted only in the precise eligible+successful state.

- [ ] **Unit 5b: Single-response composition**

**Goal:** Fold the push outcome into exactly one response — model reply plus push footer on success, one error comment on fail-loud — preserving one-response-per-run.

**Requirements:** R8, R10

**Dependencies:** Unit 5a

**Files:**

- Modify: `src/harness/phases/finalize.ts`
- Test: `src/harness/phases/finalize.test.ts`

**Approach:**

- On `pushed`: fold a push-result footer (branch + changed paths) into the response body before the single `runResponsePost`. Define the composition seam explicitly (augment `runResponsePost` input vs wrap the response-body read); treat the response file as untrusted throughout.
- On `fail-loud`: suppress the model happy-path reply, post one error comment if `commentsPosted === 0`, `setFailed`, return non-zero.
- On `bypass`/`nothing-to-deliver`: `runResponsePost` normally, unchanged.

**Test scenarios:**

- Happy path: `pushed` → exactly one comment carrying the model reply + push footer, exit 0.
- Fail-loud: exactly one error comment, model reply suppressed, exit non-zero.
- Bypass / nothing-to-deliver: exactly one normal response, exit 0.
- Integration: every outcome posts exactly one comment/review (one-response invariant asserted per state).

**Verification:** one response in every outcome; success reports the branch and paths; failures never post the model's "fixed it" reply.

- [ ] **Unit 6: Workflow + docs**

**Goal:** Supply the trusted head SHA to the action and document the trusted-push behavior.

**Requirements:** R3, R10

**Dependencies:** Unit 5a, 5b

**Files:**

- Modify: `.github/workflows/fro-bot.yaml` (pass the same-repo `issue_comment` PR head SHA into the new `trusted-head-sha` input)
- Modify: `docs/examples/fro-bot.yaml` (`persist-credentials: false` requirement + trusted-push note)
- Modify: `README.md` (trigger section: trusted same-repo PR mention push behavior + allowlist)

**Approach:**

- Pass the already-computed same-repo prehead SHA (for `issue_comment` on a PR) into the action as the trusted anchor. Fork/non-PR → empty → push path bypassed by construction. Confirm the prehead step covers the `issue_comment`-on-PR case (it does not need `pull_request`, which is not the eligible surface).
- Document that brokered push applies only to same-repo non-fork PRs by trusted maintainers, targets the PR head branch, writes only allowlisted paths, and excludes config/scripts/CI.

**Test scenarios:** Test expectation: none — workflow/doc wiring; behavior covered by Units 4/5. Verify `.github/workflows/fro-bot.yaml` passes actionlint and the committed `dist/` check is unaffected (no `src/` bundle change from docs).

**Verification:** the action receives the trusted head SHA on same-repo `issue_comment`-on-PR mentions and empty otherwise; docs describe the behavior, the allowlist, and the `persist-credentials: false` requirement.

## System-Wide Impact

- **Interaction graph:** finalize gains a push step inside the `file-convention` branch using `routing.githubClient` (in-heap Octokit); it never runs in quota/auth/failed states. The env-scrub/credential-withhold path is unchanged — the model still gets no credential.
- **Error propagation:** eligible delivery attempts that fail become fail-loud runs with one error comment and `setFailed`; ineligible contexts bypass to normal delivery. Failures never downgrade to success or "nothing to deliver".
- **State lifecycle risks:** a created commit whose `updateRef` fails is reported as failure and never disclosed as delivered (no unreachable commit URL in comments). `force:false` + full live re-resolve guard the concurrent-run race; the create-commit→ref-update window is a residual the loser handles by failing loud.
- **API surface parity:** the deletion + mode extension (Unit 1) benefits other `createCommit` callers; the allowlist validation (Unit 3) is a separate wrapper so dispatch/schedule delegated commits are unaffected.
- **Integration coverage:** one-response-per-run must hold across all outcomes — finalize tests assert exactly one comment/review per state.
- **Unchanged invariants:** credential withhold + bootstrap anti-bypass (#1167) untouched; `workflow_dispatch`/`schedule` and `pull_request_review_comment` delivery unchanged; the in-heap Octokit residual unchanged; global `validateFiles` unchanged.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Prompt-injected trusted mention writes an execution surface | Path allowlist (product/docs/test only); `.github/**`, scripts, config, manifests all denied by default |
| Net-diff delivers stray/secret tracked files in an allowed path | Allowlist bounds paths; changed-path list surfaced in the response; content-trust rests on the human authorization gate (stated, not a code-safety guarantee) |
| Symlink/submodule/executable-mode trickery | Regular-file-only invariant (Unit 1 + Unit 2) rejects non-`100644` and type/mode changes |
| Model poisons local git config/HEAD/origin in the same job | Reconstruction neutralizes local config and derives target only from live GitHub API, never workspace metadata |
| Maintainer loses access between trigger and finalize | Delivery-time live collaborator-permission re-check; fail loud if removed/unknown |
| Concurrent mention runs race to push | Full live re-resolve + `updateRef(force:false)`; loser fails loud; residual create→update window handled by fail-loud |
| Push self-blocks like the injected-deny incident | Git Data API (no shell, no permission ask); prove against existing deny rules and on consumer-like config |
| Trusted head SHA missing/malformed | Push path bypasses; run finalizes on the normal comment path |

## Documentation / Operational Notes

- Document trusted-push behavior, the allowlist, and `persist-credentials: false` in `docs/examples/fro-bot.yaml` and the README trigger section (Unit 6).
- After merge, a `docs/solutions/` learning on brokered post-run delivery composing with credential-withhold is a good ce:compound candidate.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-30-brokered-push-trusted-mention-requirements.md](../brainstorms/2026-07-30-brokered-push-trusted-mention-requirements.md)
- Related code: `src/features/delegated/commit.ts`, `src/harness/phases/finalize.ts`, `src/features/reviews/review-guards.ts`, `src/features/triggers/author-utils.ts`, `packages/runtime/src/agent/response-delivery.ts`, `src/services/setup/adapters.ts`, `.github/workflows/fro-bot.yaml`
- Related issues/PRs: #1297 (this request), #1170, #1167, #1147
- RFC: `RFCs/RFC-018-Agent-Invokable-Delegated-Work.md` (deferred agent-invokable evolution)
