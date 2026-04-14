---
date: 2026-04-13
topic: compounding-wiki
---

# Compounding Project Wiki

## Problem Frame

Fro Bot accumulates deep knowledge about the repos it serves through session memory, project memories, and `ce:compound` learnings. But this knowledge is trapped in agent context — invisible to human developers. Meanwhile, AGENTS.md is a compact operator-facing index that tells agents _how_ to work in the codebase but doesn't explain _how the system works_ to humans.

Human developers (contributors, reviewers, maintainers) need navigable, long-form documentation that explains architecture, data flow, conventions, and key subsystems. Today this doesn't exist. DeepWiki demonstrated that auto-generated project docs are useful (30+ pages for fro-bot/agent), but its cold-start, snapshot model is the opposite of Fro Bot's persistent-memory advantage.

## Requirements

- R1. Fro Bot maintains a set of markdown wiki pages in `docs/wiki/` covering the project's architecture, subsystems, and conventions.
- R2. Wiki pages are written for **human developers who use Obsidian** as their primary reader. Pages degrade to readable markdown on GitHub but wikilinks will not resolve outside Obsidian.
- R3. Wiki updates happen on a **weekly scheduled run** (alongside DMR), not on every merge.
- R4. Wiki changes are delivered via **PR with GitHub native auto-merge** (`gh pr merge --auto --squash`). Never direct commits to main.
- R5. After the initial seed, the wiki is **incremental** — Fro Bot updates only pages affected by recent changes, not regenerating from scratch. The initial seed run generates all pages from scratch.
- R6. Initial seed covers 6 canonical pages: Architecture Overview, Execution Lifecycle, Session Persistence, Prompt Architecture, Setup & Configuration, Conventions & Patterns. Page count may expand based on natural content boundaries.
- R7. Each wiki page includes YAML frontmatter metadata: `last-updated` (date), `updated-by` (commit SHA or session ID), `sources` (file paths, RFC numbers), `type` (architecture | subsystem | convention), and `summary` (one-line description for the index).
- R8. A `docs/wiki/index.md` serves as the navigable entry point — lists all pages with summaries, organized by topic area.
- R9. `AGENTS.md` remains manually curated and separate. **Boundary:** AGENTS.md contains prescriptive agent instructions (what to do, where to look). The wiki contains descriptive documentation (how the system works, why decisions were made). When content could fit both, it belongs in the wiki.
- R10. Scope is **fro-bot/agent only** for the initial implementation.
- R11. `docs/wiki/` is a valid **Obsidian vault** with a committed `.obsidian/` folder (selectively — see gitignore spec below). A developer can open it directly in the Obsidian application and get graph view, backlinks, and search out of the box.
- R12. Pages use **Obsidian wikilinks** (`[[Page Name]]`) for cross-references, enabling native graph view and backlink resolution.
- R13. The `.obsidian/` config includes **Dataview** plugin setup (frontmatter becomes queryable) and **graph view color groups** for page types (architecture, convention, subsystem).
- R14. Wiki generation is **agent-driven** — the schedule prompt instructs the OpenCode agent to read the codebase, its own session history, and existing wiki pages, then update affected pages. The harness does not parse session data directly.
- R15. Each wiki update cycle includes a **lint pass** before generating updates. The agent checks for: broken wikilinks, orphan pages (no inbound links), stale pages (source files changed since last update), contradictions between pages, and missing coverage (source modules with no wiki page). Fixes are included in the same PR as content updates.

### Obsidian Vault Gitignore Spec (R11)

**Commit** (shared config):
- `.obsidian/app.json` (vault settings: wikilinks enabled, attachment folder)
- `.obsidian/community-plugins.json` (enabled plugins list)
- `.obsidian/plugins/dataview/data.json` (Dataview settings)
- `.obsidian/graph.json` (color groups only — accept that zoom/pan state is included)

**Ignore** (user-specific state):
- `.obsidian/workspace*.json`
- `.obsidian/hotkeys.json`
- `.obsidian/appearance.json`
- `.obsidian/core-plugins*.json`
- `.obsidian/bookmarks.json`
- `.obsidian/backlink.json`

### Signal Sources for Updates (R5)

Wiki updates are triggered by changes since the last update:
- **Merged PRs** — `git log` of commits since last wiki update commit
- **Session summaries** — agent reads its own recent session context for architectural insights
- **Existing page content** — agent compares current page against current codebase to detect staleness

`ce:compound` learnings in `docs/solutions/` are a reference source (the agent can read them) but not an automatic trigger.

## Success Criteria

- Human developer can open `docs/wiki/` in Obsidian and navigate the project's architecture without reading source code or AGENTS.md.
- Wiki pages stay current — within one scheduled update cycle of a significant architectural change, the relevant page reflects the new state.
- Wiki updates are traceable — each page's frontmatter shows when it was last updated and what triggered the update.
- No wiki update regresses existing correct content (incremental, not destructive).

## Scope Boundaries

- NOT replacing AGENTS.md — it stays as the agent-facing schema/instructions layer.
- NOT building a chat/query interface ("Ask the wiki") — that's a future concern.
- NOT generating wiki for other repos — fro-bot/agent only for v1.
- NOT embedding-based search — `index.md` + Obsidian search is sufficient at this scale.
- NOT publishing to GitHub Pages or external hosting — `docs/wiki/` in the repo is the delivery mechanism.
- NOT implementing full wiki regeneration on demand — initial seed only. Regeneration may be added later.

## Key Decisions

- **Audience: Human developers using Obsidian** — prose and structure optimized for human comprehension with Obsidian as the primary viewer. Readable as plain markdown on GitHub but wikilinks won't resolve there.
- **Trigger: Weekly scheduled run** — wiki update is a task within the existing schedule trigger, like the DMR.
- **Delivery: PR + GitHub auto-merge** — respects branch protection rules; Fro Bot creates a PR for wiki changes with `gh pr merge --auto --squash` to auto-merge after checks pass.
- **Relationship to AGENTS.md: Separate with defined boundary** — AGENTS.md is prescriptive (what to do). The wiki is descriptive (how it works). They coexist with this explicit boundary.
- **Incremental updates after seed** — Initial run generates all pages. Subsequent runs update only pages affected by recent changes. Fro Bot reads merged PRs, session context, and current page content to produce targeted updates.
- **Agent-driven architecture** — The OpenCode agent generates wiki content using its own tools and memory. The harness provides the trigger and PR creation; it does not parse session data or generate content.
- **Obsidian vault** — `docs/wiki/` includes selective `.obsidian/` config committed to source control. Wikilinks for cross-references. Dataview plugin + graph view color groups for page type visualization.

## Dependencies / Assumptions

- Fro Bot already has branch/commit/PR creation capabilities via `src/features/delegated/`.
- GitHub auto-merge must be enabled in the repo's branch protection settings (repo admin action, not code change).
- Schedule trigger already runs DMR — wiki update would be an additional task in the same run or a separate schedule entry.
- The OpenCode agent has access to `session_search`, `session_read`, file read/write tools, and `gh` CLI during the scheduled run.

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] Should wiki update run in the same schedule job as DMR, or a separate schedule entry? (Resource contention, run duration)
- [Affects R4][Technical] Should the PR accumulate changes across multiple cycles if the previous wiki PR hasn't merged yet?
- [Affects R6][Technical] What's the right page granularity? Should "Execution Lifecycle" be one page or split into sub-pages (bootstrap, routing, execute, finalize)?
- [Affects R13][Needs research] Verify that graph view color groups persist correctly when `graph.json` is committed (includes user zoom/pan state alongside color config).
- [Affects R13][Needs research] Determine the minimal Dataview config needed — does the wiki need inline Dataview queries in pages, or is queryable frontmatter sufficient?

## Next Steps

→ `/ce:plan` for structured implementation planning
