---
name: generating-project-docs
description: Use when creating, refreshing, or updating the project's living documentation — README.md, ARCHITECTURE.md, STRUCTURE.md, CONTRIBUTING.md, SECURITY.md, or a single section within one of them.
---

# Generating Project Docs

## Overview

This project's **living** documentation is generated from live-repo facts and kept current with this skill. Each doc has one audience and one home; the skill derives every fact from the repo as it exists now, never from memory or a stale copy.

**Living docs (this skill owns them):**

| Doc | Audience | Owns |
| --- | --- | --- |
| `README.md` | Users / entry point | Project overview, getting started, navigation |
| `ARCHITECTURE.md` | Human + agent contributors | System design, invariants, data flows, cross-cutting concerns |
| `STRUCTURE.md` | Human + agent contributors | Directory layout, where code lives, where to add new code |
| `CONTRIBUTING.md` | Human contributors | Setup, commands, testing, commit/PR conventions |
| `SECURITY.md` | Security reporters | Reporting channel, supported versions, OpenSSF |

**Not owned here:** `AGENTS.md` (agent-operational knowledge base — hand-maintained; the living docs reference it and it references them, but this skill does not regenerate it), the `RFCs/` specs and `RFCS.md` index (referenced, not regenerated), the `docs/wiki/` Obsidian vault (long-form deep dives — the living docs cross-link *down* to it; this skill does not modify wiki content), and the 19 per-directory `AGENTS.md` files.

## Core Rules (Non-Negotiable)

1. **Derive every fact from the live repo.** If a sentence can't point to a file, command, or commit that exists right now, don't write it.
2. **Re-derive every count from live output.** Never copy a number from another doc — `AGENTS.md`'s own counts are single-package-era and wrong. Use these exact commands and exclude `node_modules`, `dist`, `.slim`, `.context`, `.sisyphus`, `.cortexkit`, `.worktrees`, `.opencode`, `.pytest_cache`, and per-package `node_modules`:
   - Source files: `find src apps packages scripts -name '*.ts' -o -name '*.mts' | grep -v node_modules | grep -v dist | wc -l`
   - Test files: same with `-name '*.test.ts'`.
   - `src/` lines: `find src -name '*.ts' | xargs wc -l | tail -1`.
   - RFCs: `ls RFCs/*.md | wc -l`; wiki pages: `ls docs/wiki/*.md | wc -l`; workflows: `ls .github/workflows/*.yaml | wc -l`.
   - Version pins: read `packages/runtime/src/shared/constants.ts` (NOT `src/shared/constants.ts`, which only re-exports — it has names, no values).
   Surface counts only where they add value (e.g. STRUCTURE.md's layout overview); if a count is incidental, omit it rather than freezing a number that will drift.
3. **Preserve the existing doc's evolved structure on re-runs.** Update only what drifted. Do not replace a doc that has grown its own shape with a generic template.
4. **Section-scoped updates replace only the target section.** Read the current doc, swap the named section, leave everything around it byte-for-byte.
5. **No leakage.** No session IDs, agent/tool names, internal process, or planning taxonomy in any public doc.
6. **Exclude non-source trees from any derivation.** Skip `node_modules/`, `dist/`, `.slim/` (cloned dep sources), `.context/`, `.sisyphus/`. Account for the `deploy/scripts/` carve-out (plain Node ESM `.mjs`, `node --test`, not a workspace package) when counting tests or source.

## This Repo's Shape (Read Before Generating)

This is **not** a single npm package — modeling the docs on a one-package layout produces wrong structure. It is a Bun monorepo with multiple deployable surfaces:

- **GitHub Action** — the actual logic lives at the repo-root `src/` (4-layer architecture: `shared/` → `services/` → `features/` → `harness/`), entry `src/main.ts` + `src/post.ts`, defined by root `action.yaml`, shipped via committed `dist/`.
- **`@fro-bot/action`** (`apps/action/`) — a thin workspace wrapper whose `src/main.ts` is `import '../../../src/main.js'`; its build (`scripts/build-action-dist.ts`) produces the committed root `dist/`. The real Action code is in root `src/`, not here.
- **`@fro.bot/harness`** (`packages/harness/`) — patched-OpenCode build + publish pipeline.
- **`@fro.bot/gateway`** (`packages/gateway/`) — Discord-first daemon + operator web surface (its `src/` is the largest package: `web/`, `http/`, `execute/`, `operator-contract/`, `approvals/`, `workspace-api/`, `discord/`, redaction).
- **`@fro.bot/runtime`** (`packages/runtime/`) — shared runtime primitives; **owns the real version-pin constants** at `packages/runtime/src/shared/constants.ts` (`src/shared/constants.ts` only re-exports them).
- **`@fro.bot/workspace-agent`** (`apps/workspace-agent/`) — Hono HTTP service in the workspace container.
- **`deploy/`** — Dockerfiles, compose, mitmproxy egress topology; `deploy/scripts/` is the `.mjs` + `node --test` carve-out.

There are **three distinct execution flows**, not one request/response: the Action phase pipeline (`main.ts → harness/run.ts → phases → executeOpenCode`), the gateway mention-loop (`mentions → run-core → streaming → reply`), and the harness release dispatcher (`harness-release.yaml → integrate → build matrix → publish`). `ARCHITECTURE.md` must show all three.

## Per-Document Structure

### README.md

Order: centered `<picture>` dark/light header → flat-square badges → ` · `-separated nav → overview → getting started → repository structure (point at `STRUCTURE.md`) → automation → development (point at `CONTRIBUTING.md`) → architecture link (`ARCHITECTURE.md`) → resources (incl. `docs/wiki/` deep dives). Avoid tables in README. Badges use `style=flat-square`.

### ARCHITECTURE.md

`# Architecture` orientation (1–2 sentences, point at `STRUCTURE.md` and `AGENTS.md`) → `## Bird's-Eye Overview` → `## Codemap` (symbol → file table, sourced from `AGENTS.md`'s CODE MAP + the per-package `AGENTS.md` files) → `## Invariants` (numbered, CI-enforced: 4-layer import rule, committed `dist/`, strict booleans, functions-only, one-comment response protocol) → `## Data Flow` (three trigger-keyed ASCII trees: action, gateway mention-loop, harness release) → `## Cross-Cutting Concerns` (redaction gate, NormalizedEvent, OIDC trusted-publishing, S3 conditional-write lock, egress topology). Cross-link the matching `docs/wiki/` deep-dive page from each major section.

### STRUCTURE.md

`# Structure` (cross-reference `ARCHITECTURE.md` and `AGENTS.md`) → sections in this order:

- `## Directory Layout` — annotated ASCII tree; special-case the layered `src/` action, then list `packages/*` and `apps/*` as separate deployable surfaces with one-line inline comments.
- `## Directory Purposes` — one bullet per top-level directory (and per `src/` layer), each a single sentence: what lives there and when you touch it. Cover top-level dirs only; don't recurse into every subdir.
- `## Key File Locations` — the one place tables are allowed. Three tables with these columns:
  - Packages & apps: `| Package | Path | Role |` (one row per `packages/*` and `apps/*` member).
  - CI workflows: `| Workflow | Trigger | Role |` (one row per `.github/workflows/*.yaml`).
  - Deploy: `| File | Builds |` (Dockerfiles + key `deploy/` assets).
- `## Naming Conventions` — bullets for the conventions that govern *where/what to name things*: file extensions (ESM `.js` in relative imports), colocated `*.test.ts`, `AGENTS.md` per directory, kebab-case files. Source from `AGENTS.md` CONVENTIONS; don't restate code-style rules that belong in CONTRIBUTING.
- `## Where to Add New Code` — a multi-track decision tree: a phase/trigger/comment-handler/reviewer → `src/features/<X>/`; a Discord command → `packages/gateway/src/discord/commands/`; a bundled CLI tool → the `versioned-tool` skill + `src/services/setup/`; a workspace API endpoint → `apps/workspace-agent/src/`.

### CONTRIBUTING.md

Contributor workflow only: setup (Bun, `bun install`), the `bun run` command surface (test, lint, check-types, build, fix), testing standards (Vitest, BDD `// #given/#when/#then`, the `deploy/scripts/` `node --test` carve-out), commit/PR conventions, the pre-commit/pre-push hooks. **De-duplicate against `ARCHITECTURE.md`/`STRUCTURE.md` — point at them, do not restate architecture or layout.**

### SECURITY.md

Reporting channel, supported-versions table, OpenSSF Scorecard badge (already present in README).

## Generation Flow

1. **Inventory** live repo facts (structure, symbols, commands, counts, version pins from `src/shared/constants.ts`).
2. **First run (doc absent):** author the full doc from the structure above as the bootstrap seed, populated from live facts. There is no evolved structure to preserve yet, so use the prescribed section order rather than improvising one. **Forward-links to sibling living docs that don't exist yet are expected and allowed during bootstrap** — write the cross-link anyway (e.g. STRUCTURE.md may link `ARCHITECTURE.md` before it exists). Generation order is README → STRUCTURE → ARCHITECTURE → CONTRIBUTING → SECURITY, but a forward-link is not a defect. The cross-link verification step only fails a relative link to a doc that the plan does not create.
3. **Re-run (doc exists):** diff against the current doc; write the minimal change, preserving the doc's evolved structure. Section-scoped requests replace only the named section.
4. **Verify** (see checklist) before finishing.

## Rule: Copy the Repo, Not the Reference Skills

This skill is modeled on the `generating-project-docs` skills in `marcusrbrown/systematic` and `fro-bot/.github`, but those assume a single package/plugin. Where this repo's shape diverges (monorepo, layered `src/`, three execution flows, multiple deployable surfaces), follow **this repo's** reality, not the reference layout.

**If this skill conflicts with the current repo, follow the repo and update this skill afterward.**

## Verification Checklist

- [ ] Every cited count (files, lines, RFCs, versions) matches live CLI output, not another doc.
- [ ] Every file path and symbol named in the doc resolves against the current tree.
- [ ] Cross-links between `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `CONTRIBUTING.md`, and the `docs/wiki/` pages resolve (no dead relative links — check the `]((../)*name.md` form across all dirs, since there is no CI link-checker).
- [ ] On a re-run, the diff is bounded to what drifted — the doc's evolved structure is intact.
- [ ] No session/process/agent-internal leakage.
- [ ] `bun run lint` passes (note: `.agents/skills/` itself is lint-excluded, but the generated top-level docs are linted — `<picture>`/`<img>`/`<source>` must be in `.markdownlint-cli2.yaml`'s `MD033.allowed_elements`).
