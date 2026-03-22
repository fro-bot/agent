# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-06 **Commit:** 3985e1a **Branch:** main

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) + [oMo](https://github.com/code-yeongyu/oh-my-openagent) agents with **persistent session state** across CI runs. TypeScript, ESM-only, Node 24.

## STRUCTURE

```
./
├── src/                  # TypeScript source (132 source files, 13.6k lines)
│   ├── main.ts           # Thin entry point → harness/run.ts
│   ├── post.ts           # Thin entry point → harness/post.ts
│   ├── index.ts          # Public API re-exports
│   ├── shared/           # Layer 0: Pure types, utils, constants (no external deps)
│   │   ├── types.ts      # Core interfaces (ActionInputs, TokenUsage, etc.)
│   │   ├── constants.ts  # Shared configuration constants
│   │   ├── logger.ts     # JSON logging with auto-redaction
│   │   ├── env.ts        # Environment variable readers
│   │   ├── errors.ts     # Error conversion utilities
│   │   ├── validation.ts # Input validation
│   │   ├── format.ts     # String formatting
│   │   ├── async.ts      # Async utilities (sleep)
│   │   ├── console.ts    # Console output helpers
│   │   └── paths.ts      # Path utilities
│   ├── services/         # Layer 1: External adapters (GitHub, cache, session, setup)
│   │   ├── github/       # Octokit client, context parsing, NormalizedEvent
│   │   ├── session/      # Persistence layer (search, prune, storage, writeback)
│   │   ├── setup/        # Bun, oMo, OpenCode installation
│   │   └── cache/        # Cache restore/save with corruption detection
│   ├── features/         # Layer 2: Business logic (agent, triggers, reviews, etc.)
│   │   ├── agent/        # SDK execution, prompts, reactions, streaming
│   │   ├── triggers/     # Event routing, skip conditions, context builders
│   │   ├── comments/     # GitHub comment read/write, error formatting
│   │   ├── context/      # GraphQL hydration for issues/PRs
│   │   ├── reviews/      # PR diff parsing, review comments
│   │   ├── attachments/  # File attachment processing
│   │   ├── delegated/    # Branch/commit/PR operations
│   │   └── observability/# Metrics collection, run summaries
│   └── harness/          # Layer 3: Workflow composition (entry points, phases)
│       ├── run.ts        # Main orchestration (delegates to phases)
│       ├── post.ts       # Post-action hook (durable cache save)
│       ├── config/       # Input parsing, outputs, state keys, omo-providers
│       └── phases/       # Bootstrap, routing, execute, finalize, cleanup, etc.
├── dist/                 # Bundled output (COMMITTED, must stay in sync)
├── RFCs/                 # 19 RFC documents (architecture specs)
├── docs/plans/           # Architecture plans and design docs
├── action.yaml           # GitHub Action definition (node24)
└── tsdown.config.ts      # esbuild bundler config (dual entry points)
```

## WHERE TO LOOK

| Task             | Location                           | Notes                                              |
| ---------------- | ---------------------------------- | -------------------------------------------------- |
| Add action logic | `src/harness/run.ts`               | Main orchestration via phases                      |
| Post-action hook | `src/harness/post.ts`              | Durable cache save (RFC-017)                       |
| Setup library    | `src/services/setup/`              | Bun/oMo/OpenCode installation (auto-setup)         |
| Cache operations | `src/services/cache/`              | `restore.ts`, `save.ts`                            |
| GitHub API       | `src/services/github/client.ts`    | `createClient()`, `createAppClient()`              |
| Event parsing    | `src/services/github/context.ts`   | `parseGitHubContext()`, `normalizeEvent()`         |
| Event types      | `src/services/github/types.ts`     | `NormalizedEvent` discriminated union (8 variants) |
| Agent execution  | `src/features/agent/execution.ts`  | `executeOpenCode()` logic                          |
| Prompt building  | `src/features/agent/prompt.ts`     | `buildAgentPrompt()`, response protocol sections   |
| Session storage  | `src/services/session/`            | `storage.ts`, `storage-mappers.ts`                 |
| Session search   | `src/services/session/search.ts`   | `listSessions()`, `searchSessions()`               |
| Event routing    | `src/features/triggers/router.ts`  | `routeEvent()` orchestration                       |
| Context hydrate  | `src/features/context/`            | GraphQL/REST issue/PR data (RFC-015)               |
| Comment posting  | `src/features/comments/writer.ts`  | `postComment()`, GraphQL mutations                 |
| PR reviews       | `src/features/reviews/reviewer.ts` | `submitReview()`, line comments                    |
| Input parsing    | `src/harness/config/inputs.ts`     | `parseActionInputs()` returns Result               |
| Logging          | `src/shared/logger.ts`             | `createLogger()` with redaction                    |
| Core types       | `src/shared/types.ts`              | `ActionInputs`, `CacheResult`, `RunContext`        |
| Build config     | `tsdown.config.ts`                 | ESM shim, bundled deps, license extraction         |

## CODE MAP

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `run` | Function | `src/harness/run.ts` | Main entry, phase orchestration |
| `runPost` | Function | `src/harness/post.ts` | Post-action cache save |
| `runSetup` | Function | `src/services/setup/setup.ts` | Setup orchestration |
| `restoreCache` | Function | `src/services/cache/restore.ts` | Restore OpenCode state |
| `saveCache` | Function | `src/services/cache/save.ts` | Persist state to cache |
| `executeOpenCode` | Function | `src/features/agent/execution.ts` | SDK execution orchestration |
| `buildAgentPrompt` | Function | `src/features/agent/prompt.ts` | Multi-section prompt with directives |
| `sendPromptToSession` | Function | `src/features/agent/prompt-sender.ts` | Send prompt to SDK session |
| `runPromptAttempt` | Function | `src/features/agent/retry.ts` | Execute prompt with retry logic |
| `pollForSessionCompletion` | Function | `src/features/agent/session-poll.ts` | Poll SDK for completion status |
| `processEventStream` | Function | `src/features/agent/streaming.ts` | Process SDK event stream |
| `bootstrapOpenCodeServer` | Function | `src/features/agent/server.ts` | Initialize SDK server lifecycle |
| `normalizeEvent` | Function | `src/services/github/context.ts` | Raw payload → typed NormalizedEvent |
| `parseGitHubContext` | Function | `src/services/github/context.ts` | Global context → typed GitHubContext |
| `routeEvent` | Function | `src/features/triggers/router.ts` | Event routing orchestration |
| `postComment` | Function | `src/features/comments/writer.ts` | Create or update comment |
| `submitReview` | Function | `src/features/reviews/reviewer.ts` | Submit PR review |
| `parseActionInputs` | Function | `src/harness/config/inputs.ts` | Parse/validate inputs |
| `createLogger` | Function | `src/shared/logger.ts` | Logger with redaction |
| `ActionInputs` | Interface | `src/shared/types.ts` | Input schema |
| `NormalizedEvent` | Union | `src/services/github/types.ts` | 8-variant discriminated event union |
| `TriggerDirective` | Interface | `src/features/agent/prompt.ts` | Directive + appendMode for triggers |
| `TriggerResult` | Interface | `src/features/triggers/types.ts` | Routing decision |

## EXECUTION FLOW

```
main.ts → harness/run.ts
  │
  ├─→ bootstrap phase (parseActionInputs, ensureOpenCodeAvailable, restoreCache)
  ├─→ routing phase (parseGitHubContext, normalizeEvent, routeEvent)
  ├─→ dedup phase (skip if agent already ran for this PR/issue recently)
  ├─→ acknowledge phase (acknowledgeReceipt)
  ├─→ cache-restore phase (dedicated session state restore)
  ├─→ session-prep phase (processAttachments, buildAgentPrompt)
  ├─→ execute phase (executeOpenCode via SDK)
  ├─→ finalize phase (writeSessionSummary, pruneSessions)
  └─→ cleanup phase (saveCache, writeJobSummary)

post.ts → harness/post.ts
  └─→ saveCache (durable persistence)
```

## COMPLEXITY HOTSPOTS

| File                              | Lines | Reason                                    |
| --------------------------------- | ----- | ----------------------------------------- |
| `features/triggers/__fixtures__/` | 627   | Factory-style payload generation          |
| `features/agent/prompt.ts`        | 420   | Prompt templates, trigger directives      |
| `services/session/types.ts`       | 292   | Session/message/part type hierarchy       |
| `features/context/types.ts`       | 279   | GraphQL context types, budget constraints |
| `features/comments/reader.ts`     | 257   | Thread reading, pagination                |
| `services/github/api.ts`          | 255   | Reactions, labels, branch discovery       |
| `services/setup/setup.ts`         | 247   | Setup orchestration                       |
| `services/github/context.ts`      | 226   | normalizeEvent() 8-variant union builder  |
| `harness/config/inputs.ts`        | 224   | Input parsing and validation              |
| `services/session/search.ts`      | 220   | Session listing and cross-session search  |

## CONVENTIONS

- **ESM-only**: `.js` extensions required in all relative imports
- **Functions only**: No ES6 classes; closures for stateful patterns
- **Logger injection**: Every function takes `logger` parameter
- **Result types**: `Result<T, E>` from `@bfra.me/es` for recoverable errors
- **Readonly interfaces**: All properties use `readonly`
- **Strict booleans**: No implicit falsy checks (`!value`); use explicit comparisons
- **Adapter pattern**: `CacheAdapter`, `ExecAdapter` for testable I/O
- **Prettier**: 120-char line width via `@bfra.me/prettier-config/120-proof`
- **Vitest**: Colocated `.test.ts` files; BDD comments (`// #given`, `// #when`, `// #then`)

## ANTI-PATTERNS (THIS PROJECT)

- **Type suppression**: Never use `as any`, `@ts-ignore`, `@ts-expect-error`
- **Raw event access**: Always use `NormalizedEvent`; never read `context.payload`
- **Global context**: Never use `github.context` directly; use `parseGitHubContext()`
- **Classes**: Functions only; project-wide functional pattern
- **Console.log**: Use injected logger with redaction
- **Force push**: Always `force: false` on ref updates
- **Blocking on UX**: Reactions are secondary; API failures must not halt execution
- **Multiple comments**: Response Protocol: exactly ONE comment/review per invocation

## COMMANDS

```bash
pnpm install        # Install dependencies
pnpm test           # Run all tests (vitest)
pnpm lint           # ESLint check
pnpm fix            # ESLint auto-fix
pnpm check-types    # TypeScript type check (tsc --noEmit)
pnpm build          # Type check + bundle to dist/ (must stay in sync)
```

## NOTES

- **Four-layer architecture**: shared/ → services/ → features/ → harness/
- **Layer dependency rules**: Each layer may only import from layers below it
- **dist/ committed**: CI fails if `git diff dist/` shows changes after build
- **Node 24 required**: Matches `action.yaml` runtime
- **19 RFCs total**: Foundation, cache, GitHub client, sessions, triggers, security, observability, comments, PR review, delegated work, setup, execution, SDK mode, file attachments, GraphQL context, additional triggers, post-action hook, plugin, S3 backend
- **SDK-based execution**: Uses `@opencode-ai/sdk` for server lifecycle + event streaming
- **Persistent memory**: Sessions survive across CI runs via GitHub Actions cache
- **NormalizedEvent**: All webhook payloads pass through `normalizeEvent()` before routing; router never touches raw payloads
- **Dual action entry points**: `main.ts` (execution) and `post.ts` (durable cache save)
- **Pre-push hook**: Runs test + lint + build + dist diff check

## EXTERNAL RESOURCES

### Context7 IDs

| Library                | ID                   | Snippets |
| ---------------------- | -------------------- | -------- |
| GitHub Actions Toolkit | /actions/toolkit     | 332      |
| GitHub Actions Cache   | /actions/cache       | 73       |
| Vitest                 | /vitest-dev/vitest   | 2776     |
| tsdown                 | /rolldown/tsdown     | 279      |
| OpenCode SDK           | /sst/opencode-sdk-js | 96       |

### Documentation

- https://github.com/actions/toolkit - @actions/core, @actions/cache, @actions/github
- https://vitest.dev - Vitest testing framework
- https://tsdown.dev - tsdown bundler
- https://opencode.ai - OpenCode AI coding agent
