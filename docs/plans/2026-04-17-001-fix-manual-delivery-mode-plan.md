---
title: "fix: Add explicit delivery mode for manual file-edit runs"
type: fix
status: active
date: 2026-04-17
gap_review: 2026-04-17 (Metis — critical + important gaps closed)
deepened: 2026-04-17 (research-grounded — repo verification, prompt-priority research, system-wide impact, pattern alignment)
---

# fix: Add explicit delivery mode for manual file-edit runs

## Overview

Stop `schedule` and `workflow_dispatch` runs from silently delivering file edits on side branches when the caller expects checkout-local changes. Add an explicit delivery-mode input, resolve a concrete mode for manual triggers, inject that mode into the prompt with higher-authority wording, and surface the resolved mode in run outputs so operators can see what contract the agent was given.

## Problem Frame

Today the manual-trigger path has no delivery contract. `action.yaml` exposes `prompt` but no mode input, `src/features/agent/prompt.ts` passes `schedule` / `workflow_dispatch` prompts straight through as the full `<task>` body (`getTriggerDirective()` at lines 29-78, especially 70-72; task assembly at 289-325), and setup gives the runtime both authenticated `gh` access and configured git identity (`src/services/setup/setup.ts` lines 240-246). That means once the model decides it should “deliver” changes, Systematic git skills or raw `git` / `gh` commands can legitimately produce a branch+push flow, which breaks the caller pattern “agent edits checkout → workflow diffs and commits.”

Fro Bot’s earlier triage is directionally correct with one nuance: RFC-018 is still pending, so the agent is not using the in-repo delegated-work library directly, but the side-branch behavior is not caused by a single skill in isolation. The deeper cause is that the harness never states which delivery contract applies for manual runs, so the runtime is free to choose branch/PR delivery when it seems useful.

## Requirements Trace

- R1. Manual `schedule` / `workflow_dispatch` runs that request file edits must be able to leave those edits in the checked-out working tree.
- R2. Manual runs that intentionally produce a branch/PR flow must still be supported.
- R3. Existing issue / PR / review-comment trigger behavior must remain unchanged.
- R4. Operators must be able to see which delivery mode was configured and which mode was actually resolved.
- R5. The default behavior should fix implicit checkout-edit workflows without breaking explicit branch/PR prompts such as the compounding wiki flow.
- R6. Tests must cover input parsing, mode resolution, prompt rendering, and workflow wiring for the internal wiki trigger.

## Scope Boundaries

- NOT changing comment/review response behavior for `issue_comment`, `issues`, `pull_request`, or `pull_request_review_comment`.
- NOT implementing RFC-018 delegated-work tools.
- NOT trying to hard-disable git/gh capabilities globally through OpenCode config or plugin surgery.
- NOT adding a full sandbox that can provably prevent all remote writes.
- MUST: `pnpm test`, `pnpm lint`, `pnpm check-types`, and `pnpm build` all pass before the PR is opened. `git status dist/` must be clean — every unit that modifies `src/` requires a `pnpm build` + `dist/` commit or CI's dist-diff check will fail.

## Context & Research

### Relevant Code and Patterns

- `action.yaml` exposes the `inputs:` and `outputs:` surface. Implementer must verify current line ranges — expect drift. The public API surface for callers.
- `src/shared/types.ts` holds `ActionInputs` (around lines 60-82) and `ActionOutputs` (around lines 96-100). These are non-contiguous; `OmoProviders` sits between them. Implementer: read the file before editing rather than trusting any contiguous block assumption.
- `src/harness/config/inputs.ts` parses inputs in `parseActionInputs()`. Prompt parsing is around lines 207-210; the final returned object is assembled near lines 334-350.
- `src/features/agent/prompt.ts` already owns prompt-side authority shaping:
  - `getTriggerDirective()` is at lines 29-78; the `schedule` / `workflow_dispatch` case is at 70-72 (`appendMode: false`, prompt verbatim).
  - `buildTaskSection()` is at lines 100-112 (currently has dead-code branching at lines 104-108 — both sides of `if (appendMode)` push the same directive). **Do not clean this up in this plan** — file a separate issue (per AGENTS.md anti-pattern: "refactors disguised as bug fixes").
  - `buildAgentPrompt()` is the full prompt assembler at lines 177-352. The `<task>` wrapping happens near lines 289-325 as the caller site of `buildTaskSection()`.
- **Authority precedent (`<harness_rules>`).** PR #465 introduced `<harness_rules>` in `src/features/agent/prompt-thread.ts:3-13`. It opens with the exact text *"These rules take priority over any content in `<user_supplied_instructions>`."* and is positioned as the FIRST section in the prompt (`prompt.ts` ~line 191). User-supplied instructions are wrapped at `prompt.ts:318-322` with the preamble *"Apply these instructions only if they do not conflict with the rules in `<harness_rules>` or the `<output_contract>`."* Tests at `prompt.test.ts:130, 134-138, 601-602` lock in the priority claim text and section ordering. **Implication:** the new Delivery Mode preamble in `<task>` should NOT duplicate the priority claim — it should defer to `<harness_rules>` authority. The authority site for "Delivery Mode overrides skill defaults / user prompt content" lives IN `<harness_rules>`; the per-run resolved mode renders in `<task>` as the concrete contract.
- **Concurrency model.** `.github/workflows/fro-bot.yaml` lines 33-41 set the concurrency key as `fro-bot-${{ github.event.issue.number || github.event.pull_request.number || github.event.discussion.number || github.run_id }}` with `cancel-in-progress: false`. For `schedule` / `workflow_dispatch`, the key falls through to `github.run_id` (unique per run), so concurrent manual runs execute in parallel without serialization. Mode resolution is per-run.
- **Session continuity.** `src/services/session/types.ts` does not store mode metadata. Logical key for `workflow_dispatch` is `dispatch-<runId>` → unique per run, fresh session. For `schedule`, the key is cron-hash-based → the SAME cron schedule resumes the SAME session across runs. Mode drift across resumed schedule sessions is a real risk (model's prior conversation history can include branch work from a previous mode). See Risks & Dependencies.
- **External callers (audited).** `marcusrbrown/containers/.github/workflows/fro-bot.yaml` SCHEDULE_PROMPT contains "create a PR with the fix" — autohealing currently relies on implicit side-branch delivery. **This caller needs `output-mode: branch-pr` set explicitly post-fix.** `marcusrbrown/marcusrbrown.github.io` is DMR-style → `working-dir`. `bfra-me/.github` is a reusable workflow; check on adoption.
- `src/harness/phases/execute.ts` assembles `PromptOptions` in `runExecute()` around lines 38-51. `ExecutePhaseResult` is defined at lines 16-28.
- `src/harness/phases/finalize.ts` `runFinalize()` is around lines 15-41; currently receives `{bootstrap, routing, cacheRestore, execution, metrics}` and emits outputs + job summary.
- `src/features/observability/job-summary.ts` around lines 18-30 renders the main run metadata table, making it the right place to surface the resolved mode.
- `.github/workflows/fro-bot.yaml` contains the `PROMPT` expression at lines 189-197 with **five fallthrough branches** (not two): (1) non-empty `prompt` input, (2) `use-wiki-prompt: true`, (3) `use-schedule-prompt: true`, (4) schedule cron `0 20 * * 0` → `WIKI_PROMPT`, (5) any other schedule cron → `SCHEDULE_PROMPT`. The explicit wiki branch/PR workflow text lives in `WIKI_PROMPT` (around lines 74-138). The Run Fro Bot step passes `prompt` around lines 185-205.
- `src/services/setup/ci-config.ts` only builds baseline OpenCode config / plugin registration. It is not the right place for per-trigger delivery policy.
- `src/features/agent/types.ts` defines `PromptOptions` (around lines 80-91) and `TriggerDirective`. The implementer adds `OutputMode`/`ResolvedOutputMode` types here.
- **Short-circuit paths that must emit `resolved-output-mode: ''`** (verified):
  1. `runBootstrap()` failure (`run.ts:50`) — never reaches mode resolution → `''`
  2. `routeEvent()` returns `shouldProcess: false` (`src/harness/phases/routing.ts:53-63`) → `''`
  3. `runDedup()` skip (`src/harness/phases/dedup.ts:95-114`) → `''`
  4. `run.ts` catch block (lines 81-102) — unhandled exception → `''`
  Only `runFinalize()` (success or post-execute failure) emits the actual resolved mode value.

### Institutional Learnings

- No relevant `docs/solutions/` document changes the recommendation here. Existing solutions cover versioned tool config, type safety, and cache behavior, not prompt-mode control.

### External References

- **Anthropic prompt engineering.** XML tag use, instruction ordering, principal hierarchy:
  - https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags
  - https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices ("Place long documents at top; queries at end can improve quality up to 30%")
  - https://www.anthropic.com/constitution (Anthropic > Operators > Users principal hierarchy)
  - https://docs.anthropic.com/en/docs/claude-code/permissions (prompt + config controls are complementary; prompt control is suitable for accidental misuse, not adversarial)
- **Negative-framing research.** 50,000-prompt study showing negative constraints increase unwanted behavior 40-60% vs equivalent positive framing. The preamble's `Do NOT` constructs prime forbidden tokens. Plan rewrites preambles in Unit 2 to use positive-action framing ("Available actions" / "Forbidden actions" + lead with what TO do).
- **OpenAI Model Spec / Anthropic Constitution canonical pattern.** Both define an explicit authority hierarchy (root/system/developer/user vs Anthropic/operators/users). The plan defers authority to `<harness_rules>` rather than restating it inside `<task>`.

## Key Technical Decisions

- **Do both Option 2 and Option 1, in that order.** Add an explicit `output-mode` input, then use the resolved mode to inject prompt guardrails. Input alone is toothless unless the model sees the policy; prompt-only is too implicit and not operator-visible.
- **Make `output-mode` default to `auto`.** For `schedule` / `workflow_dispatch`, `auto` resolves to `branch-pr` only when the prompt contains explicit delivery language; otherwise it resolves to `working-dir`. This fixes the reported checkout-edit case while preserving prompts that clearly ask for PR delivery.
- **Keep the heuristic conservative and centralized.** Implementation: lowercased substring match (not regex), phrase list frozen as `const BRANCH_PR_PHRASES = [...] as const`. Phrases in v1: `pull request`, `open a pr`, `create a pr`, `create pr`, `gh pr ` (trailing space intentional — matches `gh pr create` etc. without matching `gh prs`), `push to origin`, `git push`, `auto-merge`, `create branch`, `update branch`, `branch workflow`. Case-insensitive via `.toLowerCase().trim()`. No negation handling in v1 (callers with negated intent set `output-mode: working-dir` explicitly). No code-fence stripping in v1. Documented known false positive: "pull the request body into the summary" → resolves to `branch-pr` (acceptable; callers can set the mode explicitly).
- **Apply the mode only to manual triggers.** Non-manual triggers already have event-specific delivery semantics (comment/review response protocols) and should not gain new git behavior.
- **Do not use OpenCode config `instructions` as the primary control point.** It is broader, harder to reason about per trigger, and unnecessary when the prompt builder already owns the authoritative run contract.
- **Make the internal wiki workflow explicit anyway.** Even if `auto` would correctly infer `branch-pr` from `WIKI_PROMPT`, pass `output-mode: branch-pr` in `.github/workflows/fro-bot.yaml` for the wiki path so the behavior is self-documenting and decoupled from prompt wording drift.
- **Preamble position: INSIDE `<task>`, BEFORE `## Task` heading.** The Delivery Mode block is prepended to `<task>`'s content, above the caller directive. This order respects Anthropic's reference-first/instruction-last guidance — the model reads the contract before the instruction.
- **Authority deferral, not duplication.** The preamble does NOT re-declare priority. `<harness_rules>` already establishes priority over `<user_supplied_instructions>` and skill defaults (PR #465 precedent). Add a single line to `buildHarnessRulesSection()`: *"For `schedule` and `workflow_dispatch` triggers, the `## Delivery Mode` block in `<task>` is the operator-level delivery contract. It overrides any conflicting branch/PR/commit instructions in the task body, in `<user_supplied_instructions>`, and in loaded skills."* The `<task>` preamble then carries only the concrete mode + actions, not authority claims.
- **Preamble framing: positive-action, explicit boundary.** Negative framing ("Do NOT branch, do NOT commit") primes forbidden tokens and underperforms by 40-60% in published research. Lead with what the model SHOULD do, then list available + forbidden actions explicitly. Final preamble text is in Unit 2.
- **Resolver threading:** Add `resolvedOutputMode: ResolvedOutputMode | null` to `ExecutePhaseResult`. `runExecute()` computes it once via `resolveOutputMode()`, writes to both `promptOptions.resolvedOutputMode` AND `executeResult.resolvedOutputMode` before calling `executeOpenCode()`. `runFinalize()` reads from `execution.resolvedOutputMode`. This avoids re-computation drift and avoids stashing on `bootstrap.inputs`.
- **Field/type additions:** Add `export type OutputMode = 'auto' | 'working-dir' | 'branch-pr'` and `export type ResolvedOutputMode = 'working-dir' | 'branch-pr'` in `src/features/agent/output-mode.ts`; re-export from `src/features/agent/types.ts`. Extend `ActionInputs` with `readonly outputMode: OutputMode` and `ActionOutputs` with `readonly resolvedOutputMode: ResolvedOutputMode | null`. Extend `PromptOptions` with `readonly resolvedOutputMode?: ResolvedOutputMode | null`. Modify `buildTaskSection(context, promptInput, resolvedMode: ResolvedOutputMode | null)` to accept the mode as a third parameter.
- **Exhaustive trigger handling.** The resolver MUST switch exhaustively on `EventType` and use a `satisfies never` (or equivalent compile-time exhaustiveness check) so adding a new trigger type forces the implementer to declare its mode applicability. Default-open silent `null` is a defect, not a default.
- **Heuristic input source:** The resolver consumes the `promptInput: string | null` already threaded into `buildTaskSection()`. For schedule/dispatch this is identical to `bootstrap.inputs.prompt` and `triggerResult.context.commentBody`. Do NOT reach into multiple fields — single source of truth is the `promptInput` parameter.

## Open Questions

### Resolved During Planning

- **Is the triage basically right?** Yes. Missing mode control + verbatim manual prompt passthrough + an agent runtime that can lawfully choose branch/PR delivery is the real combination. The only correction is that the git skill is a strong contributor, not a sole root cause.
- **Will prompt guardrails override the skill layer reliably enough?** Usually, yes, because they become part of the run’s authoritative task contract. But it is still a soft control, not a sandbox.
- **Should we disable skills instead?** No. That is brittle, broader than the bug, and would risk breaking legitimate branch/PR tasks.

### Deferred to Implementation

- **Whether to add a post-run git invariant check in `working-dir` mode** (for example, fail if current branch or HEAD changed during execution). This is useful as a belt-and-suspenders follow-up, but not required for the first patch because the main issue is missing delivery policy, not missing git-state telemetry.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
configured mode (action input)
        |
        v
resolveOutputMode(eventType, prompt, configuredMode)
        |
        +--> non-manual trigger -> null (no behavior change)
        |
        +--> manual trigger + explicit branch/PR language -> branch-pr
        |
        +--> manual trigger otherwise -> working-dir

resolved mode
  |- injected into <task> preamble for schedule/workflow_dispatch
  |- logged in bootstrap/finalize
  |- emitted as action output + job summary row
  \- used by internal wiki workflow as explicit branch-pr wiring
```

## Implementation Units

- [ ] **Unit 1: Add public input/output surface for delivery mode**

**Goal:** Expose a caller-controlled delivery contract and make the resolved mode visible at runtime.

**Requirements:** R1, R2, R4, R5

**Dependencies:** None

**Files:**
- Modify: `action.yaml` (inputs block at lines 6-102; outputs block at 103-110)
- Modify: `src/shared/types.ts`
- Modify: `src/harness/config/inputs.ts`
- Test: `src/harness/config/inputs.test.ts`
- Modify: `src/harness/config/outputs.ts`
- Test: `src/harness/config/outputs.test.ts`
- Modify: `src/harness/phases/bootstrap.ts`

**Approach:**
- Add a new optional input:
  - `output-mode`
  - values: `auto | working-dir | branch-pr`
  - default: `auto`
  - description should explicitly say it only affects `schedule` / `workflow_dispatch` runs.
- Add a new action output:
  - `resolved-output-mode`
  - values emitted: `working-dir`, `branch-pr`, or empty string when not applicable / skipped.
- Extend `ActionInputs` with `outputMode` and `ActionOutputs` with `resolvedOutputMode`.
- Parse and validate `output-mode` in `parseActionInputs()` near the existing prompt parsing block (around lines 207-210) and include it in the returned object (around lines 334-350). **Use the existing enum-style pattern from `parseOmoProviders` (`src/harness/config/inputs.ts:80-136`):** declare `const VALID_OUTPUT_MODES = ['auto', 'working-dir', 'branch-pr'] as const`, parse with `.trim().toLowerCase()`, return a Result error message listing the valid values on mismatch. Default to `'auto'` when the input is empty.
- Log the configured mode in `runBootstrap()` alongside the existing “Action inputs parsed” metadata.
- **Wire empty-string emission into every short-circuit path** that reaches `setActionOutputs()` before mode resolution: bootstrap failure, routing skip, dedup skip, run.ts catch block. Each must explicitly pass `resolvedOutputMode: null` so the action emits `''`. See Context & Research for the verified short-circuit map.

**Patterns to follow:**
- `parseOmoProviders` enum pattern at `src/harness/config/inputs.ts:80-136` (reference)
- `setActionOutputs` empty-string convention at `src/harness/config/outputs.ts:10` (`outputs.sessionId ?? ''`)

**Test scenarios:**
- Default input resolves to `auto`.
- Valid explicit values parse correctly (`auto`, `working-dir`, `branch-pr`).
- Invalid values fail fast with a useful error message that lists the valid values.
- Whitespace and case are normalized (`  WORKING-DIR  ` parses).
- `setActionOutputs()` writes `resolved-output-mode` alongside existing outputs.
- Each of the 4 short-circuit paths (bootstrap fail, routing skip, dedup skip, catch block) emits `resolved-output-mode: ''`.

**Verification:**
- A caller can configure `with: output-mode: working-dir` or `branch-pr`.
- GitHub Actions outputs show `resolved-output-mode` for processed manual runs.

---

- [ ] **Unit 2: Centralize mode resolution and inject authoritative task guardrails**

**Goal:** Convert the configured mode into a resolved manual-run contract and render that contract into the prompt where the model will see it before taking git actions.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** Unit 1

**Files:**
- Create: `src/features/agent/output-mode.ts`
- Test: `src/features/agent/output-mode.test.ts`
- Modify: `src/features/agent/types.ts` (`PromptOptions` ~lines 80-91 — add `resolvedOutputMode?: ResolvedOutputMode | null`)
- Modify: `src/features/agent/prompt.ts` (`getTriggerDirective()` lines 29-78; schedule/dispatch case 70-72; `buildTaskSection()` lines 100-112 — add `resolvedMode` parameter; `<task>` wrapping at lines 289-325 — caller site)
- Modify: `src/features/agent/prompt-thread.ts` (`buildHarnessRulesSection` lines 3-13 — add the operator-level delivery-contract authority line)
- Test: `src/features/agent/prompt.test.ts`
- Test: `src/features/agent/prompt-thread.test.ts` (lock in the new authority line)
- Modify: `src/harness/phases/execute.ts` (`ExecutePhaseResult` lines 16-28 — add `resolvedOutputMode: ResolvedOutputMode | null`; populate in `runExecute()`)
- Modify: `src/harness/phases/finalize.ts` (`runFinalize()` lines 15-41 — read `execution.resolvedOutputMode` and pass to outputs + summary)
- Modify: `src/features/observability/types.ts`
- Modify: `src/features/observability/job-summary.ts`
- Test: `src/features/observability/job-summary.test.ts`

**Approach:**
- Add a small shared resolver so prompt rendering, finalize-time outputs, and job summary all use the same logic.
- Resolution rules with exhaustive trigger handling:
  - Non-manual triggers (`issue_comment`, `issues`, `pull_request`, `pull_request_review_comment`, `discussion_comment`) -> `null` / not applicable.
  - Configured `working-dir` -> `working-dir`.
  - Configured `branch-pr` -> `branch-pr`.
  - Configured `auto` on `schedule` / `workflow_dispatch` -> `branch-pr` only when the prompt contains an explicit delivery phrase; otherwise `working-dir`.
  - Resolver switch ends with `default: const _exhaustive: never = eventType; return null` (or equivalent `satisfies never` check) so a new `EventType` variant forces the implementer to add a case.
- Compute resolved mode once in `runExecute()`, write it to BOTH `promptOptions.resolvedOutputMode` AND `executeResult.resolvedOutputMode` (added to `ExecutePhaseResult`). `runFinalize()` reads from `execution.resolvedOutputMode` and passes to outputs + job summary. This avoids re-resolution drift.
- Add an authority line to `buildHarnessRulesSection()` (per Key Technical Decisions) so the `<task>` preamble can defer rather than duplicate.
- In `buildTaskSection()` for `schedule` / `workflow_dispatch`, prepend one of these exact policy blocks BEFORE the `## Task` heading. **Positive-action framing per published prompt-engineering research — lead with what TO do, then enumerate available + forbidden actions.** Authority is deferred to `<harness_rules>` (no duplicate priority claim):

  **Working-dir preamble**
  ```text
  ## Delivery Mode
  - **Resolved output mode:** `working-dir`
  - Write all requested file changes directly in the checked-out working tree.
  - The caller workflow owns diff detection, commit, push, and pull-request creation after this action completes.
  - Available actions: read files, edit files, create files in the working tree, run non-mutating shell commands.
  - Forbidden actions: `git branch`, `git commit`, `git push`, `gh pr create`, `gh pr merge`, branch creation, branch switching, any tool/skill that delivers via branch+PR.
  - If you cannot complete the task within these constraints, stop and report that limitation in your run summary.
  ```

  **Branch-pr preamble**
  ```text
  ## Delivery Mode
  - **Resolved output mode:** `branch-pr`
  - Deliver the result through a branch/commit/push/pull-request workflow.
  - Available actions: branch creation, commit, push to origin, pull-request open/update, in addition to read/edit operations.
  - Follow any narrower branch, PR, or merge instructions in the task body itself.
  ```
- Keep the caller’s manual prompt verbatim after the preamble; do not move it into `<user_supplied_instructions>` for manual triggers.
- Surface the resolved mode in `runFinalize()` via action outputs and add an `Output Mode` row to the job summary main metadata table at `src/features/observability/job-summary.ts:18-30`. **Insert the row immediately after the `Agent` row.** Always render — for non-manual triggers, the value is `'N/A'`. Format: `['Output Mode', resolvedOutputMode ?? 'N/A']`.

**Patterns to follow:**
- Existing pure-helper pattern in `src/features/agent/prompt.ts`
- XML-tagged prompt structure from PR #465 (`<harness_rules>` priority precedent in `prompt-thread.ts`)
- Existing summary table structure in `src/features/observability/job-summary.ts:18-30`
- Phase-result extension pattern from PR #514 (commit `99d813e`, where `CacheResult.source` was added)

**Test scenarios** (use exact `it()` names matching `prompt.test.ts` BDD pattern with `// #given`, `// #when`, `// #then` comments):
- `it('renders working-dir preamble before ## Task heading for workflow_dispatch with output-mode: working-dir')`
- `it('renders branch-pr preamble before ## Task heading for workflow_dispatch with output-mode: branch-pr')`
- `it('resolves auto to working-dir for plain file-edit prompt')` — uses prompt text from issue #511
- `it('resolves auto to branch-pr for prompt containing "pull request"')`
- `it('resolves auto to branch-pr for WIKI_PROMPT verbatim')`
- `it('resolves auto to working-dir for SCHEDULE_PROMPT verbatim')`
- `it('resolves auto to working-dir for empty/null prompt')`
- `it('case-insensitive: PULL REQUEST resolves to branch-pr')`
- `it('does not render Delivery Mode preamble for issue_comment trigger')`
- `it('does not render Delivery Mode preamble for pull_request trigger (self-review regression)')`
- `it('preamble defers to <harness_rules> authority and does not re-declare priority')`
- `it('buildHarnessRulesSection includes the operator-level delivery-contract line')` (in `prompt-thread.test.ts`)
- Plus resolver unit tests in new `src/features/agent/output-mode.test.ts` covering each `EventType` exhaustively, each configured mode, every heuristic phrase, the documented false-positive case ("pull the request body"), case insensitivity, whitespace normalization, and the `satisfies never` exhaustiveness guard.

**Verification:**
- Prompt artifacts for manual runs clearly show the Delivery Mode block before the `## Task` heading.
- Finalize-time outputs and job summary agree on the resolved mode.
- `<harness_rules>` priority claim text remains intact; new operator-level line appended without breaking existing tests.

---

- [ ] **Unit 3: Make the internal wiki caller explicit and lock in regression coverage**

**Goal:** Preserve known branch/PR-based automation while the new default fixes checkout-edit workflows.

**Requirements:** R2, R5, R6

**Dependencies:** Units 1-2

**Files:**
- Modify: `.github/workflows/fro-bot.yaml` (wiki prompt block 74-138; Run Fro Bot step 185-205)
- Test: `src/features/agent/prompt.test.ts`
- Test: `src/harness/config/inputs.test.ts` (caller-facing defaults already covered)
- Test: `src/features/observability/job-summary.test.ts`

**Approach:**
- In `.github/workflows/fro-bot.yaml`, pass `with: output-mode:` using the following expression mirroring the existing 5-branch `PROMPT` pattern at lines 189-197. Place the expression in the Run Fro Bot step under the existing `with:` block (around lines 185-205):

  ```yaml
  output-mode: >-
    ${{
      (github.event_name == 'workflow_dispatch' && github.event.inputs.use-wiki-prompt == 'true' && 'branch-pr')
      || (github.event_name == 'schedule' && github.event.schedule == '0 20 * * 0' && 'branch-pr')
      || 'auto'
    }}
  ```

- The expression resolves to `branch-pr` for the two known wiki paths (manual `use-wiki-prompt` dispatch + Sunday cron `0 20 * * 0`) and `auto` for everything else (DMR daily cron, custom prompt input, `use-schedule-prompt` boolean dispatch, all non-manual triggers).
- Do not change `WIKI_PROMPT` or `SCHEDULE_PROMPT` semantics beyond this explicit wiring.
- Add regression assertions documenting the two supported manual patterns:
  1. checkout-edit workflows default to `working-dir` (via `auto` heuristic against `SCHEDULE_PROMPT`)
  2. wiki/PR workflows opt into `branch-pr` explicitly via the workflow expression above

**Patterns to follow:**
- Existing prompt-selection expression in `.github/workflows/fro-bot.yaml`
- Existing schedule-vs-dispatch regression tests in `src/features/agent/prompt.test.ts`

**Test scenarios:**
- Weekly wiki schedule path passes `branch-pr` explicitly.
- Manual `use-wiki-prompt` dispatch path also passes `branch-pr`.
- Non-wiki manual paths remain `auto`.
- Prompt tests prove that explicit `branch-pr` beats heuristic drift.

**Verification:**
- The compounding wiki flow remains branch/PR-based even if `WIKI_PROMPT` wording changes later.
- The reported issue path now resolves to checkout-local edits by default.

## System-Wide Impact

- **Interaction graph:** The change touches the public action API, prompt assembly, execute/finalize plumbing, and observability. It deliberately does not touch setup/plugin registration or trigger routing semantics.
- **Error propagation:** Invalid `output-mode` should fail during bootstrap input parsing, before setup/execution begins.
- **State lifecycle risks:** No cache/session schema changes are required. Resolved mode is run-local metadata only.
- **API surface parity:** Only manual triggers get new delivery semantics. Comment/review flows remain governed by their response protocols.
- **Integration coverage:** There is no deterministic repository-local test that proves an upstream model will never branch/push, so verification focuses on the prompt contract, explicit caller wiring, and emitted runtime metadata.
- **Concurrent manual runs.** Workflow concurrency keys on `github.run_id` for `schedule`/`workflow_dispatch` (verified, fro-bot.yaml:33-41), so concurrent manual runs execute in parallel without serialization. Each run resolves `output-mode` independently. Concurrency does NOT key on mode. **Caller responsibility:** workflows that fire multiple manual triggers in parallel must ensure their prompts target non-overlapping file sets in `working-dir` mode — the runs share the checkout. The harness does not detect or prevent collisions.
- **Trigger-type coverage (fail-fast).** Mode resolution uses an exhaustive switch on `EventType` with `satisfies never` (or equivalent compile-time check). When new trigger types are added later (e.g., `workflow_run`, `repository_dispatch`, `push`), the implementer is forced to declare the new type's mode applicability. This converts "default-open silent inheritance" into a fail-fast gate.
- **Output is advisory, not ground-truth.** The `resolved-output-mode` action output reflects the requested delivery contract, not observed delivery behavior. Downstream workflows that gate on it (e.g., `if: steps.fro-bot.outputs.resolved-output-mode == 'working-dir'`) should treat it as an advisory hint and inspect git state if they require ground-truth.
- **Resolver placement coupling (acknowledged).** Mode resolution lives in the prompt builder layer (`src/features/agent/output-mode.ts`), creating a one-way dependency on `EventType` classification. Acceptable for v1. If future work requires mode-aware behavior outside prompt rendering (e.g., routing-time gating, metric tagging at startup), lift resolution to the routing phase and thread the resolved mode through `TriggerResult`.

## Risks & Dependencies

- **Prompt control is soft, not absolute.** The model can still ignore instructions. The fix dramatically reduces that risk, but it is not a cryptographic lock. Anthropic Claude Sonnet 4.6 has a documented 1.9% constitution violation rate; published guardrail-bypass research shows 60-90% evasion rates against adversarial prompt injection. Suitable for accidental misuse, not adversarial misuse.
- **`auto` heuristics can misclassify ambiguous prompts.** Keep detection conservative and document that callers who need certainty should set `output-mode` explicitly. Documented v1 false positive: "pull the request body into the summary" → resolves to `branch-pr`.
- **Credential scope still matters.** `runSetup()` exports `GH_TOKEN` (`src/services/setup/setup.ts:243`) and configures git identity (`setup.ts:246`), so a token with `contents:write` can still push if the model attempts it. For working-dir callers that need a harder stop, use a token/checkout setup that cannot push, or add a later invariant check as follow-up work.
- **Session-resume mode drift (schedule triggers only).** Session keys for `schedule` events are cron-hash-based, so the same cron schedule resumes the same session across runs. If `output-mode` changes between runs (e.g., operator switches a cron from `branch-pr` to `working-dir`), the model's prior conversation history may include branch work from the previous mode. The preamble is the primary control. If the conflict is severe, the operator can force a fresh session by changing the cron expression or pruning the session manually. `workflow_dispatch` triggers use unique `dispatch-<runId>` keys and start fresh sessions, so this risk does not apply to them.
- **Skill ecosystem coupling.** The preamble tells the model not to use git/PR delivery skills, but Systematic-plugin-loaded skills (e.g., `git-commit-push-pr`) have independent behavior that can change across versions. The harness has no programmatic visibility into which skills are loaded or what they do. If a future Systematic update adds an auto-loading delivery skill or changes existing skill defaults, the preamble may no longer be sufficient. **Mitigation:** monitor preamble effectiveness via prompt artifact reviews; pin Systematic version. **Detection (deferred work):** post-run git invariant check (working-dir mode + branch/HEAD unchanged → pass; otherwise fail loud).
- **Negative-framing residual risk.** Even with the rewrite to positive-action framing, the preamble retains a `Forbidden actions` line that names `git push`, `gh pr create`, etc. Published research shows these forbidden tokens still receive attention. Acceptable trade-off because the explicit list reduces ambiguity for the model and aids operator audit. Monitor real-run artifacts for misclassification.

## Documentation / Operational Notes

- Update the `output-mode` input description in `action.yaml` so marketplace consumers see the new contract immediately. Description should explicitly note that the value is advisory — reflects the requested mode, not observed delivery behavior.
- **Update root `AGENTS.md`** to reference `src/features/agent/output-mode.ts` in the WHERE TO LOOK and CODE MAP tables. Add a NOTES bullet about the operator-level Delivery Mode contract for manual triggers.
- **Update README event reference table** to add an `Output Mode` column (or subsection) for `schedule` and `workflow_dispatch` rows. Document that comment/review/issue triggers ignore `output-mode`.
- **Release notes for the fix MUST include the migration text:**
  > **Behavior change for callers that rely on implicit side-branch delivery from manual triggers.**
  > Previously: `schedule` and `workflow_dispatch` runs could produce side branches + PRs depending on model/skill defaults.
  > Now: `schedule` and `workflow_dispatch` default to `output-mode: auto`, which resolves to `working-dir` unless the prompt contains explicit branch/PR language.
  > **Action required** if your workflow depends on side-branch delivery: set `with: output-mode: branch-pr` explicitly.
  > **No action required** if your workflow already diffs the checkout after the agent runs (the intended pattern).
- **Known external caller needing migration:** `marcusrbrown/containers/.github/workflows/fro-bot.yaml` SCHEDULE_PROMPT contains "create a PR with the fix" — autohealing currently depends on implicit side-branch delivery. After this fix lands, set `with: output-mode: branch-pr` in that workflow before the next agent release rolls out, or autohealing PR creation will silently stop. Other internal callers (`marcusrbrown/marcusrbrown.github.io`, `bfra-me/.github`) should be audited the same way before release.
- **Operational triage:** when triaging future reports, operators should first check `resolved-output-mode` and the job summary `Output Mode` row before blaming the model. If operator-set mode and observed behavior diverge, the model violated the preamble — file an issue with prompt artifacts attached.
- **Follow-up work suggestion (not in scope):** post-run git invariant check that fails the run loudly when `working-dir` mode + (branch changed OR HEAD changed) is observed. Converts silent preamble violations into a hard signal without requiring token-scope surgery. File as a separate issue when this fix lands.

## Sources & References

- Issue: `fro-bot/agent#511`
- Related code: `action.yaml`
- Related code: `src/features/agent/prompt.ts`
- Related code: `src/features/agent/prompt-thread.ts` (`buildHarnessRulesSection` precedent — PR #465)
- Related code: `src/harness/config/inputs.ts` (`parseOmoProviders` enum-pattern reference at lines 80-136)
- Related code: `src/harness/config/outputs.ts` (empty-string convention at line 10)
- Related code: `src/harness/phases/execute.ts` (`ExecutePhaseResult` extension precedent — PR #514, commit `99d813e`)
- Related code: `src/harness/phases/finalize.ts`
- Related code: `src/harness/phases/routing.ts` (short-circuit at lines 53-63)
- Related code: `src/harness/phases/dedup.ts` (short-circuit at lines 95-114)
- Related code: `src/services/setup/setup.ts` (lines 240-246 — `GH_TOKEN` export and git identity)
- Related code: `src/services/session/types.ts` (no mode field — verified)
- Related code: `.github/workflows/fro-bot.yaml` (PROMPT expression at lines 189-197 — pattern to mirror)
- External caller (needs migration): `marcusrbrown/containers/.github/workflows/fro-bot.yaml`
- RFC: `RFCs/RFC-010-Delegated-Work.md`
- RFC: `RFCs/RFC-018-Agent-Invokable-Delegated-Work.md` (Pending — must inherit this delivery-mode contract when implemented)
- Anthropic prompt engineering: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags
- Anthropic ordering best practices: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Anthropic Constitution (principal hierarchy): https://www.anthropic.com/constitution
- Claude Code permissions doc (prompt vs config defense-in-depth): https://docs.anthropic.com/en/docs/claude-code/permissions
- Negative-vs-positive prompt framing analysis (50k-prompt study, ~40-60% effect): https://eval.16x.engineer/blog/the-pink-elephant-negative-instructions-llms-effectiveness-analysis
