# AGENTS.md

Agent-operational knowledge base for fro-bot/agent. For human-facing system design and layout, see the living docs:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, invariants, the three data flows, cross-cutting concerns, full code map.
- **[STRUCTURE.md](STRUCTURE.md)** — directory layout, directory purposes, key file locations, where to add new code.

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) agents with **persistent session state** across CI runs (cache-writable triggers, or any trigger with `s3-backup`; see NOTES). Includes bundled `@fro.bot/systematic` plugin injection during setup. A Bun monorepo (TypeScript, ESM-only, Node 24): the Action lives in the layered root `src/`, with `@fro-bot/gateway` (Discord daemon + operator surface), `@fro.bot/harness` (patched-OpenCode build/publish), and `@fro-bot/runtime` (shared primitives) alongside.

## WHERE TO LOOK

Highest-traffic entry points — see [STRUCTURE.md](STRUCTURE.md) for the full directory layout and where-to-add-code map, and [ARCHITECTURE.md](ARCHITECTURE.md) for the complete code map.

| Task                     | Location                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Action orchestration     | `src/harness/run.ts` (`run`)                                                         |
| Agent execution (V2)     | `src/features/agent/execution-v2.ts` (`executeOpenCodeV2`)                           |
| Event routing            | `src/features/triggers/router.ts` (`routeEvent`)                                     |
| Event parsing / types    | `src/services/github/context.ts`, `src/services/github/types.ts` (`NormalizedEvent`) |
| Prompt building          | `packages/runtime/src/agent/prompt.ts` (`buildAgentPrompt`)                          |
| Setup / CI config        | `src/services/setup/` (`runSetup`, `buildCIConfig`)                                  |
| Comment / review posting | `src/features/comments/writer.ts`, `src/features/reviews/reviewer.ts`                |
| Gateway mention loop     | `packages/gateway/src/execute/run.ts` (`runMention`)                                 |
| Version pins             | `packages/runtime/src/shared/constants.ts`                                           |

## CONVENTIONS

- **ESM-only**: `.js` extensions required in all relative imports
- **Functions only**: No ES6 classes; closures for stateful patterns
- **Logger injection**: Every function takes `logger` parameter
- **Result types**: `Result<T, E>` from `@bfra.me/es` for recoverable errors
- **Readonly interfaces**: All properties use `readonly` — except per-invocation mutable trackers threaded through the SSE event loop (`ActivityTrackerV2` in `src/features/agent/streaming-v2.ts`), where functional updates would allocate per token delta
- **Strict booleans**: No implicit falsy checks (`!value`); use explicit comparisons
- **Adapter pattern**: `CacheAdapter`, `ExecAdapter` for testable I/O
- **Prettier**: 120-char line width via `@bfra.me/prettier-config/120-proof`
- **Vitest**: Colocated `.test.ts` files; BDD comments (`// #given`, `// #when`, `// #then`)
- **Test isolation**: Every Vitest run gets a throwaway temp `HOME` + `XDG_*` (`scripts/vitest-home-isolation.setup.ts`, via root `vitest.config.ts` `setupFiles`); tests must never read or write the real home, and pass explicit env/dirs when asserting default-path resolution
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
bun run test                         # Run workspace package tests (vitest from repo root)
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
- **V2-only execution**: the Action runs only stock OpenCode V2, digest-pinned in `packages/runtime/src/shared/opencode-v2-pin.json`. A V1 `opencode-version` is rejected at input parsing (`parseOpenCodeVersion` in `src/harness/config/inputs.ts`); rollback is pinning the Action to the last pre-cut release (see the README's "Moving to OpenCode V2")
- **Bundled Systematic plugin**: Setup injects `@fro.bot/systematic@<version>` into CI OpenCode config by default
- **No `question` tool in CI**: nobody can answer in CI and a pending question blocks until the deadline (#1756), so the V2 permission rules (`buildPermissionRulesV2`) deny it; the gateway is unaffected
- **Persistent memory**: Sessions survive across CI runs via Actions cache when the trigger permits cache writes; mention-driven `issue_comment` and `issues` runs require `s3-backup` for continuity
- **Documented solutions**: `docs/solutions/` holds solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`) — searchable when implementing or debugging in a documented area. `module` must use the closed taxonomy enforced by `scripts/module-taxonomy.test.ts`; update that exported list deliberately when a new subsystem is established
- **Pre-push hook**: Rebuilds the Action bundle and fails if the committed `dist/` differs. Lint and the other package builds run at commit (`lint-staged`) and in CI
- **Release-notes narration (two-phase)**: After a release publishes, a `@semantic-release/exec` `successCmd` (`scripts/release/dispatch-release-notes.ts`) dispatches `fro-bot.yaml` on `main` with a `release-tag` input. **Generate phase** (read-only by construction): the agent runs with the workflow's `GITHUB_TOKEN` instead of `FRO_BOT_PAT`, gathers bounded PR evidence (`gh pr view`/`gh pr diff`), and writes a narrative candidate to `release-notes-candidate.md` — it cannot mutate any GitHub state. **Apply phase** (trusted): a separate `apply-release-notes` job on a fresh runner downloads the candidate artifact, deterministically validates and assembles the final body (`scripts/release/assemble-release-notes.ts` — marker + narrative + verbatim changelog in a collapsed block), and performs the single `gh release edit` with `FRO_BOT_PAT`. The model is operator-configurable via the `RELEASE_NOTES_MODEL` repository variable (must be a cliproxy-served id); narration is skipped with a warning if the variable is unset. Gather bounds: only exceeding the 25-candidate-PR limit stops narration; PR-body, per-PR file-list (50 paths), and diff bounds truncate evidence and narration proceeds. The generate job exposes a `candidate-exists` output; when it is not `'true'` the apply job emits one `::notice::` and skips the download/assemble steps instead of logging an artifact-not-found error. Dispatch auth is `FRO_BOT_PAT` (`RELEASE_NOTES_DISPATCH_TOKEN`). Idempotency is apply-side (marker `<!-- fro-bot-narration-v1 -->` present → skip) and the whole flow is fail-soft: missing/invalid candidates and quality failures warn and never block the release; auth anomalies hard-fail.

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

Read-only dependency source repositories are available under `.slim/clonedeps/repos/` for inspection. Do not edit these clones.

The clone is pinned to the OpenCode V2 version in `packages/runtime/src/shared/opencode-v2-pin.json`, so what you read is what the Action runs. Re-pin it when that pin moves (`git fetch --depth 1 origin tag v<version> && git checkout v<version>` in the clone, then update `.slim/clonedeps.json`) — a source check against a stale clone can be confidently wrong. V2 has a different layout from V1: there is no `packages/opencode/`. The V1 source behind `packages/harness/harness.config.json`'s `base_version` is the same repository at its `v1.x` tag.

- `.slim/clonedeps/repos/anomalyco__opencode/packages/core/` — `anomalyco/opencode` at `v2.3.2`; the session engine. Read `src/session/{prompt,execution,inbox,run-coordinator,subagent-job}.ts` and `src/session/runner/` for how a turn runs and which `session.*` events it publishes, `src/plugin/` for how plugins load and which hooks they get, and `src/{model,model-resolver,provider}.ts` and `src/config/` for model and provider resolution.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/server/` — the HTTP server: `src/routes.ts`, `src/handlers/` and `src/event-feed.ts` for the routes and the event stream the Action consumes.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/plugin/` and `packages/sdk/` — the plugin API (`@opencode/plugin`) and the SDK.
