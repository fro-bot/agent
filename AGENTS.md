# AGENTS.md

Agent-operational knowledge base for fro-bot/agent. For human-facing system design and layout, see the living docs:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, invariants, the three data flows, cross-cutting concerns, full code map.
- **[STRUCTURE.md](STRUCTURE.md)** — directory layout, directory purposes, key file locations, where to add new code.

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) + [oMo](https://github.com/code-yeongyu/oh-my-openagent) agents with **persistent session state** across CI runs. Includes bundled `@fro.bot/systematic` plugin injection during setup. A Bun monorepo (TypeScript, ESM-only, Node 24): the Action lives in the layered root `src/`, with `@fro-bot/gateway` (Discord daemon + operator surface), `@fro.bot/harness` (patched-OpenCode build/publish), and `@fro-bot/runtime` (shared primitives) alongside.

## WHERE TO LOOK

Highest-traffic entry points — see [STRUCTURE.md](STRUCTURE.md) for the full directory layout and where-to-add-code map, and [ARCHITECTURE.md](ARCHITECTURE.md) for the complete code map.

| Task | Location |
| --- | --- |
| Action orchestration | `src/harness/run.ts` (`run`) |
| Agent SDK execution | `src/features/agent/execution.ts` (`executeOpenCode`) |
| Event routing | `src/features/triggers/router.ts` (`routeEvent`) |
| Event parsing / types | `src/services/github/context.ts`, `src/services/github/types.ts` (`NormalizedEvent`) |
| Prompt building | `packages/runtime/src/agent/prompt.ts` (`buildAgentPrompt`) |
| Setup / CI config | `src/services/setup/` (`runSetup`, `buildCIConfig`) |
| Comment / review posting | `src/features/comments/writer.ts`, `src/features/reviews/reviewer.ts` |
| Gateway mention loop | `packages/gateway/src/execute/run.ts` (`runMention`) |
| Version pins | `packages/runtime/src/shared/constants.ts` |

## CONVENTIONS

- **ESM-only**: `.js` extensions required in all relative imports
- **Functions only**: No ES6 classes; closures for stateful patterns
- **Logger injection**: Every function takes `logger` parameter
- **Result types**: `Result<T, E>` from `@bfra.me/es` for recoverable errors
- **Readonly interfaces**: All properties use `readonly`
- **Strict booleans**: No implicit falsy checks (`!value`); use explicit comparisons
- **Adapter pattern**: `CacheAdapter`, `ExecAdapter` for testable I/O
- **Prettier**: 120-char line width via `@bfra.me/prettier-config/120-proof`
- **Vitest**: Colocated `.test.ts` files; BDD comments (`// #given`, `// #when`, `// #then`)
- **Exception**: `deploy/scripts/` uses plain Node ESM (`.mjs`) with the built-in `node --test` runner — not Vitest, not a workspace package, no build step; run in CI via the `workspace-smoke` job

## ANTI-PATTERNS (THIS PROJECT)

- **Type suppression**: Never use `as any`, `@ts-ignore`, `@ts-expect-error`
- **Raw event access**: Always use `NormalizedEvent`; never read `context.payload`
- **Global context**: Never use `github.context` directly; use `parseGitHubContext()`
- **Classes**: Functions only; project-wide functional pattern
- **Console.log**: Use injected logger with redaction
- **Force push**: Always `force: false` on ref updates
- **Blocking on UX**: Reactions are secondary; API failures must not halt execution
- **Multiple comments**: Response Protocol: exactly ONE comment/review per invocation

## COMMANDS

```bash
bun install                          # Install dependencies
bun run test                         # Run workspace + scripts/ tests (vitest from repo root)
bun run test:scripts                 # Run only scripts/ tests
bun run lint                         # ESLint check (also checks the committed dist/ for hidden Unicode)
bun run fix                          # ESLint auto-fix
bun run check-types                  # TypeScript type check (tsc --noEmit)
bun run build                        # Type check + bundle to dist/ (also scrubs dist/ hidden Unicode)
bun run dist:escape-hidden-unicode   # Scrub hidden Unicode from dist/ (run by build)
bun run dist:check-hidden-unicode    # Verify dist/ has no raw hidden Unicode (lint checks committed dist/; the CI Build job checks freshly built dist/)
```

## NOTES

For architecture (the four-layer rule, committed `dist/`, NormalizedEvent, dual entry points, XML-tagged prompt) see [ARCHITECTURE.md](ARCHITECTURE.md). Operational notes:

- **Node 24 required**: Matches `action.yaml` runtime
- **19 RFCs total**: Foundation, cache, GitHub client, sessions, triggers, security, observability, comments, PR review, delegated work, setup, execution, SDK mode, file attachments, GraphQL context, additional triggers, post-action hook, agent-invokable delegated work, S3 backend
- **SDK-based execution**: Uses `@opencode-ai/sdk` for server lifecycle + event streaming
- **Bundled Systematic plugin**: Setup injects `@fro.bot/systematic@<version>` into CI OpenCode config by default
- **Persistent memory**: Sessions survive across CI runs via GitHub Actions cache
- **Documented solutions**: `docs/solutions/` holds solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`) — searchable when implementing or debugging in a documented area
- **Pre-push hook**: Runs lint + build (the lint step includes the dist hidden-Unicode check)
- **Release-notes narration (two-phase)**: After a release publishes, a `@semantic-release/exec` `successCmd` (`scripts/release/dispatch-release-notes.ts`) dispatches `fro-bot.yaml` on `main` with a `release-tag` input. **Generate phase** (read-only by construction): the agent runs with the workflow's `GITHUB_TOKEN` instead of `FRO_BOT_PAT`, gathers bounded PR evidence (`gh pr view`/`gh pr diff`), and writes a narrative candidate to `release-notes-candidate.md` — it cannot mutate any GitHub state. **Apply phase** (trusted): a separate `apply-release-notes` job on a fresh runner downloads the candidate artifact, deterministically validates and assembles the final body (`scripts/release/assemble-release-notes.ts` — marker + narrative + verbatim changelog in a collapsed block), and performs the single `gh release edit` with `FRO_BOT_PAT`. The model is operator-configurable via the `RELEASE_NOTES_MODEL` repository variable (must be a cliproxy-served id); narration is skipped with a warning if the variable is unset. Dispatch auth is `FRO_BOT_PAT` (`RELEASE_NOTES_DISPATCH_TOKEN`). Idempotency is apply-side (marker `<!-- fro-bot-narration-v1 -->` present → skip) and the whole flow is fail-soft: missing/invalid candidates and quality failures warn and never block the release; auth anomalies hard-fail.

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

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/` — `anomalyco/opencode` at `v1.17.20`; OpenCode server source. Read `src/session/{prompt,message,message-v2,processor}.ts` to understand how `message.part.updated` bus events transition through the tool-part lifecycle (pending → running → completed) the Fro Bot harness consumes.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/` — `@opencode-ai/sdk` at `v1.17.20`; thin HTTP + SSE client over the server. Useful for confirming event shapes pass through unchanged and for verifying our `processEventStream` consumer matches the SSE subscription contract.
