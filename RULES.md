# Development Rules: Fro Bot Agent

**Version:** 1.0
**Last Updated:** 2026-01-03
**Applies to:** All contributors and AI assistants

---

## Table of Contents

- [Project Overview](#project-overview)
- [Technology Stack](#technology-stack)
- [Code Style & Conventions](#code-style--conventions)
- [Architecture Patterns](#architecture-patterns)
- [Security Requirements](#security-requirements)
- [Testing Standards](#testing-standards)
- [Build & Release](#build--release)
- [GitHub Action Specifics](#github-action-specifics)
- [Documentation Standards](#documentation-standards)
- [Anti-Patterns (Forbidden)](#anti-patterns-forbidden)
- [Implementation Priorities](#implementation-priorities)
- [AI Assistant Guidelines](#ai-assistant-guidelines)

---

## Project Overview

Fro Bot Agent is a GitHub Action + Discord bot harness for OpenCode with persistent session state across CI runs. The core differentiator is **durable memory** - the agent remembers prior investigations and avoids redundant work.

**Key Components:**

- GitHub Action (TypeScript, Node.js 24)
- Discord daemon (long-running bot)
- Shared OpenCode storage (persisted via cache + S3)

---

## Technology Stack

### Runtime & Language

| Technology      | Version            | Notes                                        |
| --------------- | ------------------ | -------------------------------------------- |
| Node.js         | **24.x** (24.12.0) | Bleeding-edge; matches `action.yaml` runtime |
| TypeScript      | **5.9.x**          | Strict mode enabled                          |
| Package Manager | **pnpm** (v10+)    | Workspace-enabled                            |

### Core Dependencies

| Package           | Purpose            | Bundle Strategy      |
| ----------------- | ------------------ | -------------------- |
| `@actions/core`   | GitHub Actions SDK | Bundled (noExternal) |
| `@actions/cache`  | Cache restore/save | To be added          |
| `@actions/github` | GitHub API client  | To be added          |

### Development Dependencies

| Package            | Purpose                                    |
| ------------------ | ------------------------------------------ |
| `tsdown`           | esbuild-based bundler                      |
| `vitest`           | Testing framework                          |
| `eslint`           | Linting (extends `@bfra.me/eslint-config`) |
| `typescript`       | Type checking                              |
| `simple-git-hooks` | Pre-commit automation                      |

### Shared Configurations

All tooling extends `@bfra.me/*` shared configs:

- `@bfra.me/tsconfig` - TypeScript configuration
- `@bfra.me/eslint-config` - ESLint rules
- `@bfra.me/prettier-config` - Code formatting

---

## Code Style & Conventions

### Module System

```typescript
// REQUIRED: ESM-only
// package.json: "type": "module"

// CORRECT: ESM imports
import {getInput, setOutput} from "@actions/core"
import {wait} from "./wait.js"

// WRONG: CommonJS
const core = require("@actions/core") // Never use
```

### Naming Conventions

| Element          | Convention                   | Example                              |
| ---------------- | ---------------------------- | ------------------------------------ |
| Files            | kebab-case                   | `cache-manager.ts`, `run-summary.ts` |
| Folders          | lowercase                    | `src/`, `lib/`                       |
| Functions        | camelCase                    | `restoreCache()`, `postComment()`    |
| Variables        | camelCase                    | `sessionId`, `cacheKey`              |
| Constants        | SCREAMING_SNAKE or camelCase | `MAX_RETRIES`, `defaultTimeout`      |
| Types/Interfaces | PascalCase                   | `RunSummary`, `CacheOptions`         |
| Type parameters  | Single uppercase             | `T`, `K`, `V`                        |

### Boolean Expressions (CRITICAL)

**Strict boolean expressions are mandatory.** Never use implicit falsy checks.

```typescript
// CORRECT: Explicit null/undefined checks
if (value != null) { ... }
if (value !== undefined) { ... }
if (Boolean(value)) { ... }
if (array.length > 0) { ... }
if (string !== '') { ... }

// WRONG: Implicit falsy (FORBIDDEN)
if (!value) { ... }        // Violates strict-boolean-expressions
if (array.length) { ... }  // Implicit number-to-boolean
if (string) { ... }        // Implicit string-to-boolean
```

### Function Style

**Prefer functions over classes.** Use pure functions for composability.

```typescript
// CORRECT: Function-based design
export async function restoreCache(options: CacheOptions): Promise<CacheResult> {
  const key = buildCacheKey(options)
  return await actions.cache.restoreCache(options.paths, key, options.restoreKeys)
}

// Helper functions for composition
function buildCacheKey(options: CacheOptions): string {
  return `opencode-storage-${options.agentIdentity}-${options.repo}-${options.ref}`
}

// WRONG: Class-based (FORBIDDEN)
class CacheManager {
  constructor(private options: CacheOptions) {}
  async restore(): Promise<CacheResult> { ... }
}
```

### Const Assertions

Use `as const` for fixed values:

```typescript
// CORRECT
const VALID_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const
type AuthorAssociation = (typeof VALID_ASSOCIATIONS)[number]

const RETRY_DELAYS = [30_000, 60_000, 120_000] as const
```

### Error Handling

```typescript
// CORRECT: Typed error handling
try {
  await postComment(body)
} catch (error) {
  if (error instanceof Error) {
    core.error(`Failed to post comment: ${error.message}`)
  }
  throw error
}

// CORRECT: Result types for recoverable errors
type Result<T, E = Error> = {ok: true; value: T} | {ok: false; error: E}

function parseConfig(input: string): Result<Config, ParseError> {
  // ...
}
```

---

## Architecture Patterns

### File Organization

```
src/
├── main.ts              # Action entry point (top-level await)
├── lib/
│   ├── cache.ts         # Cache restore/save logic
│   ├── github.ts        # GitHub API interactions
│   ├── session.ts       # Session management
│   ├── summary.ts       # Run summary generation
│   └── types.ts         # Shared type definitions
├── utils/
│   ├── retry.ts         # Retry with backoff
│   └── validation.ts    # Input validation
└── constants.ts         # Shared constants
```

### Entry Point Pattern

```typescript
// src/main.ts
import * as core from "@actions/core"

async function run(): Promise<void> {
  try {
    // 1. Parse and validate inputs
    const inputs = parseInputs()

    // 2. Restore cache (early)
    const cacheResult = await restoreCache(inputs)

    // 3. Execute main logic
    const result = await executeAgent(inputs, cacheResult)

    // 4. Post summary
    await postRunSummary(result)

    // 5. Save cache (always, even on failure)
    await saveCache(inputs)
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

// Top-level await for ESM entry
await run()
```

### Dependency Injection (via Parameters)

```typescript
// CORRECT: Dependencies as parameters
async function postComment(body: string, options: {octokit: Octokit; context: Context}): Promise<void> {
  // ...
}

// WRONG: Global imports for testability issues
import {octokit} from "./global-client" // Avoid
```

---

## Security Requirements

### Credential Handling (P0 - CRITICAL)

```typescript
// NEVER persist auth.json
const EXCLUDED_FROM_CACHE = ["auth.json", ".env", "*.key", "*.pem"] as const

// NEVER log credentials
function sanitizeForLog(obj: unknown): unknown {
  // Strip sensitive fields before logging
}

// Credentials from secrets only
const authJson = core.getInput("auth-json", {required: true})
// Write to auth.json at runtime, never cache
```

### Permission Gating (Fork PRs)

```typescript
const ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const

function isAuthorizedUser(association: string): boolean {
  return ALLOWED_ASSOCIATIONS.includes(association as (typeof ALLOWED_ASSOCIATIONS)[number])
}

// In main flow
if (!isAuthorizedUser(context.payload.comment?.author_association ?? "")) {
  core.info("Ignoring comment from unauthorized user")
  return
}
```

### Anti-Loop Protection

```typescript
function isSelfComment(context: Context, botLogin: string): boolean {
  const author = context.payload.comment?.user?.login
  return author === botLogin || author === `${botLogin}[bot]`
}
```

### Cache Security

- **Branch-scoped keys** to reduce poisoning risk
- **S3 prefix isolation** by agent identity + repo
- **Never cache secrets** - explicit exclusion list

---

## Testing Standards

### Framework & Patterns

- **Vitest** for all testing
- **No mocking libraries** - prefer dependency injection
- **Integration tests** execute bundled `dist/main.js`
- **BDD comments** `#given`, `#when`, `#then` (same as AAA)
- **TDD workflow** (RED-GREEN-REFACTOR)

### TDD (Test-Driven Development)

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
- Test file naming: `*.test.ts` alongside source

### Test File Structure

```typescript
// src/lib/cache.test.ts
import {describe, it, expect} from "vitest"
import {buildCacheKey, validateCacheResult} from "./cache.js"

describe("buildCacheKey", () => {
  it("includes all required components", () => {
    const key = buildCacheKey({
      agentIdentity: "github",
      repo: "owner/repo",
      ref: "main",
      os: "Linux",
    })

    expect(key).toBe("opencode-storage-github-owner/repo-main-Linux")
  })

  it("handles special characters in repo name", () => {
    // ...
  })
})
```

### Integration Test Pattern

```typescript
// src/main.test.ts
import {exec} from "node:child_process"
import {promisify} from "node:util"

const execAsync = promisify(exec)

describe("GitHub Action", () => {
  it("runs successfully with valid inputs", async () => {
    const {stdout, stderr} = await execAsync("node dist/main.js", {
      env: {
        ...process.env,
        INPUT_MILLISECONDS: "100",
        GITHUB_OUTPUT: "/dev/null",
      },
    })

    expect(stderr).toBe("")
  })
})
```

### Coverage Expectations

- **Unit tests**: All utility functions
- **Integration tests**: Full action execution
- **No test deletion**: Fix code, not tests

---

## Build & Release

### Build Process

```bash
# Development
pnpm bootstrap     # Install dependencies
pnpm build         # Bundle to dist/
pnpm check-types   # TypeScript validation
pnpm lint          # ESLint check
pnpm test          # Run tests

# Pre-commit (automatic via simple-git-hooks)
lint-staged        # Runs on staged files
```

### Build Output

- **Bundle**: `dist/main.js` (ESM, minified)
- **Bundle (setup)**: `dist/setup.js` (ESM, minified)
- **Licenses**: `dist/licenses.txt` (auto-extracted)
- **Source maps**: Not included in production

### dist/ Directory Rules

1. **Committed**: `dist/` must be committed and stay in sync
2. **CI validates**: Build runs in CI; mismatch fails the job
3. **Never manual edit**: Changes are overwritten by build

### Release Strategy

- **v-branch pattern**: `main` → `v0` for stable refs
- **Semantic release**: Runs on `v[0-9]+` branches
- **Patch triggers**: `build:` and `docs(readme):` commits

---

## GitHub Action Specifics

### action.yaml Structure

```yaml
name: "Fro Bot Agent"
description: "AI agent with persistent memory for GitHub automation"

inputs:
  auth-json:
    description: "JSON object or path with OpenCode credentials (auth.json format)"
    required: true
  app-id:
    description: "GitHub App ID"
    required: true
  private-key:
    description: "GitHub App private key"
    required: true
  prompt:
    description: "Custom prompt"
    required: false
  session-retention:
    description: "Number of sessions to retain (default: 50)"
    required: false
    default: "50"
  s3-backup:
    description: "Enable S3 write-through backup"
    required: false
    default: "false"

outputs:
  session-id:
    description: "OpenCode session ID used for this run"
  cache-status:
    description: "Cache restore status (hit/miss/corrupted)"

runs:
  using: "node24"
  main: "dist/main.js"
```

### Cache Key Pattern

```typescript
// Primary key (branch-scoped)
const primaryKey = `opencode-storage-${agentIdentity}-${repo}-${ref}-${os}`

// Restore keys (fallback chain)
const restoreKeys = [`opencode-storage-${agentIdentity}-${repo}-${ref}-`, `opencode-storage-${agentIdentity}-${repo}-`]
```

### Run Summary Format

Every comment must include:

```markdown
<details>
<summary>Run Summary</summary>

| Field    | Value              |
| -------- | ------------------ |
| Event    | issue_comment      |
| Repo     | owner/repo         |
| Ref      | main               |
| Run ID   | 12345678           |
| Cache    | hit                |
| Session  | ses_abc123         |
| Duration | 45s                |
| Tokens   | 1,234 in / 567 out |

</details>
```

---

## Documentation Standards

### Code Comments

Follow the self-explanatory code principle:

- **WHY, not WHAT**: Explain reasoning, not mechanics
- **No obvious comments**: Code should speak for itself
- **Regex patterns**: Always document what they match
- **API constraints**: Document external limitations

```typescript
// GOOD: Explains WHY
// GitHub API rate limit: 5000 requests/hour for authenticated users
await rateLimiter.wait()

// BAD: States the obvious
// Increment counter by one
counter++
```

### JSDoc for Public APIs

```typescript
/**
 * Restore OpenCode storage from cache.
 *
 * @param options - Cache configuration
 * @returns Cache result with hit/miss status and restored path
 * @throws {CacheError} If cache is corrupted and cannot be recovered
 */
export async function restoreCache(options: CacheOptions): Promise<CacheResult> {
  // ...
}
```

---

## Anti-Patterns (Forbidden)

| Pattern                  | Reason                              | Alternative                        |
| ------------------------ | ----------------------------------- | ---------------------------------- |
| ES6 classes              | Use functions for composability     | Pure functions with explicit deps  |
| `if (!value)`            | Violates strict-boolean-expressions | `if (value == null)`               |
| `as any`                 | Type safety violation               | Proper typing or unknown           |
| `@ts-ignore`             | Hides type errors                   | Fix the types                      |
| `@ts-expect-error`       | Same as above                       | Exception: known library bugs only |
| Manual dist edits        | Overwritten by build                | Edit source, run build             |
| `require()`              | CJS in ESM project                  | `import` statements                |
| Empty catch blocks       | Swallows errors silently            | Log or rethrow                     |
| Global mutable state     | Testing difficulties                | Dependency injection               |
| Committing without build | CI will fail                        | Always `pnpm build` first          |

---

## Implementation Priorities

### P0 (Must Have for MVP)

1. Cache restore/save for OpenCode storage
2. auth.json exclusion from persistence
3. Session search on startup
4. Issue/PR/Discussion comment support
5. Run summary in every comment
6. Fork PR permission gating
7. Anti-loop protection
8. Session pruning

### P1 (Should Have)

1. Setup action entrypoint
2. Corruption detection
3. Concurrency handling (last-write-wins)
4. Storage versioning

### P2 (Nice to Have)

1. S3 write-through backup
2. Org-level memory partitioning

---

## AI Assistant Guidelines

### Following Requirements

1. **Read PRD.md and FEATURES.md** before implementing features
2. **Match existing patterns** - check AGENTS.md for conventions
3. **No shortcuts** - implement full functionality, not demos
4. **No placeholders** - code must be complete and functional

### Code Quality

1. **Type everything** - no implicit any
2. **Handle errors** - never swallow exceptions
3. **Test new code** - add tests for new functionality using TDD
4. **Run checks** - `pnpm lint && pnpm check-types && pnpm test`

### Before Submitting Changes

```bash
# Required before any PR
pnpm build        # Must run - dist/ is committed
pnpm check-types  # No type errors
pnpm lint         # No lint errors
pnpm test         # All tests pass
```

### Uncertainty Protocol

When requirements are unclear:

1. Check PRD.md for product requirements
2. Check FEATURES.md for acceptance criteria
3. Check AGENTS.md for technical conventions
4. Ask for clarification before proceeding

### Commit Message Format

```
type(scope): description

# Types: feat, fix, docs, style, refactor, test, build, ci, chore
# Examples:
feat(cache): add session pruning at end of run
fix(github): handle locked issue gracefully
docs(readme): add S3 backup configuration
```

---

## Quick Reference

### Commands

```bash
pnpm bootstrap    # Install deps
pnpm build        # Bundle
pnpm check-types  # Type check
pnpm lint         # Lint
pnpm fix          # Auto-fix lint
pnpm test         # Run tests
```

### Key Files

| File               | Purpose                  |
| ------------------ | ------------------------ |
| `src/main.ts`      | Action entry point       |
| `action.yaml`      | GitHub Action definition |
| `tsdown.config.ts` | Build configuration      |
| `eslint.config.ts` | Lint rules               |
| `PRD.md`           | Product requirements     |
| `FEATURES.md`      | Feature specifications   |
| `AGENTS.md`        | Project conventions      |

### Session Tools (Required Usage)

```typescript
// On startup - search for prior work
await session_search(query)
await session_read(sessionId)

// On completion - record for future
await session_info(sessionId)
await session_list()
```

### GitHub CLI Authentication

The agent uses `gh` CLI for all GitHub operations. Authentication is configured via environment variables:

```typescript
// GH_TOKEN takes priority over GITHUB_TOKEN for gh CLI
// Set by setup action from GitHub App token or fallback
core.exportVariable("GH_TOKEN", appToken ?? githubToken)
```

**Credential Priority:**

1. GitHub App installation token (recommended for elevated operations)
2. `GITHUB_TOKEN` (default, limited permissions)

**Common gh CLI Patterns:**

```bash
# Commenting
gh issue comment 123 --body "message"
gh pr comment 456 --body "message"

# Creating PRs
gh pr create --title "feat: add feature" --body "Description" --base main --head feature-branch

# API calls
gh api repos/{owner}/{repo}/issues --jq '.[].title'
gh api /user --jq '.login'

# Authentication check
gh auth status
```

**Git Identity for Commits:**

```bash
# Configured by setup action with App bot identity
git config --global user.name "fro-bot[bot]"
git config --global user.email "<user-id>+fro-bot[bot]@users.noreply.github.com"
```

### Setup Action Usage

```yaml
- name: Setup Fro Bot Agent
  uses: fro-bot/agent/setup@v0
  with:
    auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
    app-id: ${{ secrets.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
    opencode-version: "latest" # optional

- name: Run Fro Bot Agent
  uses: fro-bot/agent@v0
  with:
    prompt: "Respond to the issue comment"
```

---

_This document establishes development standards. Violations should be caught in code review._
