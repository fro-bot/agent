---
type: convention
last-updated: "2026-04-26"
updated-by: "ca17d5e"
sources:
  - AGENTS.md
  - packages/runtime/src/shared/logger.ts
  - packages/runtime/src/shared/types.ts
  - src/shared/logger.ts
  - src/shared/types.ts
  - src/services/github/context.ts
  - src/services/github/types.ts
  - src/features/triggers/router.ts
  - src/features/agent/execution-adapter.ts
summary: "Coding conventions, architectural patterns, and anti-patterns enforced across the project"
---

# Conventions and Patterns

This page documents the recurring patterns and conventions in the Fro Bot Agent codebase. These conventions apply uniformly across both the action (`src/`) and the runtime package (`packages/runtime/`). Understanding them is essential for contributors — the project enforces them strictly, and deviations will fail CI.

## Language and Module System

**TypeScript, ESM-only.** The project targets Node 24 with `"type": "module"` in `package.json`. All relative imports must include `.js` extensions:

```typescript
import {createLogger} from "../shared/logger" // build fails
import {createLogger} from "../shared/logger.js" // correct
```

This is the single most common mistake contributors make. The `.js` extension matches Node's ESM resolution algorithm — TypeScript compiles `.ts` to `.js`, so imports reference the output extension.

## Functions Only

The entire codebase uses plain functions — no ES6 classes anywhere. Stateful patterns use closures. This was a deliberate architectural decision to keep the code simple and to avoid the complexity that class hierarchies introduce in a project of this size.

## Logger Injection

Every function that produces output takes a `Logger` parameter rather than importing a global logger. The logger (available in both `packages/runtime/src/shared/logger.ts` and `src/shared/logger.ts`) outputs JSON-structured messages with automatic credential redaction — any string matching known secret patterns is replaced before output.

```typescript
export function restoreCache(options: CacheOptions, logger: Logger): Promise<CacheResult>
```

This injection pattern makes testing straightforward: tests pass a mock logger and can assert on log output without touching global state.

## Strict Boolean Expressions

The project forbids implicit falsy checks via ESLint's `strict-boolean-expressions` rule:

```text
if (value != null) { ... }     // correct
if (array.length > 0) { ... }  // correct
if (!value) { ... }            // lint error (unless value is boolean)
```

The `!` operator is only allowed on actual `boolean` types. This eliminates an entire class of bugs where `0`, `''`, or `null` are accidentally treated as equivalent.

## Result Types

Recoverable errors use `Result<T, E>` from `@bfra.me/es` rather than exceptions. This makes error handling explicit at the type level — callers must check the result before accessing the value.

Exceptions are reserved for truly unexpected failures (programmer errors, system failures). SDK operations in the session module take this further: they return empty arrays or `null` on failure, never throwing.

## NormalizedEvent

Raw GitHub webhook payloads are never accessed directly anywhere in the codebase. Every payload passes through `normalizeEvent()` in `src/services/github/context.ts`, which produces a `NormalizedEvent` — a discriminated union with eight variants:

| Variant                                   | Discriminator                         |
| ----------------------------------------- | ------------------------------------- |
| `NormalizedIssueCommentEvent`             | `type: 'issue_comment'`               |
| `NormalizedDiscussionCommentEvent`        | `type: 'discussion_comment'`          |
| `NormalizedIssuesEvent`                   | `type: 'issues'`                      |
| `NormalizedPullRequestEvent`              | `type: 'pull_request'`                |
| `NormalizedPullRequestReviewCommentEvent` | `type: 'pull_request_review_comment'` |
| `NormalizedWorkflowDispatchEvent`         | `type: 'workflow_dispatch'`           |
| `NormalizedScheduleEvent`                 | `type: 'schedule'`                    |
| `NormalizedUnsupportedEvent`              | `type: 'unsupported'`                 |

Downstream code narrows via `event.type` before accessing variant-specific fields. All fields are `readonly`. This pattern provides type safety across the entire event-handling pipeline and makes it impossible to accidentally read a field that doesn't exist for the current event type.

## Adapter Pattern

External I/O operations are wrapped in adapter interfaces: `CacheAdapter` (for `@actions/cache`), `ExecAdapter` (for `@actions/exec`), `ToolCacheAdapter` (for `@actions/tool-cache`). Production code creates real implementations via factory functions (`createExecAdapter`, `createToolCacheAdapter`). Tests substitute fakes.

This pattern means the setup, cache, and execution modules can be tested without actually downloading binaries, caching files, or calling GitHub APIs.

## Readonly Interfaces

All interface properties use `readonly`. This is enforced project-wide and prevents accidental mutation of shared state. Combined with the functional style (no classes, no mutable instance state), this makes data flow through the system predictable.

## Testing Conventions

The project uses Vitest (not Jest) with colocated `.test.ts` files. Tests follow TDD: write the failing test first, implement the minimum code to pass, then refactor.

Test files use BDD-style comments to structure assertions:

```typescript
// #given — a cache miss
// #when — restoreCache is called
// #then — returns hit: false
```

External dependencies (`@actions/core`, `@actions/github`, `@opencode-ai/sdk`) are mocked with `vi.mock()`. Internal modules are not mocked — tests exercise real code paths through the layer below.

## Naming

- **Files**: kebab-case (`cache-manager.ts`)
- **Functions/variables**: camelCase
- **Types/interfaces**: PascalCase
- **Constants**: `SCREAMING_SNAKE` for true constants, `camelCase` for configuration defaults

## Commit Messages

The project uses conventional commits: `type(scope): description`. Types include `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`. The scope indicates the module or area affected.

## Anti-Patterns

The following are explicitly forbidden:

- **Type suppression** — `as any`, `@ts-ignore`, `@ts-expect-error` are never used.
- **Raw event access** — Always use `NormalizedEvent`; never read `context.payload`.
- **Global context** — Never use `github.context` directly; always go through `parseGitHubContext()`.
- **Console.log** — Use the injected logger with redaction.
- **Force push** — Always `force: false` on ref updates.
- **Blocking on UX** — Reactions and labels are secondary; API failures for them must not halt execution.
- **Multiple comments** — The response protocol requires exactly one comment or review per invocation.
- **Classes** — Functions only, project-wide.

## Response Protocol

Every agent run must post exactly one comment or review (never both, never multiple). The response must include a run summary block with the `<!-- fro-bot-agent -->` marker. This is enforced at the [[Prompt Architecture]] level — the prompt instructs the agent to self-enforce it, rather than code-level validation after the fact.
