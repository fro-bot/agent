# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-04
**Commit:** 8fc7482
**Branch:** main

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) + [oMo](https://github.com/code-yeongyu/oh-my-opencode) agents with **persistent session state** across CI runs. TypeScript, ESM-only, Node 24.

## STRUCTURE

```
./
├── src/                  # TypeScript source
│   ├── main.ts           # Entry point (executes run() with top-level await)
│   ├── index.ts          # Public API re-exports
│   ├── lib/              # Core libraries
│   │   ├── github/       # Octokit client, context parsing
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
├── RFCs/                 # 12 RFC documents (architecture specs)
├── .github/              # CI workflows, Renovate, settings
├── action.yaml           # GitHub Action definition (node24)
└── tsdown.config.ts      # esbuild bundler config
```

## WHERE TO LOOK

| Task             | Location                    | Notes                                                       |
| ---------------- | --------------------------- | ----------------------------------------------------------- |
| Add action logic | `src/main.ts`               | Orchestrates full run lifecycle                             |
| Cache operations | `src/lib/cache.ts`          | `restoreCache()`, `saveCache()`, corruption checks          |
| GitHub API       | `src/lib/github/client.ts`  | `createClient()`, `createAppClient()`, `getBotLogin()`      |
| Event parsing    | `src/lib/github/context.ts` | `parseGitHubContext()`, `classifyEventType()`               |
| Input parsing    | `src/lib/inputs.ts`         | `parseActionInputs()` returns `Result<ActionInputs, Error>` |
| Output setting   | `src/lib/outputs.ts`        | `setActionOutputs()`                                        |
| Logging          | `src/lib/logger.ts`         | `createLogger()` with sensitive field redaction             |
| Core types       | `src/lib/types.ts`          | `ActionInputs`, `CacheResult`, `RunContext`, `RunSummary`   |
| Build config     | `tsdown.config.ts`          | ESM shim, bundled deps, license extraction                  |
| Action I/O       | `action.yaml`               | Inputs, outputs, node24 runtime                             |
| CI pipeline      | `.github/workflows/ci.yaml` | Path-filtered jobs, v-branch release                        |
| Planned features | `RFCs/`                     | 12 RFCs: sessions, cache, security, setup                   |

## CODE MAP

| Symbol               | Type      | Location                      | Role                                      |
| -------------------- | --------- | ----------------------------- | ----------------------------------------- |
| `run`                | Function  | `src/main.ts:29`              | Main entry, orchestrates action lifecycle |
| `restoreCache`       | Function  | `src/lib/cache.ts:50`         | Restore OpenCode state from GitHub cache  |
| `saveCache`          | Function  | `src/lib/cache.ts:136`        | Persist OpenCode state to cache           |
| `createClient`       | Function  | `src/lib/github/client.ts:30` | Create Octokit with logging               |
| `createAppClient`    | Function  | `src/lib/github/client.ts:63` | Create GitHub App Octokit                 |
| `getBotLogin`        | Function  | `src/lib/github/client.ts:44` | Get authenticated user login              |
| `parseGitHubContext` | Function  | `src/lib/github/context.ts`   | Parse event payload                       |
| `parseActionInputs`  | Function  | `src/lib/inputs.ts:14`        | Parse/validate inputs                     |
| `createLogger`       | Function  | `src/lib/logger.ts:108`       | Logger with auto-redaction                |
| `ActionInputs`       | Interface | `src/lib/types.ts:39`         | Input schema                              |
| `CacheResult`        | Interface | `src/lib/types.ts:11`         | Cache restore result                      |
| `RunContext`         | Interface | `src/lib/types.ts:19`         | GitHub event context                      |
| `RunSummary`         | Interface | `src/lib/types.ts:63`         | Run result summary                        |

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
- One test at a time
- Test naming: `*.test.ts` colocated with source

**Test patterns:**

- `vi.mock()` ONLY for external deps (`@actions/core`, `@actions/github`)
- Create inline mock helpers for internal types (Logger, CacheAdapter)
- Use `// #given`, `// #when`, `// #then` comments
- `beforeEach`/`afterEach` for env cleanup

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

- **tsdown**: esbuild wrapper bundling to `dist/main.js`
- **ESM shim**: Banner injects `createRequire` for CJS compat
- **Bundled deps**: `@actions/*`, `@octokit/auth-app`, `@bfra.me/es` (not external)
- **Licenses**: Auto-extracted to `dist/licenses.txt`
- **dist/ committed**: MUST run `pnpm build` after src changes; CI fails if out of sync

### Testing

- **Vitest**: `pnpm test` runs all `*.test.ts`
- **Colocated**: Tests live alongside source
- **No mocking libs**: vi.mock for externals only, functional testing otherwise
- **Anti-.only**: `eslint-plugin-no-only-tests` blocks committing `.only`

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

## UNIQUE STYLES

- **@bfra.me ecosystem**: ESLint, Prettier, TSConfig from `@bfra.me/*`
- **Bleeding-edge Node 24**: `action.yaml`, `.node-version`
- **Top-level await**: `main.ts` executes `await run()` at module scope
- **Result type pattern**: `parseActionInputs()` returns `Result<T, E>` not throws
- **RFC-driven development**: Major features documented in `RFCs/` first
- **Black-box integration test**: `main.test.ts` spawns Node to test bundled artifact
- **v-branch releases**: Main merges to `v0` for major version pinning
- **Path-filtered CI**: Jobs run conditionally based on changed files

## COMMANDS

```bash
pnpm bootstrap        # Install dependencies
pnpm build            # Bundle to dist/ (REQUIRED before commit)
pnpm check-types      # TypeScript validation
pnpm lint             # ESLint
pnpm fix              # ESLint --fix
pnpm test             # Vitest (133 tests)
```

## NOTES

- **dist/ committed**: CI fails if `git diff dist/` shows changes after build
- **GitHub App releases**: CI uses app token to push to protected `v0` branch
- **Security scanning**: CodeQL + OSSF Scorecard + Dependency Review
- **Pre-commit hook**: `simple-git-hooks` runs `lint-staged`
- **RFCs 001-003 implemented**: Current work at RFC-004 (Session Management)
- **12 RFCs total**: Foundation, cache, GitHub client, sessions, triggers, security, observability, comments, PR review, delegated work, setup, execution

## EXTERNAL RESOURCES

> For librarian agent searches.

### Dependencies (from package.json)

@actions/core, @actions/cache, @actions/github, @bfra.me/es, @octokit/auth-app, vitest, tsdown, typescript

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
