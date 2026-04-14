---
title: "feat: Add compounding project wiki maintained by Fro Bot"
type: feat
status: active
date: 2026-04-13
origin: docs/brainstorms/2026-04-13-compounding-wiki-requirements.md
deepened: 2026-04-13
---

# feat: Add compounding project wiki maintained by Fro Bot

## Overview

Add a Karpathy-style compounding wiki to fro-bot/agent. Fro Bot maintains human-readable documentation in `docs/wiki/` as an Obsidian vault, updated weekly via scheduled runs. The wiki covers architecture, subsystems, and conventions — making the project's institutional knowledge navigable by human developers, not just agents.

## Problem Frame

Fro Bot accumulates deep knowledge through session memory and project memories, but this knowledge is invisible to human developers. AGENTS.md is prescriptive (tells agents what to do), not descriptive (explains how the system works). Human developers need navigable long-form docs. (see origin: docs/brainstorms/2026-04-13-compounding-wiki-requirements.md)

## Requirements Trace

- R1. Markdown wiki pages in `docs/wiki/` covering architecture, subsystems, conventions
- R2. Written for human developers using Obsidian
- R3. Weekly scheduled run trigger
- R4. PR with GitHub native auto-merge (`gh pr merge --auto --squash`)
- R5. Incremental after initial seed
- R6. 6 canonical seed pages
- R7. YAML frontmatter metadata on each page
- R8. `docs/wiki/index.md` as navigable entry point
- R9. AGENTS.md stays separate (prescriptive vs descriptive boundary)
- R10. fro-bot/agent only
- R11. Valid Obsidian vault with selective `.obsidian/` config
- R12. Obsidian wikilinks for cross-references
- R13. Dataview plugin + graph view color groups
- R14. Agent-driven generation
- R15. Lint pass on every update cycle

## Scope Boundaries

- NOT replacing AGENTS.md
- NOT building chat/query interface
- NOT generating wiki for other repos
- NOT embedding-based search
- NOT publishing to GitHub Pages
- NOT full regeneration on demand

## Context & Research

### Relevant Code and Patterns

**Schedule trigger infrastructure:**
- `.github/workflows/fro-bot.yaml` — single `schedule` entry (`30 15 * * *` daily), `SCHEDULE_PROMPT` env var at job level, `PROMPT` expression selects it for schedule events (line 117: `github.event_name == 'schedule' && env.SCHEDULE_PROMPT`)
- `github.event.schedule` — discriminator field containing the cron expression that fired, available when multiple cron entries exist in the `schedule` array
- `src/features/triggers/context-builders-manual.ts` — `buildScheduleContextData()` builds context with `kind: 'manual'`, `number: 0`, and `commentBody` set to the effective prompt
- `src/features/agent/prompt.ts` L70-72 — `getTriggerDirective()` returns `{directive: promptInput, appendMode: false}` for schedule events, so the prompt input IS the task

**Delegated work module:**
- `src/features/delegated/branch.ts` — `createBranch()`, `branchExists()`, `generateUniqueBranchName()`
- `src/features/delegated/commit.ts` — `createCommit()` with atomic multi-file Git Data API flow
- `src/features/delegated/pull-request.ts` — `createPullRequest()`, `findExistingPR()`, `updatePullRequest()`, `addPRLabels()`
- No existing auto-merge function — agent uses `gh pr merge --auto --squash` via CLI

**Existing schedule prompt pattern:**
- The `SCHEDULE_PROMPT` env var contains the full task instructions as a multi-line string
- The `PROMPT` expression at step level selects between `workflow_dispatch` input, `SCHEDULE_PROMPT`, or empty
- To add a second schedule type, add a second cron entry and use `github.event.schedule` to discriminate

### Institutional Learnings

- `docs/solutions/versioned-tool-config-plugin-pattern` — Pattern for constant-based configuration; relevant for any new config constants
- Session history from this session — extensive Oracle consultation on wiki architecture, Karpathy pattern analysis, DeepWiki quality comparison

## Key Technical Decisions

- **Separate cron entry**: Add a second `schedule` entry (`0 20 * * 0` — Sundays 8pm UTC) to `fro-bot.yaml`. Use `github.event.schedule` to select `WIKI_PROMPT` vs `SCHEDULE_PROMPT` in the `PROMPT` expression. This keeps DMR (Daily Maintenance Report) daily and wiki weekly without interference. Exact expression:
  ```yaml
  PROMPT: >-
    ${{ (github.event_name == 'workflow_dispatch' && (github.event.inputs.prompt || ''))
    || (github.event_name == 'schedule' && github.event.schedule == '0 20 * * 0' && env.WIKI_PROMPT)
    || (github.event_name == 'schedule' && env.SCHEDULE_PROMPT)
    || '' }}
  ```
  Note: wiki cron check comes first; DMR is the default fallback for any other schedule entry.
- **Agent creates PR via `gh` CLI**: The agent writes files, commits, creates/updates the wiki branch and PR, then runs `gh pr merge --auto --squash`. No harness changes needed — the agent uses existing `gh` CLI access.
- **One PR per cycle, update if open**: Agent checks `gh pr list --head fro-bot/wiki-update`. If open PR exists, push to it. If none, create new branch and PR. Avoids PR spam.
- **Start with 6 pages, agent decides granularity at generation time**: If a page exceeds ~2000 words, the agent may split it. No rigid page count constraint.
- **Queryable frontmatter, no inline Dataview queries**: Wiki pages include structured YAML frontmatter but do not contain Dataview code blocks. Dataview plugin is NOT bundled in the repo — users install it on first vault open if they want frontmatter queries. `community-plugins.json` lists `"dataview"` as a hint.
- **Lint before update**: Agent runs a scoped lint pass first, then generates content updates. All changes in one PR. v1 lint scope: (1) broken wikilinks — verify each `[[Page Name]]` has a corresponding `.md` file; (2) orphan pages — verify each page (except index) has at least one inbound link; (3) stale pages — compare `sources` frontmatter against `git log` for changes. Contradiction detection and missing coverage checks deferred to v2.

## Open Questions

### Resolved During Planning

- **Same job as DMR or separate?** → Separate cron entry. DMR is daily; wiki is weekly. `github.event.schedule` discriminates which cron fired.
- **PR accumulation?** → Update existing open PR if one exists; create new if none.
- **Page granularity?** → Start with 6, agent splits if needed. Deferred to execution.
- **Dataview config?** → Queryable frontmatter only. No inline queries for v1.

### Deferred to Implementation

- **Graph color group persistence** — test empirically when setting up `.obsidian/graph.json`. Cosmetic; adjust if it doesn't work.
- **Exact page prose style and depth** — agent determines during generation. Review first output and iterate.
- **Staleness detection accuracy** — agent compares page `sources` frontmatter against `git log` of those files. Refine heuristic after observing first few cycles.

## Implementation Units

- [ ] **Unit 1: Scaffold Obsidian vault and .gitignore**

  **Goal:** Create the `docs/wiki/` directory structure with Obsidian vault config, `.gitignore` for user-specific files, and a placeholder `index.md`.

  **Requirements:** R1, R8, R11, R12, R13

  **Dependencies:** None

  **Files:**
  - Create: `docs/wiki/.obsidian/app.json`
  - Create: `docs/wiki/.obsidian/community-plugins.json`
  - Create: `docs/wiki/.obsidian/graph.json`
  - Create: `docs/wiki/.gitignore`
  - Create: `docs/wiki/index.md`

  **Approach:**
  - `app.json`: enable wikilinks (`"useMarkdownLinks": false`), set attachment folder
  - `community-plugins.json`: `["dataview"]` — hints that Dataview is recommended; user must install the plugin on first vault open
  - `graph.json`: color groups by `type` frontmatter field using Obsidian search query syntax:
    ```json
    {
      "colorGroups": [
        {"query": "[type:architecture]", "color": {"a": 1, "rgb": 4468453}},
        {"query": "[type:subsystem]", "color": {"a": 1, "rgb": 14684176}},
        {"query": "[type:convention]", "color": {"a": 1, "rgb": 16185856}}
      ]
    }
    ```
  - `.gitignore`: ignore `workspace*.json`, `hotkeys.json`, `appearance.json`, `core-plugins*.json`, `bookmarks.json`, `backlink.json`
  - `index.md`: YAML frontmatter with vault description, placeholder page list that the agent will populate

  **Patterns to follow:**
  - Obsidian community vault gitignore conventions (from brainstorm feasibility review)
  - Existing `docs/` directory structure in repo

  **Test scenarios:**
  - Open `docs/wiki/` in Obsidian — vault loads without errors
  - Graph view shows color groups (verify `graph.json` format)
  - Dataview listed in community plugins (user installs on first open)

  **Verification:**
  - Obsidian opens the vault cleanly
  - Graph view shows color groups when pages with `type` frontmatter exist
  - `.gitignore` excludes user-specific files
  - `index.md` renders in both Obsidian and GitHub (standard markdown links for GitHub navigation)

- [ ] **Unit 2: Add weekly wiki schedule to fro-bot.yaml**

  **Goal:** Add a second cron entry for weekly wiki updates and a `WIKI_PROMPT` env var with the wiki maintenance instructions.

  **Requirements:** R3, R4, R5, R14, R15

  **Sequencing note:** Units 1 and 2 must ship in the same PR and merge to main before Unit 3 can execute. Unit 3 is triggered by the first wiki schedule run (or manual `workflow_dispatch` with `WIKI_PROMPT` content) after that merge.

  **Dependencies:** Unit 1 (vault must exist in repo)

  **Files:**
  - Modify: `.github/workflows/fro-bot.yaml`

  **Approach:**
  - Add `- cron: '0 20 * * 0'` (Sundays 8pm UTC) to the `schedule` array
  - Add `WIKI_PROMPT` env var at job level alongside `SCHEDULE_PROMPT`
  - Modify the `PROMPT` expression to discriminate: `github.event.schedule == '0 20 * * 0'` selects `WIKI_PROMPT`, otherwise `SCHEDULE_PROMPT`
  - The `WIKI_PROMPT` instructs the agent to:
    1. Check for an existing open wiki PR (`gh pr list --head fro-bot/wiki-update --state open`)
    2. Run lint pass on existing `docs/wiki/` pages (R15)
    3. Determine which pages need updates based on merged PRs since last wiki update
    4. Generate/update affected pages with wikilinks, frontmatter, and source references
    5. Update `docs/wiki/index.md`
    6. Create or update branch `fro-bot/wiki-update`, commit, create/update PR
    7. Enable auto-merge: `gh pr merge --auto --squash` (include fallback: if auto-merge fails, leave PR open and note failure)
    8. Branch recovery: if `fro-bot/wiki-update` branch exists but has no open PR, delete and create fresh; if merge conflicts exist, recreate the branch from main
  - The prompt must include a pre-flight check: "Verify `gh pr merge --auto` is available by checking a test PR or `gh api repos/{owner}/{repo}` for auto-merge support. If unavailable, create the PR without auto-merge."
  - The prompt must specify the page frontmatter schema (R7), wikilink format (R12), and scoped lint checks (R15: broken wikilinks, orphan pages, stale pages only)

  **Technical design:** *(Directional guidance for the WIKI_PROMPT structure, not the exact text.)*

  The WIKI_PROMPT should follow the same multi-paragraph, instruction-dense style as the existing `SCHEDULE_PROMPT` (lines 35-63 of fro-bot.yaml). Key sections the prompt must cover:

  - **Identity**: "You are maintaining a project wiki as an Obsidian vault in `docs/wiki/`."
  - **Branch workflow**: Check for open wiki PR → create/update `fro-bot/wiki-update` branch → commit → PR → auto-merge. Include orphaned-branch recovery.
  - **Page schema**: Exact YAML frontmatter fields (`last-updated`, `updated-by`, `sources`, `type`, `summary`), allowed `type` values, wikilink format `[[Page Name]]`.
  - **Lint pass**: Before writing, check broken wikilinks (each `[[X]]` has `X.md`), orphan pages (each page except index has ≥1 inbound link), stale pages (`sources` files changed in `git log` since `last-updated`). Fix inline.
  - **Update strategy**: Read `git log --oneline` since last wiki update commit. Identify which pages' `sources` files were touched. Update only those pages. For seed run (no existing pages), generate all 6 canonical pages.
  - **Content guidance**: Descriptive (how it works), not prescriptive (what to do). Use wikilinks. Cite source files. No verbatim code blocks. Reference RFCs by number.
  - **Index update**: After page changes, regenerate `docs/wiki/index.md` with standard markdown links for GitHub + wikilinks for Obsidian.
  - **Constraints**: Do NOT modify AGENTS.md. Do NOT modify source code. Do NOT create issues. This run must only update `docs/wiki/` and create one PR.

  **Patterns to follow:**
  - Existing `SCHEDULE_PROMPT` multi-line env var pattern in `fro-bot.yaml`
  - `github.event.schedule` discriminator pattern (standard GitHub Actions feature for multiple cron entries)

  **Test scenarios:**
  - Weekly cron fires → `WIKI_PROMPT` is selected as the prompt
  - Daily cron fires → `SCHEDULE_PROMPT` is still selected (no regression)
  - `workflow_dispatch` still uses input prompt (no regression)
  - `WIKI_PROMPT` expression evaluates correctly in the step-level `PROMPT` env var

  **Verification:**
  - `fro-bot.yaml` has 2 schedule entries
  - PROMPT expression correctly discriminates between the two cron strings
  - Existing DMR functionality unchanged

- [ ] **Unit 3: Generate initial seed wiki pages**

  **Goal:** Create the 6 canonical wiki pages with full content, wikilinks, and frontmatter. This is the initial "seed" generation — all pages from scratch.

  **Requirements:** R1, R2, R5, R6, R7, R9, R12, R14

  **Dependencies:** Unit 1 + Unit 2 (must be merged to main — this unit executes via the wiki schedule trigger, not as a code change)

  **Files:**
  - Create: `docs/wiki/Architecture Overview.md`
  - Create: `docs/wiki/Execution Lifecycle.md`
  - Create: `docs/wiki/Session Persistence.md`
  - Create: `docs/wiki/Prompt Architecture.md`
  - Create: `docs/wiki/Setup and Configuration.md`
  - Create: `docs/wiki/Conventions and Patterns.md`
  - Modify: `docs/wiki/index.md`

  **Approach:**
  - Each page follows the frontmatter schema: `last-updated`, `updated-by`, `sources`, `type`, `summary`
  - Content sourced from: AGENTS.md, RFCs, source code reading, session history
  - Cross-references use `[[Page Name]]` wikilinks wherever one page mentions a concept covered by another
  - `index.md` updated with page list, summaries, and topic groupings — uses **standard markdown links** (`[Page Name](Page%20Name.md)`) for GitHub navigability alongside wikilinks for Obsidian
  - Page names use spaces (Obsidian convention), not kebab-case

  **Execution note:** This unit is executed by the Fro Bot agent during its first wiki schedule run, not by a human. The agent reads the codebase and generates content. However, a manual trigger via `workflow_dispatch` with the `WIKI_PROMPT` can seed pages before the first Sunday cron.

  **Test scenarios:**
  - Each page has valid YAML frontmatter with all required fields
  - Wikilinks between pages resolve in Obsidian (no broken `[[...]]` references)
  - `index.md` lists all 6 pages with summaries
  - Pages are descriptive (how it works), not prescriptive (what to do) — boundary with AGENTS.md maintained (R9)
  - No page duplicates AGENTS.md prescriptive content (conventions section describes patterns, doesn't list rules)
  - No source code blocks copied verbatim — pages describe architecture, not reproduce code

  **Verification:**
  - Open vault in Obsidian → graph view shows 7 nodes (6 pages + index) with edges from wikilinks
  - Dataview query `TABLE summary FROM ""` returns all pages with summaries
  - Pages read as coherent documentation to a human who hasn't seen the codebase

## Post-Seed Validation Checklist

After Unit 3 completes (first wiki seed run), validate on the second wiki cycle:

- [ ] Only pages whose `sources` files changed have updated `last-updated` dates
- [ ] Unchanged pages are untouched
- [ ] Lint detects a broken wikilink if a page is manually renamed → agent fixes it
- [ ] PR description lists which pages were updated and what triggered the update
- [ ] PR auto-merges after CI passes
- [ ] After merging a PR that modifies `src/features/agent/prompt.ts`, the "Prompt Architecture" page is updated but "Session Persistence" is not

## System-Wide Impact

- **Interaction graph:** The wiki schedule cron adds a second trigger to the Fro Bot workflow. The `PROMPT` expression must correctly discriminate or both DMR and wiki will receive the wrong prompt. Both triggers share the same `concurrency` group keyed on `github.run_id`, so they never overlap — each cron entry fires as a separate workflow run.
- **Error propagation:** If wiki generation fails, the agent should note the failure in the PR body or leave a comment on a tracking issue. The failure must not block subsequent DMR runs. This is guaranteed by the separate cron entries — each fires independently, and a wiki failure on Sunday doesn't affect DMR on Monday.
- **State lifecycle risks:** The `fro-bot/wiki-update` branch persists between runs. If auto-merge fails (CI failure, merge conflict), the next wiki run must handle the stale branch gracefully — push to it or recreate it.
- **API surface parity:** No changes to the action's public API (action.yaml inputs/outputs). This is purely workflow configuration + agent prompt content.
- **Integration coverage:** The key integration test is a real schedule run that produces a wiki PR. No unit test can prove the agent generates good documentation — quality is validated by human review of the first 2-3 outputs.

## Risks & Dependencies

- **Auto-merge requires repo setting:** GitHub auto-merge must be enabled in repo branch protection settings. This is a manual admin action, not code.
- **Agent output quality:** The wiki is only as good as the agent's writing. First few outputs will likely need manual review and iteration on the `WIKI_PROMPT`.
- **Cron discrimination correctness:** If `github.event.schedule` doesn't match the cron string exactly, the wrong prompt fires. Test carefully.
- **Branch staleness:** If the wiki PR fails to merge for multiple cycles, the branch could accumulate conflicts. Agent must handle this (force-push or recreate).

## Documentation / Operational Notes

- Update AGENTS.md to note the `docs/wiki/` directory and its purpose
- Add `docs/wiki/` to the `.github/settings.yml` if path-based branch protection rules apply
- Enable GitHub auto-merge in repo settings before the first wiki run

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-13-compounding-wiki-requirements.md](../brainstorms/2026-04-13-compounding-wiki-requirements.md)
- Related: Karpathy LLM Wiki pattern (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- Related: DeepWiki output for fro-bot/agent (https://deepwiki.com/fro-bot/agent) — quality benchmark
- Related: Oracle consultation on wiki architecture (this session)
- Schedule trigger: `.github/workflows/fro-bot.yaml`
- Delegated work: `src/features/delegated/`
- Context builders: `src/features/triggers/context-builders-manual.ts`
