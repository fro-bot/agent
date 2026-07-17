---
date: 2026-07-15
topic: skip-agent-review-label
---

# Skip-agent-review label

## Summary

Repository collaborators whom GitHub permits to manage PR labels will gain a per-PR opt-out from automatic PR-event reviews. A configurable label will trigger the opt-out, matched case-insensitively. Explicit authorized requests for review will still be honored regardless of the label.

---

## Problem Frame

PR-triggered review runs currently process every authorized, non-draft, unlocked pull request that reaches trigger routing, with no per-PR opt-out. Maintainers who want automated review commentary suppressed on a specific pull request — a work-in-progress branch under active human review, or a PR that has already received enough automated feedback — have no way to signal that short of disabling the review trigger for the whole repository. Existing skip logic is based on event/action type, author association, draft state, and lock state; none of it is a PR-author-controlled, per-PR opt-out.

---

## Actors

- A1. Repository collaborator with GitHub permission to manage PR labels — applies or removes the opt-out label on a PR.
- A2. Fro Bot Action — evaluates the label during PR-event trigger routing and decides whether to run a review.
- A3. Authorized mention author — an explicit `@fro-bot` mention forces a review to run regardless of the label.
- A4. GitHub reviewer — an explicit GitHub `review_requested` event naming the bot forces a review to run regardless of the label.

---

## Key Flows

- F1. Automatic skip on labeled PR
  - **Trigger:** A PR-event review trigger fires (e.g. opened, synchronize, ready_for_review) on a PR carrying a label matching the configured opt-out name.
  - **Actors:** A1, A2
  - **Steps:** The action evaluates the label before acknowledgement or model execution; match is found; the run is skipped.
  - **Outcome:** No reaction, comment, or review is posted; an internal skip reason is recorded; no token spend occurs.
  - **Covered by:** R5, R6, R7

- F2. Explicit override on labeled PR
  - **Trigger:** A labeled PR receives an explicit `@fro-bot` mention or an explicit GitHub review request naming the bot.
  - **Actors:** A2, A3, A4
  - **Steps:** The action detects the explicit request and does not apply the label skip.
  - **Outcome:** The review runs normally, as if the label were absent.
  - **Covered by:** R10, R11

- F3. Label applied or removed between events
  - **Trigger:** The opt-out label is applied to or removed from a PR at some point in its lifecycle.
  - **Actors:** A1, A2
  - **Steps:** The action re-evaluates label presence independently on each subsequent PR-event trigger; any invocation already running when the label changes is unaffected.
  - **Outcome:** Only the next review-producing event reflects the change; an already-running invocation completes uninterrupted, and a prior skip is never retroactively processed.
  - **Covered by:** R12, R13

- F4. Feature disabled by empty configuration
  - **Trigger:** The opt-out label configuration is set to an empty value.
  - **Actors:** A2
  - **Steps:** The action skips label evaluation entirely for all PR-event triggers.
  - **Outcome:** PR-event review behavior is identical to current behavior, regardless of any labels present on the PR.
  - **Covered by:** R3

---

## Requirements

**Configuration**

- R1. The action exposes a configuration value for the opt-out label name, defaulting to `skip-agent-review` when unset.
- R2. The configured label name is trimmed of leading/trailing whitespace before use.
- R3. When the trimmed configuration value is empty, this feature is disabled: no PR label is checked, and current PR-event review behavior is unchanged.
- R4. Label-name matching against GitHub label names is case-insensitive.

**Skip behavior**

- R5. When a PR carries a label matching the configured name (R2-R4) at the time a PR-event review trigger is evaluated, the run is skipped before acknowledgement, before model execution, and before any token spend.
- R6. A skip under R5 emits no reaction, no comment, and no review.
- R7. A skip under R5 records a stable, internal skip reason distinct from existing skip reasons.
- R8. Label presence is read from the trusted normalized PR event. Missing or empty label data is treated as no match, and routing does not fetch label state from the GitHub API.
- R9. This feature does not apply to issue-triage triggers; label presence on an issue has no effect on issue-triage skip evaluation.

**Overrides**

- R10. An explicit `@fro-bot` mention on a labeled PR overrides the skip only when the existing mention authorization gate accepts the author.
- R11. A trusted GitHub `review_requested` event naming the bot on a labeled PR overrides the skip under the existing reviewer-identity checks.

**Timing and unaffected behavior**

- R12. Applying the label affects only PR-event review triggers evaluated after the label is applied; it does not cancel or otherwise affect an invocation already running at the moment the label is applied.
- R13. Removing the label affects only PR-event review triggers evaluated after removal; a run already skipped is not retroactively processed.
- R14. PRs without the configured label, and all behavior when the feature is disabled (R3), are unchanged from current PR-event review behavior.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R6, R7.** Given configuration is unset (default `skip-agent-review`) and a PR has the label `skip-agent-review` applied, when a `synchronize` event fires, then no acknowledgement reaction, comment, or review is posted and an internal skip reason is recorded.
- AE2. **Covers R2, R4, R5.** Given configuration is `Skip-Agent-Review` and a PR has the label `skip-agent-review` applied, when a PR-event review trigger fires, then the review is skipped.
- AE3. **Covers R1, R2, R5.** Given configuration is set to ` no-bot-review ` with surrounding whitespace and a PR has the label `no-bot-review` applied, when a PR-event review trigger fires, then the review is skipped.
- AE4. **Covers R3.** Given configuration is set to an empty string and a PR has a label literally named `skip-agent-review` applied, when a PR-event review trigger fires, then the review runs normally, exactly as if the PR had no labels.
- AE5. **Covers R10.** Given a PR has the configured opt-out label applied, when an authorized comment author explicitly mentions `@fro-bot`, then the review runs.
- AE6. **Covers R11.** Given a PR has the configured opt-out label applied, when a trusted GitHub `review_requested` event names the bot account, then the review runs.
- AE7. **Covers R14.** Given a PR has no labels, when a PR-event review trigger fires, then behavior is identical to behavior before this feature existed.
- AE8. **Covers R12.** Given a PR-event review run is already executing when the opt-out label is applied to that PR, when the label is applied mid-run, then the in-flight run is not cancelled and completes normally, and only the next review-producing event on that PR is skipped.
- AE9. **Covers R13.** Given a PR previously carried the opt-out label and was skipped, when the label is removed and a new `synchronize` event fires, then the review runs normally.
- AE10. **Covers R9.** Given an issue (not a PR) carries a label with the same name as the configured opt-out label, when issue-triage trigger evaluation runs, then the label has no skip effect.
- AE11. **Covers R8.** Given a normalized PR event has missing or empty label data, when PR-event review routing runs, then the opt-out does not match and no GitHub API call is made to hydrate labels.

---

## Success Criteria

- A PR carrying the configured opt-out label (default `skip-agent-review`, matched case-insensitively) produces zero reactions, comments, or reviews on PR-event review triggers, with a stable internal skip reason recorded, and the skip occurs before model execution or token spend.
- An authorized `@fro-bot` mention or a trusted GitHub `review_requested` event against a labeled PR still produces a review.
- Setting the configuration to an empty value fully disables the feature with no behavioral change from current unlabeled-PR behavior.
- Issue-triage triggers are unaffected by this feature under all configurations.
- PRs without the configured label behave identically to current (pre-feature) behavior.
- Label evaluation uses trusted normalized event data and never adds a routing-time GitHub API fetch.

---

## Scope Boundaries

- In scope: PR-event review triggers.
- Out of scope: issue-triage triggers.
- Out of scope: cancelling or interrupting an already-running invocation.
- Out of scope: creating, applying, removing, or otherwise managing the opt-out label.
- Out of scope: any GitHub-visible indication that a skip occurred.
- Out of scope: multiple configurable opt-out label names.

---

## Key Decisions

- **Single label:** one configurable name keeps matching and configuration minimal.
- **Tolerant matching:** trimming and case-insensitive comparison prevent silent casing or spacing mistakes.
- **Explicit intent wins:** mentions and review requests override a label that expresses only a default preference against automatic review.
- **Silent skip:** the action records the reason internally without posting a GitHub-visible artifact.
- **Read-only policy:** the action never creates or manages the configured label.
- **GitHub-owned authority:** the feature trusts GitHub's existing label permissions instead of adding timeline attribution or a second authorization system.
- **Event-time evaluation:** label changes affect later events and never interrupt an invocation already in progress.

---

## Dependencies / Assumptions

- Trusted PR label state is available in the webhook payload and can be normalized before routing without an API request.
- The existing skip-reason contract can accept one additional stable reason without breaking consumers.
- Explicit mentions and GitHub review requests remain distinguishable from automatic PR-event reviews.

---

## Sources / Research

- Issue #1216.
- `src/features/triggers/skip-conditions-pr.ts` — existing PR-event skip-condition checks this feature extends.
- `src/services/github/types.ts` — GitHub-facing type definitions referenced during research.
- `docs/wiki/Execution Lifecycle.md` — execution-phase ordering (acknowledgement, model execution, posting) relevant to where a skip must occur to avoid token spend.
