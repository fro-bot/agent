# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-06
**Commit:** 5062257
**Branch:** main

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) + [oMo](https://github.com/code-yeongyu/oh-my-opencode) agents with **persistent session state** across CI runs. TypeScript, ESM-only, Node 24.

## STRUCTURE

```
./
├── src/                  # TypeScript source
│   ├── main.ts           # Primary entry (9-step orchestration with top-level await)
│   ├── setup.ts          # Secondary entry (environment bootstrap)
│   ├── index.ts          # Public API re-exports
│   ├── lib/              # Core libraries
│   │   ├── agent/        # Agent execution (context, prompt, reactions, opencode)
│   │   ├── github/       # Octokit client, context parsing
│   │   ├── setup/        # Environment bootstrap (bun, omo, opencode, auth)
│   │   ├── cache.ts      # Cache restore/save with corruption detection
│   │   ├── cache-key.ts  # Branch-scoped key generation
│   │   ├── logger.ts     # JSON logging with auto-redaction
│   │   ├── inputs.ts     # Action input parsing (Result type)
│   │   ├── outputs.ts    # Action output setting
│   │   ├── types.ts      # Core interfaces
│   │   └── constants.ts  # Config values
│   └── utils/            # Pure utility functions
│       ├── env.ts        # Environment variable getters
│       └── validation.ts # Input validators
├── dist/                 # Bundled output (COMMITTED, must stay in sync)
├── setup/                # Setup action definition
│   └── action.yaml       # Secondary action (../dist/setup.js)
├── RFCs/                 # 14 RFC documents (architecture specs)
├── .github/              # CI workflows, Renovate, settings
├── action.yaml           # Primary GitHub Action definition (node24)
└── tsdown.config.ts      # esbuild bundler config (dual entry points)
```

## WHERE TO LOOK

| Task             | Location                     | Notes                                              |
| ---------------- | ---------------------------- | -------------------------------------------------- |
| Add action logic | `src/main.ts`                | 9-step orchestration lifecycle                     |
| Setup bootstrap  | `src/setup.ts`               | Bun/oMo/OpenCode installation                      |
| Cache operations | `src/lib/cache.ts`           | `restoreCache()`, `saveCache()`, corruption checks |
| GitHub API       | `src/lib/github/client.ts`   | `createClient()`, `createAppClient()`              |
| Event parsing    | `src/lib/github/context.ts`  | `parseGitHubContext()`, `classifyEventType()`      |
| Agent execution  | `src/lib/agent/opencode.ts`  | `executeOpenCode()`, `verifyOpenCodeAvailable()`   |
| Prompt building  | `src/lib/agent/prompt.ts`    | `buildAgentPrompt()` with session instructions     |
| GitHub reactions | `src/lib/agent/reactions.ts` | Eyes emoji, working label, success/failure         |
| Input parsing    | `src/lib/inputs.ts`          | `parseActionInputs()` returns `Result<T, E>`       |
| Output setting   | `src/lib/outputs.ts`         | `setActionOutputs()`                               |
| Logging          | `src/lib/logger.ts`          | `createLogger()` with sensitive field redaction    |
| Core types       | `src/lib/types.ts`           | `ActionInputs`, `CacheResult`, `RunContext`        |
| Build config     | `tsdown.config.ts`           | ESM shim, bundled deps, license extraction         |
| Action I/O       | `action.yaml`                | Inputs, outputs, node24 runtime                    |
| CI pipeline      | `.github/workflows/ci.yaml`  | Path-filtered jobs, v-branch release               |

## CODE MAP

| Symbol              | Type      | Location                    | Role                             |
| ------------------- | --------- | --------------------------- | -------------------------------- |
| `run`               | Function  | `src/main.ts:49`            | Main entry, 9-step orchestration |
| `runSetup`          | Function  | `src/lib/setup/setup.ts:64` | Setup orchestration              |
| `restoreCache`      | Function  | `src/lib/cache.ts:50`       | Restore OpenCode state           |
| `saveCache`         | Function  | `src/lib/cache.ts:136`      | Persist state to cache           |
| `parseActionInputs` | Function  | `src/lib/inputs.ts:14`      | Parse/validate inputs            |
| `createLogger`      | Function  | `src/lib/logger.ts:108`     | Logger with redaction            |
| `ActionInputs`      | Interface | `src/lib/types.ts:39`       | Input schema                     |
| `CacheResult`       | Interface | `src/lib/types.ts:11`       | Cache restore result             |

> See subdirectory AGENTS.md files for module-specific symbols (`src/lib/agent/`, `src/lib/github/`, `src/lib/setup/`).

## TDD (Test-Driven Development)

**MANDATORY for new features and bug fixes.** Follow RED-GREEN-REFACTOR:

| Phase        | Action                     | Verification                  |
| ------------ | -------------------------- | ----------------------------- |
| **RED**      | Write failing test first   | `pnpm test` → FAIL (expected) |
| **GREEN**    | Write MINIMAL code to pass | `pnpm test` → PASS            |
| **REFACTOR** | Clean up, keep tests green | `pnpm test` → PASS            |

**Rules:**

- NEVER write implementation before test
- NEVER delete failing tests - fix the code
- Test naming: `*.test.ts` colocated with source
- Use `// #given`, `// #when`, `// #then` comments

**Test patterns:**

- `vi.mock()` ONLY for external deps (`@actions/core`, `@actions/github`)
- Create inline mock helpers for internal types (Logger, CacheAdapter)
- `beforeEach`/`afterEach` for env cleanup with `vi.clearAllMocks()`/`vi.restoreAllMocks()`

**Integration test:** `main.test.ts` spawns bundled `dist/main.js` as child process (black-box)

## CONVENTIONS

### TypeScript

- **ESM-only**: `"type": "module"`, use `.js` extensions in imports
- **Function-based**: No ES6 classes, pure functions only
- **Strict booleans**: Use `!= null` or `Boolean()`, never implicit falsy (`if (!value)`)
- **Const assertions**: Use `as const` for fixed values
- **No suppressions**: Never `as any`, `@ts-ignore`, `@ts-expect-error`
- **Result type**: Use `Result<T, E>` from `@bfra.me/es` for recoverable errors

### Build

- **tsdown**: esbuild wrapper bundling to `dist/main.js` + `dist/setup.js`
- **ESM shim**: Banner injects `createRequire` for CJS compat
- **Bundled deps**: `@actions/*`, `@octokit/auth-app`, `@bfra.me/es` (not external)
- **Licenses**: Auto-extracted to `dist/licenses.txt`
- **dist/ committed**: MUST run `pnpm build` after src changes; CI fails if out of sync

### Testing

- **Vitest**: `pnpm test` runs all `*.test.ts`
- **Colocated**: Tests live alongside source
- **No mocking libs**: vi.mock for externals only, functional testing otherwise
- **Anti-.only**: `eslint-plugin-no-only-tests` blocks committing `.only`
- **Lowercase titles**: `vitest/prefer-lowercase-title` (except `describe`)

### Release

- **v-branch strategy**: `main` merges to `v0` for stable refs (`@v0`, `@v0.3.2`)
- **Semantic release**: Conventional commits drive versioning
- **Patch triggers**: `build:` and `docs(readme):` commits

### Security

- **Credential handling**: `auth.json` with `0o600`, deleted before cache save
- **No secrets in cache**: Never `.env`, `*.key`, `*.pem`, `auth.json`
- **Log redaction**: Auto-redacts `token`, `password`, `secret`, `key`, `auth`
- **Authorization gating**: Only `OWNER`, `MEMBER`, `COLLABORATOR`; bots blocked

## ANTI-PATTERNS (THIS PROJECT)

| Forbidden                                  | Reason                              |
| ------------------------------------------ | ----------------------------------- |
| ES6 classes                                | Use functions for composability     |
| `if (!value)` (implicit falsy)             | Violates strict-boolean-expressions |
| `as any`, `@ts-ignore`, `@ts-expect-error` | Maintain type safety                |
| Manual dist edits                          | Rebuilt by CI; will be overwritten  |
| Committing without `pnpm build`            | CI validates dist/ in sync          |
| Mocking libraries (jest, sinon)            | Functional testing only             |
| CommonJS `require()`                       | ESM-only project                    |
| Caching secrets                            | Security risk                       |
| Empty catch blocks                         | Log or rethrow errors               |
| Global mutable state                       | Use dependency injection            |
| Deleting failing tests                     | Fix the code instead                |

## UNIQUE STYLES

- **@bfra.me ecosystem**: ESLint, Prettier, TSConfig from `@bfra.me/*`
- **Top-level await**: `main.ts` and `setup.ts` execute at module scope
- **RFC-driven development**: Major features documented in `RFCs/` first
- **Black-box integration test**: `main.test.ts` spawns Node to test bundled artifact
- **v-branch releases**: Main merges to `v0` for major version pinning
- **Dual entry points**: Main action + setup action with separate bundled outputs

## COMMANDS

```bash
pnpm bootstrap        # Install dependencies
pnpm build            # Bundle to dist/ (REQUIRED before commit)
pnpm check-types      # TypeScript validation
pnpm lint             # ESLint
pnpm fix              # ESLint --fix
pnpm test             # Vitest (247 tests)
```

## NOTES

- **dist/ committed**: CI fails if `git diff dist/` shows changes after build
- **GitHub App releases**: CI uses app token to push to protected `v0` branch
- **Security scanning**: CodeQL + OSSF Scorecard + Dependency Review
- **Pre-commit hook**: `simple-git-hooks` runs `lint-staged`
- **12 RFCs total**: Foundation, cache, GitHub client, sessions, triggers, security, observability, comments, PR review, delegated work, setup, execution

## EXTERNAL RESOURCES

### Dependencies

@actions/core, @actions/cache, @actions/exec, @actions/github, @actions/tool-cache, @bfra.me/es, @octokit/auth-app, vitest, tsdown, typescript

### Context7 IDs

| Library                | ID                          | Snippets | Score |
| ---------------------- | --------------------------- | -------- | ----- |
| GitHub Actions Toolkit | /actions/toolkit            | 332      | 87.4  |
| GitHub Actions Cache   | /actions/cache              | 73       | 79.0  |
| GitHub Actions Docs    | /websites/github_en_actions | 6032     | 72.7  |
| Vitest                 | /vitest-dev/vitest          | 2776     | 90.4  |
| Vitest Docs            | /websites/main_vitest_dev   | 1295     | 94.0  |

### GitHub Repos

- actions/toolkit - GitHub Actions SDK (@actions/core, @actions/cache, @actions/github)
- vitest-dev/vitest - Test framework
- rolldown/tsdown - Build bundler (esbuild wrapper)
- octokit/auth-app.js - GitHub App authentication

### Documentation

- https://github.com/actions/toolkit/tree/main/packages/core - @actions/core API
- https://github.com/actions/toolkit/tree/main/packages/cache - @actions/cache API
- https://github.com/actions/toolkit/tree/main/packages/github - @actions/github (Octokit)
- https://vitest.dev - Vitest testing framework
- https://docs.github.com/en/actions - GitHub Actions official docs
