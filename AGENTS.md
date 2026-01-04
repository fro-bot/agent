# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-03
**Commit:** d11e763
**Branch:** main

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) + [oMo](https://github.com/code-yeongyu/oh-my-opencode) agents with **persistent session state** across CI runs.

## STRUCTURE

```
./
├── src/              # TypeScript source (main.ts, wait.ts, *.test.ts)
│   ├── lib/          # Core libraries (cache, logger, inputs, outputs, types)
│   │   └── github/   # GitHub API client and context utilities
│   └── utils/        # Validation and environment utilities
├── dist/             # Bundled output (committed, must stay in sync)
├── RFCs/             # 11 RFC documents defining planned features
├── .github/          # CI, Renovate, repo settings, CodeQL
├── action.yaml       # GitHub Action definition (node24 runtime)
└── tsdown.config.ts  # Build config (esbuild + license extraction)
```

## WHERE TO LOOK

| Task                  | Location                    | Notes                                              |
| --------------------- | --------------------------- | -------------------------------------------------- |
| Add action logic      | `src/main.ts`               | Uses `@actions/core`, orchestrates full run        |
| Cache operations      | `src/lib/cache.ts`          | `restoreCache()`, `saveCache()`, corruption checks |
| GitHub API calls      | `src/lib/github/client.ts`  | `createClient()`, `getBotLogin()`                  |
| Input parsing         | `src/lib/inputs.ts`         | `parseActionInputs()` with validation              |
| Output setting        | `src/lib/outputs.ts`        | `setActionOutputs()`                               |
| Logging               | `src/lib/logger.ts`         | `createLogger()` with sensitive field redaction    |
| Core types            | `src/lib/types.ts`          | `ActionInputs`, `CacheResult`, `RunContext`        |
| Modify build          | `tsdown.config.ts`          | ESM shim for CJS compat                            |
| Action inputs/outputs | `action.yaml`               | `node24` runtime                                   |
| CI pipeline           | `.github/workflows/ci.yaml` | Path-filtered, v-branch release                    |
| Lint config           | `eslint.config.ts`          | Extends `@bfra.me/eslint-config`                   |
| Type config           | `tsconfig.json`             | Extends `@bfra.me/tsconfig`, Bundler resolution    |
| Planned features      | `RFCs/`                     | 11 RFCs: sessions, cache, security, setup          |

## CODE MAP

| Symbol              | Type      | Location                      | Role                                            |
| ------------------- | --------- | ----------------------------- | ----------------------------------------------- |
| `run`               | Function  | `src/main.ts:29`              | Main entry point, orchestrates action lifecycle |
| `restoreCache`      | Function  | `src/lib/cache.ts:50`         | Restore OpenCode state from GitHub cache        |
| `saveCache`         | Function  | `src/lib/cache.ts:142`        | Persist OpenCode state to GitHub cache          |
| `createClient`      | Function  | `src/lib/github/client.ts:14` | Create Octokit instance with logging            |
| `parseActionInputs` | Function  | `src/lib/inputs.ts:14`        | Parse and validate action inputs                |
| `createLogger`      | Function  | `src/lib/logger.ts:108`       | Create logger with auto-redaction               |
| `ActionInputs`      | Interface | `src/lib/types.ts:39`         | Input schema (token, prompt, s3, etc.)          |
| `CacheResult`       | Interface | `src/lib/types.ts:11`         | Cache restore result (hit, key, corrupted)      |
| `RunContext`        | Interface | `src/lib/types.ts:19`         | GitHub event context (repo, ref, actor)         |

## TDD (Test-Driven Development)

**MANDATORY for new features and bug fixes.** Follow RED-GREEN-REFACTOR:

```
1. RED    - Write failing test first (test MUST fail)
2. GREEN  - Write MINIMAL code to pass (nothing more)
3. REFACTOR - Clean up while tests stay GREEN
4. REPEAT - Next test case
```

| Phase        | Action                                   | Verification                         |
| ------------ | ---------------------------------------- | ------------------------------------ |
| **RED**      | Write test describing expected behavior  | `pnpm test` → FAIL (expected)        |
| **GREEN**    | Implement minimum code to pass           | `pnpm test` → PASS                   |
| **REFACTOR** | Improve code quality, remove duplication | `pnpm test` → PASS (must stay green) |

**Rules:**

- NEVER write implementation before test
- NEVER delete failing tests to "pass" - fix the code
- One test at a time - don't batch
- Test file naming: `*.test.ts` alongside source in `src/`

## CONVENTIONS

### TypeScript

- **ESM-only**: `"type": "module"` in package.json
- **Function-based**: Prefer functions over ES6 classes
- **Strict booleans**: Use explicit `!= null` or `Boolean()` checks, never implicit falsy
- **Const assertions**: Use `as const` for fixed values
- **No suppressions**: Never use `as any`, `@ts-ignore`, `@ts-expect-error`
- **ESM imports**: Use `.js` extension in imports (e.g., `import {wait} from './wait.js'`)

### Build

- **tsdown**: esbuild wrapper bundling to `dist/main.js`
- **ESM shim**: Banner injects `createRequire` for CJS compatibility
- **Bundle deps**: `@actions/core` bundled via `noExternal`
- **Licenses**: Auto-extracted to `dist/licenses.txt`

### Testing

- **Vitest**: Run with `pnpm test`
- **Colocated tests**: `src/*.test.ts` alongside source files
- **Integration test**: `main.test.ts` executes bundled `dist/main.js` via child process spawn
- **No mocking libs**: Direct functional testing only
- **Anti-.only**: `eslint-plugin-no-only-tests` prevents committing `.only` blocks

### Release

- **v-branch strategy**: `main` merges to `v0` branch for stable refs
- **Semantic release**: Runs on `v[0-9]+` branches
- **Patch triggers**: `build` and `docs(readme)` commits trigger patch releases

### Security

- **Credential handling**: `auth.json` written with `0o600` permissions, deleted before cache save
- **No secrets in cache**: Never persist `.env`, `*.key`, `*.pem`, `auth.json`
- **Log redaction**: Logger auto-redacts `token`, `password`, `secret`, `key`, `auth` fields
- **Authorization gating**: Only `OWNER`, `MEMBER`, `COLLABORATOR` can trigger; bots blocked (anti-loop)

## ANTI-PATTERNS (THIS PROJECT)

| Forbidden                             | Reason                              |
| ------------------------------------- | ----------------------------------- |
| ES6 classes                           | Use functions for composability     |
| Implicit falsy checks (`if (!value)`) | Violates strict-boolean-expressions |
| Type suppressions (`as any`, etc.)    | Maintain type safety                |
| Manual dist edits                     | Rebuilt by CI; will be overwritten  |
| Committing without build              | CI validates `dist/` is in sync     |
| Mocking libraries                     | Use functional testing              |
| CommonJS `require()`                  | ESM-only project                    |
| Caching secrets                       | Security risk                       |

## UNIQUE STYLES

- **@bfra.me ecosystem**: ESLint, Prettier, TSConfig all from `@bfra.me/*` packages
- **Bleeding-edge Node**: Targets Node 24 (`action.yaml`, `.node-version`)
- **Persistent sessions (planned)**: Cache `~/.local/share/opencode/storage` across runs
- **Session tools**: Agent must use `session_list`, `session_read`, `session_search`, `session_info`
- **RFC-driven development**: All major features documented in `RFCs/` before implementation
- **Black-box integration test**: `main.test.ts` spawns Node process to test bundled `dist/main.js`

## COMMANDS

```bash
pnpm bootstrap        # Install dependencies
pnpm build            # Bundle to dist/
pnpm check-types      # TypeScript validation
pnpm lint             # ESLint
pnpm fix              # ESLint --fix
pnpm test             # Vitest
```

## NOTES

- **dist/ committed**: Must run `pnpm build` after src changes; CI fails if out of sync
- **GitHub App releases**: CI uses app token to push to protected `v0` branch
- **Security scanning**: CodeQL + OSSF Scorecard + Dependency Review active
- **Pre-commit hook**: `simple-git-hooks` runs `lint-staged` automatically
- **Dual identity**: Planned support for both GitHub Action and Discord bot entry points
- **RFCs 001-003 complete**: Start new implementation at RFC-004 (Session Management)

## EXTERNAL RESOURCES

> Generated by /init-resources. Librarian uses this for focused searches.

### Dependencies (from package.json)

@actions/core, @actions/cache, @actions/github, @bfra.me/es, vitest, tsdown, typescript

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

### Documentation

- https://github.com/actions/toolkit/tree/main/packages/core - @actions/core API
- https://github.com/actions/toolkit/tree/main/packages/cache - @actions/cache API
- https://github.com/actions/toolkit/tree/main/packages/github - @actions/github (Octokit)
- https://vitest.dev - Vitest testing framework
- https://docs.github.com/en/actions - GitHub Actions official docs
