# Development Rules: Fro Bot Agent

**Version:** 1.2
**Last Updated:** 2026-01-14
**Applies to:** All contributors and AI assistants

---

## Table of Contents

- [Project Overview](#project-overview)
- [Technology Stack](#technology-stack)
- [Code Style \& Conventions](#code-style--conventions)
- [Architecture Patterns](#architecture-patterns)
- [SDK Execution Patterns](#sdk-execution-patterns)
- [Security Requirements](#security-requirements)
- [Testing Standards](#testing-standards)
- [Build \& Release](#build--release)
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
- SDK-based execution (`@opencode-ai/sdk`)
- GraphQL context hydration for issues/PRs
- File attachment support
- Explicit model/agent configuration
- Mock event support for local testing

---

## Technology Stack

### Runtime & Language

| Technology      | Version            | Notes                                        |
| --------------- | ------------------ | -------------------------------------------- |
| Node.js         | **24.x** (24.12.0) | Bleeding-edge; matches `action.yaml` runtime |
| TypeScript      | **5.9.x**          | Strict mode enabled                          |
| Package Manager | **pnpm** (v10+)    | Workspace-enabled                            |

### Core Dependencies

| Package             | Purpose                   | Bundle Strategy      |
| ------------------- | ------------------------- | -------------------- |
| `@actions/core`     | GitHub Actions SDK        | Bundled (noExternal) |
| `@actions/cache`    | Cache restore/save        | Bundled              |
| `@actions/github`   | GitHub API client         | Bundled              |
| `@opencode-ai/sdk`  | OpenCode SDK execution    | Bundled              |
| `@octokit/auth-app` | GitHub App authentication | Bundled              |

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
import {createOpencodeClient} from "@opencode-ai/sdk"
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
├── setup.ts             # Setup action entry point
├── lib/
│   ├── agent/           # Agent execution
│   │   ├── opencode.ts  # SDK executor (executeOpenCode)
│   │   ├── context.ts   # GitHub context collection
│   │   ├── prompt.ts    # Prompt construction
│   │   ├── reactions.ts # Reactions and labels
│   │   └── types.ts     # Agent-specific types
│   ├── github/          # GitHub API
│   │   ├── client.ts    # Octokit client creation
│   │   └── context.ts   # Event parsing
│   ├── setup/           # Setup action modules
│   ├── cache.ts         # Cache restore/save logic
│   ├── logger.ts        # JSON logging with redaction
│   ├── types.ts         # Shared type definitions
│   └── constants.ts     # Shared constants
├── utils/
│   ├── env.ts           # Environment variable getters
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

## SDK Execution Patterns

### OpenCode SDK Usage (v1.1)

The agent uses `@opencode-ai/sdk` for execution. Follow these canonical patterns:

#### Server Lifecycle Management

```typescript
import {createOpencode} from "@opencode-ai/sdk"

// RECOMMENDED: Auto server + client (single function)
const {server, client} = await createOpencode({
  port: 4096,
  timeout: 5000,
})

try {
  // Use the client
  const session = await client.session.create()
  // ...
} finally {
  // ALWAYS clean up
  server.close()
}
```

#### Alternative: Manual Server + Client

```typescript
import {createOpencodeServer, createOpencodeClient} from "@opencode-ai/sdk"

// For more control over server lifecycle
const server = await createOpencodeServer({
  hostname: "127.0.0.1",
  port: 4096,
  timeout: 5000,
})

const client = createOpencodeClient({
  baseUrl: server.url,
})

// Remember to clean up
server.close()
```

#### Session Creation

```typescript
// Create session with title
const session = await client.session.create({
  body: {title: `GitHub Action: ${repo}`},
})
const sessionId = session.data.id

// Create child session (for background tasks)
const childSession = await client.session.create({
  body: {
    parentID: parentSessionId,
    title: "Background Task",
  },
})
```

#### Sending Prompts

```typescript
// Send text prompt with agent (agent is always provided, defaults to "Sisyphus")
await client.session.prompt({
  path: {id: sessionId},
  body: {
    agent: agentName, // Required, default "Sisyphus"
    parts: [{type: "text", text: promptText}],
  },
})

// Send with optional model override
// If model is not provided, uses the agent's configured model
await client.session.prompt({
  path: {id: sessionId},
  body: {
    agent: agentName,
    ...(model != null && {
      providerID: model.providerID,
      modelID: model.modelID,
    }),
    parts: [{type: "text", text: promptText}],
  },
})

// Send with file attachments
await client.session.prompt({
  path: {id: sessionId},
  body: {
    agent: agentName,
    parts: [
      {
        type: "file",
        mime: "image/png",
        url: "file:///path/to/image.png",
      },
      {type: "text", text: "Analyze this image"},
    ],
  },
})
```

#### Event Subscription

```typescript
// Subscribe to events
const events = await client.event.subscribe()

// Process events in async loop
for await (const event of events.stream) {
  switch (event.type) {
    case "session.idle":
      if (event.properties.sessionID === sessionId) {
        console.log("Session completed")
        break
      }
      break

    case "session.error":
      console.error("Error:", event.properties.error)
      break

    case "message.part.updated":
      const part = event.properties.part
      if (part.type === "text" && part.time?.end != null) {
        console.log("AI response completed")
      }
      if (part.type === "tool" && part.state.status === "completed") {
        console.log(`Tool used: ${part.tool}`)
      }
      break
  }
}

// Cancel subscription
events.controller.abort()
```

### Model Configuration

If provided, format: `provider/model`. If not provided, uses agent's configured model.

```typescript
// Parse model input (returns null if not provided)
function parseModelInput(input: string): ModelConfig {
  const [providerID, ...rest] = input.split("/")
  const modelID = rest.join("/")

  if (providerID == null || providerID.length === 0 || modelID.length === 0) {
    throw new Error(`Invalid model format: "${input}". Expected "provider/model"`)
  }

  return {providerID, modelID}
}

// Valid examples (when model override is desired)
parseModelInput("anthropic/claude-sonnet-4-20250514")
parseModelInput("openai/gpt-4o")
parseModelInput("google/gemini-2.0-flash")
```

### Agent Validation

Agent validation happens **server-side**. The SDK client passes the agent name, and the server validates:

```typescript
// Send prompt with agent (server validates)
await client.session.prompt({
  path: {id: sessionId},
  body: {
    agent: agentName, // Server validates and falls back if invalid
    parts: [...],
  },
})
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

### File Attachment Security

```typescript
// Validate attachment URLs - ONLY from github.com/user-attachments/
const ATTACHMENT_URL_PATTERN = /^https:\/\/github\.com\/user-attachments\/(assets|files)\//

function isValidAttachmentUrl(url: string): boolean {
  return ATTACHMENT_URL_PATTERN.test(url)
}

// Enforce limits
const ATTACHMENT_LIMITS = {
  maxFiles: 5,
  maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
  maxTotalSizeBytes: 15 * 1024 * 1024, // 15MB
  allowedMimeTypes: ["image/*", "text/*", "application/json", "application/pdf"],
} as const
```

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

### SDK Mocking Pattern

```typescript
// Mock @opencode-ai/sdk for tests
vi.mock("@opencode-ai/sdk", () => ({
  createOpencode: vi.fn(),
  createOpencodeClient: vi.fn(),
  createOpencodeServer: vi.fn(),
}))

// Create mock client
function createMockClient(options: {sessionIdle?: boolean; sessionError?: boolean}) {
  return {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: "ses_123"}}),
      prompt: vi.fn().mockResolvedValue({}),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({
        stream: createMockEventStream(options),
        controller: {abort: vi.fn()},
      }),
    },
  }
}
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
- **Bundle (post)**: `dist/post.js` (ESM, minified) - post-action cache hook
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
  github-token:
    description: "GitHub token (App installation token or PAT) with write permissions"
    required: true
  auth-json:
    description: "JSON object or path with OpenCode credentials (auth.json format)"
    required: true
  agent:
    description: "Agent to use (default: Sisyphus). Must be primary agent, not subagent."
    required: false
    default: "Sisyphus"
  model:
    description: "Model override (format: provider/model). If not set, uses agent's configured model."
    required: false
  timeout:
    description: "Execution timeout in milliseconds (0 = no timeout, default: 1800000)"
    required: false
    default: "1800000"
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
  share-url:
    description: "Session share URL (if sharing enabled)"

runs:
  using: "node24"
  main: "dist/main.js"
  post: "dist/post.js"
```

### Trigger Router Patterns

The action supports multiple GitHub event triggers with specific handling:

| Event | Supported Actions | Prompt Requirement | Default Behavior |
| --- | --- | --- | --- |
| `issue_comment` | `created` | Optional (uses comment body) | Respond to comment |
| `discussion_comment` | `created` | Optional (uses comment body) | Respond to discussion |
| `workflow_dispatch` | - | **Required** | Uses prompt input directly |
| `schedule` | - | **Required** | Uses prompt input directly |
| `issues` | `opened`, `edited` (with @mention) | Optional | Triage (opened) or respond to mention |
| `pull_request` | `opened`, `synchronize`, `reopened` | Optional | Code review |
| `pull_request_review_comment` | `created` | Optional (uses comment body) | Respond with file context |

**Skip Conditions:**

- `issues.edited`: Skip unless body contains `@fro-bot` mention
- `pull_request`: Skip draft PRs by default (configurable)
- `schedule`/`workflow_dispatch`: Hard fail if `inputs.prompt` is empty

### Trigger-Specific Directives

Each trigger injects a default task directive via `getTriggerDirective()`:

```typescript
// src/lib/agent/prompt.ts
function getTriggerDirective(context: TriggerContext, inputs: ActionInputs): string {
  switch (context.eventName) {
    case "issue_comment":
      return "Respond to the comment above"
    case "issues":
      return context.action === "opened"
        ? "Triage this issue: summarize, reproduce if possible, propose next steps"
        : "Respond to the mention in this issue"
    case "pull_request":
      return "Review this pull request for code quality, potential bugs, and improvements"
    case "pull_request_review_comment":
      return "Respond to the review comment with file and code context"
    case "schedule":
    case "workflow_dispatch":
      // No default - prompt input required
      return inputs.prompt
  }
}
```

**Prompt Override Behavior:**

- Comment-based triggers: Custom `prompt` **appends** to directive
- `schedule`/`workflow_dispatch`: Custom `prompt` **replaces** directive (required)

### Post-Action Cache Hook

The `post:` hook provides reliable cache persistence independent of main action lifecycle:

```typescript
// src/post.ts - Runs even on timeout/cancellation/SIGKILL
async function post(): Promise<void> {
  // 1. Save cache (idempotent, best-effort)
  await saveCache(inputs) // Never throws

  // 2. Session pruning (optional, non-fatal)
  await pruneSessions(inputs) // Never throws
}
```

**Key Properties:**

- Runs in separate process via GitHub Actions `post:` field
- Survives main action timeout, cancellation, or crash
- **MUST NOT** fail the job if cache save fails
- Complements (not replaces) `finally` block cleanup

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

| Field    | Value                              |
| -------- | ---------------------------------- |
| Event    | issue_comment                      |
| Repo     | owner/repo                         |
| Ref      | main                               |
| Run ID   | 12345678                           |
| Cache    | hit                                |
| Session  | ses_abc123                         |
| Model    | anthropic/claude-sonnet-4-20250514 |
| Agent    | Sisyphus                           |
| Duration | 45s                                |
| Tokens   | 1,234 in / 567 out                 |

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
 * Execute OpenCode agent via SDK.
 *
 * Spawns OpenCode server, creates session, sends prompt, and waits for completion.
 *
 * @param prompt - The prompt text to send to the agent
 * @param opencodePath - Path to opencode binary (null uses PATH)
 * @param logger - Logger instance
 * @returns AgentResult with success status and sessionId
 */
export async function executeOpenCode(
  prompt: string,
  opencodePath: string | null,
  logger: Logger,
): Promise<AgentResult> {
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
| Caching auth.json        | Security risk                       | Populate fresh each run            |
| Polling without timeout  | Resource exhaustion                 | Always set max timeout             |

---

## Implementation Priorities

### P0 (Must Have for MVP)

**SDK Execution (F32-F37)**

1. SDK-based execution via `@opencode-ai/sdk`
2. Session creation and prompt sending
3. Event subscription and completion detection
4. Timeout and cancellation support
5. Model input (optional, format: `provider/model`)
6. Agent input (optional, validated server-side)

**Context & Prompt (F38-F45)**

1. Mock event support for local testing
2. File attachment detection and download
3. GraphQL context hydration for issues/PRs
4. Multi-section prompt construction
5. Context budgeting (50 comments, 100 files)

**Additional Triggers (v1.2)**

1. `issues` event with `opened` action (auto-triage)
2. `issues.edited` only when `@fro-bot` mentioned
3. `pull_request` event with `opened`, `synchronize`, `reopened`
4. `pull_request_review_comment` with `created` action
5. `schedule` event with required `prompt` input
6. `workflow_dispatch` hard fails if `prompt` empty
7. Draft PR skip by default (configurable)
8. Trigger-specific directives via `getTriggerDirective()`

**Post-Action Hook (v1.2)**

1. `src/post.ts` entry point bundled to `dist/post.js`
2. `action.yaml` includes `runs.post: dist/post.js`
3. Post-hook saves cache idempotently (never fails job)
4. Post-hook runs even on main action failure/timeout

**Core Functionality**

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
5. Session sharing
6. Automatic branch management
7. Event streaming and progress logging
8. Setup action consolidation

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
feat(sdk): add session event subscription
fix(cache): handle corrupted storage gracefully
docs(readme): add SDK execution configuration
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

| File                        | Purpose                  |
| --------------------------- | ------------------------ |
| `src/main.ts`               | Action entry point       |
| `src/setup.ts`              | Setup action entry point |
| `src/lib/agent/opencode.ts` | SDK executor             |
| `action.yaml`               | GitHub Action definition |
| `tsdown.config.ts`          | Build configuration      |
| `eslint.config.ts`          | Lint rules               |
| `PRD.md`                    | Product requirements     |
| `FEATURES.md`               | Feature specifications   |
| `AGENTS.md`                 | Project conventions      |

### Session Tools: Action vs Agent

**Two layers of session management exist:**

1. **oMo Session Tools (Agent-side)** - LLM tools provided by Oh My OpenCode plugin to AI agents during runtime:
   - `session_search` - Full-text search across sessions
   - `session_read` - Read session messages and history
   - `session_info` - Get session metadata and statistics
   - `session_list` - List available sessions

   These are invoked by the agent through natural language via the LLM tool-calling interface. The agent prompt MUST instruct use of these tools before re-investigating.

2. **RFC-004 Utilities (Action-side)** - TypeScript functions used by the GitHub Action harness:
   - `listSessions()` - Startup introspection
   - `searchSessions()` - Find relevant prior sessions
   - `pruneSessions()` - Retention policy enforcement
   - `writeSessionSummary()` - Close-the-loop writeback

   These run before/after agent execution in the action lifecycle.

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
    opencode-version: "latest" # optional

- name: Run Fro Bot Agent
  uses: fro-bot/agent@v0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    agent: "Sisyphus" # Optional, defaults to Sisyphus
    # model: "anthropic/claude-sonnet-4-20250514" # Optional, overrides agent's configured model
    prompt: "Respond to the issue comment"
```

### SDK Quick Reference

```typescript
import {createOpencode} from "@opencode-ai/sdk"

// 1. Start server + client
const {server, client} = await createOpencode({port: 4096})

// 2. Create session
const session = await client.session.create({body: {title: "My Task"}})

// 3. Subscribe to events (background)
const events = await client.event.subscribe()

// 4. Send prompt (agent always provided, model override optional)
await client.session.prompt({
  path: {id: session.data.id},
  body: {
    agent: "Sisyphus", // Default agent
    // model override only if specified:
    // providerID: "anthropic", modelID: "claude-sonnet-4-20250514",
    parts: [{type: "text", text: "Your prompt here"}],
  },
})

// 5. Wait for completion
for await (const event of events.stream) {
  if (event.type === "session.idle") break
}

// 6. Clean up
server.close()
```

---

_This document establishes development standards. Violations should be caught in code review._
