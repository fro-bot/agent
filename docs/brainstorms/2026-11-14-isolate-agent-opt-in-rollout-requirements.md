---
date: 2026-11-14
topic: isolate-agent-opt-in-rollout
---

# isolate-agent: keep it opt-in, and opt in on every compatible owned caller

## Summary

`isolate-agent` stays opt-in. Every compatible workflow the operator owns turns it on explicitly, on every trigger. The README recommends the input for any run whose `github-token` has write access. #2135 closes when this decision and the docs land, before the rollout finishes.

---

## Problem Frame

v0.141.0 isolation is complete:
- the model runs as its own user;
- provider keys stay in a runner-side proxy;
- the published-install live check passed end to end.

What remains is deciding who gets it.

**Without isolation, every trigger exposes the Action's token.** On comment, review and issue triggers, withholding keeps `github-token` out of the model's environment and `gh` config. The model still runs as the same user as the Action, so it can read `INPUT_GITHUB-TOKEN` from the Action's `/proc/<pid>/environ` on any trigger. On the operator's callers that token is usually a write-capable PAT. PR and comment runs also read PR diffs and comment text, which is the likelier route for prompt injection. Schedule and dispatch runs read mostly the repo's own content.

**Flipping the default costs every caller.** Hosted runners are fresh, so every isolated run pays a cold `useradd`: 36.8 s of a 61 s run in the live check, and 30-100 s in earlier runs. The Action runs about 3,800 times in two weeks. A flip would also break callers on upgrade, because these fail closed under isolation:
- checkouts that persist credentials (11 of the 27 caller files);
- self-hosted runners, macOS runners and container jobs;
- `uses: ./` installs;
- `lfs: true` checkouts.

Every one of them would need an edit.

**Who uses the Action.** 26 repos call it. All but two are under the operator's own orgs (marcusrbrown, fro-bot, bfra-me). The two external ones are `qunqin24/opendock` and `thejustinwalsh/three-flatland`.

---

## Requirements

**Decision and docs**
- R1. The `isolate-agent` default stays `false`. No breaking release.
- R2. The README and the canonical isolate-agent section say that without isolation the agent can read the Action's `github-token` on every trigger. They recommend `isolate-agent: true` for any run whose token has write access, and state the per-run account-setup cost as the price.
- R3. #2135 closes with a pointer to this decision once R1 and R2 land. It does not wait for the rollout.

**Rollout**
- R4. Every compatible owned workflow sets `isolate-agent: true` on every trigger. The agent job's checkout must have `persist-credentials: false` on every trigger. Add it where it's missing, or change an existing expression so it is false everywhere. Two kinds of workflow stay out:
  - fro-bot/agent's own self-review job, which installs from `uses: ./`, and isolation refuses that.
  - Workflows whose model runs runner-home toolchains, such as panthea and ddr with `~/.cargo`. They opt in only once the toolchain works under isolation, or once losing it is accepted for that workflow.
- R5. Each workflow that pushes from the model's run (`output-mode: branch-pr`) proves that pushing still works under isolation with `persist-credentials: false` before its opt-in PR merges. The proof is a `workflow_dispatch` of the opt-in PR's branch. Today that means fro-bot/.github's remediate job and infra's `fro-bot-storage` job.
- R6. survey-repo, which runs several isolated steps in one job, opts in only after #2186 is fixed. In #2186, an earlier step's post hook can upload a log written by a later isolated step's sandbox.
- R7. Opting in a workflow is a normal PR in that repo. A workflow still pinned below v0.141.0 bumps its pin in the same PR.

---

## Acceptance Examples

- AE1. **Covers R4.** Given a repo whose single Fro Bot job serves comment, review, schedule and dispatch triggers, a run on each of those triggers executes isolated and completes.
- AE2. **Covers R5.** Given fro-bot/.github's remediate job (`output-mode: branch-pr`), a `workflow_dispatch` of its opt-in branch runs isolated and opens its branch and PR. Only then does the opt-in PR merge.

---

## Success Criteria

- Every compatible owned workflow runs isolated on every trigger, and none of them breaks. The gated workflows (R5, R6) count once their gate clears.
- No caller breaks on upgrade.
- #2135 is closed.

---

## Scope Boundaries

- Flipping the default. Revisit it if account setup stops costing 30-100 s per run, for example by creating the account at image level or reusing a prebuilt uid.
- An `auto` mode that silently falls back to running without isolation.
- Changing external callers' workflows.

---

## Key Decisions

- **Explicit opt-in over a default flip.** The operator's callers get full coverage, nothing breaks on upgrade, and external callers choose for themselves. Opted-in workflows pay the setup cost on every run, and that cost is the accepted price of closing the token leak.
- **Every trigger, not only credentialed ones.** The `/proc` read works on every trigger, so withholding is no substitute. The triggers that read PR and comment content are where injection is likeliest.
- **No `auto` mode.** Silently falling back to running without isolation is a guarantee that disappears without anyone noticing.
- The isolate-agent and key-proxy plans are recorded as active in `docs/plans/2026-11-10-001-feat-isolate-agent-uid-plan.md` and `docs/plans/2026-11-13-001-feat-isolate-agent-key-proxy-plan.md`. This doc covers the rollout they both left open.

---

## Dependencies / Assumptions

- #2186 is fixed before R6.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R5][Needs research] How the model pushes in provision mode under isolation with `persist-credentials: false`. The candidates are the provisioned `gh` config, `gh auth setup-git`, and the Action's own push. Confirm it in the remediate live run.
- [Affects R4, R7][Technical] The exact list of compatible owned workflows and the order of their PRs. The 2026-11-13 caller inventory is the starting point. It scanned only the `fro-bot` and `marcusrbrown` owners, so the `bfra-me` callers still need inventorying.

---

## Sources / Research

- The caller inventory of 27 workflow files across owned repos (2026-11-13).
- A GitHub code search for `fro-bot/agent@` in `.github/workflows` found 26 repos.
- The published-install live check on v0.141.0, fro-bot/.github run 43528290791.
- Issue #2135. Issue #2186.
