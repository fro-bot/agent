---
title: "docs: Document Supported Event Triggers & Create Pristine Example Workflow"
type: docs
date: 2026-02-16
---

# docs: Document Supported Event Triggers & Create Pristine Example Workflow

## Overview

The Fro Bot action supports 7 event types in code (`router.ts`, `context.ts`), but the project's own `fro-bot.yaml` only uses 4 of them (`issue_comment`, `pull_request_review_comment`, `schedule`, `workflow_dispatch`). Two fully-implemented triggers — `issues` and `discussion_comment` — are not wired up. The `pull_request` trigger is handled by `ci.yaml` for build/test, but the agent's AI code review capability (distinct from CI) is not exposed anywhere.

This plan covers:

1. **Updating the README** with a comprehensive event trigger reference
2. **Upgrading the project's `fro-bot.yaml`** to use all supported triggers with purpose-built prompts
3. **Creating a pristine drop-in example workflow** for other projects adopting Fro Bot

## Problem Statement / Motivation

- **Documentation gap:** Users can't discover `issues`, `discussion_comment`, or `pull_request` (AI review) triggers from the README. The "Supported Events" table exists but lacks setup guidance, required permissions, `if` conditions, and concurrency considerations.
- **Underutilized code:** `issues.opened` auto-triage and `discussion_comment` engagement are fully implemented in `router.ts` (lines 223-322) and `prompt.ts` (lines 33-44) but never activated.
- **Generic prompts:** The current `DEFAULT_PROMPT` and `SCHEDULE_PROMPT` are vague. Event-specific prompts would make the agent far more useful.
- **No reusable template:** Other repos wanting Fro Bot have to reverse-engineer the workflow from the README examples, which only show fragments.

## Proposed Solution

### Deliverable 1: README Enhancement (`README.md`)

Expand the existing "Supported Events" section into a comprehensive reference:

| Section | Content |
| --- | --- |
| **Trigger Reference Table** | All 7 event types with: supported actions, required permissions, `@mention` requirement, prompt requirement, concurrency key |
| **Per-Trigger Details** | Collapsible `<details>` blocks explaining behavior, skip conditions, and `if` guard expressions |
| **Permissions Guide** | Minimum required `permissions` block for each trigger combination |
| **Concurrency Strategy** | How `concurrency.group` should be structured to prevent collisions across event types |
| **Security Model** | Access control (OWNER/MEMBER/COLLABORATOR gating on all triggers), fork protection, bot-loop prevention. Must explicitly document that external contributors and first-time users are gated out. |

Keep existing Quick Start (minimal `issue_comment` only) intact — the trigger reference goes in a new "## Event Trigger Reference" section between "Usage" and "Configuration".

### Deliverable 2: Upgraded `fro-bot.yaml` (`.github/workflows/fro-bot.yaml`)

Add missing triggers to the project's own workflow:

| Trigger | Current | Proposed | Notes |
| --- | --- | --- | --- |
| `issue_comment` | `created` | Keep as-is | Works |
| `pull_request_review_comment` | `created` | Keep as-is | Works |
| `schedule` | Daily midnight | Weekly Monday 9AM UTC | Less noisy, more useful |
| `workflow_dispatch` | Optional prompt | Keep as-is | Works |
| **`issues`** | **Missing** | `opened`, `edited` | Auto-triage on open; `@mention` required for edit (enforced by router) |
| **`discussion_comment`** | **Missing** | `created` | Responds to `@mention` from authorized users (OWNER/MEMBER/COLLABORATOR only — external contributors are gated by the router's `author_association` check) |
| **`pull_request`** | **Missing** | `opened`, `synchronize`, `reopened` | AI code review (distinct from CI lint/build/test) |

Update the `if` condition, concurrency group, permissions, and prompts accordingly.

#### Prompt Strategy

Replace the generic `DEFAULT_PROMPT` / `SCHEDULE_PROMPT` with event-specific prompts:

```yaml
env:
  # issue_comment / pull_request_review_comment / discussion_comment
  # → No prompt needed; the agent uses the comment body + built-in directives

  # issues.opened → Built-in triage directive from prompt.ts, no custom prompt needed

  # pull_request → Built-in review directive from prompt.ts, can enhance with custom prompt
  PR_REVIEW_PROMPT: |
    Focus your review on:
    - Correctness and edge cases
    - Security implications
    - Breaking changes to public API
    - Test coverage for new/changed behavior
    Skip style nits — the linter handles those.

  # schedule → Single maintenance report (the agent publishes exactly ONE artifact per run)
  SCHEDULE_PROMPT: |
    Perform weekly repository maintenance and create a SINGLE issue titled
    "Weekly Maintenance Report — YYYY-MM-DD" containing:
    - Open issues with no activity in 14+ days (list with links)
    - Open PRs with no review activity in 7+ days (list with links)
    - Issues labeled 'bug' without assignees (list with links)
    - Recommended actions for each item
    Do NOT comment on individual issues or PRs. Produce one summary issue only.

  # workflow_dispatch → User-provided prompt (required: true in workflow_dispatch.inputs to prevent silent skips)
```

#### Prompt → Action Input Wiring

The action's `prompt` input is how event-specific prompts reach the agent. The `PROMPT` env var must be computed from the event name to select the right prompt:

```yaml
env:
  PROMPT: >-
    ${{
      (github.event_name == 'workflow_dispatch' && (github.event.inputs.prompt || ''))
      || (github.event_name == 'schedule' && env.SCHEDULE_PROMPT)
      || (github.event_name == 'pull_request' && env.PR_REVIEW_PROMPT)
      || ''
    }}

# In the step:
- uses: fro-bot/agent@v0  # or ./
  with:
    prompt: ${{ env.PROMPT }}
```

Events not listed above (`issue_comment`, `pull_request_review_comment`, `discussion_comment`, `issues`) pass an empty prompt — the agent uses the comment body + built-in directives from `getTriggerDirective()` in `prompt.ts`.

#### Concurrency Group Update

Current group only handles issues and PRs:

```yaml
# Current (incomplete)
group: fro-bot-${{ github.event.issue.number || github.event.pull_request.number || github.ref }}

# Proposed (covers all event types)
# Falls through to run_id for schedule/dispatch where there's no
# issue/PR/discussion number — each run gets its own group (no dedup needed).
group: >-
  fro-bot-${{
    github.event.issue.number
    || github.event.pull_request.number
    || github.event.discussion.number
    || github.run_id
  }}
```

#### Permissions Expansion

```yaml
# Full mode (all 7 triggers)
permissions:
  contents: read # Checkout + code access
  discussions: write # Discussion comments (only needed if using discussion_comment trigger)
  issues: write # Issue comments + labels
  pull-requests: write # PR reviews + comments


# Mention-less mode (minimal — no comment triggers)
# permissions:
#   contents: read
#   issues: write        # For issues.opened triage + schedule maintenance reports
#   pull-requests: write # For pull_request AI reviews
```

#### `if` Condition Update

The existing `if` condition needs to handle:

- `issues` events (no `@mention` required for `opened`, required for `edited` — but the router handles this, so the workflow `if` only needs to pass `issues` through)
- `discussion_comment` events (same `@mention` + author_association checks as `issue_comment`)
- `pull_request` events (no `@mention`, no fork PRs)

```yaml
if: >-
  (
    github.event.pull_request == null ||
    !github.event.pull_request.head.repo.fork
  ) && (
    github.event_name == 'issues' ||
    github.event_name == 'schedule' ||
    github.event_name == 'workflow_dispatch' ||
    github.event_name == 'pull_request' ||
    (
      (github.event_name == 'issue_comment' ||
       github.event_name == 'pull_request_review_comment' ||
       github.event_name == 'discussion_comment') &&
      contains(github.event.comment.body || '', '@fro-bot') &&
      (github.event.comment.user.login || '') != 'fro-bot' &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association || '')
    )
  )
```

**Fork guard strategy:** The first clause (`github.event.pull_request == null || !github.event.pull_request.head.repo.fork`) is a generic guard that works for both `pull_request` AND `pull_request_review_comment` events — both include `github.event.pull_request` in their payload. Events without `pull_request` in the payload (issues, schedule, etc.) pass through because `== null` is true. This preserves the existing pattern from the current workflow.

The router (`router.ts`) does its own skip-condition checks (bot filtering, association gating, draft PR skip, locked issue skip), so the workflow `if` is a cost-saving pre-filter + fork gate, not the sole security boundary.

### Deliverable 3: Pristine Example Workflow (`docs/examples/fro-bot.yaml`)

A self-contained, well-commented drop-in file for external projects:

**Design principles:**

- Uses `fro-bot/agent@v0` (not `./`)
- Documents token requirements clearly: **Two deployment modes:**
  1. **Mention-less mode** (`GITHUB_TOKEN` only): Works for `pull_request`, `issues.opened`, `schedule`, `workflow_dispatch`. No `@mention` triggers. Simplest setup — 1 secret (`OPENCODE_AUTH_JSON`).
  2. **Full mode** (PAT or GitHub App token): Enables all 7 triggers including `@mention` in comments. The token's login must match the `@` mention users will type (e.g., PAT for `fro-bot` user = users type `@fro-bot`). Requires an additional secret. The example workflow defaults to **Full mode** with clear comments explaining how to fall back to Mention-less mode by removing comment triggers.
- All prompts defined as `env` variables for easy customization
- Comprehensive inline comments explaining each trigger, permission, and `if` condition
- Covers all 7 supported event types, clearly labeled as **required** (`issue_comment`) vs **recommended** (`issues`, `pull_request`, `schedule`) vs **optional** (`discussion_comment`, `pull_request_review_comment`, `workflow_dispatch`) so adopters can prune without guessing
- Fork protection for `pull_request` events
- Proper `concurrency` to prevent duplicate runs

**Structure:**

```
docs/examples/fro-bot.yaml     # Drop-in workflow file
docs/examples/README.md         # NOT CREATED (docs only if requested)
```

## Technical Considerations

- **Bot mention identity (`botLogin`):** The router's `hasBotMention()` matches against the authenticated token's login. With `GITHUB_TOKEN`, the login is `github-actions[bot]`, so users would need to type `@github-actions` — not `@fro-bot`. To use a custom mention like `@fro-bot`, the workflow needs a PAT or GitHub App token for that bot account. The README and example workflow must clearly document this: `GITHUB_TOKEN` works for non-mention triggers (`issues.opened`, `pull_request`, `schedule`, `workflow_dispatch`), but **mention-based triggers require a token whose login matches the `@` mention users will type**. The project's own `fro-bot.yaml` uses `FRO_BOT_PAT` specifically for this reason.
- **`pull_request` overlap with CI:** The CI workflow already triggers on `pull_request` for build/test. The Fro Bot workflow's `pull_request` trigger is for AI code review — a fundamentally different job. Both can run in parallel. The concurrency group (`fro-bot-*`) is distinct from CI's group (`CI-*`), so no collision.
- **`discussion_comment` permissions:** Requires `discussions: write` permission. If the repo doesn't have Discussions enabled, the trigger simply never fires — no error.
- **Fork PRs:** `pull_request` from forks has `contents: read` only and can't post reviews with `GITHUB_TOKEN`. The `if` condition should filter forks: `!github.event.pull_request.head.repo.fork`.
- **Schedule + prompt requirement:** The router **skips** the event (with `skipReason: 'prompt_required'`) if `schedule` fires without a prompt — it does not crash or hard-fail. The prompt must be passed via the `prompt` action input (set from env var in the workflow). The action will exit cleanly with no output.
- **Author association gating:** All triggers gate on `author_association` — only `OWNER`, `MEMBER`, and `COLLABORATOR` can activate the agent. This means `issues.opened` auto-triage only runs for issues opened by authorized users, not external contributors. Similarly, `discussion_comment` only responds to mentions from authorized users. The README must document this clearly to avoid confusion about "community engagement" capabilities. If broader access is desired in the future, it would require a code change to `ALLOWED_ASSOCIATIONS` in `types.ts`.

## Acceptance Criteria

- [x] README contains a new "## Event Trigger Reference" section with all 7 event types, their actions, permissions, and concurrency keys
- [x] README trigger reference includes per-trigger `<details>` blocks with skip conditions and `if` guard examples
- [x] Project's `fro-bot.yaml` includes `issues`, `discussion_comment`, and `pull_request` triggers
- [x] Project's `fro-bot.yaml` has event-specific prompts (not a generic `DEFAULT_PROMPT`)
- [x] Project's `fro-bot.yaml` `if` condition correctly handles all event types
- [x] Project's `fro-bot.yaml` concurrency group covers `discussion.number` and `run_id` fallback
- [x] Project's `fro-bot.yaml` permissions include `discussions: write`, `issues: write`, `pull-requests: write`
- [x] `docs/examples/fro-bot.yaml` exists as a self-contained drop-in for external projects
- [x] Example workflow uses `fro-bot/agent@v0` (not `./`)
- [x] Example workflow has inline comments explaining each trigger, guard, and prompt
- [x] Example workflow includes fork protection for `pull_request`
- [x] All existing README content (Quick Start, How It Works, Configuration, etc.) remains unchanged
- [x] No code changes — this is documentation and workflow YAML only

## Success Metrics

- External projects can copy `docs/examples/fro-bot.yaml` into their `.github/workflows/` directory, set 1 secret (`OPENCODE_AUTH_JSON`), and have a working agent covering all 7 triggers
- The README trigger reference answers "what events does Fro Bot support?" without requiring source code reading

## Dependencies & Risks

| Risk | Mitigation |
| --- | --- |
| `discussions: write` permission not available in all repos | Note in docs that Discussions must be enabled; trigger is silently ignored if not |
| `pull_request` from forks can't post reviews | `if` condition filters forks; document this limitation |
| Schedule prompt forgotten by adopters | Example workflow includes the prompt inline with clear comments |
| Concurrency group collision between triggers | Test that `run_id` fallback works for schedule/dispatch (no issue/PR/discussion number) |

## References & Research

### Internal References

- Event classification: `src/lib/github/context.ts:16-36` (`classifyEventType`)
- Event normalization: `src/lib/github/context.ts:38-164` (`normalizeEvent`)
- NormalizedEvent types: `src/lib/github/types.ts:19-143` (all 8 variants)
- Router skip conditions: `src/lib/triggers/router.ts:256-322` (issues), `374-430` (pull_request), `623-632` (discussion_comment)
- Trigger directives (built-in prompts): `src/lib/agent/prompt.ts:19-68` (`getTriggerDirective`)
- Supported actions: `ISSUES_SUPPORTED_ACTIONS` (opened, edited), `PR_SUPPORTED_ACTIONS` (opened, synchronize, reopened)
- Current workflow: `.github/workflows/fro-bot.yaml` (77 lines, 4 triggers)
- CI workflow: `.github/workflows/ci.yaml` (handles `pull_request` for build/test only)
- Trigger types/config: `src/lib/triggers/types.ts:171-193` (`TriggerConfig`, `DEFAULT_TRIGGER_CONFIG`)

### External References

- [GitHub Actions: Events that trigger workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)
- [GitHub Actions: Workflow syntax — permissions](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions)
- [GitHub Actions: Concurrency](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#concurrency)
