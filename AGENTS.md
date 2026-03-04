# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-14
**Commit:** 34240c9
**Branch:** main

## OVERVIEW

GitHub Action harness for [OpenCode](https://opencode.ai/) + [oMo](https://github.com/code-yeongyu/oh-my-opencode) agents with **persistent session state** across CI runs. TypeScript, ESM-only, Node 24.

## STRUCTURE

```
./
15: ├── src/                  # TypeScript source (88 source files, 13k lines)
16: │   ├── main.ts           # Thin entry point → harness/run.ts
17: │   ├── post.ts           # Thin entry point → harness/run.ts
18: │   ├── index.ts          # Public API re-exports
19: │   ├── shared/           # Layer 0: Pure types, utils, constants (no external deps)
20: │   │   ├── types.ts      # Core interfaces (ActionInputs, TokenUsage, etc.)
21: │   │   ├── constants.ts  # Shared configuration constants
22: │   │   ├── logger.ts     # JSON logging with auto-redaction
23: │   │   ├── env.ts        # Environment variable readers
24: │   │   ├── errors.ts     # Error conversion utilities
25: │   │   ├── validation.ts # Input validation
26: │   │   ├── format.ts     # String formatting
27: │   │   ├── async.ts      # Async utilities (sleep)
28: │   │   ├── console.ts    # Console output helpers
29: │   │   └── paths.ts      # Path utilities
30: │   ├── services/         # Layer 1: External adapters (GitHub, cache, session, setup)
31: │   │   ├── github/       # Octokit client, context parsing, NormalizedEvent
32: │   │   ├── session/      # Persistence layer (search, prune, storage, writeback)
33: │   │   ├── setup/        # Bun, oMo, OpenCode installation
34: │   │   └── cache/        # Cache restore/save with corruption detection
35: │   ├── features/         # Layer 2: Business logic (agent, triggers, reviews, etc.)
36: │   │   ├── agent/        # SDK execution, prompts, reactions, streaming
37: │   │   ├── triggers/     # Event routing, skip conditions, context builders
38: │   │   ├── comments/     # GitHub comment read/write, error formatting
39: │   │   ├── context/      # GraphQL hydration for issues/PRs
40: │   │   ├── reviews/      # PR diff parsing, review comments
41: │   │   ├── attachments/  # File attachment processing
42: │   │   ├── delegated/    # Branch/commit/PR operations
43: │   │   └── observability/# Metrics collection, run summaries
44: │   └── harness/          # Layer 3: Workflow composition (entry points, phases)
45: │       ├── run.ts        # Main orchestration (delegates to phases)
46: │       ├── post.ts       # Post-action hook (durable cache save)
47: │       ├── config/       # Input parsing, outputs, state keys, omo-providers
48: │       └── phases/       # Bootstrap, routing, execute, finalize, cleanup, etc.
49: ├── dist/                 # Bundled output (COMMITTED, must stay in sync)
50: ├── RFCs/                 # 19 RFC documents (architecture specs)
51: ├── docs/plans/           # Architecture plans and design docs
52: ├── action.yaml           # GitHub Action definition (node24)
53: └── tsdown.config.ts      # esbuild bundler config (dual entry points)
```

## WHERE TO LOOK

| Task             | Location                      | Notes                                              |
| ---------------- | ----------------------------- | -------------------------------------------------- |
47: | Add action logic | `src/harness/run.ts`          | Main orchestration via phases                      |
48: | Post-action hook | `src/harness/post.ts`         | Durable cache save (RFC-017)                       |
49: | Setup library    | `src/services/setup/`         | Bun/oMo/OpenCode installation (auto-setup)         |
50: | Cache operations | `src/services/cache/`         | `restore.ts`, `save.ts`                            |
51: | GitHub API       | `src/services/github/client.ts` | `createClient()`, `createAppClient()`              |
52: | Event parsing    | `src/services/github/context.ts` | `parseGitHubContext()`, `normalizeEvent()`         |
53: | Event types      | `src/services/github/types.ts` | `NormalizedEvent` discriminated union (7 variants) |
54: | Agent execution  | `src/features/agent/execution.ts` | `executeOpenCode()` logic                          |
55: | Prompt building  | `src/features/agent/prompt.ts` | `buildAgentPrompt()`, response protocol sections   |
56: | Session storage  | `src/services/session/`       | `storage-read.ts`, `storage-write.ts`              |
57: | Session search   | `src/services/session/search.ts` | `listSessions()`, `searchSessions()`               |
58: | Event routing    | `src/features/triggers/router.ts` | `routeEvent()` orchestration                       |
59: | Context hydrate  | `src/features/context/`       | GraphQL/REST issue/PR data (RFC-015)               |
60: | Comment posting  | `src/features/comments/writer.ts` | `postComment()`, GraphQL mutations                 |
61: | PR reviews       | `src/features/reviews/reviewer.ts` | `submitReview()`, line comments                    |
62: | Input parsing    | `src/harness/config/inputs.ts` | `parseActionInputs()` returns Result               |
63: | Logging          | `src/shared/logger.ts`        | `createLogger()` with redaction                    |
64: | Core types       | `src/shared/types.ts`         | `ActionInputs`, `CacheResult`, `RunContext`        |
65: | Build config     | `tsdown.config.ts`            | ESM shim, bundled deps, license extraction         |
80: 
81: ## CODE MAP
82: 
83: | Symbol | Type | Location | Role |
84: | --- | --- | --- | --- |
85: | `run` | Function | `src/harness/run.ts` | Main entry, phase orchestration |
86: | `runPost` | Function | `src/harness/post.ts` | Post-action cache save |
87: | `runSetup` | Function | `src/services/setup/setup.ts` | Setup orchestration |
88: | `restoreCache` | Function | `src/services/cache/restore.ts` | Restore OpenCode state |
89: | `saveCache` | Function | `src/services/cache/save.ts` | Persist state to cache |
90: | `executeOpenCode` | Function | `src/features/agent/execution.ts` | SDK execution orchestration |
91: | `buildAgentPrompt` | Function | `src/features/agent/prompt.ts` | Multi-section prompt with directives |
92: | `sendPromptToSession` | Function | `src/features/agent/prompt-sender.ts` | Send prompt to SDK session |
93: | `runPromptAttempt` | Function | `src/features/agent/retry.ts` | Execute prompt with retry logic |
94: | `pollForSessionCompletion` | Function | `src/features/agent/session-poll.ts` | Poll SDK for completion status |
95: | `processEventStream` | Function | `src/features/agent/streaming.ts` | Process SDK event stream |
96: | `bootstrapOpenCodeServer` | Function | `src/features/agent/server.ts` | Initialize SDK server lifecycle |
97: | `normalizeEvent` | Function | `src/services/github/context.ts` | Raw payload → typed NormalizedEvent |
98: | `parseGitHubContext` | Function | `src/services/github/context.ts` | Global context → typed GitHubContext |
99: | `routeEvent` | Function | `src/features/triggers/router.ts` | Event routing orchestration |
100: | `postComment` | Function | `src/features/comments/writer.ts` | Create or update comment |
101: | `submitReview` | Function | `src/features/reviews/reviewer.ts` | Submit PR review |
102: | `parseActionInputs` | Function | `src/harness/config/inputs.ts` | Parse/validate inputs |
103: | `createLogger` | Function | `src/shared/logger.ts` | Logger with redaction |
104: | `ActionInputs` | Interface | `src/shared/types.ts` | Input schema |
105: | `NormalizedEvent` | Union | `src/services/github/types.ts` | 7-variant discriminated event union |
106: | `TriggerDirective` | Interface | `src/features/agent/prompt.ts` | Directive + appendMode for triggers |
107: | `TriggerResult` | Interface | `src/features/triggers/types.ts` | Routing decision |
108: 
109: ## EXECUTION FLOW
110: 
111: ```
112: main.ts → harness/run.ts
113:   │
114:   ├─→ bootstrap phase (parseActionInputs, ensureOpenCodeAvailable, restoreCache)
115:   ├─→ routing phase (parseGitHubContext, normalizeEvent, routeEvent)
116:   ├─→ acknowledge phase (acknowledgeReceipt)
117:   ├─→ session-prep phase (processAttachments, buildAgentPrompt)
118:   ├─→ execute phase (executeOpenCode via SDK)
119:   ├─→ finalize phase (writeSessionSummary, pruneSessions)
120:   └─→ cleanup phase (saveCache)
121: 
122: post.ts → harness/post.ts
123:   └─→ saveCache (durable persistence)
124: ```
125: 
126: ## COMPLEXITY HOTSPOTS
127: 
128: | File                 | Lines | Reason                                                   |
129: | -------------------- | ----- | -------------------------------------------------------- |
130: | `features/triggers/router.ts` | 39    | Routing logic (skip/context extracted)          |
131: | `features/agent/execution.ts` | 178   | SDK execution orchestration                    |
132: | `harness/run.ts`              | 97    | 12-step orchestration, phase delegation        |
133: | `features/agent/prompt.ts`    | 420   | Prompt templates, trigger directives           |
134: | `services/cache/restore.ts`   | 187   | Corruption detection, version checking          |
135: | `services/session/types.ts`   | 291   | Session/message/part type hierarchy             |
136: | `features/context/types.ts`   | 279   | GraphQL context types, budget constraints       |
137: | `services/github/context.ts`  | 226   | normalizeEvent() 7-variant union builder        |
138: | `features/agent/streaming.ts` | 137   | SDK event stream processing                    |
139: | `features/agent/session-poll.ts` | 110 | SDK session completion polling                |
140: 
141: ## NOTES
142: 
143: - **Four-layer architecture**: shared/ → services/ → features/ → harness/
144: - **Layer dependency rules**: Each layer may only import from layers below it.
145: - **dist/ committed**: CI fails if `git diff dist/` shows changes after build
146: - **Node 24 required**: Matches `action.yaml` runtime
147: - **19 RFCs total**: Foundation, cache, GitHub client, sessions, triggers, security, observability, comments, PR review, delegated work, setup, execution, SDK mode, file attachments, GraphQL context, additional triggers, post-action hook, plugin, S3 backend
148: - **SDK-based execution**: Uses `@opencode-ai/sdk` for server lifecycle + event streaming
149: - **Persistent memory**: Sessions survive across CI runs via GitHub Actions cache
150: - **NormalizedEvent**: All webhook payloads pass through `normalizeEvent()` before routing; router never touches raw payloads

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
