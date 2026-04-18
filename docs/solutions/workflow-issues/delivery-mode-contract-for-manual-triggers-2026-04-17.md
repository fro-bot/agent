---
title: "Delivery-mode contract for manual workflow triggers"
date: 2026-04-17
category: workflow_issue
module: src/features/agent
problem_type: workflow_issue
component: assistant
severity: high
applies_when:
  - Designing autonomous-agent workflows that run without conversation context (CI, cron, scheduled triggers)
  - The workflow has more than one valid delivery semantics (commit to checkout vs branch+PR vs side-effects only)
  - Previous behavior was implicit or heuristic and you want to move to an explicit contract
  - You have known internal callers that need different delivery modes
related_components:
  - development_workflow
  - tooling
tags:
  - delivery-mode
  - prompt-engineering
  - output-mode
  - manual-triggers
  - schedule
  - workflow-dispatch
  - authority-hierarchy
  - soft-control
---

# Delivery-mode contract for manual workflow triggers

## Context

Fro Bot's `schedule` and `workflow_dispatch` triggers had no delivery contract. The action exposed `prompt` but nothing that told the runtime *how* the caller wanted file changes delivered. Meanwhile setup gave the runtime authenticated `gh` access plus a configured git identity, so when the model decided to "deliver" changes, Systematic's git skills (or raw `git`/`gh` commands) could legitimately produce a branch + push + PR flow. That silently broke the caller pattern: **agent edits checkout → workflow diffs and commits**.

The trigger was [issue #511](https://github.com/fro-bot/agent/issues/511): a wiki-update workflow on the Sunday `schedule` cron silently pushed to a side branch instead of leaving edits in the working directory for the workflow to diff and commit. The deeper cause wasn't a single skill misbehaving — it was that the harness never stated which delivery contract applied for manual runs, so the runtime was free to choose branch/PR delivery whenever it seemed useful.

This learning describes the pattern that fixed it: a layered delivery contract that scales beyond the original bug. Any future autonomous workflow that runs without conversation context can use the same shape.

## Guidance

The fix in [PR #517](https://github.com/fro-bot/agent/pull/517) establishes a six-layer delivery contract pattern. None of the layers depend on adversarial-grade enforcement — see [Why This Matters](#why-this-matters) for the soft-control framing.

### 1. Public action input + advisory output for the contract

`action.yaml` defines the caller-controlled surface. The output is explicitly **advisory** — it reflects the requested contract, not observed delivery behavior:

```yaml
inputs:
  output-mode:
    description: >-
      Requested delivery mode for schedule/workflow_dispatch runs only. Values:
      auto, working-dir, branch-pr. Default: auto. Advisory only: reflects the
      requested/resolved contract, not observed delivery behavior.
    required: false
    default: auto

outputs:
  resolved-output-mode:
    description: >-
      Resolved delivery mode for this run (working-dir, branch-pr, or empty
      string for non-applicable / skipped runs).
```

### 2. Centralized resolver with exhaustive `EventType` switch

`src/features/agent/output-mode.ts` owns all mode resolution logic. Every trigger type is enumerated; new trigger types fail compilation until their delivery semantics are declared:

```ts
const BRANCH_PR_PHRASES = [
  'pull request', 'open a pr', 'create a pr', 'create pr',
  'gh pr ', 'push to origin', 'git push', 'auto-merge',
  'create branch', 'update branch', 'branch workflow',
] as const

export function resolveOutputMode(
  eventType: EventType,
  prompt: string | null,
  configuredMode: OutputMode,
): ResolvedOutputMode | null {
  switch (eventType) {
    case 'discussion_comment':
    case 'issue_comment':
    case 'issues':
    case 'pull_request':
    case 'pull_request_review_comment':
    case 'unsupported':
      return null  // Non-manual triggers: contract does not apply

    case 'schedule':
    case 'workflow_dispatch':
      switch (configuredMode) {
        case 'working-dir': return 'working-dir'
        case 'branch-pr':   return 'branch-pr'
        case 'auto':        return resolveAutoMode(prompt)
        default: {
          // Compile-time exhaustiveness check
          const exhaustiveModeCheck: never = configuredMode
          return exhaustiveModeCheck
        }
      }

    default: {
      const exhaustiveCheck: never = eventType
      return exhaustiveCheck
    }
  }
}
```

The `auto` mode resolves to `branch-pr` only when the prompt contains explicit delivery language from a frozen phrase list; otherwise `working-dir`. The phrase list is intentionally narrow — it catches unambiguous cases without trying to be a semantic classifier.

### 3. Prompt-side preamble with positive-action framing

`src/features/agent/prompt.ts` injects the delivery contract inside `<task>` **before** the `## Task` heading. `buildTaskSection()` calls an internal `buildDeliveryModePreamble()` helper that uses positive-action framing — `Available actions:` / `Forbidden actions:` lists rather than a "Do NOT" wall (see [Why This Matters](#why-this-matters)):

```ts
// Internal helper called by buildTaskSection() for schedule/workflow_dispatch triggers.
function buildDeliveryModePreamble(resolvedMode: ResolvedOutputMode): string {
  if (resolvedMode === 'working-dir') {
    return [
      '## Delivery Mode',
      '- **Resolved output mode:** `working-dir`',
      '- Write all requested file changes directly in the checked-out working tree.',
      '- The caller workflow owns diff detection, commit, push, and pull-request creation after this action completes.',
      '- Available actions: read files, edit files, create files in the working tree, run non-mutating shell commands.',
      '- Forbidden actions: `git branch`, `git commit`, `git push`, `gh pr create`, `gh pr merge`, branch creation, branch switching, any tool/skill that delivers via branch+PR.',
      '- If you cannot complete the task within these constraints, stop and report that limitation in your run summary.',
      '',
    ].join('\n')
  }
  // branch-pr preamble: mirror shape, invert allowed/forbidden
}
```

### 4. Authority deferral to `<harness_rules>`, not duplication

`src/features/agent/prompt-thread.ts` declares operator-level priority **once** in the always-on `<harness_rules>` section. The Delivery Mode preamble does not re-declare priority — it relies on the existing authority hierarchy established by [PR #465](https://github.com/fro-bot/agent/pull/465):

```ts
'- For `schedule` and `workflow_dispatch` triggers, the `## Delivery Mode` block in `<task>` is the operator-level delivery contract. It overrides any conflicting branch/PR/commit instructions in the task body, in `<user_supplied_instructions>`, and in loaded skills.',
```

This matters because duplicating priority claims in multiple sections weakens both. One authoritative declaration plus per-section pointers is sturdier than competing claims at every level.

### 5. Caller wiring via explicit YAML expression

Known internal workflows opt into specific modes explicitly rather than relying on the heuristic. `.github/workflows/fro-bot.yaml`:

```yaml
output-mode: >-
  ${{
    (github.event_name == 'workflow_dispatch' && github.event.inputs.use-wiki-prompt == 'true' && 'branch-pr')
    || (github.event_name == 'schedule' && github.event.schedule == '0 20 * * 0' && 'branch-pr')
    || 'auto'
  }}
```

Wiki paths get `branch-pr` because the wiki workflow needs PR delivery. Daily Maintenance Report and ad-hoc dispatches use `auto`, which the resolver maps to `working-dir` against the current `SCHEDULE_PROMPT` text. **The decoupling matters:** if `WIKI_PROMPT` text changes someday and accidentally drops the word "PR," the wiring still says `branch-pr`. Heuristic-only resolution would silently flip behavior; explicit wiring won't.

### 6. Observability via action output and job summary

`src/harness/phases/finalize.ts` emits the resolved mode to action outputs and the job summary's main metadata table includes an `Output Mode` row (always rendered; `N/A` for non-manual triggers). Operators can check the resolved value before blaming the model when delivery looks wrong.

Four short-circuit paths (bootstrap fail, routing skip, dedup skip, unhandled exception) explicitly emit `''` for `resolved-output-mode` so downstream workflow steps that gate on the value never see `undefined`.

## Why This Matters

**Prompt control is a soft guardrail.** Anthropic's published metrics show ~1.9% Claude constitution-violation rate. Published prompt-injection research shows 60-90% adversarial bypass rates. The delivery contract pattern guards against *accidental* misuse — a model defaulting to branch/PR delivery when the caller expected checkout edits — not adversarial misuse. Callers needing hard guarantees should rely on token scope (don't grant `contents:write`) or post-run git invariant checks, not on the preamble alone.

**Without a contract, behavior is non-deterministic.** Model defaults plus skill-layer behavior decide delivery semantics. "What does the model feel like doing today" determines whether your CI run silently produces side branches or edits in place. That's not acceptable for autonomous workflows that run without conversation context.

**The pattern compounds.** Future delivery modes (e.g., a `dry-run` mode that runs read-only, or a `commit-locally` mode that commits without pushing) plug into the same surface — action input → resolver → preamble → observability — without redesigning anything.

**Positive-action framing outperforms negative framing.** Published research on a 50,000-prompt dataset showed negative phrasings ("Do NOT create a PR") increase unwanted behavior by 40-60% relative to equivalent positive framing. The `Available actions:` / `Forbidden actions:` shape leads with what to do instead of what to avoid; "Forbidden" still appears, but only after the positive lead.

**Exhaustive typing catches drift.** The `const x: never = ...` exhaustiveness checks on both `EventType` and `OutputMode` mean adding a new variant forces the implementer to declare its applicability. This converts "default-open silent inheritance" into a fail-fast compile-time gate.

**Authority deferral keeps prompts auditable.** With one authoritative declaration in `<harness_rules>`, you can read a prompt artifact and know exactly which section wins when sections conflict. Duplicate authority claims at multiple section levels obscure that.

## When to Apply

- Designing any autonomous-agent workflow that runs without conversation context (CI/cron/scheduled triggers)
- A workflow has more than one valid delivery semantics (commit to checkout vs branch+PR vs side-effects only)
- Previous behavior was implicit or heuristic and you want to move to explicit contract
- You need a soft-control pattern that survives accidental misuse and prompt-wording drift
- One or more known internal callers need different delivery modes
- You want triage observability so operators can check `resolved-output-mode` (or your equivalent) before blaming the model
- You can accept ~1.9% accidental violation as a residual risk and harden separately for adversarial cases (token scope, post-run invariant checks)

## Examples

### Before — implicit, prompt-wording dependent

```yaml
# Wiki workflow relied on prompt wording alone.
- uses: fro-bot/agent@v0.40
  with:
    prompt: ${{ env.WIKI_PROMPT }}  # Contains "create a PR" but no explicit contract
```

The model could choose to edit files in place OR push a side branch, depending on which Systematic git skill loaded and what the model felt like doing. Issue #511 reported the same shape: a `workflow_dispatch` prompt that asked for in-place file edits silently produced a side-branch PR.

### After — explicit caller wiring

```yaml
# Wiki workflow opts into branch-pr explicitly.
- uses: fro-bot/agent@v0.40
  with:
    prompt: ${{ env.WIKI_PROMPT }}
    output-mode: >-
      ${{
        (github.event_name == 'workflow_dispatch' && github.event.inputs.use-wiki-prompt == 'true' && 'branch-pr')
        || (github.event_name == 'schedule' && github.event.schedule == '0 20 * * 0' && 'branch-pr')
        || 'auto'
      }}
```

The prompt artifact now shows:

```markdown
## Delivery Mode
- **Resolved output mode:** `branch-pr`
- Deliver the result through a branch/commit/push/pull-request workflow.
- Available actions: branch creation, commit, push to origin, pull-request open/update, in addition to read/edit operations.
- Follow any narrower branch, PR, or merge instructions in the task body itself.

## Task
[task body...]
```

### After — checkout-edit workflows (default `auto` → resolves to `working-dir`)

```yaml
# DMR workflow: agent edits checkout, workflow diffs and commits.
- uses: fro-bot/agent@v0.40
  with:
    prompt: ${{ env.SCHEDULE_PROMPT }}  # No branch/PR phrases → resolves to working-dir
    # output-mode: auto (default — no need to set explicitly)
```

The prompt artifact shows:

```markdown
## Delivery Mode
- **Resolved output mode:** `working-dir`
- Write all requested file changes directly in the checked-out working tree.
- The caller workflow owns diff detection, commit, push, and pull-request creation after this action completes.
- Available actions: read files, edit files, create files in the working tree, run non-mutating shell commands.
- Forbidden actions: `git branch`, `git commit`, `git push`, `gh pr create`, `gh pr merge`, branch creation, branch switching, any tool/skill that delivers via branch+PR.

## Task
[task body...]
```

The job summary's metadata table includes:

| Property    | Value          |
| ----------- | -------------- |
| Agent       | build          |
| Output Mode | working-dir    |
| ...         | ...            |

If delivery later looks wrong, the operator's first triage step is "what does `Output Mode` show?" rather than "what did the model decide today?"

## Related

- [Issue #511](https://github.com/fro-bot/agent/issues/511) — source bug report
- [PR #517](https://github.com/fro-bot/agent/pull/517) — implementation
- `docs/plans/2026-04-17-001-fix-manual-delivery-mode-plan.md` — Metis-gap-reviewed and research-deepened plan with full design rationale and external references
- [PR #465](https://github.com/fro-bot/agent/pull/465) — established the `<harness_rules>` authority hierarchy that this fix defers to
- `docs/plans/2026-04-07-001-refactor-prompt-xml-architecture-plan.md` — XML-tagged prompt architecture plan
- `docs/plans/2026-04-13-001-feat-compounding-wiki-plan.md` — wiki workflow that became the first explicit `branch-pr` caller
- `src/features/agent/output-mode.ts` — resolver implementation
- `src/features/agent/prompt.ts` — `buildTaskSection()` Delivery Mode preamble injection
- `src/features/agent/prompt-thread.ts` — `<harness_rules>` operator-level rule line
- `.github/workflows/fro-bot.yaml` — wiki workflow wiring example
