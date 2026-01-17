# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-16
**Commit:** 3d85a4d
**Branch:** main

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) + [oMo](https://github.com/code-yeongyu/oh-my-opencode) agents with **persistent session state** across CI runs. TypeScript, ESM-only, Node 24.

## STRUCTURE

```
./
├── src/                  # TypeScript source
│   ├── main.ts           # Primary entry (11-step orchestration)
│   ├── setup.ts          # Secondary entry (environment bootstrap)
│   ├── post.ts           # Post-action hook (durable cache save, RFC-017)
│   ├── index.ts          # Public API re-exports
│   ├── lib/              # Core libraries (see subdir AGENTS.md)
│   │   ├── agent/        # SDK execution, prompts, reactions
│   │   ├── github/       # Octokit client, context parsing
│   │   ├── setup/        # Bun, oMo, OpenCode installation
│   │   ├── session/      # Persistence layer (search, prune, writeback)
│   │   ├── triggers/     # Event routing, skip conditions
│   │   ├── cache.ts      # Cache restore/save with corruption detection
│   │   ├── logger.ts     # JSON logging with auto-redaction
│   │   ├── inputs.ts     # Action input parsing (Result type)
│   │   └── types.ts      # Core interfaces
│   └── utils/            # Pure utility functions (env, validation)
├── dist/                 # Bundled output (COMMITTED, must stay in sync)
├── setup/                # Setup action definition
├── RFCs/                 # 17 RFC documents (architecture specs)
├── action.yaml           # Primary GitHub Action definition (node24)
└── tsdown.config.ts      # esbuild bundler config (triple entry points)
```

## WHERE TO LOOK

| Task             | Location                     | Notes                                       |
| ---------------- | ---------------------------- | ------------------------------------------- |
| Add action logic | `src/main.ts`                | 11-step orchestration lifecycle             |
| Setup bootstrap  | `src/setup.ts`               | Bun/oMo/OpenCode installation               |
| Post-action hook | `src/post.ts`                | Durable cache save (RFC-017)                |
| Cache operations | `src/lib/cache.ts`           | `restoreCache()`, `saveCache()`             |
| GitHub API       | `src/lib/github/client.ts`   | `createClient()`, `createAppClient()`       |
| Event parsing    | `src/lib/github/context.ts`  | `parseGitHubContext()`                      |
| Agent execution  | `src/lib/agent/opencode.ts`  | `executeOpenCode()` via SDK                 |
| Prompt building  | `src/lib/agent/prompt.ts`    | `buildAgentPrompt()`                        |
| Session storage  | `src/lib/session/storage.ts` | File I/O, project discovery                 |
| Session search   | `src/lib/session/search.ts`  | `listSessions()`, `searchSessions()`        |
| Event routing    | `src/lib/triggers/router.ts` | `routeEvent()`, skip conditions             |
| Input parsing    | `src/lib/inputs.ts`          | `parseActionInputs()` returns Result        |
| Logging          | `src/lib/logger.ts`          | `createLogger()` with redaction             |
| Core types       | `src/lib/types.ts`           | `ActionInputs`, `CacheResult`, `RunContext` |
| Build config     | `tsdown.config.ts`           | ESM shim, bundled deps, license extraction  |

## CODE MAP

| Symbol              | Type      | Location                      | Role                              |
| ------------------- | --------- | ----------------------------- | --------------------------------- |
| `run`               | Function  | `src/main.ts:63`              | Main entry, 11-step orchestration |
| `runSetup`          | Function  | `src/lib/setup/setup.ts`      | Setup orchestration               |
| `runPost`           | Function  | `src/post.ts:31`              | Post-action cache save            |
| `restoreCache`      | Function  | `src/lib/cache.ts`            | Restore OpenCode state            |
| `saveCache`         | Function  | `src/lib/cache.ts`            | Persist state to cache            |
| `ensureProjectId`   | Function  | `src/lib/setup/project-id.ts` | Deterministic project ID creation |
| `executeOpenCode`   | Function  | `src/lib/agent/opencode.ts`   | SDK execution with events         |
| `routeEvent`        | Function  | `src/lib/triggers/router.ts`  | Event routing + skip-gating       |
| `parseActionInputs` | Function  | `src/lib/inputs.ts`           | Parse/validate inputs             |
| `createLogger`      | Function  | `src/lib/logger.ts`           | Logger with redaction             |
| `ActionInputs`      | Interface | `src/lib/types.ts`            | Input schema                      |
| `CacheResult`       | Interface | `src/lib/types.ts`            | Cache restore result              |
| `TriggerResult`     | Interface | `src/lib/triggers/types.ts`   | Routing decision                  |

## TDD (MANDATORY)

**RED-GREEN-REFACTOR for all new features and bug fixes.**

| Phase        | Action                     | Verification       |
| ------------ | -------------------------- | ------------------ |
| **RED**      | Write failing test first   | `pnpm test` → FAIL |
| **GREEN**    | Write MINIMAL code to pass | `pnpm test` → PASS |
| **REFACTOR** | Clean up, keep tests green | `pnpm test` → PASS |

- NEVER write implementation before test
- NEVER delete failing tests - fix the code
- Test naming: `*.test.ts` colocated with source
- BDD comments: `// #given`, `// #when`, `// #then`
- `vi.mock()` ONLY for external deps (`@actions/core`, `@actions/github`)

## CONVENTIONS

### TypeScript

- **ESM-only**: `"type": "module"`, use `.js` extensions in imports
- **Function-based**: No ES6 classes, pure functions only
- **Strict booleans**: Use `!= null` or `Boolean()` for non-boolean values; `!` is allowed only for `boolean` types (never for generic falsy checks)
- **Const assertions**: Use `as const` for fixed values
- **No suppressions**: Never `as any`, `@ts-ignore`, `@ts-expect-error`
- **Result type**: Use `Result<T, E>` from `@bfra.me/es` for recoverable errors
- **Logger injection**: All functions take `logger: Logger` as parameter

### Build

- **tsdown**: Bundles to `dist/main.js` + `dist/setup.js` + `dist/post.js`
- **ESM shim**: Banner injects `createRequire` for CJS compat
- **Bundled deps**: `@actions/*`, `@octokit/auth-app`, `@opencode-ai/sdk`
- **dist/ committed**: MUST run `pnpm build` after src changes

### Security

- **Credential handling**: `auth.json` with `0o600`, deleted before cache save
- **No secrets in cache**: Never `.env`, `*.key`, `*.pem`, `auth.json`
- **Log redaction**: Auto-redacts `token`, `password`, `secret`, `key`, `auth`
- **Authorization gating**: Only `OWNER`, `MEMBER`, `COLLABORATOR`; bots blocked

## ANTI-PATTERNS

| Forbidden                       | Reason                              |
| ------------------------------- | ----------------------------------- |
| ES6 classes                     | Use functions for composability     |
| `if (!value)` (implicit falsy)  | Violates strict-boolean-expressions |
| `as any`, `@ts-ignore`          | Maintain type safety                |
| Manual dist edits               | Rebuilt by CI; will be overwritten  |
| Committing without `pnpm build` | CI validates dist/ in sync          |
| CommonJS `require()`            | ESM-only project                    |
| Caching secrets                 | Security risk                       |
| Empty catch blocks              | Log or rethrow errors               |
| Global mutable state            | Use dependency injection            |
| Deleting failing tests          | Fix the code instead                |

## UNIQUE STYLES

- **Triple entry points**: Main action + setup action + post-action hook
- **RFC-driven development**: Major features documented in `RFCs/` first (17 total)
- **Black-box integration test**: `main.test.ts` spawns Node to test bundled artifact
- **v-branch releases**: Main merges to `v0` for major version pinning
- **Logger injection**: All functions take `logger: Logger` as parameter
- **Synthetic run summaries**: Session writeback creates "user" messages for discoverability
- **Post-action hook**: `post.ts` ensures cache save even on timeout/crash

## COMMANDS

```bash
pnpm bootstrap        # Install dependencies
pnpm build            # Bundle to dist/ (REQUIRED before commit)
pnpm check-types      # TypeScript validation
pnpm lint             # ESLint
pnpm fix              # ESLint --fix
pnpm test             # Vitest (350+ tests)
```

## NOTES

- **dist/ committed**: CI fails if `git diff dist/` shows changes after build
- **Node 24 required**: Matches `action.yaml` runtime
- **17 RFCs total**: Foundation, cache, GitHub client, sessions, triggers, security, observability, comments, PR review, delegated work, setup, execution, SDK mode, file attachments, GraphQL context, additional triggers, post-action hook
- **Phase 2 complete**: Core infrastructure done; Phase 3 (PR review, delegated work) pending

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
