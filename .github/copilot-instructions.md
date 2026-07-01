# Copilot Instructions

## Before You Start

Read these files before implementing anything:

- **AGENTS.md** — Conventions, anti-patterns, commands, and a where-to-look pointer index
- **ARCHITECTURE.md** — System design, invariants, the three data flows, SDK execution patterns, cross-cutting concerns (credential handling, log redaction, authorization)
- **STRUCTURE.md** — Directory layout, key file locations, where to add new code
- **CONTRIBUTING.md** — Setup, command surface, testing standards, commit conventions
- **RFCs/** — Check relevant RFCs for feature-specific architecture decisions
- **docs/product/PRD.md / docs/product/FEATURES.md** — Historical product requirements (archived; check for background only)

Documentation hierarchy: PRD > RFCs > ARCHITECTURE.md / STRUCTURE.md > AGENTS.md

## Critical Patterns (AI Failure Modes)

These patterns differ from common AI training data. Get them wrong and the build breaks.

### 1. ESM imports MUST use `.js` extensions

```typescript
// ✅ CORRECT
import {createLogger} from "../shared/logger.js"
import {restoreCache} from "../services/cache/restore.js"
import {restoreCache} from "./cache.js"

// ❌ WRONG — build fails without extension
import {createLogger} from "../shared/logger"
import {restoreCache} from "../services/cache/restore"
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
bun run test          # All tests must pass
bun run lint          # No lint errors
bun run build         # Bundle to dist/ (includes type-check); dist/ is committed
```

- Never manually edit `dist/`; it is always overwritten by build
- CI validates `dist/` is in sync — always run `bun run build` after source changes

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
- Event routing lives in `src/features/triggers/router.ts`; never bypass it
- SDK: Use `createOpencode({ port, timeout })` for server + client lifecycle
- Always `server.close()` in a `finally` block — never leak the server

## Commit Format

- `type(scope): description` (e.g., `feat(setup): add --skip-auth flag`)
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`

## Output

- Produce PR-ready changes
- Update tests and `README.md` when inputs or public behavior changes
- Keep changes minimal and reversible; minimize blast radius
