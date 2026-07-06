---
type: index
last-updated: "2026-07-05"
summary: "Navigable entry point for the Fro Bot Agent project wiki"
---

# Fro Bot Agent Wiki

An Obsidian-powered project wiki maintained by Fro Bot. This vault provides human-readable documentation covering the architecture, subsystems, and conventions of the [fro-bot/agent](https://github.com/fro-bot/agent) GitHub Action.

> **Getting started:** Open this folder (`docs/wiki/`) as a vault in [Obsidian](https://obsidian.md/) for the best experience — graph view, backlinks, and search work out of the box. For the Dataview plugin (optional), install it from Obsidian's community plugins after opening the vault.

## Pages

### Architecture

| Page | Type | Summary |
| --- | --- | --- |
| [Architecture Overview](Architecture%20Overview.md) | architecture | Monorepo structure, action + harness + gateway + workspace-agent packages, and module map |
| [Execution Lifecycle](Execution%20Lifecycle.md) | architecture | Phase-by-phase walkthrough of a single action run, including review reconciliation |

### Subsystems

| Page | Type | Summary |
| --- | --- | --- |
| [Session Persistence](Session%20Persistence.md) | subsystem | How agent memory survives across CI runs via cache, SDK sessions, S3 object store, and pruning |
| [Prompt Architecture](Prompt%20Architecture.md) | subsystem | How the multi-section XML-tagged prompt is assembled and why each section exists |
| [Setup and Configuration](Setup%20and%20Configuration.md) | subsystem | Tool installation, configuration assembly, credential management, cache strategy, and oMo opt-in |
| [Operator Web Control Surface](Operator%20Web%20Control%20Surface.md) | subsystem | Authenticated browser surface that lets operators launch, observe, and approve gateway agent runs over HTTP and SSE |

### Conventions

| Page | Type | Summary |
| --- | --- | --- |
| [Conventions and Patterns](Conventions%20and%20Patterns.md) | convention | Coding conventions, architectural patterns, and anti-patterns enforced across the project |

### Guides

| Page | Type | Summary |
| --- | --- | --- |
| [Troubleshooting](Troubleshooting.md) | guide | Diagnosing common Action failures — no response, cache persistence, and timeouts |

## About This Wiki

- **Audience:** Human developers — contributors, reviewers, and maintainers
- **Content:** Descriptive documentation (how the system works, why decisions were made)
- **Not:** Prescriptive agent instructions — those live in [AGENTS.md](../../AGENTS.md)
- **Updated:** Weekly via Fro Bot scheduled runs, delivered as auto-merged PRs
- **Format:** Obsidian wikilinks (`[[Page Name]]`) for cross-references; YAML frontmatter for metadata
- **Optional:** Install the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) community plugin for frontmatter queries (e.g., `TABLE summary FROM ""`)
