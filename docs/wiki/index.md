---
type: architecture
last-updated: "2026-11-02"
updated-by: "f8ee76a3"
sources:
  - docs/wiki/Architecture Overview.md
  - docs/wiki/Background Subagents and Ownership.md
  - docs/wiki/Conventions and Patterns.md
  - docs/wiki/Execution Lifecycle.md
  - docs/wiki/Operator Web Control Surface.md
  - docs/wiki/Prompt Architecture.md
  - docs/wiki/Session Persistence.md
  - docs/wiki/Setup and Configuration.md
  - docs/wiki/Troubleshooting.md
summary: "Navigable entry point for the Fro Bot Agent project wiki"
---

# Fro Bot Agent Wiki

An Obsidian-powered project wiki maintained by Fro Bot. This vault provides human-readable documentation covering the architecture, subsystems, and conventions of the [fro-bot/agent](https://github.com/fro-bot/agent) Bun monorepo — the GitHub Action, the Discord-first Gateway and operator web surface, the sandboxed workspace executor, the patched OpenCode harness, the V2 plugin, and the shared runtime/session primitives underneath them.

> **Getting started:** Open this folder (`docs/wiki/`) as a vault in [Obsidian](https://obsidian.md/) for the best experience — graph view, backlinks, and search work out of the box. For the Dataview plugin (optional), install it from Obsidian's community plugins after opening the vault.

## Pages

### Architecture

| Page | Type | Summary |
| --- | --- | --- |
| [Architecture Overview](Architecture%20Overview.md) | architecture | Monorepo structure, module map, and the boundary between gateway execution and workspace checkout management |
| [Execution Lifecycle](Execution%20Lifecycle.md) | architecture | Action phases across OpenCode V1 and V2, from bootstrap and prompt submission through verified release and persistence |

### Subsystems

| Page | Type | Summary |
| --- | --- | --- |
| [Session Persistence](Session%20Persistence.md) | subsystem | Generation-isolated session transport, V1-to-V2 history import, session tools, and durable run memory |
| [Background Subagents and Ownership](Background%20Subagents%20and%20Ownership.md) | subsystem | How ownership accounting and generation-specific release gates contain background subagents, shells, and follow-up turns |
| [Prompt Architecture](Prompt%20Architecture.md) | subsystem | How the multi-section XML-tagged prompt is assembled and why each section exists |
| [Setup and Configuration](Setup%20and%20Configuration.md) | subsystem | Generation-aware tool installation, permission gates, provider credentials, plugins, and tools caching |
| [Operator Web Control Surface](Operator%20Web%20Control%20Surface.md) | subsystem | Authenticated browser surface for gateway runs, OAuth admission, durable sessions, bindings-based repo access, checkout provenance, live observation, and push health |

### Conventions

| Page | Type | Summary |
| --- | --- | --- |
| [Conventions and Patterns](Conventions%20and%20Patterns.md) | convention | Coding conventions, architectural patterns, and anti-patterns enforced across the project |

### Guides

| Page | Type | Summary |
| --- | --- | --- |
| [Troubleshooting](Troubleshooting.md) | convention | Common failure symptoms and their causes across action execution, persistence, setup, and gateway runs |

## About This Wiki

Current coverage includes the Action's stock V2 default and explicit V1 rollback, directory-based release gates and verdict diagnostics, bounded completion waits, generation-isolated session restore and history import, file-referenced Action credentials, workspace credential provisioning, bundled-skill access, and run-local Always approvals. The workspace image retains its independent V1 harness default; the gateway selects its protocol from the image's reported version.

- **Audience:** Human developers — contributors, reviewers, and maintainers
- **Content:** Descriptive documentation (how the system works, why decisions were made)
- **Not:** Prescriptive agent instructions — those live in [AGENTS.md](../../AGENTS.md)
- **Updated:** Weekly via Fro Bot scheduled runs, delivered as auto-merged PRs
- **Format:** Obsidian double-bracket wikilinks for cross-references; YAML frontmatter for metadata
- **Optional:** Install the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) community plugin for frontmatter queries (e.g., `TABLE summary FROM ""`)
