# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-03
**Commit:** 25a8abc
**Branch:** main

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) + [oMo](https://github.com/code-yeongyu/oh-my-opencode) agents with **persistent session state** across CI runs. Currently a minimal "wait" template; agent features defined in RFCs.

## STRUCTURE

```
./
├── src/              # TypeScript source (main.ts, wait.ts, *.test.ts)
├── dist/             # Bundled output (committed, must stay in sync)
├── RFCs/             # 11 RFC documents defining planned features
├── .github/          # CI, Renovate, repo settings, CodeQL
├── action.yaml       # GitHub Action definition (node24 runtime)
└── tsdown.config.ts  # Build config (esbuild + license extraction)
```

## WHERE TO LOOK

| Task                  | Location                    | Notes                                           |
| --------------------- | --------------------------- | ----------------------------------------------- |
| Add action logic      | `src/main.ts`               | Uses `@actions/core`                            |
| Add utilities         | `src/wait.ts`               | Export pure functions                           |
| Modify build          | `tsdown.config.ts`          | ESM shim for CJS compat                         |
| Action inputs/outputs | `action.yaml`               | `node24` runtime                                |
| CI pipeline           | `.github/workflows/ci.yaml` | Path-filtered, v-branch release                 |
| Lint config           | `eslint.config.ts`          | Extends `@bfra.me/eslint-config`                |
| Type config           | `tsconfig.json`             | Extends `@bfra.me/tsconfig`, Bundler resolution |
| Planned features      | `RFCs/`                     | 11 RFCs: sessions, cache, security, setup       |

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
- **Integration test**: `main.test.ts` executes bundled `dist/main.js` via child process
- **No mocking libs**: Direct functional testing only
- **Anti-.only**: `eslint-plugin-no-only-tests` prevents committing `.only` blocks

### Release

- **v-branch strategy**: `main` merges to `v0` branch for stable refs
- **Semantic release**: Runs on `v[0-9]+` branches
- **Patch triggers**: `build` and `docs(readme)` commits trigger patch releases

## ANTI-PATTERNS (THIS PROJECT)

| Forbidden                             | Reason                              |
| ------------------------------------- | ----------------------------------- |
| ES6 classes                           | Use functions for composability     |
| Implicit falsy checks (`if (!value)`) | Violates strict-boolean-expressions |
| Type suppressions                     | Maintain type safety                |
| Manual dist edits                     | Rebuilt by CI; will be overwritten  |
| Committing without build              | CI validates `dist/` is in sync     |
| Mocking libraries                     | Use functional testing              |

## UNIQUE STYLES

- **@bfra.me ecosystem**: ESLint, Prettier, TSConfig all from `@bfra.me/*` packages
- **Bleeding-edge Node**: Targets Node 24 (`action.yaml`, `.node-version`)
- **Persistent sessions (planned)**: Cache `~/.local/share/opencode/storage` across runs
- **Session tools**: Agent must use `session_list`, `session_read`, `session_search`, `session_info`
- **RFC-driven development**: All major features documented in `RFCs/` before implementation

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
