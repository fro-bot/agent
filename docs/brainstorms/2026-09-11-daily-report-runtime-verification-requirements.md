---
date: 2026-09-11
topic: daily-report-runtime-verification
---

# Daily Report Runtime Verification

## Summary

Extend the Daily Maintenance Report with a temporary autonomous task that tracks runtime credential-preflight evidence for `fro-bot/agent#1598`. The task updates the issue only when progress changes and closes it when all 27 active downstream repositories have evidence-backed dispositions.

---

## Problem Frame

The downstream checkout migration is complete, and `v0.111.0` contains the fail-closed credential preflight. Static workflow inspection cannot prove the effective Git configuration on the actual runner, so `fro-bot/agent#1598` remains open at 0 of 27 runtime-verified repositories.

The current smart note can detect qualifying runs and surface follow-up work, but it cannot update or close the tracker autonomously. The daily maintenance run already performs recurring repository checks, but its current contract permits modifying only the rolling Daily Maintenance Report issue.

The scheduled agent's GitHub App token is limited to the `fro-bot` installation. It cannot inspect every cross-owner or private downstream repository, and broad cross-owner credentials must not be exposed to the model.

---

## Actors

- A1. Trusted evidence collector: inspects downstream workflow metadata and emits sanitized verification results.
- A2. Daily maintenance agent: updates the DMR and conditionally updates or closes `fro-bot/agent#1598`.
- A3. Repository operator: removes the temporary task after completion and resolves exceptional access or policy failures.

---

## Key Flows

- F1. Daily verification sweep
  - **Trigger:** The normal Daily Maintenance Report schedule runs while `fro-bot/agent#1598` is open.
  - **Actors:** A1, A2
  - **Steps:** The collector inspects all 27 repositories, classifies new evidence, sanitizes private results, and gives the resulting dispositions to the agent. The agent compares them with the tracker and updates #1598 only when progress changed.
  - **Outcome:** The tracker advances monotonically without exposing credentials or private repository identities.
  - **Covered by:** R1-R17
- F2. No-change daily run
  - **Trigger:** The collector finds no new qualifying or no-longer-applicable disposition.
  - **Actors:** A1, A2
  - **Steps:** The agent records the no-change result in the DMR and leaves #1598 untouched.
  - **Outcome:** Daily visibility is preserved without tracker churn.
  - **Covered by:** R11, R13, R15, R16
- F3. Verification completion
  - **Trigger:** All 27 repositories have evidence-backed dispositions.
  - **Actors:** A1, A2, A3
  - **Steps:** The agent writes the final tracker state, closes #1598, stops future verification work, and records a cleanup reminder in the DMR.
  - **Outcome:** The migration tracker closes automatically, and the temporary daily task is queued for removal.
  - **Covered by:** R18, R20, R21

---

## Requirements

**Evidence collection**

- R1. The runtime verification sweep must run as part of the normal Daily Maintenance Report schedule while `fro-bot/agent#1598` remains open.
- R2. The sweep must cover the fixed set of 27 active downstream repositories recorded by #1598 without publishing private repository identities.
- R3. A repository qualifies through runtime evidence only when an affected-event Fro Bot run finishes successfully after `v0.111.0`, the workflow uses either literal `fro-bot/agent@v0` or a full 40-character action SHA, the run logs resolve that action to a revision containing #1597, and the run succeeds.
- R4. A run that fails the credential preflight or does not reach terminal success must not qualify the repository.
- R5. A repository may instead resolve as no longer applicable when evidence shows that it no longer consumes Fro Bot on its default branch, is archived, or is deleted.
- R6. Cross-owner and private inspection must happen in a deterministic trusted collector using a step-scoped credential that is never exposed to the agent.
- R7. The collector must receive the existing `FRO_BOT_PAT` only as a step-local `GH_TOKEN`; it must not write the credential to the job environment, outputs, artifacts, files, logs, or model context, and the collector binding must be removed after #1598 closes.
- R8. The collector may use the cross-owner credential only for read-only repository metadata, default-branch workflow content, Actions run metadata, and Actions logs; insufficient access must fail closed without mutating a downstream repository.
- R9. For private repositories, names, URLs, and per-repository evidence must not enter the model context, public workflow logs, the DMR, or #1598.
- R10. Private repository identities must be stored only in a GitHub Actions secret, exposed only to the collector step, never echoed or propagated through outputs or artifacts, and deleted after #1598 closes.
- R11. Inaccessible or incomplete data must remain unresolved, must not reduce previously recorded progress, and must be reported as unavailable in the DMR.

**Tracker behavior**

- R12. Verification progress in #1598 must be monotonic unless an operator explicitly corrects invalid evidence.
- R13. The daily agent must update #1598 only when a repository newly resolves, a material blocker changes, or the completion condition is reached.
- R14. Public repositories may include evidence links in #1598, while private repositories must appear only as an aggregate resolved count.
- R15. A no-change sweep must update only the DMR and must leave #1598 unchanged.
- R16. The DMR prompt's blanket one-issue prohibition must be narrowed while #1598 is open: the daily run may modify only the DMR and #1598, and no other issue or pull request.
- R17. The agent must use the minted owner-wide App token with `issues: write` for DMR and #1598 mutations; the read-only `github.token` must not be used for issue updates or closure.

**Completion and lifecycle**

- R18. The agent must close #1598 only when all 27 repositories have qualifying runtime evidence or an evidence-backed no-longer-applicable disposition.
- R19. The sweep must not create synthetic issues, comments, pull requests, review requests, workflow reruns, or other events to manufacture evidence.
- R20. After #1598 closes, later daily runs must skip the sweep, remove access to the private-identity secret and the collector's `FRO_BOT_PAT` binding, and add a concise reminder to remove the temporary task.
- R21. The daily task must not open its own cleanup pull request.

---

## Acceptance Examples

- AE1. **Covers R3, R4, R13, R14.** Given a public repository has a successful post-release `issue_comment` run using a qualifying `v0` revision, when the daily sweep runs, #1598 records that repository as verified with the run link.
- AE2. **Covers R11, R15.** Given no repository has new evidence and one API source is temporarily unavailable, when the daily sweep runs, the DMR reports the unavailable data and #1598 is not edited.
- AE3. **Covers R6-R10, R14.** Given one private repository newly qualifies, when the daily sweep runs, the collector increments the private aggregate without exposing the credential, repository identity, or run URL to the agent.
- AE4. **Covers R5, R13.** Given a repository removes its Fro Bot workflow from the default branch, when the collector verifies the removal, #1598 records it as no longer applicable.
- AE5. **Covers R4, R11.** Given a post-release run fails with `Refusing to proceed with credential withheld`, when the sweep runs, the repository remains unresolved and the DMR surfaces the blocker.
- AE6. **Covers R17-R21.** Given the final unresolved repository receives valid evidence, when the daily sweep runs, the agent uses the owner-wide App token to update and close #1598, removes the temporary collector secret bindings, and records a cleanup reminder without opening a pull request.

---

## Success Criteria

- #1598 progresses and closes without requiring an active local agent session.
- Every resolved repository has qualifying evidence or a documented no-longer-applicable disposition.
- The model and public artifacts never receive a cross-owner credential or private repository identity.
- No-change daily runs produce no edits to #1598.
- The DMR retains its existing behavior except for the single bounded #1598 exception.
- Planning can derive implementation and verification work without inventing qualification, privacy, update, or closure behavior.

---

## Scope Boundaries

- This is a temporary task for `fro-bot/agent#1598`, not a reusable recurring-watch registry.
- The task does not trigger downstream events to accelerate verification.
- The task does not expose a durable cross-owner credential to the agent.
- The task does not publish private repository names or per-repository private evidence.
- The task does not change the Daily Maintenance Report cadence or its existing report sections.
- Removal of the temporary task happens in a separate cleanup change after #1598 closes.

---

## Key Decisions

- Trusted collection before model execution: cross-owner access is necessary, but the agent does not need the credential or raw private evidence.
- Progress-only tracker edits: the DMR carries daily visibility while #1598 remains concise.
- Evidence-backed resolution: retired consumers must not block closure indefinitely, but the agent cannot declare them resolved without proof.
- Temporary exception over general framework: one migration tracker does not justify a recurring-job subsystem.
- Organic evidence only: verification must reflect real downstream use rather than synthetic activity created to satisfy a checklist.

---

## Dependencies / Assumptions

- The existing `FRO_BOT_PAT` can read the required metadata and logs across all 27 active repositories without permission expansion.
- A new encrypted secret can supply private repository identities to the trusted collector without placing them in source control.
- The scheduled run's existing owner-wide App token retains `issues: write` and can update and close #1598.
- #1598 can hold stable public verification state while representing private progress as an aggregate.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7, R8][Needs research] Does the existing `FRO_BOT_PAT` already provide the required cross-owner Actions read access without permission expansion?
- [Affects R3, R12][Technical] What evidence format makes qualification deterministic and tracker updates resistant to concurrent or human edits?
- [Affects R3][Technical] How should the collector prove that a resolved `v0` revision contains #1597 when the mutable branch advances beyond `v0.111.0`?
- [Affects R9-R11][Technical] How should private-repository and access failures be represented internally without leaking identifiers through logs or model context?

---

## Sources / Research

- `.github/workflows/fro-bot.yaml` — Daily Maintenance Report schedule, prompt, token selection, and one-issue mutation rule.
- `scripts/harness/mint-app-token.ts` — owner-wide scheduled App token permissions and installation boundary.
- `src/harness/phases/bootstrap.ts` — credential-preflight placement before agent setup.
- `src/services/setup/git-credential-check.ts` — runtime qualification failure conditions.
- `docs/brainstorms/2026-04-13-compounding-wiki-requirements.md` — established autonomous daily and weekly maintenance loops.
- `fro-bot/agent#1598` — migration inventory, runtime verification baseline, and privacy constraints.
