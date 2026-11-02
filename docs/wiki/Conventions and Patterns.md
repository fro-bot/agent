---
type: convention
last-updated: "2026-11-01"
updated-by: "9a429e2a6ddc692bd6098b5504c225830af85bf9"
sources:
  - packages/runtime/src/session/generation.ts
  - packages/runtime/src/agent/event-v2.ts
  - packages/runtime/src/agent/directory-quiescence-v2.ts
  - src/harness/phases/execution-backend.ts
  - src/features/agent/prompt-sender-v2.ts
  - AGENTS.md
  - src/harness/outcome.ts
  - src/features/agent/streaming.ts
  - packages/runtime/src/agent/ownership-ledger.ts
  - packages/runtime/src/agent/server.ts
  - src/shared/cache-save-result.ts
  - src/services/cache/checkpoint.ts
  - scripts/module-taxonomy.test.ts
  - scripts/harness-tag-derivation.test.ts
  - packages/runtime/src/shared/logger.ts
  - packages/runtime/src/shared/errors.ts
  - packages/runtime/src/coordination/entity-ref.ts
  - packages/runtime/src/repo/slug.ts
  - packages/gateway/src/execute/runtime-logger.ts
  - packages/runtime/src/shared/types.ts
  - src/shared/logger.ts
  - src/shared/types.ts
  - src/services/github/context.ts
  - src/services/github/types.ts
  - src/features/triggers/router.ts
  - vitest.config.ts
  - scripts/vitest-config-wiring.test.ts
  - scripts/vitest-home-isolation.ts
  - scripts/vitest-home-isolation.setup.ts
  - scripts/vitest-incomplete-run-reporter.ts
summary: "Coding conventions, architectural patterns, and anti-patterns enforced across the project"
---

# Conventions and Patterns

This page documents the recurring patterns and conventions in the Fro Bot Agent codebase. These conventions apply uniformly across both the action (`src/`) and the runtime package (`packages/runtime/`). Understanding them is essential for contributors — the project enforces them strictly, and deviations will fail CI.

The prescriptive, operational version of these rules lives in the repository's own documentation set, which has settled into a clear hierarchy: `AGENTS.md` is now a slim operational page (conventions, anti-patterns, and a where-to-look pointer index), while the structural and process detail it once carried moved into dedicated siblings — `ARCHITECTURE.md` (system design and data flows), `STRUCTURE.md` (directory layout), and `CONTRIBUTING.md` (setup and command surface). This wiki is the _descriptive_ counterpart: it explains why the conventions exist and how the system behaves, rather than restating the rules an agent must follow.

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

Error rendering has a shared boundary too. `toErrorMessage` in `packages/runtime/src/shared/errors.ts` safely describes caught values, returning `[unprintable error]` if coercion itself fails. `formatSdkError` handles SDK response envelopes separately: it prefers their nested message, then message/name/type fields, and finally JSON, with a 500-character ceiling. These are diagnostic helpers, not classifiers or sanitizers; structured evidence and the injected logger's redaction still carry those responsibilities.

Small compatibility adapters remain beside their consumers. For example, `packages/gateway/src/execute/runtime-logger.ts` bridges gateway logging to runtime callbacks, while repository parsing and entity-reference interpretation live in shared runtime modules. This keeps transport-specific adaptation local without multiplying definitions of the same data contract.

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

## Named Outcomes Over Booleans

A related habit runs through the operations-facing parts of the codebase: when an operation can end several materially different ways, it returns a named terminal condition rather than a boolean. `CheckpointOutcome` in `src/services/cache/checkpoint.ts` and `CacheSaveResult` in `src/shared/cache-save-result.ts` are the reference examples.

The motivation is consistent. A boolean forces "deliberately skipped", "denied by the platform", and "succeeded" onto two poles, which destroys the distinction exactly where an operator most needs it — in a job summary or an action output, after the fact, with no way to re-observe the run. The replacement typically pairs one or more structural axes with a named outcome: `CacheSaveResult` carries `cachePersisted` and `storePersisted` as independent facts, plus an `outcome` naming the condition that produced them.

Two supporting practices travel with the pattern. Mappings from an outcome union to some other representation are pinned with `satisfies Record<Outcome, ...>`, so adding a new outcome without handling it fails `check-types` rather than silently mapping to nothing. And where a value crosses a process boundary and is read back as a string — the action-state handoff between the main step and the post hook — parsing is defensive in a stated direction: an absent or unrecognized value maps to the outcome that causes the work to be retried, never the one that causes it to be skipped, because the reader is the last chance to do the work.

Comments in these modules also distinguish inference from observation. `cache-save-result.ts` states explicitly that `cache-rejected` covers several causes because the API boundary cannot tell them apart, not because one was determined over the others — and warns against inferring the cause from surrounding signals. Documenting the limits of what a value proves is treated as part of defining it.

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

Generation-specific adapters now keep V1 and V2 protocol differences explicit. The shared generation selector interprets versions once, and the Action's execution backend keeps prompt submission, overflow recovery, archiving, and search on the same generation. V2's event adapter translates its native envelope into the activity and ownership vocabulary rather than leaking raw transport shapes throughout the harness.

This follows the same evidence discipline as named outcomes: a lost V2 prompt acknowledgment means uncertain admission, not permission to retry blindly, and an unreadable directory observation means unknown activity, not quiet. Completion uses consecutive bounded observations instead of equating a successful interrupt response with a stopped writer. [[Background Subagents and Ownership]] describes the release gate.

External I/O operations are wrapped in adapter interfaces: `CacheAdapter` (for `@actions/cache`), `ExecAdapter` (for `@actions/exec`), `ToolCacheAdapter` (for `@actions/tool-cache`). Production code creates real implementations via factory functions (`createExecAdapter`, `createToolCacheAdapter`). Tests substitute fakes.

This pattern means the setup, cache, and execution modules can be tested without actually downloading binaries, caching files, or calling GitHub APIs.

## Readonly Interfaces

All interface properties use `readonly`. This is enforced project-wide and prevents accidental mutation of shared state. Combined with the functional style (no classes, no mutable instance state), this makes data flow through the system predictable.

The rule carries one named exception, and naming it explicitly is the point — a silent exception invites a second one. Per-invocation mutable trackers threaded through the SSE event loop (the activity tracker and its root-freshness tracker in `src/features/agent/streaming.ts`) hold mutable fields, because a functional update would allocate a fresh object on every token delta. The exception is bounded by scope rather than convention: these objects live for one invocation, never escape the event loop, and are never shared across runs. Anything outside that scope stays `readonly`.

## Veto, Not Certificate

A recurring distinction in the harness's safety logic is worth stating on its own, because it shapes several unrelated gates: a known defect may _veto_ an action, but the absence of that defect does not _certify_ the action is safe. The invocation-outcome assessment gates reversible certificates (the dedup marker, the success reaction) on the full verification picture, while irreversible ones (a brokered push, a formal review approval) are gated on a narrower "known execution veto" — an observation gap or unresolved background ownership. Reading a passing veto check as proof of correctness is precisely the inversion the comments in those modules guard against. The related habit shows up in the ownership ledger, where an `unknown` state is never collapsed into `settled`: not knowing is a reason to keep waiting, not a reason to proceed. See [[Background Subagents and Ownership]].

## Defaulting on Unset or Empty

Environment-driven defaults in this project check for **unset or empty**, never presence alone, and let an explicit operator value win in either direction. The reason is specific to the deployment surface: GitHub Actions materializes an unset `env:` input as an empty string rather than an absent key, so a presence-only check sees a variable that "exists" and skips its own default, while the downstream consumer's boolean parsing does not read an empty string as true. The result is a default that silently never applies. The convention was established for the OpenCode file-watcher flag and reused verbatim for background subagents (see [[Setup and Configuration]]).

## Testing Conventions

The project uses Vitest (not Jest) with colocated `.test.ts` files. Tests follow TDD: write the failing test first, implement the minimum code to pass, then refactor.

Test files use BDD-style comments to structure assertions:

```typescript
// #given — a cache miss
// #when — restoreCache is called
// #then — returns hit: false
```

External dependencies (`@actions/core`, `@actions/github`, `@opencode-ai/sdk`) are mocked with `vi.mock()`. Internal modules are not mocked — tests exercise real code paths through the layer below.

The root `vitest.config.ts` supplies a setup file before each test file imports application modules. `scripts/vitest-home-isolation.ts` redirects HOME and the XDG config, data, state, and cache paths into a disposable temporary tree, so tests that exercise default path resolution do not touch a developer's OpenCode history or credentials. It verifies that `os.homedir()` follows the override and fails rather than running unisolated; live evals (`FRO_BOT_EVAL=1`) opt out because their runner manages its own sandbox and needs real provider authentication.

Vitest 5 no longer searches parent directories for configuration. Workspace package test commands therefore name `../../vitest.config.ts` explicitly, and the Action suite sets its root to the repository. The workspace-test image copies that shared configuration and its imported scripts as well. `scripts/vitest-config-wiring.test.ts` checks these entry points so a package-local run cannot silently lose home isolation or incomplete-run detection after a toolchain update.

The same shared configuration installs an incomplete-run reporter (`scripts/vitest-incomplete-run-reporter.ts`). A worker crash can leave discovered tests with no result even when the completed tests passed. The reporter makes that missing coverage fail the run rather than allowing a partial result to appear green.

One directory sits outside this convention. `deploy/scripts/` is plain Node ESM (`.mjs`) tested with the built-in `node --test` runner: it is not a workspace package, has no build step, and is exercised in CI by a dedicated smoke job. The split is deliberate — deployment scripts run on hosts where the monorepo's toolchain may not exist, so they are kept dependency-free rather than folded into Vitest.

### Drift Guards

A second, less common pattern appears where one fact is necessarily produced in more than one place — for example the harness release-tag shape, which is derived independently by the release workflow, the npm version builder, and the setup module (see [[Setup and Configuration]]). Rather than accept that these will silently diverge, the suite carries **drift guards**: tests that read the repository's own source text and fail by name when one producer is changed without the others.

The guards exist because the obvious alternative failed in practice. A mirrored copy of the harness-version predicate, added under a comment claiming it matched production, kept passing after production changed — it was asserting against its own copy, not the module. That is the failure mode drift guards are built to prevent, and it is why they are written to fail in a specific, nameable direction rather than to merely pattern-match a line. Their known limitations (for instance, the shared comment-stripper does not parse regex literals) are documented at the guard, and are chosen so that a parse failure produces a _weaker_ guard rather than a false pass on missing code.

## Documented Solutions

Solved problems are written up under `docs/solutions/`, organized by category, each carrying YAML frontmatter with `module`, `tags`, and `problem_type`. The `module` field is not free text: it draws from a closed taxonomy enforced by a test (`scripts/module-taxonomy.test.ts`). Closing the set was a deliberate trade — it costs a small explicit step when a genuinely new subsystem appears, and in exchange it keeps retrieval reliable, since near-synonym modules would otherwise accumulate and quietly split a topic's documents across several labels.

## Naming

- **Files**: kebab-case (`cache-manager.ts`)
- **Functions/variables**: camelCase
- **Types/interfaces**: PascalCase
- **Constants**: `SCREAMING_SNAKE` for true constants, `camelCase` for configuration defaults

## Commit Messages

The project uses conventional commits: `type(scope): description`. Types include `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`. The scope indicates the module or area affected.

## Boundary-Preserving Patterns

The conventions above preserve a few recurring boundaries: typed normalization separates external webhook payloads from business logic, injected loggers keep credential redaction on the output path, and non-force ref updates avoid replacing another writer's work. Type suppressions and hidden global context would weaken the evidence these boundaries provide, which explains their absence from the project's normal implementation style.

User-facing acknowledgment is deliberately secondary to execution. Reactions and labels can fail without stopping the agent, whereas response delivery has its own explicit success contract. The operational rules are maintained in `AGENTS.md`; these patterns explain the architectural reasons behind them.

## Response Protocol

Every agent run must post exactly one comment or review (never both, never multiple). The response must include a run summary block with the `<!-- fro-bot-agent -->` marker. This is enforced at the [[Prompt Architecture]] level — the prompt instructs the agent to self-enforce it, rather than code-level validation after the fact.

When these invariants appear to break in practice — a run posts nothing, cache state fails to persist, or a run times out — the symptoms and their usual causes are cataloged in the [[Troubleshooting]] guide.
