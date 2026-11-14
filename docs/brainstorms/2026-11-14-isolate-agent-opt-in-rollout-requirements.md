---
date: 2026-11-14
topic: isolate-agent-opt-in-rollout
---

# isolate-agent: keep it opt-in, and opt in where the model holds credentials

## Summary

`isolate-agent` stays opt-in. The operator's own credentialed runs opt in explicitly. A **credentialed run** is a `schedule` or `workflow_dispatch` run where the model is given a write-capable token or PAT. The README recommends the input, and #2135 closes when the decision and docs land, before the rollout finishes.

---

## Problem Frame

v0.141.0 isolation is complete:
- the model runs as its own user;
- provider keys stay in a runner-side proxy;
- the published-install live check passed end to end.

What remains is deciding who gets it.

**Flipping the default has a cost on every run.** Hosted runners are fresh, so every isolated run pays a cold `useradd`. That took 36.8 s of a 61 s run in the live check, and 30-100 s in earlier runs. The Action runs about 3,800 times in two weeks.

**A flip would also break callers on upgrade.** These all fail closed under isolation:
- checkouts that persist credentials (11 of the 27 caller files);
- self-hosted runners, macOS runners and container jobs;
- `uses: ./` installs;
- `lfs: true` checkouts.

Every one of them would need an edit.

**Who uses the Action.** 26 repos call it. All but two are under the operator's own orgs (marcusrbrown, fro-bot, bfra-me). The two external ones are `qunqin24/opendock` and `thejustinwalsh/three-flatland`.

**Isolation protects most where the model holds credentials.** Comment, review and issue triggers already keep the GitHub token from the model, so there isolation only adds key hiding. On provision-mode `schedule` and `workflow_dispatch` runs, the model holds a write PAT and the provider key.

---

## Requirements

**Decision and docs**
- R1. The `isolate-agent` default stays `false`. No breaking release.
- R2. The README and the canonical isolate-agent section recommend `isolate-agent: true` for credentialed runs. They also state the per-run account-setup cost.
- R3. #2135 closes with a pointer to this decision once R1 and R2 land. It does not wait for the rollout.

**Rollout**
- R4. Every compatible owned workflow turns isolation on for its credentialed runs. On those runs the agent job's checkout must have `persist-credentials: false`: add it where it's missing, or change an existing expression so it evaluates false on those triggers. Two kinds of workflow stay out:
  - fro-bot/agent's own self-review job, which installs from `uses: ./`, and isolation refuses that.
  - Workflows whose model runs runner-home toolchains, such as panthea and ddr with `~/.cargo`. They opt in only once the toolchain works under isolation, or once losing it is accepted for that workflow.
- R5. In a job that serves several triggers, isolation turns on for the credentialed triggers only. Comment, review and issue runs in that job keep today's behavior.
- R6. Each workflow that pushes from the model's run (`output-mode: branch-pr`) proves pushing still works under isolation with `persist-credentials: false` before its opt-in PR merges. The proof is a `workflow_dispatch` of the opt-in PR's branch. Today that means fro-bot/.github's remediate job and infra's `fro-bot-storage` job.
- R7. survey-repo, which runs several isolated steps in one job, opts in only after #2186 is fixed. In #2186, an earlier step's post hook can upload a later isolated step's sandbox-written log.
- R8. Opting in a workflow is a normal PR in that repo. A workflow still pinned below v0.141.0 bumps its pin in the same PR.

---

## Acceptance Examples

- AE1. **Covers R4, R5.** Given a repo whose single Fro Bot job serves comment, schedule and dispatch triggers, a scheduled run executes isolated, and a comment-triggered run in the same job doesn't.
- AE2. **Covers R6.** Given fro-bot/.github's remediate job (`output-mode: branch-pr`), a `workflow_dispatch` of its opt-in branch runs isolated and opens its branch and PR. Only then does the opt-in PR merge.

---

## Success Criteria

- Every compatible owned credentialed run executes isolated, and none of them breaks. The gated workflows (R6, R7) count once their gate clears.
- No caller breaks on upgrade.
- #2135 is closed.

---

## Scope Boundaries

- Flipping the default. Revisit it if account setup stops costing 30-100 s per run, for example by creating the account at image level or reusing a prebuilt uid.
- An `auto` mode that silently falls back to running without isolation.
- Opting in comment, review and issue flows. They already keep the GitHub token from the model. Revisit only if one of them starts giving the model write credentials.
- Changing external callers' workflows.

---

## Key Decisions

- **Explicit opt-in over a default flip.** The operator's callers get the same coverage where credentials are at stake, nothing breaks, and the setup cost is spent only there.
- **No `auto` mode.** Silently falling back to running without isolation is a guarantee that disappears without anyone noticing.
- **Credentialed triggers first.** That's where a leaked token or key would cost the most.
- The isolate-agent and key-proxy plans are recorded as active in `docs/plans/2026-11-10-001-feat-isolate-agent-uid-plan.md` and `docs/plans/2026-11-13-001-feat-isolate-agent-key-proxy-plan.md`. This doc covers the rollout they both left open.

---

## Dependencies / Assumptions

- #2186 is fixed before R7.
- A per-trigger input value works for R5, for example an expression on `github.event_name`. This is unverified until the first mixed-trigger opt-in.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R6][Needs research] How the model pushes in provision mode under isolation with `persist-credentials: false`. The candidates are the provisioned `gh` config, `gh auth setup-git`, and the Action's own push. Confirm it in the remediate live run.
- [Affects R4, R8][Technical] The exact list of credentialed owned workflows and the order of their PRs. The 2026-11-13 caller inventory is the starting point. It scanned only the `fro-bot` and `marcusrbrown` owners, so the `bfra-me` callers still need inventorying.
- [Affects R5][Technical] What a mixed-trigger job falls back to if a per-trigger input value doesn't work. One option is a separate credentialed job.

---

## Sources / Research

- The caller inventory of 27 workflow files across owned repos (2026-11-13).
- A GitHub code search for `fro-bot/agent@` in `.github/workflows` found 26 repos.
- The published-install live check on v0.141.0, fro-bot/.github run 43528290791.
- Issue #2135. Issue #2186.
