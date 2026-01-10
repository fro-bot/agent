# RFC-013: SDK Execution Mode

**Status:** Completed
**Priority:** MUST
**Complexity:** High
**Phase:** 1
**Completed:** 2026-01-10

---

## Summary

Implement OpenCode SDK-based execution as the **primary and only** execution mode for the Fro Bot Agent, replacing the CLI-based execution from RFC-012. This RFC specifies the integration with `@opencode-ai/sdk`, including server lifecycle management, session creation, event subscription, completion detection, timeout handling, and cleanup.

## Dependencies

- **Requires:** RFC-001 (Foundation), RFC-002 (Cache), RFC-003 (GitHub Client), RFC-011 (Setup Action)
- **Supersedes:** RFC-012 (Execution Layer only - context/reactions/prompt remain valid)
- **Enables:** RFC-004 (Sessions), RFC-005 (Triggers), RFC-006 (Security), RFC-007 (Observability)

## Features Addressed

| Feature ID | Feature Name                    | Priority |
| ---------- | ------------------------------- | -------- |
| NEW        | OpenCode SDK Execution          | P0       |
| NEW        | SDK Server Lifecycle Management | P0       |
| NEW        | Session Creation & Prompt       | P0       |
| NEW        | Event Subscription & Processing | P0       |
| NEW        | Completion Detection            | P0       |
| NEW        | Timeout & Cancellation          | P0       |
| NEW        | Model & Agent Configuration     | P0       |
| F41        | Agent Prompt Context Injection  | P0       |

## Background: Why SDK Over CLI

RFC-012 specified CLI execution via `opencode run "$PROMPT"`. PRD v1.1 (2026-01-10) supersedes this with SDK-based execution for several reasons:

| Factor                | CLI                   | SDK                         |
| --------------------- | --------------------- | --------------------------- |
| Session ID Access     | Requires log parsing  | Direct API return           |
| Event Streaming       | stdout parsing        | Typed event subscription    |
| Completion Detection  | Exit code only        | Session state polling       |
| File Attachments      | Not supported         | Native `type: "file"` parts |
| Model/Agent Selection | Environment variables | Direct API parameters       |
| Error Handling        | String parsing        | Typed error objects         |
| Server Lifecycle      | External process      | Managed via AbortController |

**Decision:** SDK is the only execution mode. CLI may return in the medium-term as a separate fro-bot harness project.

---

## Technical Specification

### 1. File Structure

SDK implementation is a **drop-in replacement** for RFC-012's CLI executor. No subdirectory—all code lives directly in `src/lib/agent/`.

```
src/lib/agent/
├── context.ts            # UNCHANGED: GitHub context collection
├── prompt.ts             # UNCHANGED: Prompt construction
├── reactions.ts          # UNCHANGED: GitHub reactions/labels
├── opencode.ts           # REPLACED: SDK implementation (keeps executeOpenCode() signature)
├── types.ts              # UPDATED: SDK types merged with existing agent types
├── index.ts              # UPDATED: Exports remain stable
└── opencode.test.ts      # UPDATED: Tests rewritten for SDK behavior (colocated)
```

**Explicitly NOT created:**

- `src/lib/agent/sdk/` subdirectory does NOT exist
- `executeWithSDK()` function does NOT exist

### 2. Removed CLI Code

The following CLI-specific code from RFC-012 is **removed**:

| Removed                                 | Reason                                                   |
| --------------------------------------- | -------------------------------------------------------- |
| `@actions/exec` import and usage        | Server mode uses `child_process.spawn()`                 |
| `opencode run "$PROMPT"` CLI invocation | Replaced by `opencode serve` + SDK client                |
| `stdbuf` Linux streaming workaround     | SDK provides SSE event subscription                      |
| `OPENCODE_PROMPT` environment variable  | Prompt passed directly to `client.session.prompt()`      |
| Exit code parsing from CLI              | SDK `prompt()` is synchronous, returns response directly |
| Stdout/stderr log parsing               | SDK provides typed event stream via `/event` SSE         |

### 3. Type Additions (`src/lib/agent/types.ts`)

SDK types are **merged into the existing `types.ts`**, not a separate file:

```typescript
// Existing types remain unchanged:
// - AgentContext
// - ReactionContext
// - PromptOptions
// - AgentResult (updated to include sessionId)

// NEW: Model configuration (public, used by action inputs)
export interface ModelConfig {
  readonly providerID: string
  readonly modelID: string
}

// NEW: Prompt parts for file attachments (public, for future RFC)
export interface PromptPart {
  readonly type: "text" | "file"
  readonly content: string
  readonly filename?: string
  readonly mimeType?: string
}

// UPDATED: AgentResult now includes sessionId
export interface AgentResult {
  readonly success: boolean
  readonly sessionId: string | null // NEW: Direct from SDK
  readonly exitCode: 0 | 1 | 130
  readonly error?: string
}
```

**Internal types** (kept private inside `opencode.ts`, not exported):

- `SessionState` (idle/error tracking)
- `TimeoutHandler`
- `CompletionResult`
- SDK client type aliases

### 4. SDK Executor (`src/lib/agent/opencode.ts`)

The entire SDK implementation is consolidated into a single file, replacing the CLI executor. The public API signature remains unchanged for backward compatibility.

**Key Pattern**: OpenCode runs as a server process (`opencode serve`), and the SDK client connects to it. This matches the [OpenCode GitHub action](https://github.com/anomalyco/opencode/blob/dev/github/index.ts) pattern.

```typescript
/**
 * OpenCode SDK Executor
 *
 * Replaces CLI-based execution from RFC-012 with @opencode-ai/sdk.
 * Public API remains stable: executeOpenCode() signature unchanged.
 *
 * Architecture:
 * 1. Spawn OpenCode server: `opencode serve --hostname=127.0.0.1 --port=4096`
 * 2. Create SDK client: `createOpencodeClient({ baseUrl: url })`
 * 3. Verify connection with retry loop
 * 4. Create session and send prompt via `client.session.prompt()`
 * 5. Subscribe to events via SSE (`/event` endpoint)
 * 6. Kill server process on cleanup
 */

import type {ChildProcess} from "node:child_process"
import {spawn} from "node:child_process"
import type {Logger} from "../logger.js"
import type {AgentResult, ModelConfig} from "./types.js"
import {createOpencodeClient} from "@opencode-ai/sdk"

// ============================================================================
// Internal Types (not exported)
// ============================================================================

interface OpenCodeServer {
  readonly url: string
  readonly process: ChildProcess
  close: () => void
}

interface SessionInfo {
  readonly id: string
  readonly title: string
  readonly version: string
}

type SDKClient = ReturnType<typeof createOpencodeClient>

// ============================================================================
// Public API (signature unchanged from RFC-012)
// ============================================================================

/**
 * Verify OpenCode is available for server mode.
 *
 * @param opencodePath - Path to opencode binary (null uses PATH)
 * @param logger - Logger instance
 */
export async function verifyOpenCodeAvailable(opencodePath: string | null, logger: Logger): Promise<void> {
  const binary = opencodePath ?? "opencode"
  logger.debug("Verifying OpenCode availability", {binary})

  try {
    const proc = spawn(binary, ["--version"], {stdio: "pipe"})
    await new Promise<void>((resolve, reject) => {
      proc.on("close", code => {
        if (code === 0) resolve()
        else reject(new Error(`opencode --version exited with code ${code}`))
      })
      proc.on("error", reject)
    })
    logger.info("OpenCode verified")
  } catch (error) {
    throw new Error(`OpenCode not available: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Execute OpenCode agent via SDK (server mode).
 *
 * Spawns OpenCode in server mode, connects via SDK client, sends prompt,
 * waits for completion, and returns the result.
 *
 * @param prompt - The prompt text to send to the agent
 * @param opencodePath - Path to opencode binary (null uses PATH)
 * @param logger - Logger instance
 * @returns AgentResult with success status and sessionId
 */
/**
 * Execution configuration passed from parsed action inputs.
 * Follows repo pattern: parse in inputs.ts, pass as config object.
 */
export interface ExecutionConfig {
  readonly agent: string
  readonly model: ModelConfig | null
  readonly timeoutMs: number
}

export async function executeOpenCode(
  prompt: string,
  opencodePath: string | null,
  logger: Logger,
  config?: ExecutionConfig,
): Promise<AgentResult> {
  let server: OpenCodeServer | null = null
  let client: SDKClient | null = null
  let session: SessionInfo | null = null

  const timeoutMs = config?.timeoutMs ?? 1800000 // Default: 30 minutes
  const timeoutId =
    timeoutMs > 0
      ? setTimeout(() => {
          logger.warning("Execution timeout reached", {timeoutMs})
          server?.close()
        }, timeoutMs)
      : null

  try {
    logger.info("Starting OpenCode SDK execution (server mode)")

    // 1. Spawn OpenCode server
    server = createOpenCodeServer(opencodePath, logger)

    // 2. Create SDK client
    client = createOpencodeClient({baseUrl: server.url})

    // 3. Verify connection with retry
    await assertOpenCodeConnected(client, logger)

    // 4. Get model and agent configuration from config (parsed in inputs.ts)
    const model = config?.model ?? null
    const agentName = config?.agent ?? "Sisyphus"
    const agent = await resolveAgent(client, agentName, logger)

    // 5. Create session
    const sessionResponse = await client.session.create<true>()
    session = sessionResponse.data as SessionInfo
    logger.info("Session created", {sessionId: session.id})

    // 6. Subscribe to session events (background)
    subscribeSessionEvents(server.url, session.id, logger)

    // 7. Send prompt and wait for response (synchronous)
    logger.debug("Sending prompt to OpenCode...")
    const promptResponse = await client.session.prompt<true>({
      path: {id: session.id},
      body: {
        ...(model != null && {
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
          },
        }),
        agent: agent ?? undefined,
        parts: [{type: "text", text: prompt}],
      },
    })

    // 8. Extract text response
    const responseParts = promptResponse.data?.parts ?? []
    const textPart = responseParts.findLast((p: {type: string}) => p.type === "text") as
      | {type: "text"; text: string}
      | undefined

    if (textPart == null) {
      throw new Error("No text response received from OpenCode")
    }

    logger.info("OpenCode execution completed successfully", {sessionId: session.id})

    return {
      success: true,
      sessionId: session.id,
      exitCode: 0,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error("OpenCode execution failed", {
      error: errorMessage,
      sessionId: session?.id ?? null,
    })

    return {
      success: false,
      sessionId: session?.id ?? null,
      exitCode: 1,
      error: errorMessage,
    }
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
    if (server != null) {
      server.close()
      logger.info("OpenCode server closed")
    }
  }
}

/**
 * Parse model input string into ModelConfig.
 *
 * @param modelInput - Format: "provider/model" (e.g., "anthropic/claude-sonnet-4-20250514")
 * @returns ModelConfig with providerID and modelID
 * @throws Error if format is invalid
 */
export function parseModelInput(modelInput: string): ModelConfig {
  const [providerID, ...rest] = modelInput.split("/")
  const modelID = rest.join("/")

  if (providerID == null || providerID.length === 0 || modelID.length === 0) {
    throw new Error(
      `Invalid model format: "${modelInput}". Expected "provider/model" (e.g., "anthropic/claude-sonnet-4-20250514")`,
    )
  }

  return {providerID, modelID}
}

// ============================================================================
// Internal Helpers (not exported)
// ============================================================================

/**
 * Spawn OpenCode in server mode.
 *
 * Matches the pattern from OpenCode GitHub action:
 * `opencode serve --hostname=127.0.0.1 --port=4096`
 */
function createOpenCodeServer(opencodePath: string | null, logger: Logger): OpenCodeServer {
  const host = "127.0.0.1"
  const port = 4096
  const url = `http://${host}:${port}`
  const binary = opencodePath ?? "opencode"

  logger.debug("Spawning OpenCode server", {binary, host, port})

  const proc = spawn(binary, ["serve", `--hostname=${host}`, `--port=${port}`], {
    stdio: "pipe",
  })

  proc.on("error", error => {
    logger.error("OpenCode server process error", {error: error.message})
  })

  proc.stderr?.on("data", (data: Buffer) => {
    const message = data.toString().trim()
    if (message.length > 0) {
      logger.debug("OpenCode server stderr", {message})
    }
  })

  return {
    url,
    process: proc,
    close: () => proc.kill(),
  }
}

/**
 * Verify SDK client can connect to OpenCode server.
 *
 * Uses retry loop matching OpenCode GitHub action pattern.
 */
async function assertOpenCodeConnected(client: SDKClient, logger: Logger): Promise<void> {
  const maxRetries = 30
  const retryDelayMs = 300

  logger.debug("Waiting for OpenCode server connection...")

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      await client.app.log<true>({
        body: {
          service: "fro-bot-agent",
          level: "info",
          message: "Agent connecting to OpenCode server",
        },
      })
      logger.info("Connected to OpenCode server")
      return
    } catch {
      // Connection not ready yet
    }
    await sleep(retryDelayMs)
  }

  throw new Error("Failed to connect to OpenCode server after 30 retries")
}

// NOTE: Model/agent/timeout configuration is now parsed in src/lib/inputs.ts
// and passed via the ExecutionConfig parameter. The helper functions
// getModelConfig(), getAgentName(), getTimeoutMs() are REMOVED.
// This follows the repo pattern of parsing inputs centrally.

/**
 * Validate agent exists and is a primary agent.
 *
 * Matches OpenCode GitHub action's `resolveAgent()` pattern.
 * Returns the validated agent name, or falls back to "Sisyphus" if validation fails.
 */
async function resolveAgent(client: SDKClient, agentName: string, logger: Logger): Promise<string> {
  try {
    const agents = await client.agent.list<true>()
    const agent = agents.data?.find(a => a.name === agentName)

    if (agent == null) {
      logger.warning(`Agent "${agentName}" not found. Falling back to Sisyphus`)
      return "Sisyphus"
    }

    if (agent.mode === "subagent") {
      logger.warning(`Agent "${agentName}" is a subagent, not a primary agent. Falling back to Sisyphus`)
      return "Sisyphus"
    }

    logger.info("Agent validated", {agent: agentName})
    return agentName
  } catch (error) {
    logger.warning("Failed to validate agent, using Sisyphus", {
      error: error instanceof Error ? error.message : String(error),
    })
    return "Sisyphus"
  }
}

/**
 * Subscribe to session events via SSE.
 *
 * Matches OpenCode GitHub action's event subscription pattern.
 * Runs in background, logs tool executions and text responses.
 */
function subscribeSessionEvents(serverUrl: string, sessionId: string, logger: Logger): void {
  logger.debug("Subscribing to session events...", {sessionId})

  const TOOL_LABELS: Record<string, string> = {
    todowrite: "Todo",
    todoread: "Todo",
    bash: "Bash",
    edit: "Edit",
    glob: "Glob",
    grep: "Grep",
    list: "List",
    read: "Read",
    write: "Write",
    websearch: "Search",
  }

  fetch(`${serverUrl}/event`)
    .then(async response => {
      if (response.body == null) {
        logger.warning("No response body from event stream")
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const {done, value} = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, {stream: true})
        const lines = chunk.split("\n")

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue

          const jsonStr = line.slice(6).trim()
          if (jsonStr.length === 0) continue

          try {
            const evt = JSON.parse(jsonStr)

            if (evt.type === "message.part.updated") {
              if (evt.properties?.part?.sessionID !== sessionId) continue
              const part = evt.properties.part

              if (part.type === "tool" && part.state?.status === "completed") {
                const toolLabel = TOOL_LABELS[part.tool] ?? part.tool
                const title = part.state.title ?? JSON.stringify(part.state.input ?? {})
                logger.debug(`Tool completed: ${toolLabel}`, {title})
              }

              if (part.type === "text" && part.time?.end != null) {
                logger.debug("Text response completed")
              }
            }

            if (evt.type === "session.updated") {
              if (evt.properties?.info?.id === sessionId) {
                logger.debug("Session updated", {version: evt.properties.info.version})
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    })
    .catch(error => {
      logger.debug("Event subscription ended", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

### 5. Updated Exports (`src/lib/agent/index.ts`)

Exports remain stable—no new paths introduced:

```typescript
// src/lib/agent/index.ts
export {collectAgentContext} from "./context.js"
export {buildAgentPrompt} from "./prompt.js"
export {acknowledgeReceipt, completeAcknowledgment} from "./reactions.js"
export {executeOpenCode, verifyOpenCodeAvailable, parseModelInput} from "./opencode.js"
export type {AgentContext, ReactionContext, PromptOptions, AgentResult, ModelConfig, PromptPart} from "./types.js"
```

### 6. Main Entry Point (`src/main.ts`)

The main entry point continues to import from `./lib/agent/index.js`—no SDK subdirectory imports:

```typescript
/**
 * Fro Bot Agent - Main Entry Point (SDK Mode)
 *
 * GitHub Action harness for OpenCode + oMo agents with persistent session state.
 * Uses @opencode-ai/sdk for execution (replaces CLI mode from RFC-012).
 */

import type {CacheKeyComponents} from "./lib/cache-key.js"
import type {CacheResult} from "./lib/types.js"
import type {ReactionContext} from "./lib/agent/types.js"
import * as core from "@actions/core"
import {restoreCache, saveCache} from "./lib/cache.js"
import {parseActionInputs} from "./lib/inputs.js"
import {createLogger} from "./lib/logger.js"
import {setActionOutputs} from "./lib/outputs.js"
import {
  collectAgentContext,
  buildAgentPrompt,
  executeOpenCode,
  acknowledgeReceipt,
  completeAcknowledgment,
} from "./lib/agent/index.js"
import {
  getGitHubRefName,
  getGitHubRepository,
  getGitHubRunId,
  getOpenCodeAuthPath,
  getOpenCodeStoragePath,
  getRunnerOS,
} from "./utils/env.js"

async function run(): Promise<void> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: "bootstrap"})

  let reactionCtx: ReactionContext | null = null
  let agentSuccess = false

  try {
    bootstrapLogger.info("Starting Fro Bot Agent (SDK Mode)")

    // 1. Parse and validate action inputs
    const inputsResult = parseActionInputs()

    if (!inputsResult.success) {
      core.setFailed(`Invalid inputs: ${inputsResult.error.message}`)
      return
    }

    const inputs = inputsResult.data
    const logger = createLogger({phase: "main"})

    // 2. Collect GitHub context
    const contextLogger = createLogger({phase: "context"})
    const agentContext = collectAgentContext(contextLogger)

    // 3. Build reaction context for acknowledgment
    const botLogin = process.env["BOT_LOGIN"] ?? null
    reactionCtx = {
      repo: agentContext.repo,
      commentId: agentContext.commentId,
      issueNumber: agentContext.issueNumber,
      issueType: agentContext.issueType,
      botLogin,
    }

    // 4. Acknowledge receipt immediately
    const ackLogger = createLogger({phase: "acknowledgment"})
    await acknowledgeReceipt(reactionCtx, ackLogger)

    // 5. Restore cache
    const cacheComponents: CacheKeyComponents = {
      agentIdentity: "github",
      repo: getGitHubRepository(),
      ref: getGitHubRefName(),
      os: getRunnerOS(),
    }

    const cacheLogger = createLogger({phase: "cache"})
    const cacheResult: CacheResult = await restoreCache({
      components: cacheComponents,
      logger: cacheLogger,
      storagePath: getOpenCodeStoragePath(),
      authPath: getOpenCodeAuthPath(),
    })

    const cacheStatus = cacheResult.corrupted ? "corrupted" : cacheResult.hit ? "hit" : "miss"

    // 6. Build agent prompt
    const promptLogger = createLogger({phase: "prompt"})
    const promptText = buildAgentPrompt(
      {
        context: agentContext,
        customPrompt: inputs.prompt,
        cacheStatus,
      },
      promptLogger,
    )

    // 7. Execute with SDK (via executeOpenCode)
    const execLogger = createLogger({phase: "execution"})

    // Note: opencodePath parameter is deprecated in SDK mode (passed as null)
    const result = await executeOpenCode(promptText, null, execLogger)

    agentSuccess = result.success

    // 8. Set outputs
    const duration = Date.now() - startTime

    setActionOutputs({
      sessionId: result.sessionId,
      cacheStatus,
      duration,
    })

    if (!result.success) {
      core.setFailed(`Agent execution failed: ${result.error ?? "Unknown error"}`)
    } else {
      logger.info("Agent run completed successfully", {durationMs: duration})
    }
  } catch (error) {
    const duration = Date.now() - startTime

    setActionOutputs({
      sessionId: null,
      cacheStatus: "miss",
      duration,
    })

    if (error instanceof Error) {
      bootstrapLogger.error("Agent failed", {error: error.message})
      core.setFailed(error.message)
    } else {
      bootstrapLogger.error("Agent failed with unknown error")
      core.setFailed("An unknown error occurred")
    }
  } finally {
    try {
      if (reactionCtx != null) {
        const cleanupLogger = createLogger({phase: "cleanup"})
        await completeAcknowledgment(reactionCtx, agentSuccess, cleanupLogger)
      }

      const cacheComponents: CacheKeyComponents = {
        agentIdentity: "github",
        repo: getGitHubRepository(),
        ref: getGitHubRefName(),
        os: getRunnerOS(),
      }

      const cacheLogger = createLogger({phase: "cache-save"})
      await saveCache({
        components: cacheComponents,
        runId: getGitHubRunId(),
        logger: cacheLogger,
        storagePath: getOpenCodeStoragePath(),
        authPath: getOpenCodeAuthPath(),
      })
    } catch {
      // Cleanup failures should not mask the original error
    }
  }
}

await run()
```

---

## Action Input Changes

RFC-013 requires updates to `action.yaml`:

```yaml
inputs:
  # ... existing inputs ...

  agent:
    description: "Agent to use (default: Sisyphus). Must be a primary agent, not subagent."
    required: false
    default: "Sisyphus"

  model:
    description: "Model override (format: provider/model). If not set, uses agent's configured model."
    required: false

  timeout:
    description: "Execution timeout in milliseconds. 0 = no timeout. Default: 1800000 (30 minutes)"
    required: false
    default: "1800000"
```

**Key changes from RFC-012:**

- `agent` input with default `"Sisyphus"` (oMo's default agent)
- `model` input is now **optional** — if not provided, uses the agent's configured model
- Follows the pattern from [oh-my-opencode runner.ts](https://github.com/code-yeongyu/oh-my-opencode/blob/dev/src/cli/run/runner.ts)

---

## Acceptance Criteria

### OpenCode Server Lifecycle

- [x] Server spawned via `opencode serve --hostname=127.0.0.1 --port=4096`
- [x] SDK client created via `createOpencodeClient({ baseUrl: url })`
- [x] Connection verified with retry loop (30 retries, 300ms delay)
- [x] Server process killed on completion, error, or signal

### Model & Agent Configuration

- [x] `agent` input defaults to `"Sisyphus"` if not provided
- [x] `model` input is parsed as `provider/model` format when provided; if not provided, uses agent's configured model
- [x] Invalid model format produces clear error message
- [x] Agent validated against `client.agent.list()`
- [x] Non-primary agents fall back to default with warning
- [x] Missing agents fall back to default with warning

### Session Lifecycle

- [x] Session created via `client.session.create()`
- [x] Session ID tracked throughout execution
- [x] Prompt sent via `client.session.prompt()` (synchronous, waits for completion)
- [x] Session ID included in action outputs

### Event Subscription

- [x] Events subscribed via SSE at `${serverUrl}/event`
- [x] Tool completion events logged
- [x] Text response completion logged
- [x] Session update events tracked

### Completion Detection

- [x] `client.session.prompt()` is synchronous (waits for response)
- [x] Text response extracted from `promptResponse.data.parts`
- [x] Proper exit codes (0=success, 1=error, 130=timeout)

### Timeout & Cancellation

- [x] Configurable timeout via `timeout` input
- [x] 0 = no timeout (infinite)
- [x] Default: 30 minutes (1800000ms)
- [x] Timeout kills server process
- [x] Server closed on timeout

### Cleanup

- [x] `server.close()` (proc.kill()) called on completion
- [x] `server.close()` called on error
- [x] `server.close()` called on timeout
- [x] Cleanup failures don't mask original errors

---

## Test Cases

Tests are colocated in `src/lib/agent/opencode.test.ts`, rewritten to mock `@opencode-ai/sdk` and `child_process`.

### executeOpenCode

```typescript
import {describe, it, expect, vi, beforeEach, afterEach} from "vitest"
import {executeOpenCode, parseModelInput, verifyOpenCodeAvailable} from "./opencode.js"

// Mock child_process
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}))

// Mock the SDK
vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: vi.fn(),
}))

describe("executeOpenCode", () => {
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Note: INPUT_MODEL is now optional, not setting it uses agent's configured model
    delete process.env["INPUT_MODEL"]
    delete process.env["INPUT_AGENT"]
  })

  afterEach(() => {
    delete process.env["INPUT_MODEL"]
    delete process.env["INPUT_AGENT"]
  })

  it("spawns opencode server and returns success with sessionId", async () => {
    // #given
    const mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc)

    const mockClient = createMockClient({
      promptResponse: {parts: [{type: "text", text: "Response"}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient)

    // #when
    const result = await executeOpenCode("test prompt", null, mockLogger)

    // #then
    expect(spawn).toHaveBeenCalledWith("opencode", ["serve", "--hostname=127.0.0.1", "--port=4096"], expect.any(Object))
    expect(result.success).toBe(true)
    expect(result.sessionId).toBe("ses_123")
    expect(result.exitCode).toBe(0)
  })

  it("uses Sisyphus as default agent when INPUT_AGENT not set", async () => {
    // #given
    const mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc)

    const mockClient = createMockClient({
      promptResponse: {parts: [{type: "text", text: "Response"}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient)

    // #when
    await executeOpenCode("test prompt", null, mockLogger)

    // #then
    expect(mockClient.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          agent: "Sisyphus",
        }),
      }),
    )
  })

  it("uses agent's configured model when INPUT_MODEL not set", async () => {
    // #given
    const mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc)

    const mockClient = createMockClient({
      promptResponse: {parts: [{type: "text", text: "Response"}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient)

    // #when
    await executeOpenCode("test prompt", null, mockLogger)

    // #then
    // Should NOT include providerID/modelID when model not specified
    expect(mockClient.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.objectContaining({
          providerID: expect.any(String),
          modelID: expect.any(String),
        }),
      }),
    )
  })

  it("includes model override when INPUT_MODEL is set", async () => {
    // #given
    process.env["INPUT_MODEL"] = "anthropic/claude-sonnet-4-20250514"
    const mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc)

    const mockClient = createMockClient({
      promptResponse: {parts: [{type: "text", text: "Response"}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient)

    // #when
    await executeOpenCode("test prompt", null, mockLogger)

    // #then
    expect(mockClient.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          agent: "Sisyphus",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        }),
      }),
    )
  })

  it("uses custom opencodePath when provided", async () => {
    // #given
    const mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc)

    const mockClient = createMockClient({
      promptResponse: {parts: [{type: "text", text: "Response"}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient)

    // #when
    await executeOpenCode("test prompt", "/custom/opencode", mockLogger)

    // #then
    expect(spawn).toHaveBeenCalledWith("/custom/opencode", expect.any(Array), expect.any(Object))
  })

  it("returns failure when chat throws error", async () => {
    // #given
    const mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc)

    const mockClient = createMockClient({throwOnPrompt: true})
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient)

    // #when
    const result = await executeOpenCode("test prompt", null, mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain("Chat failed")
  })

  it("kills server process on completion", async () => {
    // #given
    const mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc)

    const mockClient = createMockClient({
      promptResponse: {parts: [{type: "text", text: "Response"}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient)

    // #when
    await executeOpenCode("test prompt", null, mockLogger)

    // #then
    expect(mockProc.kill).toHaveBeenCalled()
  })

  it("kills server process on error", async () => {
    // #given
    const mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc)

    const mockClient = createMockClient({throwOnPrompt: true})
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient)

    // #when
    await executeOpenCode("test prompt", null, mockLogger)

    // #then
    expect(mockProc.kill).toHaveBeenCalled()
  })
})
```

### parseModelInput

```typescript
describe("parseModelInput", () => {
  it("parses valid provider/model format", () => {
    const result = parseModelInput("anthropic/claude-sonnet-4-20250514")
    expect(result.providerID).toBe("anthropic")
    expect(result.modelID).toBe("claude-sonnet-4-20250514")
  })

  it("handles models with multiple slashes", () => {
    // Provider is first segment, model is rest joined
    const result = parseModelInput("openai/gpt-4/turbo")
    expect(result.providerID).toBe("openai")
    expect(result.modelID).toBe("gpt-4/turbo")
  })

  it("rejects missing provider", () => {
    expect(() => parseModelInput("/model")).toThrow(/Invalid model format/)
  })

  it("rejects missing model", () => {
    expect(() => parseModelInput("provider/")).toThrow(/Invalid model format/)
  })

  it("rejects no separator", () => {
    expect(() => parseModelInput("model-only")).toThrow(/Invalid model format/)
  })
})
```

### verifyOpenCodeAvailable

```typescript
describe("verifyOpenCodeAvailable", () => {
  it("succeeds when opencode --version exits 0", async () => {
    // #given
    const mockProc = createMockProcess({exitCode: 0})
    vi.mocked(spawn).mockReturnValue(mockProc)

    // #when / #then
    await expect(verifyOpenCodeAvailable(null, mockLogger)).resolves.not.toThrow()
  })

  it("throws when opencode --version fails", async () => {
    // #given
    const mockProc = createMockProcess({exitCode: 1})
    vi.mocked(spawn).mockReturnValue(mockProc)

    // #when / #then
    await expect(verifyOpenCodeAvailable(null, mockLogger)).rejects.toThrow(/OpenCode not available/)
  })
})
```

### Test Helpers

```typescript
function createMockProcess(options: {exitCode?: number} = {}) {
  const {exitCode = 0} = options
  const listeners: Record<string, Function[]> = {}

  const mockProc = {
    kill: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
      // Auto-trigger close for --version checks
      if (event === "close") {
        setTimeout(() => cb(exitCode), 10)
      }
      return mockProc
    }),
    stderr: {
      on: vi.fn(),
    },
  }

  return mockProc as unknown as ChildProcess
}

function createMockClient(options: {
  promptResponse?: {parts: Array<{type: string; text?: string}>}
  throwOnPrompt?: boolean
}) {
  return {
    app: {
      log: vi.fn().mockResolvedValue({}),
    },
    session: {
      create: vi.fn().mockResolvedValue({data: {id: "ses_123", title: "Test", version: "1"}}),
      prompt: options.throwOnPrompt
        ? vi.fn().mockRejectedValue(new Error("Prompt failed"))
        : vi.fn().mockResolvedValue({data: options.promptResponse}),
    },
    agent: {
      list: vi.fn().mockResolvedValue({data: []}),
    },
  }
}
```

---

## Security Considerations

1. **Server Process**: SDK server runs as child process; ensure proper cleanup
2. **Timeout Protection**: Default 30-minute timeout prevents runaway execution
3. **Signal Handling**: Graceful shutdown on SIGINT/SIGTERM
4. **Error Isolation**: SDK errors don't expose internal state in logs
5. **Agent Validation**: Prevents using subagents that may have different permissions

---

## Migration from RFC-012

RFC-012's CLI execution is replaced **in-place** by this RFC. The exported API (`executeOpenCode()`) remains stable—only the internal implementation changes.

| File | Status | Notes |
| --- | --- | --- |
| `src/lib/agent/context.ts` | UNCHANGED | Context collection remains the same |
| `src/lib/agent/prompt.ts` | UNCHANGED | Prompt construction remains the same |
| `src/lib/agent/reactions.ts` | UNCHANGED | Reactions/labels remain the same |
| `src/lib/agent/types.ts` | UPDATED | SDK types merged (ModelConfig, PromptPart, AgentResult.sessionId) |
| `src/lib/agent/opencode.ts` | REPLACED | CLI internals replaced with SDK; API signature unchanged |
| `src/lib/agent/index.ts` | UPDATED | Exports parseModelInput; no new paths |
| `src/lib/agent/opencode.test.ts` | REWRITTEN | Tests mock `@opencode-ai/sdk` instead of `@actions/exec` |
| `src/main.ts` | MINIMAL CHANGE | Continues calling executeOpenCode(); no SDK imports |

### Backward Compatibility

- `executeOpenCode(prompt, opencodePath, logger)` signature is **unchanged**
- `opencodePath` parameter is **deprecated** (ignored in SDK mode, kept for API stability)
- `AgentResult` now includes `sessionId: string | null` (additive, non-breaking)
- Callers do not need to change

---

## Dependencies

### New Package Dependency

```json
{
  "dependencies": {
    "@opencode-ai/sdk": "^0.1.0"
  }
}
```

---

## Estimated Effort

- **Development**: 12-16 hours (reduced: consolidated into single file)
- **Testing**: 4-6 hours (rewrite existing tests, not new test files)
- **Integration**: 2-4 hours (minimal main.ts changes)
- **Total**: 18-26 hours

---

## Implementation Notes

1. **SDK Package**: Requires `@opencode-ai/sdk` package (verify exact version)
2. **Event Types**: Event type names may vary from SDK version; verify against actual SDK
3. **Agent List API**: Verify exact API shape for `client.agent.list()`
4. **Session State**: Verify exact event names for session idle/error/active states
5. **Prompt Parts**: File attachment support deferred to RFC for attachments (PRD section H)

---

## Completion Notes

**Completed:** 2026-01-10

### Implementation Summary

RFC-013 SDK Execution Mode has been fully implemented, replacing CLI-based execution from RFC-012 with `@opencode-ai/sdk`.

### Files Changed

| File                             | Change                                          |
| -------------------------------- | ----------------------------------------------- |
| `package.json`                   | Added `@opencode-ai/sdk` dependency             |
| `tsdown.config.ts`               | Added SDK to bundled dependencies               |
| `action.yaml`                    | Added `agent`, `model`, `timeout` inputs        |
| `src/lib/inputs.ts`              | Added `parseModelInput()` + new field parsing   |
| `src/lib/types.ts`               | Added `ModelConfig` interface                   |
| `src/lib/agent/types.ts`         | Added `ExecutionConfig`, `PromptPart`           |
| `src/lib/agent/opencode.ts`      | Replaced CLI spawning with SDK client           |
| `src/lib/agent/index.ts`         | Updated exports                                 |
| `src/main.ts`                    | Passes `ExecutionConfig` to `executeOpenCode()` |
| `src/lib/agent/opencode.test.ts` | Rewrote 19 tests for SDK mode                   |
| `src/lib/inputs.test.ts`         | Added 6 tests for `parseModelInput()`           |

### Verification

- **Type check**: ✓ Pass
- **Lint**: ✓ Pass
- **Tests**: ✓ 349 tests passed
- **Build**: ✓ 154KB main.js, 23KB setup.js
- **Diagnostics**: ✓ No errors
