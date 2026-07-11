---
title: Remove the CI agent's GitHub credential for comment/review flows (file-convention response delivery)
date: 2026-07-11
status: requirements
tier: deep
issue: fro-bot/agent#1167
related:
  - fro-bot/agent#1147 (closed — env-scrub that this residual survives)
  - fro-bot/agent#1154 (review-bot regression — cautionary tale for cutover)
  - fro-bot/agent#1060 → marcusrbrown/infra#725 (merge-agent credential split precedent)
  - fro-bot/agent#1107 → fro-bot/agent#1124 (integrate-token split precedent)
---

# Remove the CI agent's GitHub credential for comment/review flows

## Problem

The Fro Bot Action runs an OpenCode agent in CI. Today the model's bash posts the agent's response by running `gh pr review` / `gh pr comment` / `gh issue comment` directly (Response Protocol, `packages/runtime/src/agent/prompt.ts` — the self-post instruction near line 681 plus the comment/review examples around lines 210-212). To make that work, `configureGhAuth` (`src/services/setup/gh-auth.ts`) persists the raw GitHub token to a temporary `GH_CONFIG_DIR/hosts.yml` (mode `0600`).

`#1147` closed the `${GH_TOKEN}` env-expansion vector by scrubbing the token from the child environment. The on-disk `hosts.yml` write is the residual: `0600` protects the token from *other* users, not from the *same-UID* process that runs the model's bash. A prompt-injected model can `cat "$GH_CONFIG_DIR/hosts.yml"` and recover the token, bypassing the env-scrub entirely.

Tightening permissions, moving the path, or obfuscating the file does not help — the exposure is same-user. The fix removes the durable raw credential from the runner for the flows where it is the residual.

**Scope (load-bearing).** This applies to **comment/review flows only** — `pull_request` (review), `issue_comment`, and `issues` triggers, whose terminal output is a single comment or review the action can post on the model's behalf. **`workflow_dispatch` and `schedule` triggers are explicitly out of scope**: many downstream repos depend on them to autonomously post issues and open PRs, which requires the model to retain creation agency (and its credential). Converting those would break those consumers. The credential is therefore removed *conditionally by trigger type*, not globally.

## Why this is the right frame

The model's `gh` credential is used for **exactly one thing**: posting its Response-Protocol output (a comment or a review). Verified against source:

- **Delegated work** (branch / commit / PR creation) already goes through the action's own Octokit Git Data API (`src/features/delegated/branch.ts`, `commit.ts`, `pull-request.ts`) — not model `git`/`gh`.
- The action's comment/review **writers** already use Octokit (`src/features/comments/writer.ts`, `src/features/reviews/reviewer.ts`).

So in the comment/review flows the model needs a GitHub credential solely because the Response Protocol tells it to self-post. Remove that need — for those flows — and the on-disk credential has nothing left to protect there. (For `workflow_dispatch`/`schedule`, the model genuinely creates resources and keeps its credential; those flows are unchanged.)

**In-job posture is forced by the consumption contract.** An independent review recommended posting from a *separate* CI job for true credential isolation (in-job, the action's own Octokit client still holds the token in its heap). That is architecturally incompatible with how Fro Bot is consumed: it is a GitHub **action** (`uses: fro-bot/agent@v1` as a *step*), and a step cannot spawn or dispatch a job. Separate-job posting would force every consumer to restructure into a two-job workflow (or convert the action into a reusable workflow), breaking the drop-in contract the dispatch/schedule repos depend on. `src/post.ts` (the post-action hook) is a separate *step* in the *same* job — same UID — so it is not a boundary either. In-job is therefore the only posture compatible with not breaking consumers.

This is the in-repo half of the same pattern used for the merge agent (`#1060` → `infra#725`) and the integrate token (`#1107` → `#1124`), and here it needs **no infra/broker dependency** for the affected flows.

## Goals

- For comment/review flows (`pull_request`, `issue_comment`, `issues`): remove the on-disk/env GitHub token from the model's reach — the model's same-UID bash cannot `cat` a `hosts.yml`, run `gh auth token`, or read the token from the parent process environment, because none of those carry it anymore.
- Preserve the current external behavior for those flows: exactly one comment or review posted per invocation, with the correct surface and (for reviews) the correct verdict.
- Leave `workflow_dispatch`/`schedule` flows (autonomous issue/PR creation) fully working and unchanged.
- No regression to the `#1147` env-scrub.
- No new infrastructure or broker dependency, and no change to how downstream repos consume the action.

## Non-goals

- **`workflow_dispatch`/`schedule` credential removal** — out of scope; those flows keep the credential and current posting because they need autonomous issue/PR creation agency that downstream repos depend on.
- **Separate-job / separate-runner posting** — rejected on feasibility: it breaks the action-step consumption contract (see "Why this is the right frame"). The residual heap-token co-residency it would have addressed is accepted and documented instead.
- **Full elimination of the token from the job** — not achievable in-job: the action's own Octokit client (used for context hydration, reactions, and error comments today, created before model execution) holds the token in-heap to post. That is pre-existing baseline, not a regression this introduces.
- Option A (narrow the token's scope/lifetime) and Option B (broker-proxied `gh`) — considered and rejected for the comment/review flows.
- Delegated branch/commit/PR delivery — already Octokit, unchanged.
- Any `marcusrbrown/infra` or `broker.fro.bot` work — not required for this fix.
- A structured `submit_response` agent tool — rejected (see Key Decisions).

## Approach: file-convention response delivery

For comment/review flows, the model writes its response to a convention file in the workspace instead of self-posting. The action reads that file after the run, validates it, and posts it via the existing Octokit writer. The credential is provisioned to the child only for the out-of-scope autonomous flows (`workflow_dispatch`/`schedule`); for the comment/review triggers it is withheld from the child entirely.

Shape (to be finalized in planning):

- A run-scoped path (e.g. `.fro-bot/response.md`, unique per invocation) carrying the response **body**, and — only when the trusted event context is a PR review — a **verdict** value (`approve` / `request-changes`) drawn from a strict enum.
- The action reads it in the finalize phase (which runs after the model exits and already posts independently of execution — `src/harness/phases/finalize.ts`; the action has workspace filesystem access via `getGitHubWorkspace()` — `src/features/agent/execution.ts`), validates it, and posts through the existing Octokit writers (`src/features/comments/writer.ts`, `src/features/reviews/reviewer.ts`).
- **The response file is untrusted input.** The model that writes it is the same potentially-prompt-injected model. The action therefore derives the **target** (which issue/PR) and the **surface** (issue-comment / pr-comment / pr-review) exclusively from the trusted `NormalizedEvent` routing context — never from the file. The file may contribute only body text and, for a review context, a validated verdict value. Any target/surface metadata embedded in the file is rejected outright; it can never redirect the bot's posting authority.
- **Atomic, run-scoped, single-use.** The file is written atomically (temp + rename), is immutable once written, is read only after the agent process has fully exited, and is unique per CI invocation so re-review runs on the same PR never coalesce or replay a stale response.
- **Fail-closed.** A missing, malformed, or validation-failing response file results in **no post** and a loud, unambiguous run failure — never a default comment, guessed target, or auto-repaired content.
- For the affected triggers, the Response Protocol in `packages/runtime/src/agent/prompt.ts` is rewritten to instruct the model to write the file rather than run `gh`, and to state plainly that `gh` is unavailable in the child (so a habitual `gh` call fails fast with a specific, recognizable error rather than looking like an infra regression). The autonomous-flow prompt path keeps its current `gh` instructions.
- For the affected triggers, `configureGhAuth`'s on-disk `hosts.yml` write and the `GH_TOKEN` parent-env assignment (`gh-auth.ts` around line 27) are both suppressed, so neither the child's disk nor the parent process environment carries the token. The credential-provisioning path stays intact for `workflow_dispatch`/`schedule`.

## Key Decisions

1. **Option C (remove the model's credential for comment/review flows) over A (narrow) or B (broker).** For those flows the model MUST post *something*, so any credential that works for posting is by construction usable by same-UID bash — A only limits blast radius, B only relocates the credential (its broker session token is itself same-UID readable). Removing the credential leaves nothing on the child to steal. Needs no infra.

   *Honest scope of the fix.* This is **exposure reduction on the affected flows, not whole-job credential isolation.** What it removes from the model's reach: the on-disk `hosts.yml` token, the model's `gh` capability, and the `GH_TOKEN` parent-env copy (closing the `/proc/<pid>/environ` read an independent review flagged). What remains: the action's own Octokit client holds the token in its heap to post — pre-existing baseline (the same client hydrates context, posts reactions, and posts error comments today), unremovable in-job without the consumption-breaking separate-job restructure. In-job C raises the bar from "trivially `cat` a `0600` file" to "no credential reachable by the model's bash (file gone, env gone) — only a heap-resident token in a different process that would need a memory-read primitive to reach." For an ephemeral (~1h) App installation token that is a materially stronger and sufficient posture. The bet: **posting for comment/review flows moves to the action** (which already owns delegated pushes and the Octokit writers), at the cost of making those responses less directly agent-native. A remains the cheaper stopgap if deprioritized.

2. **File convention over a structured `submit_response` tool.** A bounded investigation of the OpenCode SDK + this repo's harness established that the tool option's decisive advantage — synchronous validation with in-run retry — is **not achievable** in the current harness: there is no action-hosted tool handler, and no back-pressure path to reject a malformed call and make the model retry before the run ends (`src/features/agent/streaming.ts` can *observe* tool-call args but cannot reject them). Both options are therefore post-run capture. A `submit_response` tool would additionally require standing up an MCP server or plugin to define it (the SDK `tools` field only enables/disables existing tools). The file convention delivers the same post-run-capture + Octokit-post + action-side validation with zero new tool infrastructure — the model's bash already writes files and the action already reads the workspace post-run. The tool's added surface does not pay rent.

3. **Invariants move to action-enforcement.** "Exactly one comment or review per invocation" and verdict validity are today prompt-enforced (the model is told to self-post once). Because the action now owns posting, it owns these guarantees structurally — the action posts exactly once, from the validated file, on the target and surface it derives from trusted context.

4. **The response file is untrusted payload, not a command.** Posting authority (target, surface, review-eligibility) is bound to the trusted `NormalizedEvent`, and the file contributes only content within that envelope. This is the security crux: without it, the file convention would hand the possibly-injected model a channel to post arbitrary content, to the wrong target, under the bot's identity — trading one exposure for a worse one.

5. **No credential on the child for comment/review flows — read-path inventory resolved.** Research inventoried every model-side `gh` use: the only reads are one `gh api .../files` example, already redundant with the changed-files table the action injects into the prompt via context hydration. So removing the credential for the affected flows breaks no read path — no action-side read replacement is needed, and the affected triggers get zero child credential (disk + env).

## Decided (moved out of open questions by review)

- **Failure posture: fail-closed.** Missing/malformed/invalid response file → no post + loud run failure. Not a soft fallback (security- and availability-load-bearing).
- **Delivery must be asserted.** The run fails unless the action confirms it posted exactly one validated response on the trusted-context surface — closing the `#1154` green-but-silent class.
- **Posting authority is bound to trusted context, not the file** (Key Decisions 3-4).

## Open Questions (for planning)

1. **Cutover mechanism.** The migration must prove end-to-end posting before the credential is removed. Decide the mechanism: phased dual-path (write the file *and* keep `gh` briefly, compare deliveries), a canary scope, or a hard cutover guarded by the mandatory delivery assertion above. `#1154` is the cautionary tale — a green job hid a repo-wide broken bot.
2. **Trigger-conditional credential provisioning.** How the setup path branches provisioning by trigger type so `workflow_dispatch`/`schedule` keep the credential while `pull_request`/`issue_comment`/`issues` get none — the trigger type is known at setup/routing time; planning pins where the branch lives and how it stays consistent with the prompt's per-trigger Response Protocol.
3. **Re-review multiplicity.** Confirm the run-scoped file model cleanly handles a PR re-reviewed after a push (each invocation gets a fresh, uniquely-scoped response artifact; the action consumes exactly one per run).
4. **Existing review-reconciliation interaction.** `src/harness/phases/review-reconciliation.ts` today reads the model's *already-posted* review body to backstop the approval. Under file-convention posting the model posts nothing; planning decides whether reconciliation reads the file's verdict or is superseded by the finalize post.

## Success Criteria

- For `pull_request`/`issue_comment`/`issues` runs: no GitHub token is readable from the child's disk or from the parent process environment by the model's same-UID bash (`hosts.yml` gone, `GH_TOKEN` not exported). The residual in-heap token in the action's own process is documented as accepted, pre-existing, and out of the model's direct reach.
- `workflow_dispatch`/`schedule` runs continue to post issues and open PRs exactly as before — no regression to autonomous flows.
- For the affected flows the bot posts exactly one comment or review per invocation, on the surface and target **derived from trusted event context**, with the correct verdict, verified end-to-end against a real PR and a real issue.
- **Response-file contents cannot change who or what the bot posts to** — target and surface are never taken from the file; embedded target/surface metadata is rejected.
- **A missing or malformed response file results in no post and a failed run** (fail-closed), and the job fails unless the action confirms a response was actually delivered (no green-but-silent outcome).
- No regression to the `#1147` env-scrub.
- No credential material appears in logs, artifacts, or failure telemetry during or after the migration.
- For the affected flows, `configureGhAuth` writes no `hosts.yml` and exports no `GH_TOKEN` to the child; for `workflow_dispatch`/`schedule` the credential path is unchanged.
- The cutover does not silently break posting (the `#1154` failure mode is explicitly guarded by the delivery assertion).

## References

- `packages/runtime/src/agent/prompt.ts` (~line 681 self-post instruction; ~210-212 comment/review examples) — current Response Protocol (self-post via `gh`).
- `src/services/setup/gh-auth.ts` — the on-disk `hosts.yml` raw-token write (the residual).
- `src/features/comments/writer.ts`, `src/features/reviews/reviewer.ts` — existing Octokit posting paths the action would reuse.
- `src/features/delegated/{branch,commit,pull-request}.ts` — delegated work already on Octokit (confirms `gh` is the model's only credential use).
- `src/features/agent/streaming.ts`, `src/features/agent/execution.ts` — event-stream capture and workspace filesystem access.
- `docs/solutions/workflow-issues/gh-auth-login-refuses-to-persist-when-gh-token-set-2026-07-10.md` — the `#1154` regression this cutover must not repeat.
