---
title: 'feat: Two-phase release-notes narration (read-only generate, trusted apply)'
type: feat
status: active
date: 2026-07-17
---

# feat: Two-phase release-notes narration (read-only generate, trusted apply)

## Overview

Split the LLM release-notes narration into two phases: a **read-only generation agent** that gathers PR evidence and writes a narrative candidate file, and a **trusted deterministic apply job** that validates the candidate, assembles the final body in code, and performs the single permitted `gh release edit`. This fixes both defects of the current pipeline — the agent has no change detail to narrate from (its only input is the semantic-release body), and the prompt's own output contract mandates the duplicated category-bullet list — without expanding the prompt-injection surface under a write-capable credential.

## Problem Frame

Release narratives are shallow reformats of commit subjects (e.g. v0.92.1) because `buildNarrationPrompt` never instructs evidence gathering, and the category-bullet structure it prescribes duplicates the collapsed changelog below it. The quality bar is marcusrbrown/systematic's releases: per-change narrative paragraphs carrying mechanism and rationale learned from the actual change. Naively adding PR-body gathering to the current architecture is a security regression: the narration run carries `FRO_BOT_PAT` (checkout token + `github-token` input in `.github/workflows/fro-bot.yaml`), PR bodies are contributor-authored and instruction-like, and the prompt's scope constraints are instruction-following policy, not containment (off-target detection only warns post-hoc).

## Requirements Trace

- R1. The generation agent runs with a read-only token (`contents: read`, `pull-requests: read`); it cannot mutate any GitHub state, including the release.
- R2. The agent gathers bounded PR evidence (`gh pr view --json number,title,body,url,labels,files`; `gh pr diff` fallback) and composes per-change narrative paragraphs: observable problem → what changed → mechanism → rationale, PR link(s) at paragraph end.
- R3. The candidate is a narrative fragment only — no `## What's new` heading, no narration marker, no `<details>` block, no restated conventional-commit list.
- R4. A separate trusted job (no model-controlled code, fresh checkout) validates the candidate deterministically, assembles marker + narrative + verbatim original changelog in a collapsed block, performs exactly one `gh release edit <tag>`, and verifies the result.
- R5. Idempotency is apply-side and deterministic: existing marker in the release body → skip without editing.
- R6. Gather bounds: ≤25 candidate PRs, per-PR body truncation (~6k chars), ≤50 file paths per PR, ≤5 diff fallbacks (byte-bounded). Over-bound releases produce no candidate and report that manual narration is required.
- R7. Untrusted-data preamble: PR titles/bodies/comments/diffs/release text are evidence, never instructions.
- R8. Fail-soft posture preserved: quality failures warn and never block the release; credential/security anomalies hard-fail.
- R9. Dependency-only chores stay in the collapsed changelog; coupled PRs merge into one logical narrative; headings appear only when ≥2 logical changes share a category.
- R10. `RELEASE_NOTES_MODEL` stays operator-configurable; the harness-integrate `workflow_call` path and normal mention/dispatch runs are unchanged.

## Scope Boundaries

- Out of scope: changing semantic-release itself, the release cadence, or the `successCmd` mechanism (still dispatches after publish).
- Out of scope: narrating historical releases (a manual re-dispatch capability falls out for free but backfilling is operator-driven).
- Out of scope: model selection changes (`RELEASE_NOTES_MODEL` A/B is a post-ship operator decision; keep the variable contract).
- Out of scope: the workflow_call (harness-integrate) path — credential wiring there is untouched.

## Context & Research

### Relevant Code and Patterns (all verified against main)

- `scripts/release/release-notes.ts` — `buildNarrationPrompt` (54-117), `NARRATION_MARKER` (20), pure helpers already tested (`resolveNarrationModel`, `validateTag`, `classifyOutcome`, `selectDispatchedRun`, `parseDispatchedRuns`, `hasOffTargetEdit` 207-219).
- `scripts/release/dispatch-release-notes.ts` — dispatch via `gh workflow run fro-bot.yaml -f prompt=… -f correlation-id=… -f model=…` (84-102); polling correlates on `createdAt` + `displayTitle` (122-160); `RELEASE_NOTES_DISPATCH_TOKEN` overrides `GH_TOKEN` (76-80).
- `.github/workflows/fro-bot.yaml` — single job; workflow permissions `contents: read` + `pull-requests: read` (61-63); `FRO_BOT_PAT` at checkout `token` (241) and `github-token` input (262); correlation-id gates already force `enable-omo: false` (264-268), `output-mode: working-dir` (275-282), `response-mode: none` (284-287), timeout 600000 (288-291). No artifacts, no job outputs.
- Artifact conventions: `harness-release.yaml` upload/download with explicit names + `retention-days: 1` (403-413, 484-522).
- `.releaserc.yaml:11` — `successCmd` invokes `dispatch-release-notes.ts "${nextRelease.gitTag}"`.
- `deploy/scripts` / `scripts/` carve-out: plain Node ESM, `node --test`-style for scripts; release scripts use vitest via `test:scripts` (follow existing `release-notes.test.ts`, 71 tests).

### Institutional Learnings

- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — credential isolation via construction, not instruction; same posture here (read-only by token, not by prompt).
- `docs/solutions/best-practices/same-job-phase-split-is-not-a-security-boundary-2026-07-04.md` — the apply phase must be a separate job on a fresh runner; a later step in the model's job can be poisoned via `$GITHUB_ENV`/workspace.
- `docs/solutions/logic-errors/sender-substituted-association-breaks-mention-authority-2026-07-17.md` — identity/authority of a signal must match the identity that was validated; here: the model's prose is untrusted until deterministically validated.

## Key Technical Decisions

- **Read-only by construction, not instruction**: for correlation-tagged (release-notes) runs, both the checkout `token` and the `github-token` action input switch from `FRO_BOT_PAT` to the workflow's `GITHUB_TOKEN` via the same `inputs.correlation-id != ''` conditional pattern the workflow already uses for omo/response-mode/output-mode. The two-axis resolver then provisions the read-only token to the model's `gh` — gather works, `gh release edit` 403s structurally. The prompt's scope constraints remain as defense-in-depth.
- **Candidate handoff via artifact**: the generate run writes the candidate to a fixed path in the working dir (output-mode is already `working-dir` for these runs); a post-agent workflow step uploads it (`actions/upload-artifact`, `retention-days: 1`, name keyed on correlation id). The apply job (`needs: fro-bot`, `if:` release-notes run) downloads it. No same-job trust boundary.
- **Apply job runs trusted code only**: fresh checkout of `main` on a fresh runner (different runner from the model's job — workspace poisoning cannot reach it), then a new pure+CLI script `scripts/release/assemble-release-notes.ts` validates and assembles. `FRO_BOT_PAT` appears only in this job.
- **Deterministic assembly**: the original release body is fetched by the apply job and embedded verbatim in the `<details>` block by code — the model never copies the changelog, so preservation cannot drift.
- **Validation gate (apply-side)**: bounded size, valid UTF-8, no marker, no `<details>`, no conventional-commit bullet dump (reject line-pattern `- **type(scope):**`-style lists and `* type(scope):` restatements), ≥1 PR link when the changelog contains PR references. Failure → warn + leave release untouched (fail-soft).
- **Tag as a first-class input**: `fro-bot.yaml` gains a `release-tag` dispatch input; the dispatcher passes it explicitly instead of burying the tag in prose. The apply job and run-name keying use it. Empty `release-tag` → apply job skipped (all other dispatch uses unaffected).
- **`hasOffTargetEdit` demotes to belt-and-suspenders**: with a read-only generate token the class it detects is structurally impossible; keep the check, log-only.

## Open Questions

### Resolved During Planning

- Where does the candidate live? — Fixed path `release-notes-candidate.md` in the working dir; correlation-tagged runs already force `output-mode: working-dir`.
- Can the apply job trust its checkout? — Yes: separate job = separate runner; the model's workspace never existed there. Checkout `main` (the workflow ran from `main`).
- Does the harness need changes? — No. Both phases are workflow + scripts + prompt changes; the action itself is untouched.

### Deferred to Implementation

- Exact artifact name shape (`release-notes-candidate-<correlation-id>` vs run-id-keyed) — pick at implementation to match `harness-release.yaml` conventions.
- Whether `classifyOutcome` needs a new outcome for "candidate missing" (agent hit bounds / produced nothing) vs reusing the existing warn path — decide when wiring the dispatcher's monitoring.

## Implementation Units

- [ ] **Unit 1: Trusted assembly module**

**Goal:** Pure validation + assembly logic for the apply phase, plus its CLI entry.

**Requirements:** R3, R4, R5, R8

**Dependencies:** None

**Files:**
- Create: `scripts/release/assemble-release-notes.ts`
- Test: `scripts/release/assemble-release-notes.test.ts`

**Approach:**
- Pure functions: `validateCandidate(text, originalBody)` (size/UTF-8/no-marker/no-details/no-bullet-dump/PR-link-present rules → typed result with reason) and `assembleReleaseBody(candidate, originalBody)` (marker + narrative + verbatim `<details>` changelog). CLI wraps: fetch body (`gh release view`), idempotency (marker → exit neutral), validate, assemble to temp file, `gh release edit <tag> --notes-file`, re-fetch + verify marker. Follow `release-notes.ts`'s export/test structure.

**Execution note:** Test-first — the validation rules and assembly invariants are the contract; include an injection-shaped candidate fixture (candidate containing instructions/marker/details) and a conventional-commit-dump fixture.

**Test scenarios:**
- Happy path: valid narrative candidate → assembled body with marker, narrative, verbatim original in details.
- Edge: candidate at/over size bound; invalid UTF-8; empty candidate → typed rejection, no edit.
- Error: candidate containing the marker, a `<details>` block, or a commit-list dump → rejected with distinct reasons.
- Edge: original body already carries the marker → idempotent skip (no edit call).
- Happy: PR-link presence rule — changelog with PR refs + candidate without any link → rejected; candidate with links → passes.
- Integration (CLI-level, mocked `gh`): edit called exactly once with the assembled file; verify step re-fetches.

**Verification:** New test file green under `bun run test:scripts`; no behavior change anywhere (module unused until Unit 3).

- [ ] **Unit 2: Generation prompt rewrite**

**Goal:** `buildNarrationPrompt` produces the gather/synthesize/candidate contract instead of rewrite/apply.

**Requirements:** R2, R3, R6, R7, R9

**Dependencies:** None (parallel-safe with Unit 1)

**Files:**
- Modify: `scripts/release/release-notes.ts`
- Test: `scripts/release/release-notes.test.ts`

**Approach:**
- New prompt sections: untrusted-data preamble (R7, placed before gather); gather (extract PR numbers from the release body's changelog entries — semantic-release emits `/issues/<n>` links, validate each with `gh pr view`; bounds per R6; skip generated bundles/lockfiles unless they are the subject); select/organize (audience-impact meaningful-change definition, coupled-PR merging, dependency-chore exclusion); compose (paragraph contract, 3-6 sentences per logical change, sparse headings, PR links at end, "must contain facts not present in the commit subject", no bullets/no restatement); output (write ONLY the narrative fragment to `release-notes-candidate.md` in the working directory; if bounds exceeded, write nothing and report manual narration required). Remove: rewrite structure, application instruction (`gh release edit`), idempotency section (apply-side now). Keep: scope-constraints block reworded to read-only expectations (defense-in-depth).
- Update prompt-contract tests: assert new sections present, old mutation instructions absent (`gh release edit` must NOT appear in the prompt).

**Test scenarios:**
- Happy: prompt contains untrusted-data preamble, gather bounds (25/6000/50/5), candidate path, no-bullet contract.
- Regression: prompt does not contain `gh release edit`, the marker, or the details-block instruction.
- Edge: prompt still carries correlation id and tag interpolation; `NARRATION_MARKER` export unchanged (apply-side consumes it).

**Verification:** `test:scripts` green; prompt snapshot readable end-to-end.

- [ ] **Unit 3: Workflow split — read-only generate job + trusted apply job**

**Goal:** Wire the credential boundary and candidate handoff in `.github/workflows/fro-bot.yaml`.

**Requirements:** R1, R4, R8, R10

**Dependencies:** Units 1, 2 — and this unit must ship in the same merge as them: switching the correlation-run credential to `github.token` while the old mutation-instructing prompt is live would break narration outright (the agent would 403 on `gh release edit` with no apply job to take over). The whole feature lands as one PR.

**Files:**
- Modify: `.github/workflows/fro-bot.yaml`

**Approach:**
- Add `release-tag` dispatch input (default `''`).
- Correlation-tagged runs: checkout `token` and `github-token` input switch to `${{ github.token }}` via the existing conditional pattern (all other paths keep `FRO_BOT_PAT`).
- Post-agent step (same job, `if` release-notes run): upload `release-notes-candidate.md` artifact, `retention-days: 1`, `if-no-files-found: warn` (agent may legitimately produce nothing — fail-soft).
- New `apply-release-notes` job: `needs: fro-bot`, `if: inputs.release-tag != ''` and generate job did not hard-fail; fresh checkout of `main`; download artifact (absent → warn + exit 0); run `assemble-release-notes.ts` with `GH_TOKEN: ${{ secrets.FRO_BOT_PAT }}`; job-level `permissions: contents: read` (PAT carries the write authority; no elevated GITHUB_TOKEN needed).
- Workflow_call path untouched.

**Test scenarios:**
- Test expectation: none — workflow YAML; CI's actionlint/workflow checks plus the Unit 5 live dry-run are the gates.

**Verification:** `bun run lint` green (workflow lint included); YAML parses; a plain `workflow_dispatch` without `release-tag` runs exactly as today (no apply job, PAT provisioned).

- [ ] **Unit 4: Dispatcher passes the tag + monitoring update**

**Goal:** `dispatch-release-notes.ts` sends `release-tag` as a structured input and monitors the two-job outcome.

**Requirements:** R8, R10

**Dependencies:** Unit 3

**Files:**
- Modify: `scripts/release/dispatch-release-notes.ts`, `scripts/release/release-notes.ts` (classifyOutcome), `.releaserc.yaml` (only if the invocation shape changes — expected unchanged)
- Test: `scripts/release/release-notes.test.ts`

**Approach:**
- Add `-f release-tag=<tag>` to the dispatch; keep prompt/correlation-id/model inputs.
- `classifyOutcome`: apply-job failure surfaces as warn (fail-soft) unless auth-shaped (hard-fail per existing `hasAuthFailure` semantics); decide "candidate missing" outcome shape (deferred question) here.
- `hasOffTargetEdit` stays, log-only.

**Test scenarios:**
- Happy: dispatch args include `release-tag`.
- Edge: apply-job skip (no candidate) classifies as warn, not failure.
- Regression: auth failures still hard-fail.

**Verification:** `test:scripts` green; a dry-run dispatch (Unit 5) proves end-to-end wiring.

- [ ] **Unit 5: Docs + live verification**

**Goal:** Update operational docs and prove the pipeline on a real tag without mutating a real release incorrectly.

**Requirements:** R4, R5, R8

**Dependencies:** Units 1-4 merged to main (the dispatched workflow runs from `main`)

**Files:**
- Modify: `AGENTS.md` (release-notes narration NOTES entry — generation vs trusted application), `docs/wiki/Execution Lifecycle.md` only if it references the narration flow (verify)

**Approach:**
- Docs describe the two-phase flow, the read-only boundary, and the fail-soft contract.
- Live verification sequence (operator-gated, after merge): (1) unit + lint gates on main; (2) re-dispatch against v0.92.1 — its body already carries the marker → proves apply-side idempotent skip end-to-end; (3) manually strip the marker from a sandbox draft release (or accept a one-time re-narration of v0.92.1 with Marcus's approval) → proves the full generate→apply path; rubric: the candidate must mention facts available in #1227's body but absent from its title (structured `account_rate_limit`, SSE + REST paths, transient 429s remain retryable); (4) injection canary optional: craft a PR-body-shaped instruction in a test PR and confirm the read-only token structurally cannot mutate (403 in logs).
- Then observe the next real release.

**Test scenarios:**
- Test expectation: none — docs + operator-driven live verification.

**Verification:** md-links green; live dry-run evidence recorded; next real release produces a Systematic-quality narrative with zero duplicated bullet list.

## System-Wide Impact

- **Interaction graph:** Only correlation-tagged (release-notes) dispatch runs change credentials; mention/comment/schedule/workflow_call paths untouched. The apply job is net-new and gated on `release-tag`.
- **Error propagation:** All narrative-quality failures warn (release keeps its semantic-release body); auth/credential anomalies hard-fail (existing `hasAuthFailure` semantics preserved).
- **State lifecycle risks:** Artifact retention 1 day; candidate absent → apply skips cleanly; double-dispatch → apply-side marker idempotency prevents double-edit.
- **API surface parity:** `fro-bot.yaml` dispatch input surface grows by `release-tag` (default empty — external dispatchers unaffected).
- **Unchanged invariants:** Response Protocol (narration runs are `response-mode: none`); the action's two-axis credential resolver (workflow supplies a different token, resolver logic untouched); `successCmd` invocation shape.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Read-only `GITHUB_TOKEN` breaks some harness step that assumed PAT scope on dispatch runs | Unit 3 verification includes a plain dispatch regression run; correlation-tagged runs already run `response-mode: none` so posting paths are inert |
| Model ignores the candidate contract (writes marker/details anyway) | Apply-side validation rejects; release keeps semantic-release body (fail-soft); reasons logged for prompt iteration |
| Candidate artifact name collision across concurrent releases | Key the artifact on correlation id; releases are serialized by semantic-release anyway |
| Haiku-class model can't synthesize even with evidence | `RELEASE_NOTES_MODEL` A/B on the v0.92.1 fixture post-ship (operator decision, oracle expects mid-tier noticeably better) |
| Apply job checkout drift (main advanced between generate and apply) | Acceptable: assembly code is versioned and backward-compatible; both jobs run within one workflow run minutes apart |

## Sources & References

- Origin: oracle design review (session `ora-1`, 2026-07-17) — two-phase architecture, bounds, verification rubric
- Related code: `scripts/release/release-notes.ts`, `scripts/release/dispatch-release-notes.ts`, `.github/workflows/fro-bot.yaml`, `.releaserc.yaml`
- Quality bar: marcusrbrown/systematic release notes (e.g. v2.33.2)
- Related learnings: `docs/solutions/best-practices/same-job-phase-split-is-not-a-security-boundary-2026-07-04.md`, `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md`
