# Structure

This document maps the repository's directory layout and explains where code lives. For system design, invariants, and data flows see [`ARCHITECTURE.md`](ARCHITECTURE.md). For agent-operational knowledge — commands, conventions, and the full code map — see [`AGENTS.md`](AGENTS.md).

## Directory Layout

```text
fro-bot/agent/
├── src/                        # GitHub Action logic — 4-layer architecture (~14.6k lines)
│   ├── shared/                 # Layer 0: pure types, utils, constants (only @bfra.me/es Result; no heavy deps)
│   ├── services/               # Layer 1: external adapters (GitHub, cache, setup, object-store, artifact)
│   │   ├── github/             # Octokit client, context parsing, NormalizedEvent
│   │   ├── cache/              # Restore/save with corruption detection
│   │   ├── setup/              # Bun, oMo, OpenCode + Systematic install/config
│   │   ├── artifact/           # Artifact upload
│   │   └── session/            # (stub — session types migrated to packages/runtime)
│   ├── features/               # Layer 2: business logic
│   │   ├── agent/              # SDK execution, prompts, streaming, retry
│   │   ├── triggers/           # Event routing, skip conditions, context builders
│   │   ├── comments/           # GitHub comment read/write, error formatting
│   │   ├── context/            # GraphQL hydration for issues/PRs
│   │   ├── reviews/            # PR diff parsing, review comments
│   │   ├── attachments/        # File attachment processing
│   │   ├── delegated/          # Branch/commit/PR operations
│   │   └── observability/      # Metrics collection, run summaries
│   └── harness/                # Layer 3: workflow composition (entry points, phases)
│       ├── config/             # Input parsing, outputs, state keys, omo-providers
│       └── phases/             # Bootstrap, routing, dedup, execute, finalize, cleanup, …
│
├── apps/
│   ├── action/                 # @fro-bot/action — thin wrapper; main.ts = import '../../../src/main.js'
│   └── workspace-agent/        # @fro-bot/workspace-agent — Hono HTTP service in workspace container
│
├── packages/
│   ├── gateway/                # @fro-bot/gateway — Discord daemon + operator web surface
│   │   └── src/
│   │       ├── discord/        # Discord client, mentions, commands, streaming
│   │       ├── execute/        # run-core, queue, concurrency, recovery
│   │       ├── web/            # Operator HTTP routes, SSE, audit
│   │       ├── workspace-api/  # Workspace API surface
│   │       ├── approvals/      # Approval gate
│   │       ├── operator-contract/ # Operator contract types
│   │       └── redaction/      # PII/secret redaction gate
│   ├── harness/                # @fro.bot/harness — patched-OpenCode build + publish pipeline
│   └── runtime/                # @fro-bot/runtime — shared runtime primitives + version-pin constants
│       └── src/
│           ├── shared/         # Logger, types, constants (owns real version pins)
│           ├── session/        # Session storage, search, prune, writeback
│           ├── object-store/   # S3-compatible canonical persistence
│           ├── agent/          # Shared agent execution primitives
│           └── coordination/   # Heartbeat, lock, run-state
│
├── deploy/                     # Docker Compose stack, Dockerfiles, mitmproxy egress topology
│   └── scripts/                # Plain Node ESM (.mjs) deploy helpers; node --test runner
│
├── scripts/                    # Repo-level build scripts (build-action-dist, unicode checks, release)
│   └── release/                # Release dispatch scripts
│
├── .github/
│   └── workflows/              # 11 CI/CD workflow files
│
├── RFCs/                       # 19 RFC documents (architecture specs)
├── docs/
│   ├── wiki/                   # 8 Obsidian deep-dive pages
│   ├── plans/                  # Architecture plans and design docs
│   ├── solutions/              # Documented solutions to past problems
│   └── decisions/              # Architecture decision records
│
├── action.yaml                 # GitHub Action definition (node24 runtime)
├── dist/                       # Committed bundled output — must stay in sync with src/
├── tsdown.config.ts            # tsdown/rolldown bundler config (dual entry points)
├── vitest.config.ts            # Vitest workspace config
└── package.json                # Bun workspace root
```

## Directory Purposes

- **`src/`** — The GitHub Action's real logic; all four layers live here and are bundled into root `dist/`.
- **`src/shared/`** — Pure utilities and types with no external dependencies; every other layer imports from here.
- **`src/services/`** — Adapters that talk to external systems (GitHub API, Actions cache, S3, tool installers); no business logic.
- **`src/features/`** — Business logic organized by capability; imports from `shared/` and `services/` only.
- **`src/harness/`** — Entry points and phase orchestration; the only layer allowed to compose across all others.
- **`apps/action/`** — Thin workspace package whose sole purpose is re-exporting `src/main.ts` and `src/post.ts`; its build produces the committed root `dist/`.
- **`apps/workspace-agent/`** — Hono HTTP service that runs inside the workspace container; touch when adding workspace-side API endpoints.
- **`packages/gateway/`** — Discord-first daemon and operator web surface; the largest package, containing the mention loop, command handlers, approval gate, and redaction pipeline.
- **`packages/harness/`** — Patched-OpenCode build and publish pipeline; touch when updating the bundled OpenCode binary.
- **`packages/runtime/`** — Shared runtime primitives consumed by both `src/` and `packages/gateway/`; owns the authoritative version-pin constants.
- **`deploy/`** — Docker Compose stack, Dockerfiles, mitmproxy egress topology, and deploy validation scripts.
- **`deploy/scripts/`** — Plain Node ESM (`.mjs`) helpers for deploy-time operations; uses `node --test`, not Vitest.
- **`scripts/`** — Repo-level build tooling: action dist builder, hidden-Unicode scrubber, third-party notices, release dispatch.
- **`.github/workflows/`** — All CI/CD automation; 11 workflow files covering tests, releases, security scanning, and bot triggers.
- **`RFCs/`** — 19 architecture specification documents; read before making cross-cutting changes.
- **`docs/wiki/`** — 8 Obsidian deep-dive pages covering architecture, execution lifecycle, prompt design, and operator surface.
- **`dist/`** — Committed bundle output; CI fails if a fresh build produces a diff here.

## Key File Locations

### Packages and Apps

| Package | Path | Role |
| --- | --- | --- |
| `@fro-bot/action` | `apps/action/` | Thin wrapper re-exporting root `src/`; build produces committed `dist/` |
| `@fro-bot/workspace-agent` | `apps/workspace-agent/` | Hono HTTP service in the workspace container |
| `@fro-bot/gateway` | `packages/gateway/` | Discord daemon, operator web surface, mention loop, redaction |
| `@fro.bot/harness` | `packages/harness/` | Patched-OpenCode build and publish pipeline |
| `@fro-bot/runtime` | `packages/runtime/` | Shared runtime primitives; owns authoritative version-pin constants |

### CI Workflows

| Workflow | Trigger | Role |
| --- | --- | --- |
| `auto-release.yaml` | `pull_request` | Automated release preparation on PR merge |
| `ci.yaml` | `push`, `pull_request`, `workflow_dispatch`, `release` | Main CI: test, lint, type-check, build, dist diff |
| `codeql-analysis.yaml` | `push`, `pull_request`, `schedule`, `workflow_dispatch` | CodeQL security scanning |
| `copilot-setup-steps.yaml` | `push`, `pull_request`, `workflow_dispatch` | Copilot environment setup steps |
| `fro-bot.yaml` | `issue_comment`, `issues`, `schedule`, `workflow_dispatch` | Fro Bot agent invocation (the Action under development) |
| `harness-integrate.yaml` | `workflow_call` | LLM-merge integration of OpenCode refs into the harness build; called by `harness-release.yaml` |
| `harness-release.yaml` | `push`, `workflow_dispatch` | Build matrix and publish for `@fro.bot/harness` |
| `prepare-release-pr.yaml` | `schedule`, `workflow_dispatch` | Opens release PR via semantic-release |
| `renovate.yaml` | `issues`, `pull_request`, `push`, `workflow_dispatch`, `workflow_run` | Renovate dependency update automation |
| `scorecard.yaml` | `schedule`, `push` | OpenSSF Scorecard security posture |
| `update-repo-settings.yaml` | `push`, `schedule`, `workflow_dispatch` | Sync repository settings from config |

### Deploy

| File                                   | Builds                                                |
| -------------------------------------- | ----------------------------------------------------- |
| `deploy/gateway.Dockerfile`            | `@fro-bot/gateway` daemon container                   |
| `deploy/workspace.Dockerfile`          | Workspace container (runs `@fro-bot/workspace-agent`) |
| `deploy/compose.yaml`                  | Full stack: gateway + workspace + mitmproxy egress    |
| `deploy/compose.override.example.yaml` | Local override template for `compose.yaml`            |

## Naming Conventions

- **ESM `.js` extensions** — all relative imports in TypeScript source use `.js` extensions (e.g. `import './utils.js'`), even though the source files are `.ts`.
- **Colocated tests** — test files live next to the code they test as `<name>.test.ts`; no separate `__tests__/` directories.
- **Per-directory `AGENTS.md`** — every significant directory carries its own `AGENTS.md` with local conventions, symbols, and notes for that layer.
- **Kebab-case filenames** — all source files use kebab-case (e.g. `cache-key.ts`, `build-action-dist.ts`).
- **`deploy/scripts/` carve-out** — files under `deploy/scripts/` are plain Node ESM (`.mjs`) and use `node --test`, not Vitest; they are not workspace packages and have no build step.

## Where to Add New Code

Use this decision tree to find the right home for new code:

- **New Action phase, trigger handler, comment handler, or reviewer** → `src/features/<capability>/` (e.g. `src/features/triggers/`, `src/features/comments/`); wire it into `src/harness/phases/` or `src/features/triggers/router.ts`.
- **New Discord command** → `packages/gateway/src/discord/commands/`; register it in the commands index.
- **New bundled CLI tool or version-pinned binary** (Bun, oMo, OpenCode, Systematic) → add a versioned-tool entry in `src/services/setup/` following the existing adapter pattern; pin the version constant in `packages/runtime/src/shared/constants.ts`.
- **New workspace API endpoint** → `apps/workspace-agent/src/`; add the route to the Hono server.
- **Shared primitive used by both Action and gateway** → `packages/runtime/src/`; export from its `index.ts`.
- **New GitHub API helper** → `src/services/github/api.ts` or a new file under `src/services/github/`.
- **New deploy service or container** → `deploy/` (Dockerfile + compose service entry).
