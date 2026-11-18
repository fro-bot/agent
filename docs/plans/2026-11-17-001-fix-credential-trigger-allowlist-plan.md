---
title: "fix: Provision the GitHub credential only on schedule and workflow_dispatch"
type: fix
status: active
date: 2026-11-17
---

# fix: Provision the GitHub credential only on schedule and workflow_dispatch

## Overview

The Action decides per trigger whether the model receives the GitHub credential and how its reply is delivered. Today the decision names three triggers that withhold (`pull_request`, `issue_comment`, `issues`) and provisions on everything else. `pull_request_review_comment`, `discussion_comment` and any event name the table does not know therefore hand the write token to a model that is reading untrusted comment text (#2157).

This plan turns the table into an allowlist: only `schedule` and `workflow_dispatch` provision. Every other event name withholds the credential and delivers the reply through the response file. It lands as two pull requests. The first makes response-file delivery correct for discussions and changes nothing for current callers. The second flips the default and is a breaking fix.

## Problem Frame

- `resolveResponseDelivery` in `packages/runtime/src/agent/response-delivery.ts` classifies a raw event name as `affected`, `autonomous` or `deferred-or-unknown`. The last class provisions the credential and uses `model-gh` delivery. It is the permissive default.
- Comment triggers require an OWNER, MEMBER or COLLABORATOR author, but the text the model reads (the thread, the diff, the discussion) is written by anyone. On a review-comment or discussion run the model holds a token that can push and post.
- A flip alone is not enough. In response-file mode a discussion run resolves to the `issue-comment` surface and posts through the issues REST endpoint with the discussion number. The likely result is three failed attempts and a failed run with nothing posted.
- Withholding is exposure reduction, not an OS boundary. `isolate-agent` is the boundary (`docs/wiki/Setup and Configuration.md`). This plan does not change that.

## Requirements Trace

- R1. Only `schedule` and `workflow_dispatch` provision the GitHub credential. Every other raw event name, known or unknown, withholds it.
- R2. A withheld run delivers through the response file. `response-mode: none` still selects no delivery and still withholds on a non-allowlisted trigger.
- R3. A discussion run in response-file mode posts one top-level discussion comment through the existing GraphQL writer. The target comes from trusted event context only. No path falls back to an issue target.
- R4. A PR review-comment run in response-file mode posts one top-level PR comment. No review is submitted and no inline reply is attempted.
- R5. Brokered push stays limited to `issue_comment` on a pull request.
- R6. The first pull request changes no behaviour for any trigger that is delivered by the model today.
- R7. The model is told where its reply lands on discussion and review-comment runs, and a withheld run logs one line saying the credential and push are withheld for this event.
- R8. Every document and message that names the withheld trigger list states the new rule.
- R9. The breaking change ships with a migration note that names each loss and each new refusal.

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
- The comment in `src/harness/phases/bootstrap.ts` and the wiki say routing re-asserts the classification. No such assertion exists. This plan corrects the text (Unit 4 and Unit 5). Adding the assertion is separate.

## Context & Research

### Relevant Code and Patterns

- The decision: `resolveResponseDelivery`, `classifyEvent`, `resolveCredential`, `resolveDelivery` in `packages/runtime/src/agent/response-delivery.ts`. Three call sites read it: `src/harness/phases/bootstrap.ts`, `src/harness/phases/cache-restore.ts`, `src/harness/phases/execute.ts`.
- Surface selection: `resolveResponseSurface` in `src/features/agent/response-file.ts`; the surface type and `RESPONSE_SURFACE_POLICIES` in `packages/runtime/src/agent/response-file.ts`. The policy `target` is `'issue' | 'pr'` today.
- Target and post: `deriveSurfaceAndTarget` and `postCommentWithRetry` in `src/features/agent/response-post.ts`; `postComment` and `postDiscussionComment` in `src/features/comments/writer.ts`. `CommentTarget.type` already admits `'discussion'`, the writer resolves the discussion node id from owner, repo and number, and the retry probe's reader already has a discussion branch (`src/features/comments/reader.ts`).
- The error-comment path already targets a discussion: `resolveCommentTarget` in `src/harness/phases/finalize.ts`.
- Consumers of the credential half: the persisted-credential preflight in `src/harness/phases/bootstrap.ts`; `provisionChildCredential` in `src/services/setup/setup.ts`; the `{env:}` refusal in `src/services/setup/ci-config-v2.ts`; remote MCP filtering in `src/services/setup/mcp-servers-v2.ts`; context-overflow replay in `src/harness/phases/execute.ts`; the sandbox git credential helper in `src/harness/phases/sandbox-lifecycle.ts`; `src/harness/phases/brokered-push-plan.ts`.
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

- **Allowlist on the raw event name, inline.** The decision keeps taking the raw name and names the two provisioning events. It cannot import the typed classifier (runtime sits below `src/`), and a two-name list needs no mapper. Any name not on the list withholds, which also covers the raw `discussion` name.
- **Two classes, not three.** `autonomous` provisions and uses `model-gh`. Everything else withholds and uses `file-convention`. `response-mode: none` keeps overriding delivery only.
- **A `discussion-comment` surface with a `discussion` target.** The policy target type widens to include `discussion`, and `resolveResponseSurface` selects the new surface from the trusted event type. `deriveSurfaceAndTarget` then yields a discussion target with no other plumbing, and the success path and the error-comment path agree on the target.
- **No issue fallback for a discussion.** If the trusted context does not identify a discussion, the post fails as a missing target. It never retargets.
- **Top-level replies.** The normalized event carries no node ids, and no document promises threading. The prompt tells the model where the reply lands.
- **Discussion surface first, flip second.** With the flip alone a discussion reply is lost. With the surface alone nothing changes for callers, because discussion runs stay on `model-gh` until the flip.
- **Bootstrap order stays.** The preflight, the `{env:}` refusal and MCP filtering keep running before routing, so they now apply to events the Action goes on to skip. A skip that was green can fail on a persisted checkout credential or `{env:}` in `opencode-config`. The migration note says so.
- **Breaking fix.** Commit type `fix!` with a `BREAKING CHANGE:` footer. Under the 0.x policy that is a minor release.
- **Retry behaviour is inherited.** Discussion posts use the same three attempts and run-marker probe as other surfaces. Delivery is at-least-once on an ambiguous network failure, as it is today for issues and PRs.

## Open Questions

### Resolved During Planning

- Do owned callers need a checkout migration first? No. All 36 already pass the preflight on every trigger.
- Can `merge_group` in this repository's CI turn red? No evidence it can. The same job and secret already run withheld on `pull_request`.
- Does the model need new instructions to stop calling `gh`? No. Delivery mode already switches the protocol text.
- Can a discussion number address an issue? Not established either way. The plan does not depend on it, because no path sends a discussion number to an issue endpoint for the reply.

### Deferred to Implementation

- Whether `src/main.test.ts`, which runs the built bundle on `push`, passes the preflight unchanged in a developer checkout and in CI. Run it; adjust the test's environment only if it fails for a reason the test does not mean to cover.
- The exact wording of the destination sentences and the withhold log line.
- Whether the `<issue>` context block needs a new builder branch for a discussion or only a label change.

## Implementation Units

### Phase 1: discussion delivery (pull request 1, `fix`)

- [ ] **Unit 1: Discussion response surface and target**

**Goal:** A response-file run on a discussion trigger posts a top-level discussion comment to the discussion named by trusted context.

**Requirements:** R3, R6

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
- `deriveSurfaceAndTarget` builds the target from the policy and the trusted number, as it does for the other surfaces. A discussion surface without a discussion in trusted context is a missing target.
- Every place that reads the policy table handles the new member: the output-contract gate and the protocol builders in the prompt.

**Execution note:** Implement test-first. Start with the failing post-path test.

**Patterns to follow:**

- The `pr-comment` surface end to end, including its tests.
- `resolveCommentTarget` in `src/harness/phases/finalize.ts` for the discussion target shape.

**Test scenarios:**

- Happy path: discussion event, file-convention delivery, valid comment file -> the GraphQL add-comment mutation is called with the discussion resolved from owner, repo and number, and the issues REST create-comment endpoint is not called.
- Happy path: surface resolution returns `discussion-comment` for a discussion event and is unchanged for every existing event and issue-type combination.
- Edge case: a review verdict in the file on the discussion surface is dropped with a warning and the body is posted as a comment.
- Edge case: the policy table's key list assertion includes the new surface and the table stays total.
- Error path: the writer returns no result three times -> the post reports `post-failed` and nothing is sent to an issue endpoint.
- Error path: a discussion surface with no discussion in trusted context -> missing target, no post.
- Integration: for one discussion run, the success target and the error-comment target are the same discussion.
- Integration: a discussion run under `model-gh` delivery builds the same prompt as before this unit.

**Verification:**

- The discussion post-path tests fail before the change and pass after it.
- No test for an existing surface changes its expectation.

- [ ] **Unit 2: Tell the model where the reply lands**

**Goal:** Under response-file delivery the prompt names a discussion as a discussion and says that discussion and review-comment replies are top-level.

**Requirements:** R4, R7

**Dependencies:** Unit 1

**Files:**

- Modify: `packages/runtime/src/agent/prompt.ts`
- Test: `packages/runtime/src/agent/prompt.test.ts`

**Approach:**

- The context block for a discussion target says Discussion, not Issue of unknown type.
- Under file-convention only, the discussion directive and the review-comment directive each gain one sentence: the Action posts the reply as a top-level comment on the discussion or the pull request.
- Text under `model-gh` delivery is unchanged.

**Patterns to follow:**

- The existing delivery-keyed branches in the agent-context and harness-rules builders.

**Test scenarios:**

- Happy path: discussion event with file-convention -> the prompt names the discussion and states the top-level destination.
- Happy path: review-comment event with file-convention -> the prompt states the reply is a top-level PR comment and still carries the file, line and diff context.
- Edge case: the same two events under `model-gh` -> prompt text is byte-identical to before.

**Verification:**

- Existing prompt snapshot and list-contiguity tests pass without edits, apart from the new rows.

### Phase 2: the flip (pull request 2, `fix!`)

- [ ] **Unit 3: Allowlist the provisioning triggers**

**Goal:** Only `schedule` and `workflow_dispatch` provision the credential and use `model-gh`.

**Requirements:** R1, R2, R5

**Dependencies:** Units 1 and 2 merged and released

**Files:**

- Modify: `packages/runtime/src/agent/response-delivery.ts`
- Test: `packages/runtime/src/agent/response-delivery.test.ts`
- Test: `src/harness/phases/brokered-push-plan.test.ts`

**Approach:**

- Replace the three event classes with two: the allowlisted pair, and everything else.
- Rewrite the module header to state the rule and why the default denies.

**Execution note:** Implement test-first. Rewrite the table tests as a matrix before changing the classifier.

**Patterns to follow:**

- `evaluateRepoSkillsTrust` and `resolveOutputMode` for deny-by-absence.

**Test scenarios:**

- Happy path: `schedule` and `workflow_dispatch`, response mode `github` -> provision and `model-gh`.
- Happy path: `pull_request`, `issue_comment`, `issues`, `pull_request_review_comment`, `discussion_comment`, response mode `github` -> withhold and `file-convention`.
- Edge case: `discussion`, `merge_group`, `push`, `pull_request_target`, an empty string and an invented name -> withhold and `file-convention`.
- Edge case: every name above with response mode `none` -> delivery `none`; credential still follows the allowlist.
- Edge case: a name that differs from an allowlisted one only by case or surrounding whitespace -> withhold.
- Integration: brokered push planning stays ineligible for `discussion_comment` and `pull_request_review_comment` under file-convention.

**Verification:**

- The two tests that pin the permissive default are replaced by the matrix and no test asserts provisioning for a non-allowlisted name.

- [ ] **Unit 4: Messages, comments and the withhold notice**

**Goal:** Every string that names the old trigger list states the rule, and a withheld run says so once.

**Requirements:** R7, R8

**Dependencies:** Unit 3

**Files:**

- Modify: `src/services/setup/ci-config-v2.ts`
- Modify: `src/harness/phases/bootstrap.ts`
- Test: `src/services/setup/ci-config-v2.test.ts`
- Test: `src/harness/phases/bootstrap.test.ts`
- Test: `src/harness/phases/execute.test.ts`

**Approach:**

- The `{env:}` refusal message and the comment above the credential field describe the rule, not three trigger names.
- The bootstrap comment stops claiming routing re-asserts the classification.
- On a withheld run bootstrap logs one info line: the event name, that the GitHub credential and push are withheld, and that the reply is posted from the response file. No token-derived value is logged.
- Context-overflow replay becomes eligible on the flipped triggers through its existing condition. Pin that with a test; no code change is expected.

**Test scenarios:**

- Happy path: a withheld review-comment run logs the notice once; a `workflow_dispatch` run does not log it.
- Error path: `{env:}` in `opencode-config` on a review-comment run fails setup with a message that does not list three trigger names.
- Edge case: replay eligibility is true for a review-comment run with a context overflow, no response file and no uncertain send, and false when a valid response file exists.
- Integration: the built bundle on a `push` event still starts, passes the preflight in a clean checkout and exits through the routing skip.

**Verification:**

- A search for the old three-name list in `src/` and `packages/` finds only test data that means it.
- `dist/` is rebuilt and committed with the source change.

- [ ] **Unit 5: Documents and the migration note**

**Goal:** Documentation states the allowlist, the destinations and the losses.

**Requirements:** R8, R9

**Dependencies:** Unit 3

**Files:**

- Modify: `docs/wiki/Setup and Configuration.md`
- Modify: `docs/wiki/Prompt Architecture.md`
- Modify: `docs/wiki/Execution Lifecycle.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `src/services/setup/AGENTS.md`
- Modify: `src/features/agent/AGENTS.md`
- Modify: `docs/examples/fro-bot.yaml`
- Modify: `docs/solutions/best-practices/credential-gated-surface-is-event-intersection-2026-07-30.md`
- Modify: `docs/solutions/best-practices/response-file-is-untrusted-input-2026-07-11.md`

**Approach:**

- Replace each trigger list with the rule: every trigger except `schedule` and `workflow_dispatch` withholds the credential and is answered from the response file.
- The README MCP paragraph and the wiki MCP and `{env:}` paragraphs follow the same rule.
- The event table says review-comment and discussion replies are top-level comments.
- The lifecycle page drops the claim of a routing re-assertion.
- The two learnings get in-place updates through the compound-refresh workflow: the withheld set, and the statement that review-comment runs push with their own credential. The brokered-push conclusion stays.
- Follow `.agents/skills/generating-project-docs` for the living documents.
- The migration note goes in the commit's `BREAKING CHANGE:` footer and the pull request body. It covers: on review-comment, discussion and any other non-allowlisted trigger the model has no `gh` authentication, no `git push` and no remote MCP servers; replies there are top-level comments posted by the Action; `{env:}` in `opencode-config` and a persisted checkout credential now fail on every non-allowlisted event, including events the Action then skips; the token needs `discussions: write` to answer a discussion; work that needs the credential belongs in a dispatched or scheduled run; withholding is not isolation.

**Test scenarios:**

- Test expectation: none -- documentation only. The link checker and the module taxonomy test cover the edited files.

**Verification:**

- No document under `docs/wiki/`, `README.md`, `ARCHITECTURE.md` or the two `AGENTS.md` files names the old three-trigger list as the withheld set.

- [ ] **Unit 6: Live check from a real caller**

**Goal:** The released Action answers a discussion mention and a review-comment mention from a published install.

**Requirements:** R3, R4, R9

**Dependencies:** The release that carries Unit 3

**Files:**

- None in this repository.

**Approach:**

- On an owned caller already pinned by Renovate to the new release, post one discussion comment mention and one PR review-comment mention.
- Read each run's log and the posted reply.

**Test scenarios:**

- Test expectation: none -- live verification, not an automated test.

**Verification:**

- The discussion run logs the withhold notice and posts one top-level discussion comment authored by the Action's token identity.
- The review-comment run logs the notice and posts one top-level PR comment, with no review and no push.
- Neither run shows a `gh` authentication in the model's session.

## System-Wide Impact

- **Interaction graph:** the decision feeds setup's `gh` authentication, the config builder, MCP filtering, the preflight, the response-file path, finalize's post path, replay eligibility, brokered-push planning and the sandbox git credential helper. All read the same resolver.
- **Error propagation:** a withheld run with no valid response file fails the job. That now applies to review-comment and discussion runs. A discussion post that fails three times fails the run.
- **State lifecycle risks:** a restored session may contain earlier `gh` instructions and tool calls from a provisioned run on the same PR or discussion. The current prompt states the delivery rule each run. An ambiguous network failure can produce a duplicate discussion comment when the marker probe cannot see the first one.
- **API surface parity:** the gateway does not use this decision. No gateway change.
- **Integration coverage:** the bundle test on `push`, the CI `test-action` job on `merge_group`, and Unit 6.
- **Unchanged invariants:** `schedule` and `workflow_dispatch` behaviour; the `pull_request`, `issue_comment` and `issues` paths; brokered push eligibility; response-file trust rules; `isolate-agent`.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| A caller's prompt or skill relies on model `gh` or `git push` on a review-comment or discussion run | Migration note; the per-run withhold notice; 27 owned jobs are known and none has a documented need |
| A caller outside the owned set persists checkout credentials or uses `{env:}` and subscribes to these events or runs the Action on unhandled ones | The refusal messages name the fix; breaking-change footer; the release is a minor under 0.x |
| The discussion reply is lost if the flip ships without the surface | Unit 3 depends on Units 1 and 2 being released |
| Token lacks `discussions: write` | The post fails and the run fails visibly; the migration note names the permission |
| This repository's own review-comment and discussion runs lose `gh` | Accepted; it is the intended behaviour |
| Edits made by the model on a review-comment run stay local and the run is green | The withhold notice and the prompt's delivery rules say push is unavailable; brokered push is not widened by design |

## Documentation / Operational Notes

- Pull request 1 is a patch release with no caller-visible change.
- Pull request 2 is a minor release. Renovate will open pin bumps in each owned caller; no caller edit is required first.
- After pull request 2 lands, record a learning for the allowlist itself.
- File the three deferred issues before pull request 2 opens.

## Sources & References

- Issue: #2157. Related: #2135, #2156.
- Related code: `packages/runtime/src/agent/response-delivery.ts`, `src/features/agent/response-file.ts`, `src/features/agent/response-post.ts`, `src/features/comments/writer.ts`
- Related past work: `docs/plans/2026-07-11-001-fix-remove-agent-credential-comment-review-flows-plan.md`, recorded done. It withheld on three triggers and deferred the discussion and review-comment surfaces; this plan covers them and denies by default.
- Related past work: `docs/plans/2026-07-30-001-feat-brokered-push-trusted-mention-plan.md`, recorded done. It assumed review-comment runs keep a credential; this plan removes it and leaves the broker's gate as it is.
- Related past work: `docs/brainstorms/2026-07-11-remove-agent-github-credential-requirements.md`, recorded as requirements. Same objective; its workspace-file placement was replaced by the run-scoped path outside the checkout.
