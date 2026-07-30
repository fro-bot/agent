---
date: 2026-07-30
topic: brokered-push-trusted-mention
---

# Brokered Push for Trusted Same-Repo Mention Runs

## Summary

Give a trusted same-repo `@fro-bot` mention a safe way to deliver a fix it just made: the model commits its changes locally during the run, and after the run the action validates those changes and delivers them to the pull request's head branch as a fresh bot-authored commit built through the existing Git Data API path. No push credential is ever exposed to the model's shell.

---

## Problem Frame

Since the credential-withhold hardening (PR #1170, issue #1167), `pull_request` / `issue_comment` / `issues` runs receive no GitHub credential in the agent child, and bootstrap fail-closes if the checkout carries any persisted git credential. That protection is correct for untrusted comment input.

The side effect: a maintainer (`OWNER` / `MEMBER` / `COLLABORATOR`) can mention the bot on a same-repo, non-fork PR, ask for a change, watch the model make and locally commit that change — and then the run has no way to deliver it. `git push` fails with `could not read Username for 'https://github.com'`, and the usual `.git/config` extraheader workaround makes the run refuse to start. The maintainer must reproduce the fix by hand. `workflow_dispatch` / `schedule` runs are unaffected because they keep a provisioned credential; only the trusted mention path is stranded.

---

## Actors

- A1. Trusted maintainer: mentions `@fro-bot` on a same-repo non-fork PR and asks for a change to be pushed back.
- A2. Model (agent child): makes ordinary edits and a local commit during the run; never holds a push credential.
- A3. Action (harness): after the run, validates the model's local commit and performs the push via its in-heap Octokit client.
- A4. GitHub: receives the branch update through the Git Data API.

---

## Key Flows

- F1. Trusted mention delivers a fix to the PR head
  - **Trigger:** A trusted maintainer mentions `@fro-bot` on a same-repo non-fork PR asking for a change.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** The run checks out the PR head. The model edits files and makes a local commit ahead of the head SHA. The run ends. The action confirms authorization and same-repo non-fork target from the event, re-resolves the live head target, validates the changed files, and delivers them to the PR head branch as a fresh commit via the Git Data API. The action reports delivery in its single response.
  - **Outcome:** The PR head branch advances with the model's change, authored by the bot; the response states what was pushed.
  - **Covered by:** R1, R2, R3, R4, R5, R7

- F2. Nothing to deliver, or delivery blocked
  - **Trigger:** Same as F1, but the model produced no local commit, or the push target is unsafe / has moved.
  - **Actors:** A2, A3
  - **Steps:** The action finds no eligible commit, or the authorization / target-safety check fails, or the head advanced so the replay is rejected. The action pushes nothing and fails the run with a clear reason.
  - **Outcome:** No partial or wrong delivery; the run ends failed and loud.
  - **Covered by:** R5, R6, R8, R9

---

## Requirements

**Trusted push path**

- R1. A trusted same-repo mention run can deliver file changes to the PR head branch without any push credential reaching the model's shell or environment.
- R2. Delivery is performed by the action after the run using the existing Git Data API path (build tree, create commit, update ref), not by the model process. The delivered commit is a fresh bot-authored commit rebuilt from the model's file changes, not a transplant of the local git commit object.
- R3. The push target (owner, repo, head branch) is derived from the trusted event context, never from model output.

**Authorization and safety gate**

- R4. Delivery is allowed only when the event is same-repo, non-fork, and the actor's association is `OWNER`, `MEMBER`, or `COLLABORATOR`, read through a single shared gate helper from the normalized event context. Any other case delivers nothing.
- R5. The change set is validated before push: reject writes to sensitive paths (`.git/`, `.env`, credential files), path traversal, and oversized payloads, and never force-push. R5 is a path-and-size integrity gate, not a semantic content-safety guarantee — it does not judge whether the contents of an allowed file are benign.
- R6. Within the affected mention triggers, a fork PR or an unauthorized actor never results in a push; these fail the authorization gate and deliver nothing. This requirement governs only the trusted-mention path and does not change `workflow_dispatch` / `schedule` behavior.
- R11. Immediately before writing the branch, the action re-resolves the PR identity and head-branch target from live GitHub state. If the PR was retargeted, renamed, closed, or changed fork status since checkout, delivery fails with a clear reason rather than writing to a stale or wrong target.

**Delivery contract**

- R7. Delivery rebuilds a commit from the file changes the model made ahead of the trusted head SHA captured at checkout and writes it to the PR head branch. "Nothing to deliver" applies only when no eligible commit exists at run end; a clean working tree with no new commit is the only no-op case.
- R8. If an eligible commit exists but its write to the branch is rejected or partially fails, the run reports delivery failure and fails loudly — it is never downgraded to "nothing to deliver" or reported as success.
- R9. If the PR head advanced during the run so the replay cannot apply without force, the run fails with a clear reason rather than force-pushing or silently rebasing.

**Delivery reporting**

- R10. The run's single response states whether a push occurred and what branch it targeted, consistent with the one-response-per-invocation protocol.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3, R7.** Given a `COLLABORATOR` mention on a same-repo non-fork PR, when the model edits files and makes one local commit, then the action delivers those changes to the PR head branch as a fresh bot-authored commit and no credential was present in the model's environment.
- AE2. **Covers R4, R6.** Given the same request but the actor association is `NONE` (or the PR head is a fork), when the run ends, then no push occurs and the run reports the authorization gate blocked delivery.
- AE3. **Covers R7.** Given a trusted mention where the model changes nothing and makes no commit, when the run ends, then nothing is pushed and the response says there was nothing to deliver.
- AE4. **Covers R9.** Given a trusted mention where the PR head branch advances after checkout, when the action attempts the replay, then the non-fast-forward is rejected, no force-push happens, and the run fails with a clear reason.
- AE5. **Covers R5.** Given a trusted mention where the model's commit touches `.env` or a path outside the repo, when the action validates the change set, then the push is refused and the run fails.
- AE6. **Covers R8.** Given a trusted mention where a change was expected to deliver but the delivery step produced no branch update, when the run finalizes, then the run fails loudly instead of returning success.
- AE7. **Covers R5.** Given a trusted mention where the model's commit touches only allowed source files but embeds hostile content (e.g. a prompt-injection payload copied from the PR diff), when the action validates the change set, then R5's path-and-size gate passes and delivery proceeds — validation does not certify content is benign; content trust rests entirely on the authorization gate.
- AE8. **Covers R8, R11.** Given a trusted mention with an eligible commit, when the live head re-resolves to a different SHA (or the PR was retargeted) so the ref write is rejected, then the run reports delivery failure and fails loudly rather than reporting "nothing to deliver".

---

## Success Criteria

- A maintainer can `@fro-bot`-mention a same-repo PR asking for a fix, and the fix lands on the PR head branch with no manual reproduction.
- No push credential is ever readable by the model's shell or environment on the affected triggers; the withhold/anti-bypass protection from #1167 stays intact.
- Every non-trusted or unsafe case (fork, unauthorized actor, sensitive path, moved head) results in zero delivery and a clear failed run — no partial or wrong pushes.
- A planner can implement from this doc without inventing the authorization bar, the target-derivation source, the deliver-nothing cases, or the fail-loud contract.

---

## Scope Boundaries

- Option 2 from #1297 (a documented opt-in on-disk push credential on comment triggers) is rejected — it reopens the same-UID disk/env credential residual the #1167 withhold design removed.
- Content-level trust of the model's changes is out of scope: the authorization gate (trusted same-repo maintainer) is the content trust boundary, and R5 validation is path/size integrity only. The specific bound on repo-execution surfaces is a security decision deferred to planning, not a v1 requirement here.
- No agent-invokable push tool in v1; the model uses ordinary edits and a local commit, and the action replays it. A structured agent-invokable delegated-work tool (RFC-018) is a possible later evolution.
- Push targets are limited to the existing same-repo PR head branch. Opening a new PR from a fresh branch, or acting on non-PR issue mentions, is deferred.
- No auto-rebase, auto-retry, or conflict resolution when the head moves during a run; v1 fails loud.
- `workflow_dispatch` / `schedule` behavior is unchanged; they keep the provisioned-credential path.

---

## Key Decisions

- Replay the model's local commit (staging model B) rather than build an agent-invokable RFC-018 tool (A): no new model-facing contract, smallest lift, and it reuses the finalize pattern of reconstructing a trusted target from the event and writing via in-heap Octokit. It is also robust to model behavior — there is no special tool the model must remember to call.
- PR-head-only for v1: the target branch is unambiguous from the mention event, which keeps the authorization and validation surface tightest.
- Brokered (option 1) over credentialed (option 2): the safe write primitive already exists in `src/features/delegated/` and never shells out, so it sidesteps the withhold/anti-bypass mechanism by construction.

---

## Dependencies / Assumptions

- The existing delegated-write primitives (`src/features/delegated/commit.ts`, `branch.ts`) with hardcoded `force: false` and `validateFiles` guards are the delivery mechanism.
- The action's in-heap Octokit token (the accepted residual documented in the #1167 plan's Scope Boundaries) remains the credential that performs the push; this doc does not change that residual.
- The trusted-context derivation and same-repo/non-fork + association guards proven in the finalize and review-reconciliation paths are reused, not reinvented.
- The actor association is read from the normalized event context — `author_association` on the comment for `issue_comment`, on the pull request for `pull_request`, both normalized to `authorAssociation` in `src/services/github/context.ts`. A single shared gate helper reads this; it is never recomputed per call site.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7][Technical] How the action identifies "the model's changes ahead of the trusted head SHA" — read the local git range in the checkout vs diff the working tree — and how it reconstructs the change set for the Git Data API.
- [Affects R7][Technical] Whether multiple local commits map to multiple GitHub commits or are folded into a single aggregate-tree commit for v1.
- [Affects R2, R10][Technical] Where in the phase sequence the push runs relative to the existing response-file delivery, and whether push delivery and comment delivery are reported in one response or composed.
- [Affects R4, R11][Technical] Whether authorization is re-checked against live repository permissions at delivery time, or the event-time association snapshot is sufficient (a maintainer could lose `COLLABORATOR`/`MEMBER` status mid-run).
- [Affects R5][Security] What bound v1 places on repo-execution surfaces. R5's path/size gate does not cover `.github/workflows/**` or release/package automation scripts, so a prompt-injected trusted mention could push a change to a persistent-compromise surface with bot authority. Planning chooses the exact policy: denylist execution surfaces, a tighter editable-path allowlist, or an explicit accepted-risk decision. This is a security bound, not a mechanical detail.

---

## Sources / Research

- Issue #1297 (this request) and its Fro Bot triage — repro, why the workflow-level fix fails, and the option-1 recommendation.
- Credential resolver: `packages/runtime/src/agent/response-delivery.ts` (`classifyEvent` / `resolveCredential`), withhold seams `src/services/setup/setup.ts`, `src/services/setup/gh-auth.ts`, anti-bypass `src/services/setup/git-credential-check.ts`, bootstrap `src/harness/phases/bootstrap.ts`.
- Safe write primitive: `src/features/delegated/commit.ts` (`createBlob → createTree → createCommit → updateRef`, `force: false`, `validateFiles`), `branch.ts`, `pull-request.ts`.
- Trusted-target + finalize delivery pattern: `src/harness/phases/finalize.ts`, `src/features/agent/response-post.ts`; trust guards `src/features/reviews/review-reconciliation.ts`, event derivation `src/services/github/context.ts`.
- RFC-018 (`RFCs/RFC-018-Agent-Invokable-Delegated-Work.md`, Status: Pending) — the agent-invokable delegated-work capability this deliberately does not build in v1.
- Prior credential arc: PR #1170, issue #1167, and `docs/plans/2026-07-11-001-fix-remove-agent-credential-comment-review-flows-plan.md` Scope Boundaries (why `workflow_dispatch`/`schedule` kept the credential).
