---
title: "fix: Provision the GitHub credential only on schedule and workflow_dispatch"
type: fix
status: active
date: 2026-11-17
---

# fix: Provision the GitHub credential only on schedule and workflow_dispatch

## Overview

The Action decides per trigger whether the model receives the GitHub credential and how its reply is delivered. Today the decision names three triggers that withhold (`pull_request`, `issue_comment`, `issues`) and provisions on everything else. `pull_request_review_comment`, `discussion_comment` and any event name the table does not know therefore hand the write token to a model that is reading untrusted comment text (#2157).

This plan turns the table into an allowlist: only `schedule` and `workflow_dispatch` provision. Every other event name withholds the credential and delivers the reply through the response file. The same pull request makes response-file delivery correct for discussions, because a flip alone would lose discussion replies. It is a breaking fix.

## Problem Frame

- `resolveResponseDelivery` in `packages/runtime/src/agent/response-delivery.ts` classifies a raw event name as `affected`, `autonomous` or `deferred-or-unknown`. The last class provisions the credential and uses `model-gh` delivery. It is the permissive default.
- Comment triggers require an OWNER, MEMBER or COLLABORATOR author, but the text the model reads (the thread, the diff, the discussion) is written by anyone. On a review-comment or discussion run the model holds a token that can push and post.
- A flip alone is not enough. In response-file mode a discussion run resolves to the `issue-comment` surface and posts through the issues REST endpoint with the discussion number. The likely result is three failed attempts and a failed run with nothing posted.
- Withholding is exposure reduction, not an OS boundary. `isolate-agent` is the boundary (`docs/wiki/Setup and Configuration.md`). This plan does not change that.

## Requirements Trace

- R1. Only `schedule` and `workflow_dispatch` provision the GitHub credential. Every other raw event name, known or unknown, withholds it.
- R2. A withheld run delivers through the response file. `response-mode: none` still selects no delivery and still withholds on a non-allowlisted trigger.
- R3. A discussion run in response-file mode posts one top-level discussion comment through the existing GraphQL writer. The target comes from trusted event context only. The reply never falls back to an issue target.
- R4. A PR review-comment run in response-file mode posts one top-level PR comment. No review is submitted and no inline reply is attempted.
- R5. Brokered push stays limited to `issue_comment` on a pull request.
- R6. `schedule` and `workflow_dispatch` runs behave as before.
- R7. The model is told where its reply lands on discussion and review-comment runs.
- R8. Every document and message that names the withheld trigger list states the new rule.
- R9. The breaking change ships with a migration note that names each loss and each new refusal.
- R10. A comment written by the Action's own identity does not start a run, whether or not that identity is a bot account.

## Scope Boundaries

- No inline reply to a review thread. No threaded discussion reply. Both replies are top-level.
- No change to brokered push eligibility.
- No reordering of bootstrap and routing. Withhold-side checks keep running before routing decides to skip an event.
- No change to `isolate-agent`, the key proxy, or what `schedule` and `workflow_dispatch` runs can do.
- No per-caller opt-out input. A caller that needs model `gh` on a comment trigger moves that work to a dispatched run.

### Deferred to Separate Tasks

- Wrong-endpoint acknowledgements: on discussion and review-comment runs the Action sends the discussion number to issue-label endpoints and discussion or review comment ids to issue-comment reaction endpoints (`src/features/comments/reactions.ts`, `src/features/agent/acknowledge.ts`). Separate issue, own fix.
- A raw `discussion` (created) payload has no comment, and `normalizeEvent` in `src/services/github/context.ts` dereferences one. No owned caller subscribes to it. Separate issue.
- `response-mode: none` still lets the generic recoverable-error branch in `src/harness/phases/finalize.ts` post an error comment. Separate issue.

## Context & Research

### Relevant Code and Patterns

- The decision: `resolveResponseDelivery`, `classifyEvent`, `resolveCredential`, `resolveDelivery` in `packages/runtime/src/agent/response-delivery.ts`. Three call sites resolve it, each from its own copy of the event name: `src/harness/phases/bootstrap.ts`, `src/harness/phases/cache-restore.ts`, `src/harness/phases/execute.ts`.
- Surface selection: `resolveResponseSurface` in `src/features/agent/response-file.ts`; the surface type and `RESPONSE_SURFACE_POLICIES` in `packages/runtime/src/agent/response-file.ts`. The policy `target` is `'issue' | 'pr'` today.
- Target and post: `deriveSurfaceAndTarget` and `postCommentWithRetry` in `src/features/agent/response-post.ts`; `postComment` and `postDiscussionComment` in `src/features/comments/writer.ts`. `CommentTarget.type` already admits `'discussion'`, the writer resolves the discussion node id from owner, repo and number, and the retry probe's reader already has a discussion branch (`src/features/comments/reader.ts`).
- The error-comment path already targets a discussion: `resolveCommentTarget` in `src/harness/phases/finalize.ts`.
- Consumers of the credential half: the persisted-credential preflight in `src/harness/phases/bootstrap.ts`; `provisionChildCredential` in `src/services/setup/setup.ts`; the `{env:}` refusal in `src/services/setup/ci-config-v2.ts`; remote MCP filtering in `src/services/setup/mcp-servers-v2.ts`; context-overflow replay in `src/harness/phases/execute.ts`; the sandbox git credential helper in `src/harness/phases/sandbox-lifecycle.ts`; `src/harness/phases/brokered-push-plan.ts`.
- Self-trigger guard: `isBotUser` in `src/features/triggers/author-utils.ts` checks the `[bot]` suffix; the comment skip check is in `src/features/triggers/skip-conditions-comment.ts`. The Action's own login is already passed to the comment context builders.
- Default-deny idioms to follow: `evaluateRepoSkillsTrust` in `src/features/agent/repo-skills-trust.ts` (its header names this permissive default as its opposite) and `resolveOutputMode` in `packages/runtime/src/agent/output-mode.ts`.
- Prompt text keyed on delivery and surface: `packages/runtime/src/agent/prompt.ts` and `packages/runtime/src/agent/prompt-thread.ts`. Delivery already selects the whole reply protocol, so no string has to change for the model to write the file instead of calling `gh`.
- Release typing: `.releaserc.yaml` makes any breaking commit a minor release; `scripts/release/release-policy.test.ts` pins `fix!` to minor.

### Institutional Learnings

- `docs/solutions/best-practices/response-file-is-untrusted-input-2026-07-11.md`: trusted event context alone selects repository, target and surface. The file contributes a body and a validated verdict. Its trigger list goes stale with this change.
- `docs/solutions/best-practices/credential-gated-surface-is-event-intersection-2026-07-30.md`: brokered push is the intersection of withheld and PR-bound events, behind an explicit gate. It says review-comment runs push through their provisioned credential. This change makes that false. Widening withholding does not widen the broker.
- `docs/solutions/logic-errors/fail-closed-against-an-unchecked-default-2026-09-19.md`: check a fail-closed rule against every consumer's default configuration. The owned-caller check below is that check.
- `docs/solutions/logic-errors/injected-deny-blocks-own-delivery-path-2026-07-13.md` and `docs/solutions/security-issues/relative-response-file-write-silently-lost-review-2026-08-21.md`: the newly withheld triggers must inherit the response-path permission exception and the fallback rules unchanged. They do, because both key on delivery mode.
- `docs/solutions/workflow-issues/published-install-live-check-before-rollout-2026-11-17.md`: prove the change from a real caller before calling it done.

### Owned-Caller Check

Each caller's default branch was fetched and parsed on 2026-11-17.

- 36 owned agent jobs. Each has one checkout with a literal `persist-credentials: false` and sets `isolate-agent: true`. The persisted-credential preflight already runs for them on every trigger. None is newly refused.
- 27 of them run on review-comment or discussion events. After the flip the model on those runs has no `gh` authentication, no `git push` credential and no remote MCP servers.
- This repository's `.github/workflows/fro-bot.yaml` subscribes to both events with a local install and no `isolate-agent`. It is not refused and takes the same losses.
- This repository's CI `test-action` job runs on `merge_group`, which flips from provision to withhold. The same job with the same `OPENCODE_CONFIG` secret already runs withheld on `pull_request` and passes, so the `{env:}` refusal and the preflight are already satisfied there.
- One external caller was found, pinned to v0.93.1. It is unaffected until it bumps.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "fro-bot/agent at origin/main: src/, packages/runtime/src, scripts/, docs/solutions (packages/gateway by search only)",
  "freshness": {
    "vcs_reference": "34d8e83b39adf154ebc84fbd43f453ba094bab51"
  },
  "budget": {
    "max_search_passes": 6,
    "max_candidate_inspections": 12,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/agent/response-delivery.ts: resolveResponseDelivery",
      "description": "Owns the per-trigger credential and delivery decision; its default class provisions.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/features/agent/response-file.ts: resolveResponseSurface",
      "description": "Maps trusted event type and issue type to a response surface; anything unnamed falls to issue-comment.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/features/agent/response-post.ts: deriveSurfaceAndTarget; src/features/comments/writer.ts: postDiscussionComment",
      "description": "Builds the post target from trusted context; the GraphQL discussion writer exists and is used only for error comments.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/features/agent/repo-skills-trust.ts: evaluateRepoSkillsTrust",
      "description": "Default-deny allow list over event type with an exhaustive switch; returns a trust verdict, not a credential decision.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/output-mode.ts: resolveOutputMode",
      "description": "Closed switch where only schedule and workflow_dispatch resolve an autonomous mode; takes the typed event, not the raw name.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/features/delegated/brokered-push-gate.ts: evaluateBrokeredPushEarlyGate",
      "description": "Per-capability default-deny on issue_comment; narrower than the credential decision.",
      "disposition": "insufficient"
    },
    {
      "path_or_symbol": "src/services/github/context.ts: classifyEventType",
      "description": "Raw name to closed event type; lives above the runtime layer, so the runtime decision cannot import it.",
      "disposition": "insufficient"
    }
  ]
}
```

The two `reuse` rows are idioms to follow, not code to call.

## Key Technical Decisions

- **Allowlist on the raw event name, inline.** The decision keeps taking the raw name and names the two provisioning events with exact string matches. It cannot import the typed classifier (runtime sits below `src/`), and a two-name list needs no mapper. Any other value withholds, including the raw `discussion` name, a case variant and an empty string.
- **Two classes, not three.** The allowlisted pair provisions and uses `model-gh`. Everything else withholds and uses `file-convention`. `response-mode: none` keeps overriding delivery only.
- **One decision per run.** Bootstrap resolves the credential and delivery once and carries both on its result. Cache restore and execute read them from there and stop resolving their own. Today the three call sites read the event name from three sources; they agree in practice, but a disagreement would build a provisioned config on a withheld run. This also makes the "one classification" claim in the code and wiki true.
- **A `discussion-comment` surface with a `discussion` target.** The policy target type widens to include `discussion`, and `resolveResponseSurface` selects the new surface from the trusted event type. `deriveSurfaceAndTarget` requires the trigger context's target to be a discussion and takes the number from it. The success path and the error-comment path then agree on the target.
- **No issue fallback for a discussion reply.** If the trusted context does not identify a discussion, the post fails as a missing target. It never retargets.
- **Top-level replies.** The normalized event carries no node ids, and no document promises threading. The prompt tells the model where the reply lands.
- **One pull request.** The discussion surface cannot be exercised in production until the flip, because discussion runs are model-delivered until then. Shipping both together removes the release-order dependency.
- **Skip the Action's own comments by login.** The self-trigger guard today is the `[bot]` suffix. Under a PAT the Action's login has no such suffix, and the Action now posts model-written text on two more surfaces. Routing skips a comment whose author is the Action's own login.
- **Bootstrap order stays.** The preflight, the `{env:}` refusal and MCP filtering keep running before routing, so they now apply to events the Action goes on to skip. A skip that was green can fail on a persisted checkout credential or `{env:}` in `opencode-config`. The migration note says so.
- **No new log line.** Setup already logs that the `gh` credential is withheld from the child. Its wording names an "affected trigger"; it is reworded to name the event and the rule. It claims nothing about push or delivery, because brokered push can still apply and a skipped event delivers nothing.
- **Breaking fix.** Commit type `fix!` with a `BREAKING CHANGE:` footer. Under the 0.x policy that is a minor release.
- **Retry behaviour is inherited.** Discussion posts use the same three attempts and run-marker probe as other surfaces. Delivery is at-least-once on an ambiguous network failure, as it is today for issues and PRs. The probe matches on the Action's login, so when that login cannot be resolved an ambiguous failure can duplicate.

## Open Questions

### Resolved During Planning

- Do owned callers need a checkout migration first? No. All 36 already pass the preflight on every trigger.
- Can `merge_group` in this repository's CI turn red? The same job and secret already run withheld on `pull_request` and pass. This pull request's own merge-queue run is the proof.
- Does the model need new instructions to stop calling `gh`? No. Delivery mode already switches the protocol text.

### Open, Not Blocking

- Whether a discussion number can ever address an issue or pull request is not established. The reply path does not depend on it, because it never sends a discussion number to an issue endpoint.

### Deferred to Implementation

- `src/main.test.ts` runs the built bundle on `push` and sets no `RUNNER_TEMP`. After the flip a `push` run resolves a response-file path, which needs it. Set it in the test.
- The exact wording of the destination sentences and the reworded setup log line.
- Whether the context block needs a new builder branch for a discussion or only a label change.

## Implementation Units

- [ ] **Unit 1: Discussion response surface**

**Goal:** A response-file run on a discussion trigger posts a top-level discussion comment to the discussion named by trusted context, and the prompt says where discussion and review-comment replies land.

**Requirements:** R3, R4, R7

**Dependencies:** None

**Files:**

- Modify: `packages/runtime/src/agent/response-file.ts`
- Modify: `src/features/agent/response-file.ts`
- Modify: `src/features/agent/response-post.ts`
- Modify: `packages/runtime/src/agent/prompt.ts`
- Test: `src/features/agent/response-file.test.ts`
- Test: `src/features/agent/response-post.test.ts`
- Test: `packages/runtime/src/agent/prompt.test.ts`
- Test: `src/harness/phases/finalize.test.ts`

**Approach:**

- Add the `discussion-comment` surface to the surface type and the policy table, comment-only, with target `discussion`. Widen the policy target type.
- `resolveResponseSurface` returns it for the discussion event type before the issue fallback.
- `deriveSurfaceAndTarget` requires the trigger context's target to be of kind `discussion` for this surface and takes the number from that target. An absent target or one of another kind is a missing target. The agent context's issue type cannot serve as this check, because it is null for a discussion.
- Every reader of the policy table handles the new member: the output-contract gate and the protocol builders in the prompt.
- The context block for a discussion target says Discussion, not Issue of unknown type.
- Under file-convention only, the discussion directive and the review-comment directive each gain one sentence: the Action posts the reply as a top-level comment on the discussion or the pull request. Text under `model-gh` delivery is unchanged.
- The review-comment post path needs no change. It already resolves to `pr-comment` and posts a top-level PR comment (`src/features/agent/response-post.test.ts` covers it).

**Execution note:** Implement test-first. Start with the failing post-path test.

**Patterns to follow:**

- The `pr-comment` surface end to end, including its tests.
- `resolveCommentTarget` in `src/harness/phases/finalize.ts` for the discussion target shape.

**Test scenarios:**

- Happy path: discussion event, file-convention delivery, valid comment file -> the GraphQL add-comment mutation is called for the discussion resolved from owner, repo and number, and the issues REST create-comment endpoint is not called.
- Happy path: discussion event with file-convention -> the prompt names the discussion and states the top-level destination.
- Happy path: review-comment event with file-convention -> the prompt states the reply is a top-level PR comment.
- Edge case: a review verdict in the file on the discussion surface is dropped with a warning and the body is posted as a comment.
- Edge case: discussion and review-comment events under `model-gh` -> prompt text is identical to before.
- Error path: the writer returns no result three times -> the post reports `post-failed` and nothing is sent to an issue endpoint.
- Error path: a discussion surface with no target in trusted context -> missing target, no post.
- Error path: a discussion surface whose trusted target is an issue or a pull request -> missing target, no post.
- Integration: for one discussion run, the success target and the error-comment target are the same discussion.

**Verification:**

- The discussion post-path tests fail before the change and pass after it.
- No test for an existing surface changes its expectation. The existing surface key-list assertion gains the new member.

- [ ] **Unit 2: Allowlist the provisioning triggers, decided once**

**Goal:** Only `schedule` and `workflow_dispatch` provision the credential and use `model-gh`, and every phase reads the one decision bootstrap made.

**Requirements:** R1, R2, R5, R6

**Dependencies:** Unit 1

**Files:**

- Modify: `packages/runtime/src/agent/response-delivery.ts`
- Modify: `src/harness/phases/bootstrap.ts`
- Modify: `src/harness/phases/cache-restore.ts`
- Modify: `src/harness/phases/execute.ts`
- Test: `packages/runtime/src/agent/response-delivery.test.ts`
- Test: `src/harness/phases/bootstrap.test.ts`
- Test: `src/harness/phases/cache-restore.test.ts`
- Test: `src/harness/phases/execute.test.ts`
- Test: `src/harness/phases/brokered-push-plan.test.ts`
- Test: `src/main.test.ts`

**Approach:**

- Replace the three event classes with two: the allowlisted pair, and everything else. Rewrite the module header to state the rule and why the default denies.
- The bootstrap result carries the credential disposition next to the delivery mode it already carries. Cache restore and execute read it and drop their own calls to the resolver.
- The bootstrap comment that claims routing re-asserts the classification is replaced by a statement of the single decision.

**Execution note:** Implement test-first. Replace the two tests that pin the permissive default before changing the classifier.

**Patterns to follow:**

- `evaluateRepoSkillsTrust` and `resolveOutputMode` for deny-by-absence.
- How `delivery` already travels on the bootstrap result.

**Test scenarios:**

- Happy path: `pull_request_review_comment`, `discussion_comment`, `discussion`, `push`, `merge_group` and an empty string, response mode `github` -> withhold and `file-convention`. This replaces the two tests that assert provisioning for unknown and deferred names.
- Edge case: one non-allowlisted name with response mode `none` -> delivery `none`, credential withheld.
- Integration: cache restore builds a withheld config when the bootstrap result says withhold, whatever `GITHUB_EVENT_NAME` holds at that point.
- Integration: execute takes replay eligibility from the bootstrap result's disposition.
- Integration: brokered push planning stays ineligible for `discussion_comment`; add it to the existing ineligible-trigger row.
- Integration: the built bundle on a `push` event starts, passes the preflight in a clean checkout and exits through the routing skip.

**Verification:**

- No test asserts provisioning for a non-allowlisted name.
- The resolver has one production caller.
- The existing tests for `schedule`, `workflow_dispatch`, `pull_request`, `issue_comment` and `issues` pass unchanged.

- [ ] **Unit 3: Skip the Action's own comments**

**Goal:** A comment written by the Action's own identity never starts a run.

**Requirements:** R10

**Dependencies:** None

**Files:**

- Modify: `src/features/triggers/skip-conditions-comment.ts`
- Test: `src/features/triggers/router.test.ts`

**Approach:**

- The comment skip check compares the comment author's login with the Action's own login from the trigger config and skips with its own reason when they match. The `[bot]` suffix check stays.
- It applies to `issue_comment`, `pull_request_review_comment` and `discussion_comment`, which share the check.
- When the Action's login is unknown the check does not skip; the suffix check and the caller's workflow filter still apply.

**Execution note:** Implement test-first.

**Patterns to follow:**

- The existing bot-author and association skips in the same function, and their reason strings.

**Test scenarios:**

- Happy path: comment author equals the Action's login (a PAT user with no `[bot]` suffix), mention present, association OWNER -> skipped with the self-comment reason.
- Happy path: comment author differs from the Action's login -> not skipped by this check.
- Edge case: login comparison ignores case.
- Edge case: the Action's login is unknown -> this check does not skip.
- Integration: a discussion comment authored by the Action's login is skipped at routing.

**Verification:**

- The self-comment test fails before the change.

- [ ] **Unit 4: Messages and comments**

**Goal:** Every string in code that names the old trigger list states the rule.

**Requirements:** R8

**Dependencies:** Unit 2

**Files:**

- Modify: `src/services/setup/ci-config-v2.ts`
- Modify: `src/services/setup/mcp-servers-v2.ts`
- Modify: `src/services/setup/setup.ts`
- Test: `src/services/setup/ci-config-v2.test.ts`

**Approach:**

- The `{env:}` refusal message, the comment above the credential field and the header of the MCP filter describe the rule, not three trigger names.
- The existing setup log line for a withheld credential names the event and says the model does not receive the GitHub credential. Nothing token-derived is logged.

**Test scenarios:**

- Error path: `{env:}` in `opencode-config` on a review-comment run fails setup with a message that does not list three trigger names.

**Verification:**

- A search for the old three-name list in `src/` and `packages/` finds only test data that means it.
- `dist/` is rebuilt and committed.

- [ ] **Unit 5: Documents and the migration note**

**Goal:** Documentation states the allowlist, the destinations and the losses.

**Requirements:** R8, R9

**Dependencies:** Unit 2

**Files:**

- Modify: `docs/wiki/Setup and Configuration.md`
- Modify: `docs/wiki/Prompt Architecture.md`
- Modify: `docs/wiki/Execution Lifecycle.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `src/services/setup/AGENTS.md`
- Modify: `src/features/agent/AGENTS.md`
- Modify: `docs/solutions/best-practices/credential-gated-surface-is-event-intersection-2026-07-30.md`
- Modify: `docs/solutions/best-practices/response-file-is-untrusted-input-2026-07-11.md`

**Approach:**

- Replace each trigger list with the rule: every trigger except `schedule` and `workflow_dispatch` withholds the credential and is answered from the response file.
- The README MCP paragraph and the wiki MCP and `{env:}` paragraphs follow the same rule.
- The event table says review-comment and discussion replies are top-level comments.
- The lifecycle page says the decision is made once in bootstrap and drops the routing re-assertion.
- The two learnings are corrected in place: the withheld set, and the statement that review-comment runs push with their own credential. The brokered-push conclusion stays.
- Follow `.agents/skills/generating-project-docs` for the living documents.
- The migration note goes in the commit's `BREAKING CHANGE:` footer and the pull request body. It says:
  - On review-comment, discussion and every other trigger except `schedule` and `workflow_dispatch`, the model has no `gh` authentication, no `git push` and no remote MCP servers. Replies there are top-level comments posted by the Action.
  - `{env:}` in `opencode-config` and a persisted checkout credential now fail on every such event, including events the Action then skips.
  - The token needs `discussions: write` to answer a discussion.
  - Work that needs the credential belongs in a dispatched or scheduled run. A workflow that relays untrusted text into a dispatch input hands that text to a provisioned model.
  - Withholding keeps the token out of the model's environment and `gh` config. Without `isolate-agent` a model can still read it from the Action's process; see the wiki section on isolation.

**Test scenarios:**

- Test expectation: none -- documentation only. The link checker and the module taxonomy test cover the edited files.

**Verification:**

- No document under `docs/wiki/`, `README.md`, `ARCHITECTURE.md` or the two `AGENTS.md` files names the old three-trigger list as the withheld set.

- [ ] **Unit 6: Live check from a real caller**

**Goal:** The released Action answers a discussion mention and a review-comment mention from a published install.

**Requirements:** R3, R4

**Dependencies:** The release that carries Units 1 to 5

**Files:**

- None in this repository.

**Approach:**

- On an owned caller pinned to the new release (by Renovate or by hand), post one discussion comment mention and one PR review-comment mention.
- Read each run's log and the posted reply.

**Test scenarios:**

- Test expectation: none -- live verification, not an automated test.

**Verification:**

- The discussion run posts one top-level discussion comment under the Action's token identity, and that comment does not start another run.
- The review-comment run posts one top-level PR comment, with no review and no push.
- Both runs log the withheld-credential line.

## System-Wide Impact

- **Interaction graph:** the decision feeds setup's `gh` authentication, the config builder, MCP filtering, the preflight, the response-file path, finalize's post path, replay eligibility, brokered-push planning and the sandbox git credential helper. After Unit 2 all of them read bootstrap's result.
- **Error propagation:** a withheld run with no valid response file fails the job. That now applies to review-comment and discussion runs. A discussion post that fails three times fails the run.
- **State lifecycle risks:** a restored session may contain earlier `gh` instructions and tool calls from a provisioned run on the same PR or discussion. The current prompt states the delivery rule each run.
- **API surface parity:** the gateway does not use this decision. No gateway change.
- **Integration coverage:** the bundle test on `push`, this pull request's CI `test-action` run on `merge_group`, and Unit 6.
- **Unchanged invariants:** `schedule` and `workflow_dispatch` behaviour; the `pull_request`, `issue_comment` and `issues` paths; brokered push eligibility; response-file trust rules; `isolate-agent`.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| A caller's prompt or skill relies on model `gh` or `git push` on a review-comment or discussion run | Migration note; the prompt states the delivery rule; 27 owned jobs are known and none has a documented need |
| A caller outside the owned set persists checkout credentials or uses `{env:}` and subscribes to these events or runs the Action on unhandled ones | The refusal messages name the fix; breaking-change footer; minor release under 0.x |
| A reader takes withholding for isolation | The migration note and the wiki say what a non-isolated model can still reach: the Action's token through its process environment, the cache runtime token, object-store credentials, provider key files and literal config values. `isolate-agent` closes the process and key-file paths, not network egress |
| Token lacks `discussions: write` | The post fails and the run fails visibly; the migration note names the permission |
| This repository's own review-comment and discussion runs lose `gh` | Accepted; it is the intended behaviour |
| Edits made by the model on a review-comment run stay local and the run is green | The prompt's delivery rules say push is unavailable; brokered push is not widened by design |
| The posted body can mention any user or team | Existing property of every surface; not changed here |

## Documentation / Operational Notes

- One pull request, one minor release. Renovate opens pin bumps in each owned caller; no caller edit is required first.
- File the three deferred issues when the pull request opens.

## Sources & References

- Issue: #2157. Related: #2135, #2156.
- Related code: `packages/runtime/src/agent/response-delivery.ts`, `src/features/agent/response-file.ts`, `src/features/agent/response-post.ts`, `src/features/comments/writer.ts`, `src/features/triggers/skip-conditions-comment.ts`
- Related past work: `docs/plans/2026-07-11-001-fix-remove-agent-credential-comment-review-flows-plan.md`, recorded done. It withheld on three triggers and deferred the discussion and review-comment surfaces; this plan covers them and denies by default.
- Related past work: `docs/plans/2026-07-30-001-feat-brokered-push-trusted-mention-plan.md`, recorded done. It assumed review-comment runs keep a credential; this plan removes it and leaves the broker's gate as it is.
- Related past work: `docs/brainstorms/2026-07-11-remove-agent-github-credential-requirements.md`, recorded as requirements. Same objective; its workspace-file placement was replaced by the run-scoped path outside the checkout.
