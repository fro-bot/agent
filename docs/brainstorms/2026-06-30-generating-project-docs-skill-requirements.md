---
date: 2026-06-30
topic: generating-project-docs-skill
---

# Add a `generating-project-docs` skill for living project documentation

## Summary

Add an agent skill at `.agents/skills/generating-project-docs/SKILL.md` that generates and refreshes this repo's **living** documentation — `README.md`, `ARCHITECTURE.md` (new), `STRUCTURE.md` (new), `CONTRIBUTING.md`, and community-health files — from live-repo facts, modeled on the `generating-project-docs` skills in `marcusrbrown/systematic` and `fro-bot/.github`. The skill owns only the living docs and how to keep them current; it does not reconcile or archive legacy documentation.

A separate, gated legacy-prep task runs first to give the skill a clean field: archive stale planning docs, fold contributor rules into `CONTRIBUTING.md`, and re-point the agent knowledge base and automation at the new canonical docs.

---

## Problem

Project documentation has drifted badly. `README.md`'s body is stale (its last change was an OpenCode version bump). There is no `ARCHITECTURE.md` or `STRUCTURE.md`. Meanwhile the repo root carries ~2.6K lines of stale planning prose (`PRD.md` from January, `FEATURES.md` from March) and overlapping convention/spec docs (`RULES.md`, `RFCS.md`). `AGENTS.md` is a hand-maintained "PROJECT KNOWLEDGE BASE" that already holds most of the structural content a `STRUCTURE.md`/`ARCHITECTURE.md` would, so naive new docs would create a third drifting copy.

There is no repeatable, fact-grounded way to regenerate the human-facing docs, so they rot between releases.

## Goals

- A durable skill that regenerates/refreshes the living docs on demand, deriving every fact from the live repo.
- Establish `ARCHITECTURE.md` and `STRUCTURE.md` as canonical human-contributor onboarding docs.
- Make doc refresh a section-scoped, low-drift operation rather than a full rewrite.
- Keep public docs free of session/process/agent-internal leakage.

## Non-Goals

- The skill does not own, rewrite, or archive legacy docs (`PRD.md`, `FEATURES.md`, `RFCS.md`, `RULES.md`) — that is the separate legacy-prep task.
- The skill does not regenerate `AGENTS.md` (hand-maintained) or the `RFCs/` specs; it cross-references them.
- No engineering-backlog work (e.g. the action/gateway timeout convergence) is in scope.

## Document taxonomy

Audience-based split that removes the current overlap:

| Doc | Audience | Owner |
| --- | --- | --- |
| `README.md` | Entry point / users | Skill (living) |
| `ARCHITECTURE.md` *(new)* | Human contributors — system design | Skill (living) |
| `STRUCTURE.md` *(new)* | Human contributors — where code lives | Skill (living) |
| `CONTRIBUTING.md` | Human contributors — how to work | Skill (living) |
| `SECURITY.md`, `.github/copilot-instructions.md` | Community-health | Skill (living) |
| `AGENTS.md` | Agent operational knowledge base | Hand-maintained; references the living docs |
| `RFCs/` + `RFCS.md` index | Design specs | Hand-maintained; referenced by `ARCHITECTURE.md` |
| `PRD.md`, `FEATURES.md` | Historical planning | Archived to `docs/product/` |

Relationship decision: `ARCHITECTURE.md` and `STRUCTURE.md` are **human + agent** useful and become the home for the architecture and structure/code-map content currently carried in `AGENTS.md`. `AGENTS.md` is slimmed simply by extracting that content into them; what remains is the genuinely agent-operational material (conventions, anti-patterns, commands, prompt rules) that an agent still needs. No source-of-truth inversion — the new docs own the extracted architecture/structure knowledge; `AGENTS.md` keeps what's operational and references the living docs for the rest.

## The skill

Lives at `.agents/skills/generating-project-docs/SKILL.md`. Modeled on the two reference skills, adapted to this repo.

### Core rules (from the references)

- Derive every fact from the live repo. If a sentence can't point to a file, command, or commit, don't write it.
- Re-derive any count in prose from live CLI output (`ls`, `find`, test runner), never from memory.
- Preserve the existing doc's evolved structure on re-runs; update only what changed.
- Support section-scoped updates: read the current doc, replace only the target section, preserve surrounding structure exactly.
- No session/process/agent-internal leakage in public docs.
- Backtick paths, commands, and env vars; language-tag code blocks; terse, fact-first voice.

### Per-document structure the skill defines

- **`README.md`** — `<picture>` dark/light header, flat-square badges, ` · `-separated nav, overview, features, getting started, repository structure, automation, development, resources. Avoid tables in README.
- **`ARCHITECTURE.md`** — `# Architecture` orientation (pointing at `STRUCTURE.md` and `AGENTS.md`) → Bird's-Eye Overview → Codemap (pipeline diagram + symbol→file table) → Invariants (CI-enforced, numbered) → Data Flow (ASCII tree) → Cross-Cutting Concerns. References `RFCs/` for deep specs.
- **`STRUCTURE.md`** — `# Structure` with cross-references → Directory Layout (annotated ASCII tree) → Directory Purposes → Key File Locations (the one place tables are allowed: `| File | Role |`) → Naming Conventions → Where to Add New Code (prescriptive checklist).
- **`CONTRIBUTING.md`** — contributor workflow: setup, the `bun run` command surface, testing standards, commit/PR conventions, anti-patterns. De-duplicated against `ARCHITECTURE.md`/`STRUCTURE.md` (points at them rather than restating).
- **Community-health** — `SECURITY.md` (reporting channel, supported versions, OpenSSF badges), `.github/copilot-instructions.md`.

### Generation flow

1. Inventory live repo facts (structure, symbols, commands, counts).
2. **First run (doc does not exist):** author the full doc from the bootstrap contract — the required section ordering and headings defined per-document below — populated from live-repo facts. There is no evolved structure to preserve, so the skill uses the prescribed structure as the seed rather than improvising one from the reference repos.
3. **Re-run (doc exists):** diff against the current doc and write the minimal diff, preserving the doc's evolved structure and changing only what drifted.
4. Re-read the target doc end-to-end; verify counts match live output and every file/symbol name resolves; verify cross-links between README/ARCHITECTURE/STRUCTURE/CONTRIBUTING.

### Argument surface

`[readme | architecture | structure | contributing | security | all | <section-name>]` — generate/refresh one doc, one section, or all.

## Separate legacy-prep (gated task, runs first)

Not part of the skill. Gives the skill a clean field before it is authored and first run:

- Archive `PRD.md` + `FEATURES.md` → `docs/product/` with a one-line "historical; see README/ARCHITECTURE for current state" note.
- Fold the genuinely contributor-facing content of `RULES.md` into `CONTRIBUTING.md`; retire/redirect `RULES.md`.
- Keep `RFCS.md` as the `RFCs/` index; ensure `ARCHITECTURE.md` references it.
- Slim `AGENTS.md` to reference the living docs instead of restating structure/architecture.
- Update the `fro-bot.yaml` Daily Maintenance Report prompt, which currently instructs the agent not to duplicate `AGENTS.md` prescriptive content and not to modify `AGENTS.md` — re-point/extend it for the new canonical living docs. The prompt must stay fenced to an explicit file allowlist so the maintenance agent cannot treat `README.md`/`ARCHITECTURE.md`/`STRUCTURE.md` as fair game to mutate.

## Sequencing

1. **Legacy-prep** (gated) — taxonomy migration above.
2. **Author the skill** (gated) — against the cleaned doc field.
3. **First generation run** (gated) — skill generates/refreshes the living docs.

Each step is reviewed before the next begins.

## Open questions / risks

- `AGENTS.md` slimming vs. the harness's tuned knowledge-base format: the agent harness reads `AGENTS.md` operationally. Slimming must preserve the operational signal the harness depends on while moving the human-onboarding content to the living docs — confirm the harness still has what it needs after the split.
- `CONTRIBUTING.md` boundary with `ARCHITECTURE.md`/`STRUCTURE.md`: avoid re-introducing the duplication we're removing; CONTRIBUTING references, doesn't restate.
- `fro-bot.yaml` prompt change interacts with the live DMR automation — verify the maintenance agent behaves correctly against the new doc targets before relying on it.

## Acceptance criteria

- A `generating-project-docs` skill exists at `.agents/skills/generating-project-docs/SKILL.md` defining the structures, style rules, generation flow, and argument surface above.
- The skill generates `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `CONTRIBUTING.md`, and community-health files from live-repo facts, and supports section-scoped refresh.
- Re-running the skill on an existing doc preserves its evolved structure and changes only what drifted.
- Generated docs contain no session/process leakage and every cited count/file/symbol resolves against the live repo.
- The legacy-prep leaves a clean field (PRD/FEATURES archived, RULES folded into CONTRIBUTING, AGENTS.md and the DMR prompt re-pointed) — tracked and gated separately from the skill.
