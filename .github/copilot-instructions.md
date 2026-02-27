# Copilot Instructions

## Before You Start

Read these files before implementing anything:

- **AGENTS.md** — Code map, execution flow, complexity hotspots, and project commands
- **RULES.md** — Focus on these sections:
  - _Code Style & Conventions_ (module system, booleans, function style)
  - _Architecture Patterns_ (adapters, dependency injection, NormalizedEvent)
  - _SDK Execution Patterns_ (server lifecycle, sessions, events)
  - _Security Requirements_ (credential handling, log redaction, authorization)
  - _Testing Standards_ (TDD workflow, SDK mocking, BDD comments)
  - _Anti-Patterns (Forbidden)_ (comprehensive list of what NOT to do)
- **RFCs/** — Check relevant RFCs for feature-specific architecture decisions
- **PRD.md / FEATURES.md** — Check for requirements on new features

Documentation hierarchy: PRD > RFCs > FEATURES.md > RULES.md > AGENTS.md

## Critical Patterns (AI Failure Modes)

These patterns differ from common AI training data. Get them wrong and the build breaks.

### 1. ESM imports MUST use `.js` extensions

```typescript
// ✅ CORRECT
import {createLogger} from "../lib/logger.js"
import {restoreCache} from "./cache.js"

// ❌ WRONG — build fails without extension
import {createLogger} from "../lib/logger"
import {restoreCache} from "./cache"
```

### 2. Strict boolean expressions — no implicit falsy checks

```typescript
// ✅ CORRECT
if (value != null) { ... }
if (array.length > 0) { ... }
if (str !== '') { ... }

// ❌ WRONG — violates strict-boolean-expressions
if (!value) { ... }
if (array.length) { ... }
if (str) { ... }
```

`!` is ONLY allowed for actual `boolean` types.

### 3. Functions only — no ES6 classes

```typescript
// ✅ CORRECT
export async function restoreCache(options: CacheOptions, logger: Logger): Promise<CacheResult> {
  // ...
}

// ❌ WRONG — classes are forbidden
class CacheManager {
  constructor(private options: CacheOptions) {}
  async restore(): Promise<CacheResult> { ... }
}
```

### 4. Vitest, not Jest

```typescript
// ✅ CORRECT
import {describe, expect, it, vi} from "vitest"
vi.mock("@actions/core", () => ({getInput: vi.fn()}))

// ❌ WRONG
import {jest} from "@jest/globals"
jest.mock("@actions/core")
```

### 5. Logger injection in every function

```typescript
// ✅ CORRECT — logger as parameter
export function parseInputs(raw: Record<string, string>, logger: Logger): Result<ActionInputs> {
  logger.info("Parsing action inputs")
  // ...
}

// ❌ WRONG — no logger parameter
export function parseInputs(raw: Record<string, string>): Result<ActionInputs> {
  console.log("Parsing action inputs")
  // ...
}
```

## Core Conventions

- **ESM-only**: `"type": "module"`, `.js` extensions in all relative imports
- **No type suppression**: Never use `as any`, `@ts-ignore`, `@ts-expect-error`
- **Result types**: Use `Result<T, E>` from `@bfra.me/es` for recoverable errors
- **Readonly interfaces**: All interface properties use `readonly`
- **Discriminated unions** over optional properties
- **`as const`** for fixed value arrays; infer union types from them
- **Dependency injection**: Dependencies as function parameters, not global imports
- **Adapter pattern**: `CacheAdapter`, `ExecAdapter`, `ToolCacheAdapter` for testable I/O

## Testing (TDD — Mandatory)

- RED → GREEN → REFACTOR; write the failing test first, always
- Test files: colocated `*.test.ts` alongside source
- BDD comments: `// #given`, `// #when`, `// #then`
- `vi.mock()` only for external deps (`@actions/core`, `@actions/github`, `@opencode-ai/sdk`)
- Never delete a failing test — fix the code instead

## Build & Verification

```bash
pnpm test          # All tests must pass
pnpm lint          # No lint errors
pnpm build         # Bundle to dist/ (includes type-check); dist/ is committed
```

- Never manually edit `dist/`; it is always overwritten by build
- CI validates `dist/` is in sync — always run `pnpm build` after source changes

## Security

- Never log or commit secrets; never cache `auth.json`, `.env`, `*.key`, `*.pem`
- Authorization gating: only `OWNER`, `MEMBER`, `COLLABORATOR`; bots and forks blocked
- Post-action hook (`post.ts`): must never call `core.setFailed()` — best-effort only

## Naming

- Files: kebab-case (`cache-manager.ts`)
- Functions/variables: camelCase
- Types/interfaces: PascalCase
- Constants: SCREAMING_SNAKE or camelCase

## Architecture

- NormalizedEvent layer: always use `normalizeEvent()` before routing; never check raw event strings
- Event routing lives in `triggers/router.ts`; never bypass it
- SDK: Use `createOpencode({ port, timeout })` for server + client lifecycle
- Always `server.close()` in a `finally` block — never leak the server

## Commit Format

- `type(scope): description` (e.g., `feat(setup): add --skip-auth flag`)
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`

## Output

- Produce PR-ready changes
- Update tests and `README.md` when inputs or public behavior changes
- Keep changes minimal and reversible; minimize blast radius
