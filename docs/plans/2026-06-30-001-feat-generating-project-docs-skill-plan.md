---
title: "feat: generating-project-docs skill + living-docs reconciliation"
type: feat
status: done
date: 2026-06-30
origin: docs/brainstorms/2026-06-30-generating-project-docs-skill-requirements.md
---

> **Status: done.** All 5 units shipped: PRD/FEATURES archived to `docs/product/` (#1071), the `generating-project-docs` skill authored (#1073), `ARCHITECTURE.md`/`STRUCTURE.md` generated and `AGENTS.md` slimmed (#1075), `CONTRIBUTING.md`/`SECURITY.md` added and `RULES.md` retired (#1076), and `README.md` refreshed as the canonical entry point (#1077) — all merged.

# feat: generating-project-docs skill + living-docs reconciliation

## Overview

Add an agent skill at `.agents/skills/generating-project-docs/SKILL.md` that generates and refreshes the repo's **living** documentation — `README.md`, `ARCHITECTURE.md` (new), `STRUCTURE.md` (new), `CONTRIBUTING.md` (new), and community-health files (`SECURITY.md`, `.github/copilot-instructions.md`) — from live-repo facts. A reconciliation effort precedes and follows the skill: archive stale planning docs, extract architecture/structure content out of `AGENTS.md` into the new canonical docs, and repair the cross-references the moves would break.

The work is delivered in three gated phases as a stack of revertable PRs, not one mega-commit (per `docs/solutions/workflow-issues/migrate-pnpm-to-bun-monorepo-2026-06-24.md`).

## Problem Frame

Project docs have drifted. `README.md`'s body is stale, there is no `ARCHITECTURE.md`/`STRUCTURE.md`, and the repo root carries ~2.6K lines of January-stamped planning prose (`PRD.md`, `FEATURES.md`) plus overlapping convention/spec docs (`RULES.md`, `RFCS.md`). `AGENTS.md` is a hand-maintained knowledge base whose architecture/code-map/structure content is exactly what `ARCHITECTURE.md`/`STRUCTURE.md` should own, so adding those docs naively creates a third drifting copy. There is no repeatable, fact-grounded way to regenerate the human-facing docs, so they rot between releases. (See origin: `docs/brainstorms/2026-06-30-generating-project-docs-skill-requirements.md`.)

## Requirements Trace

- R1. A `generating-project-docs` skill exists at `.agents/skills/generating-project-docs/SKILL.md` defining per-document structures, style rules, a generation flow, and an argument surface — following the local `versioned-tool` skill's minimal frontmatter convention.
- R2. The skill generates/refreshes `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `CONTRIBUTING.md`, and community-health files from live-repo facts, and supports section-scoped refresh.
- R3. Re-running the skill on an existing doc preserves its evolved structure and changes only what drifted; first runs author from a bootstrap contract (no structure to preserve yet).
- R4. `ARCHITECTURE.md` and `STRUCTURE.md` become canonical concise onboarding docs (human + agent useful); they own the architecture/code-map/structure content extracted from `AGENTS.md`, which is slimmed to its operational remainder.
- R5. The reconciliation leaves a clean field: `PRD.md`/`FEATURES.md` archived, `RULES.md` folded into `CONTRIBUTING.md`, and every inbound cross-reference and lint ignore-list in **live** files (`README.md`, `.github/**`, `.agents/**`, config) repaired in lockstep. Frozen historical docs (`RFCs/*.md`, `docs/plans/*`) are explicitly out of scope — their backlinks to retired roots are accepted as historical and intentionally left as-is.
- R6. Generated docs contain no session/process/agent-internal leakage, and every cited count/file/symbol resolves against the live repo.

## Scope Boundaries

- The skill owns only the living docs and how to keep them current. It does not own or rewrite `RFCs/` specs or the `RFCS.md` index (referenced, not regenerated).
- No source-of-truth inversion drama: `ARCHITECTURE.md`/`STRUCTURE.md` own the extracted architecture/structure knowledge; `AGENTS.md` keeps the operational remainder (conventions, anti-patterns, commands, external resources, cloned-deps) and references the living docs.
- Dual-use sections keep a compact navigational stub in `AGENTS.md`, not the full content. `CODE MAP`, `WHERE TO LOOK`, and `COMPLEXITY HOTSPOTS` serve agents operationally (fast symbol/location lookup) and human onboarding. The full tables move to `STRUCTURE.md`/`ARCHITECTURE.md` (one home per fact), but `AGENTS.md` retains a short pointer index — a handful of highest-traffic entry points plus a link to the full table — so the harness keeps a quick operational map without duplicating the canonical content. The stub is navigational pointers, not a second copy of the data, so it does not re-create drift.
- Top-level `ARCHITECTURE.md`/`STRUCTURE.md` are the canonical *concise* onboarding entry points; the `docs/wiki/` Obsidian vault remains the long-form deep-dive surface. The new docs cross-link down to wiki pages; the skill does not own or modify wiki content.

### Deferred to Separate Tasks

- The 19 per-directory `AGENTS.md` files: out of scope. They re-declare some project conventions and may warrant a later de-dup pass against the new canonical docs — tracked as a follow-up, not done here.
- Retiring/redirecting the overlapping `docs/wiki/` pages (`Architecture Overview.md`, `Execution Lifecycle.md`): not done — the decision is to cross-link, not consolidate.
- Any new CI link-checker or markdown-link validation: there is no prior art in `docs/solutions/` and none exists today; if wanted, it is a separate decision (this plan relies on the skill's own cross-link verification instead).

## Context & Research

### Relevant Code and Patterns

- `.agents/skills/versioned-tool/SKILL.md` — the sole local skill and de-facto template: minimal `name` + `description` frontmatter (no `argument-hint`/schema), sentence-case `##` headings, inline content (no bundled `references/`), a closing `## Verification Checklist`, and a self-overriding "follow the repo, update the skill after" escape-hatch rule. Mirror this shape.
- `AGENTS.md` (root, 233 lines) — the extraction source. Section→destination map:
  - → `STRUCTURE.md`: `## STRUCTURE` (annotated tree), `## WHERE TO LOOK` (21-row task→location table)
  - → `ARCHITECTURE.md`: `## CODE MAP` (28-row symbol table), `## EXECUTION FLOW` (phase pipeline), `## COMPLEXITY HOTSPOTS`, the architectural bullets in `## NOTES` (four-layer architecture, dist/ committed, Node 24, SDK execution, NormalizedEvent, dual entry points, XML-tagged prompt)
  - stays in `AGENTS.md`: `## CONVENTIONS`, `## ANTI-PATTERNS`, `## COMMANDS`, `## EXTERNAL RESOURCES`, `## Cloned Dependency Source`, operational `NOTES` bullets (pre-push hook)
- `RULES.md` (1239 lines) — `CONTRIBUTING.md` content source: its contributor-workflow sections (Technology Stack, Code Style, Testing Standards, Build & Release, commit format, Quick Reference) fold into CONTRIBUTING; its Architecture/SDK-Execution patterns belong in `ARCHITECTURE.md`; its Anti-Patterns overlap `AGENTS.md`.
- Inbound cross-references that break on the moves (repair in lockstep): `README.md` (links to `AGENTS.md`, `RFCs/`), `.github/copilot-instructions.md` (encodes a "PRD > RFCs > FEATURES > RULES > AGENTS" hierarchy + per-doc reading guide), `.github/agents/fro-bot.agent.md` (reads `AGENTS.md`/`RULES.md`), `.agents/skills/versioned-tool/SKILL.md` (notes `FEATURES.md`/`AGENTS.md`), plus the `eslint.config.ts` and `.markdownlint-cli2.yaml` ignore-lists (which name `PRD*.md`, `FEATURES.md`, `RULES.md`, `RFCS.md`).
- `docs/examples/fro-bot.yaml` and `.github/workflows/fro-bot.yaml` — the wiki automation's `WIKI_PROMPT` (the explicit file-allowlist + descriptive-not-prescriptive pattern) is the model for any future doc automation; the Daily Maintenance Report prompt is **not** relevant (it only updates a single GitHub issue and references no docs).

### Institutional Learnings

- `migrate-pnpm-to-bun-monorepo-2026-06-24.md` — high-blast-radius migrations: spike then cut over as a small stack of revertable PRs; never big-bang.
- `semantic-release-tag-namespace-collision-2026-06-14.md` — migrate, don't delete-in-place: write the new path/redirect before retiring the old, so references keep resolving.
- `harness-base-version-source-of-truth-2026-06-12.md` — don't add a "docs in sync" / drift-detection test; remove the duplicate so there's one source of truth. The reconciliation's success criterion is "one home per fact," not "two copies agree."
- `versioned-tool-config-plugin-pattern-2026-03-29.md` — local skill convention: minimal frontmatter + a load-bearing verification checklist.
- `rebase-without-bun-install-stale-dist-2026-06-26.md` — after rebasing onto `main`, run `bun install` before any build/verify so generated output matches CI.

### External References

- None fetched — the two reference `generating-project-docs` skills (`marcusrbrown/systematic`, `fro-bot/.github`) are the pattern and are already summarized in the origin doc. Divergence from them is captured in Key Technical Decisions.

## Key Technical Decisions

- **Phase the AGENTS.md slim into the generation phase, not legacy-prep.** Slimming `AGENTS.md` requires `ARCHITECTURE.md`/`STRUCTURE.md` to already hold the extracted content, and creating those is the skill's first-run job. So legacy-prep does only the moves that don't depend on the new docs (archive PRD/FEATURES, repair their cross-refs); the AGENTS.md extraction + slim happens in Phase 3 once the targets exist. This resolves an ordering inconsistency in the origin doc (which listed the slim under legacy-prep).
- **Repo-shape divergence from the reference skills.** The references assume a single npm package/plugin. This repo is a Bun monorepo with multiple deployable surfaces (the GitHub Action under `src/` + `action.yaml` + committed `dist/`; `@fro.bot/harness`, `@fro.bot/gateway`, `@fro.bot/runtime` packages; `@fro.bot/workspace-agent` app; `deploy/`). So `STRUCTURE.md` Directory Layout special-cases the layered `src/` action and lists packages/apps as separate surfaces; `ARCHITECTURE.md` Data Flow shows three trigger-keyed flows (action / gateway mention-loop / harness release), not one; and the "tables only in STRUCTURE Key File Locations" style rule gets an explicit carve-out for this repo's packages/CI/deploy tables.
- **First-run bootstrap contract.** "Preserve evolved structure" only applies to re-runs. The skill defines required section ordering/headings per doc as the first-run seed, so net-new `ARCHITECTURE.md`/`STRUCTURE.md`/`CONTRIBUTING.md`/`SECURITY.md` are authored from the repo's own facts, not improvised from the reference repos' shape.
- **Minimal skill frontmatter.** `name` + `description` only, matching `versioned-tool`. No invented schema (none is enforced; `.agents/skills/` is excluded from eslint and markdownlint).
- **Lockstep cross-ref repair.** Because there is no CI link-checker, every doc move/slim patches its inbound references and the lint ignore-lists in the same PR. The skill's generation flow includes a cross-link verification step as the standing safety net.

## Open Questions

### Resolved During Planning

- Does the skill or legacy-prep create ARCHITECTURE/STRUCTURE? → The skill (Phase 3 first run); legacy-prep is the doc moves that don't need them.
- Which automation references docs prescriptively? → `.github/copilot-instructions.md` + `.github/agents/fro-bot.agent.md` (not the DMR prompt, which the origin doc misnamed). Corrected in scope.
- wiki vs new docs → top-level docs canonical-concise, cross-link to wiki deep-dives; wiki untouched.

### Deferred to Implementation

- Exact `RULES.md` section partition between `CONTRIBUTING.md`, `ARCHITECTURE.md`, and `AGENTS.md` — settle when the content is in front of the implementer; `RULES.md` is 1239 lines and will lose redundancy in the fold.
- Whether `OVERVIEW`'s one-liner in `AGENTS.md` moves to README or stays — minor, decide during the slim.
- Whether `.github/copilot-instructions.md`'s doc-hierarchy block is rewritten by hand in legacy-prep or regenerated by the skill (it is a community-health file in the skill's living set) — resolve when authoring the skill's copilot-instructions section.

## Output Structure

    .agents/skills/generating-project-docs/
    └── SKILL.md                      # the skill (inline, no bundled references/)

    ARCHITECTURE.md                   # new — canonical concise system design
    STRUCTURE.md                      # new — canonical concise layout/where-to-add
    CONTRIBUTING.md                   # new — contributor workflow (from RULES.md)
    SECURITY.md                       # new — reporting channel, supported versions, OpenSSF
    docs/product/
    ├── PRD.md                        # moved from root (historical)
    └── FEATURES.md                   # moved from root (historical)

## High-Level Technical Design

> *This illustrates the intended phasing and is directional guidance for review, not implementation specification.*

```
Phase 1 (legacy-prep, skill-independent)
  archive PRD.md, FEATURES.md → docs/product/  +  repair their inbound refs + ignore-lists

Phase 2 (author the skill)
  .agents/skills/generating-project-docs/SKILL.md
    defines: per-doc structure (README/ARCHITECTURE/STRUCTURE/CONTRIBUTING/SECURITY),
             style rules, first-run bootstrap vs re-run diff, argument surface,
             verification checklist (incl. cross-link check)

Phase 3 (first generation run — uses the skill)
  generate ARCHITECTURE.md ← extract CODE MAP / EXECUTION FLOW / HOTSPOTS / arch NOTES from AGENTS.md + live repo
  generate STRUCTURE.md    ← extract STRUCTURE / WHERE TO LOOK from AGENTS.md + live repo
  generate CONTRIBUTING.md ← fold RULES.md contributor sections
  generate SECURITY.md     ← from scratch (reporting, versions, OpenSSF)
  refresh  README.md       ← live facts, picture header, flat-square badges, link to ARCHITECTURE/STRUCTURE + wiki
  slim     AGENTS.md       ← remove extracted sections, leave operational remainder + references to living docs
  retire   RULES.md        ← after CONTRIBUTING absorbs it; repair remaining cross-refs + ignore-lists
```

## Implementation Units

- [x] **Unit 1: Archive PRD.md and FEATURES.md to docs/product/**

**Goal:** Move the two stale planning docs out of the repo root with a historical note, and repair every inbound reference and ignore-list entry so nothing dead-links.

**Requirements:** R5

**Dependencies:** None (skill-independent; this is the safe first PR).

**Files:**
- Move: `PRD.md` → `docs/product/PRD.md`; `FEATURES.md` → `docs/product/FEATURES.md`
- Modify: `.github/copilot-instructions.md` (the PRD/FEATURES references + the doc-hierarchy block), `.github/agents/fro-bot.agent.md`, `.agents/skills/versioned-tool/SKILL.md` (the `FEATURES.md` note), `eslint.config.ts` (ignore-list), `.markdownlint-cli2.yaml` (ignore-list), any `RFCs/*.md` link to `PRD.md` that is cheap to fix (else note as acceptable historical dead-link)
- Add: a one-line "historical; see README/ARCHITECTURE for current state" banner atop each moved doc

**Approach:**
- Write the new `docs/product/` location first, then update references, then ensure no root copy remains (migrate-don't-delete-in-place).
- Add `docs/product/**` to the lint ignore-lists; remove the now-stale root `PRD*.md`/`FEATURES.md` ignore entries.

**Patterns to follow:** Cross-ref repair map in Context; migrate-before-retire learning.

**Test scenarios:**
- Integration: grep the repo for `PRD.md`/`FEATURES.md` references after the move → every non-historical reference points at `docs/product/...` or is removed.
- Edge case: lint runs clean on the moved files under their new path (ignore-lists updated).
- Test expectation: no behavioral code; verification is reference-resolution + lint, not unit tests.

**Verification:** No dead links to the old paths from `README.md`, `.github/`, or `.agents/`; `bun run lint` clean; `git grep -n "FEATURES.md\|PRD.md"` shows only intended targets.

- [x] **Unit 2: Author the generating-project-docs skill**

**Goal:** Create `.agents/skills/generating-project-docs/SKILL.md` defining the living-doc set, per-document structures, style rules, first-run-vs-re-run generation flow, argument surface, and a verification checklist — adapted to this repo's monorepo shape.

**Requirements:** R1, R3, R6

**Dependencies:** None structurally, but author after Unit 1 so the skill documents the post-archive taxonomy.

**Files:**
- Create: `.agents/skills/generating-project-docs/SKILL.md`

**Approach:**
- Minimal `name` + `description` frontmatter; sentence-case `##` sections; inline (no bundled files); closing `## Verification Checklist`; the self-overriding "follow the repo, update the skill after" rule.
- Define per-doc required structure: README (picture header, flat-square badges, `·` nav, overview/getting-started/structure/automation/development/resources, avoid tables); ARCHITECTURE (orientation → Bird's-Eye → Codemap → Invariants → three trigger-keyed Data Flows → Cross-Cutting); STRUCTURE (Directory Layout special-casing layered `src/` + packages/apps surfaces → Purposes → Key File Locations tables, with the repo-specific table carve-out → Naming → Where-to-Add-Code multi-track decision tree); CONTRIBUTING (setup, `bun run` command surface, testing, commit/PR, anti-patterns, de-duped to point at ARCHITECTURE/STRUCTURE); SECURITY (reporting channel, supported versions, OpenSSF).
- Encode the core rules: derive every fact from live repo; re-derive counts from live CLI output; first-run authors from the bootstrap section ordering, re-run writes the minimal diff preserving evolved structure; section-scoped updates; no session/process leakage; cross-link verification; exclude `.slim/**`, account for the `deploy/scripts/` non-Vitest carve-out when counting.
- Argument surface: `[readme | architecture | structure | contributing | security | all | <section-name>]`.

**Execution note:** Documentation/prose authoring — no automated tests. Verification is human review against the origin doc's structure list and the two reference skills.

**Patterns to follow:** `.agents/skills/versioned-tool/SKILL.md` shape; origin doc's per-document structure section.

**Test scenarios:**
- Test expectation: none — this unit authors an instruction-prose skill file with no executable behavior. Validation is review-based (Verification below).

**Verification:** The skill defines all five living docs with concrete structures, the bootstrap-vs-diff distinction, the argument surface, and a verification checklist; `.agents/skills/` lint exclusion means no lint gate, but the file parses as valid markdown + YAML frontmatter; a reviewer can follow it to produce each doc without inventing structure.

- [x] **Unit 3: Generate ARCHITECTURE.md and STRUCTURE.md; slim AGENTS.md**

**Goal:** Run the skill to author the two canonical structural docs from `AGENTS.md`'s extracted content + live-repo facts, then slim `AGENTS.md` to its operational remainder with references to the new docs.

**Requirements:** R2, R4, R6

**Dependencies:** Unit 2 (skill must exist).

**Files:**
- Create: `ARCHITECTURE.md`, `STRUCTURE.md` (these contain *outbound* links down to the relevant `docs/wiki/` deep-dive pages — the wiki files themselves are NOT modified)
- Modify: `AGENTS.md` (remove extracted sections; add references to ARCHITECTURE/STRUCTURE), `.markdownlint-cli2.yaml` / `eslint.config.ts` if the new top-level docs need lint treatment (e.g. `<picture>` in README later, long table lines)

**Approach:**
- ARCHITECTURE.md absorbs `CODE MAP`, `EXECUTION FLOW`, `COMPLEXITY HOTSPOTS`, and architectural `NOTES`; adds the gateway + harness data-flow trees (sourced from `packages/gateway/AGENTS.md` and `packages/harness/AGENTS.md`); cross-links to `RFCs/` and the `docs/wiki/` deep-dive pages.
- STRUCTURE.md absorbs `STRUCTURE` + `WHERE TO LOOK`; adds packages/apps + CI-workflow + deploy tables and a multi-track Where-to-Add-Code tree.
- Slim AGENTS.md to: `OVERVIEW` (or move to README), `CONVENTIONS`, `ANTI-PATTERNS`, `COMMANDS`, `EXTERNAL RESOURCES`, `Cloned Dependency Source`, operational `NOTES`; replace the removed sections with one-line "see ARCHITECTURE.md / STRUCTURE.md" pointers.
- Counts (source files, lines, RFC count) re-derived from live CLI output, not copied from AGENTS.md's stale stamps.

**Patterns to follow:** The skill (Unit 2); the AGENTS.md section→destination map in Context.

**Test scenarios:**
- Integration: every file path and symbol cited in ARCHITECTURE.md/STRUCTURE.md resolves against the live tree (the skill's cross-link/symbol-resolution check).
- Edge case: counts in prose match live `find`/`wc` output, not the old AGENTS.md numbers.
- Edge case: AGENTS.md after slim still contains the operational sections the harness/agents read; nothing operational was lost to the new docs.
- Test expectation: prose docs — verification is resolution + review, not unit tests.

**Verification:** ARCHITECTURE.md + STRUCTURE.md exist with the defined structures and resolve all references; AGENTS.md is reduced to operational content + pointers and retains every convention/anti-pattern/command; no duplicate architecture/structure content across AGENTS.md and the new docs (one home per fact).

- [x] **Unit 4: Generate CONTRIBUTING.md (fold RULES.md) and SECURITY.md; retire RULES.md**

**Goal:** Partition `RULES.md` (1239 lines) by section into a written triage map, then author `CONTRIBUTING.md` from its contributor-facing buckets and `SECURITY.md` from scratch, then retire `RULES.md` and repair its remaining inbound references and ignore-lists. The partition is the load-bearing first step — produce it explicitly before authoring, not as an implicit byproduct.

**Requirements:** R2, R5

**Dependencies:** Unit 3 (CONTRIBUTING de-dupes against ARCHITECTURE/STRUCTURE, which must exist first).

**Partition map (the explicit triage — settle the exact line ranges at execution, but the section-level buckets are fixed here):**
- → `CONTRIBUTING.md`: Project Overview, Technology Stack, Code Style & Conventions, Testing Standards, Build & Release, Documentation Standards, AI Assistant Guidelines, Quick Reference (commit format, required-before-PR).
- → `ARCHITECTURE.md` (amend Unit 3 output): Architecture Patterns, SDK Execution Patterns, Delegated Work Plugin Patterns.
- → already in `AGENTS.md` (reference, do not duplicate): Anti-Patterns (Forbidden), Security Requirements (cross-link; the operational rules already live in AGENTS.md / gateway AGENTS.md).
- → drop (superseded/redundant): Implementation Priorities, anything restating PRD/FEATURES scope (those docs are archived).

**Files:**
- Create: `CONTRIBUTING.md`, `SECURITY.md`
- Remove/redirect: `RULES.md` (after content folded)
- Modify: `.github/copilot-instructions.md` (the extensive RULES.md reading-guide → point at CONTRIBUTING/ARCHITECTURE), `.github/agents/fro-bot.agent.md`, `eslint.config.ts` + `.markdownlint-cli2.yaml` ignore-lists (drop `RULES.md`, add new docs as needed), any `RFCs/*.md` link to `RULES.md` (cheap fix or accept historical)

**Approach:**
- Partition RULES.md: contributor workflow (setup, stack, code style, testing, build/release, commit format, quick reference) → CONTRIBUTING; architectural patterns / SDK-execution → fold into ARCHITECTURE.md (Unit 3 output, amend); anti-patterns → already in AGENTS.md, reference rather than duplicate.
- SECURITY.md: reporting channel, supported-versions table, OpenSSF badges (the Scorecard badge already exists in README).
- Write CONTRIBUTING/SECURITY first, repair references, then remove RULES.md (migrate-before-retire).

**Patterns to follow:** RULES.md partition in Context; CONTRIBUTING de-dup rule (point at ARCHITECTURE/STRUCTURE, don't restate).

**Test scenarios:**
- Integration: no dead links to `RULES.md` remain anywhere in `README.md`/`.github/`/`.agents/`; `git grep -n "RULES.md"` shows only intended/historical targets.
- Edge case: CONTRIBUTING.md does not restate architecture/structure content already in ARCHITECTURE/STRUCTURE (no re-introduced duplication).
- Edge case: lint clean on the new docs and updated ignore-lists.
- Test expectation: prose docs — verification is resolution + review.

**Verification:** CONTRIBUTING.md + SECURITY.md exist and resolve references; RULES.md is gone with no dead inbound links; `bun run lint` clean; the contributor content survived the fold without duplicating ARCHITECTURE/STRUCTURE.

- [x] **Unit 5: Refresh README.md as the canonical entry point**

**Goal:** Apply a bounded structural update to `README.md` — refresh stale body from live facts, add the picture header, flat-square badges, and `·` nav, and wire in the net-new navigation nodes (links to ARCHITECTURE/STRUCTURE/CONTRIBUTING/SECURITY and the wiki). Preserve the existing banner/TOC shape where still accurate; the doc graph changed, so this is a topology update, not a no-op diff.

**Requirements:** R2, R3, R6

**Dependencies:** Units 3 and 4 (README links to the new docs).

**Files:**
- Modify: `README.md`
- Modify: `.markdownlint-cli2.yaml` (`MD033.allowed_elements` to add `picture`/`source` if the skill introduces a `<picture>` header)

**Approach:**
- Re-run the skill's README path: refresh stale body text from live repo facts, switch badges to `flat-square`, ensure nav links resolve, add the repository-structure section pointing at STRUCTURE.md and the architecture link to ARCHITECTURE.md, link the wiki for deep dives.
- Preserve the existing banner/table-of-contents shape; change only what drifted (re-run discipline, not a rewrite).

**Patterns to follow:** Reference skill README style rules; existing `README.md` banner.

**Test scenarios:**
- Edge case: all nav and cross-doc links resolve (ARCHITECTURE.md, STRUCTURE.md, CONTRIBUTING.md, SECURITY.md, wiki).
- Edge case: `<picture>`/`<img>` HTML passes markdownlint `MD033` (allowed_elements updated if needed).
- Integration: any count/version in README matches live repo output (e.g. OpenCode/Systematic version from `src/shared/constants.ts`).
- Test expectation: prose doc — verification is resolution + review.

**Verification:** README renders with the picture header + flat-square badges, every cross-link resolves, no stale version/count text, and its evolved structure is preserved (diff is minimal, not a from-scratch rewrite); `bun run lint` clean.

## System-Wide Impact

- **Interaction graph:** `.github/copilot-instructions.md` and `.github/agents/fro-bot.agent.md` steer the Fro Bot agent's doc-reading; their references must point at the new taxonomy or the agent reads stale/missing docs. The wiki automation (`WIKI_PROMPT`) is untouched but now coexists with canonical ARCHITECTURE/STRUCTURE — the cross-link direction (top-level → wiki) keeps them non-competing.
- **Error propagation:** No CI link-checker exists, so a missed cross-ref repair surfaces only as a dead link at read time. This is the plan's single biggest fragility, and it is mitigated by discipline, not automation: each move/retire unit runs an explicit `git grep -n "<oldname>.md"` sweep after its edits and treats any non-historical hit as a blocker. Residual risk stated plainly — manual lockstep repair across ~6 live files can still miss an incidental reference; if that proves real in execution, a lightweight markdown link-check is the escalation (deferred, see Scope Boundaries).
- **State lifecycle risks:** `RULES.md`/`PRD.md`/`FEATURES.md` are referenced by historical `RFCs/*.md` and `docs/plans/*`. Distinguish carefully (lesson from Unit 1 / PR #1071): a **relative markdown link** `[..](../X.md)` to a moved/retired doc genuinely 404s and MUST be repaired even in a frozen RFC (e.g. `RFCs/RFC-018:644` → `../docs/product/PRD.md`); a **bare prose/table mention** of a filename does not dead-link and may be left as historical. Each move/retire unit greps for the relative-link form `\]\((\.\./)*<name>\.md` across ALL dirs (not just live ones) and fixes those, while leaving bare prose mentions in frozen docs.
- **API surface parity:** `eslint.config.ts` and `.markdownlint-cli2.yaml` ignore-lists name the docs by path; every move/create/retire must update both in the same PR or lint flips (any root `*.md` change trips `should-lint`/`should-build`).
- **Unchanged invariants:** `RFCs/` + `RFCS.md`, the 19 per-directory `AGENTS.md` files, `docs/wiki/` content, and committed `dist/` are not modified. `AGENTS.md` keeps its operational contract for the harness; only architecture/structure prose moves out.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Dead links after moves (no CI link-check) | Repair inbound refs + ignore-lists in the same PR as each move; skill verification step greps for resolution; per-unit grep checks |
| AGENTS.md slim strips operational signal the harness needs | Extraction boundary is section-explicit (only CODE MAP/EXECUTION FLOW/HOTSPOTS/arch-NOTES move); slim unit verifies conventions/anti-patterns/commands remain |
| CONTRIBUTING re-introduces the duplication being removed | De-dup rule: CONTRIBUTING points at ARCHITECTURE/STRUCTURE, doesn't restate; verified per unit |
| Big-bang migration hard to bisect/revert | Five units delivered as a stack of revertable PRs (Unit 1 first, fully independent), not one commit |
| Stale counts copied from AGENTS.md into new docs | Skill re-derives all counts from live CLI output; verification checks counts against `find`/`wc` |
| wiki vs new docs drift back into overlap | Top-level docs are concise + canonical and link down to wiki; wiki stays deep-dive; no shared ownership |

## Documentation / Operational Notes

- Each phase is reviewed before the next begins (gated). Recommended PR sequence: Unit 1 (archive) → Unit 2 (skill) → Unit 3 (ARCHITECTURE/STRUCTURE + AGENTS slim) → Unit 4 (CONTRIBUTING/SECURITY + RULES retire) → Unit 5 (README). Units 3–5 may be reviewed together as the "first generation run" but should land as separate commits/PRs for revertability.
- After any rebase onto `main`, run `bun install` before building/verifying so output matches CI.
- Follow-up to file after this lands: per-directory `AGENTS.md` de-dup pass against the new canonical docs.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-30-generating-project-docs-skill-requirements.md`
- Reference skills: `marcusrbrown/systematic` and `fro-bot/.github` `.agents/skills/generating-project-docs/SKILL.md`
- Local template: `.agents/skills/versioned-tool/SKILL.md`
- Extraction source: `AGENTS.md`; fold source: `RULES.md`; archive targets: `PRD.md`, `FEATURES.md`
- Learnings: `docs/solutions/workflow-issues/migrate-pnpm-to-bun-monorepo-2026-06-24.md`, `semantic-release-tag-namespace-collision-2026-06-14.md`, `harness-base-version-source-of-truth-2026-06-12.md`, `best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md`
