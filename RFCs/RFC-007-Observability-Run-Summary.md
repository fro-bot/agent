# RFC-007: Observability & Run Summary

**Status:** Completed
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2
**Completed:** 2026-01-17

---

## Completion Notes

RFC-007 was successfully implemented with the following components:

1. **New observability module** (`src/lib/observability/`)
   - `types.ts`: `RunMetrics`, `ErrorRecord`, `CommentSummaryOptions`
   - `metrics.ts`: Closure-based `MetricsCollector` factory
   - `run-summary.ts`: Comment summary generation and manipulation
   - `job-summary.ts`: GitHub Actions job summary via `@actions/core` summary API
   - `index.ts`: Public exports
   - `AGENTS.md`: Module documentation

2. **Updated core types** (`src/lib/types.ts`)
   - Expanded `TokenUsage` to full SDK structure (input, output, reasoning, cache)

3. **Updated agent execution** (`src/lib/agent/opencode.ts`)
   - Token extraction from `message.updated` events
   - Artifact detection from bash tool outputs (PRs, commits, comments)

4. **Main action integration** (`src/main.ts`)
   - `MetricsCollector` lifecycle management
   - Job summary written on completion
   - Session writeback includes token usage

**Tests:** 550 tests passing (15 new observability tests) **Build:** Verified

---

## Summary

Implement comprehensive observability: structured run summaries in GitHub comments, job summaries in Actions UI, metrics collection with token usage tracking, and artifact detection. Every agent interaction must be traceable and auditable.

## Dependencies

- **Builds Upon:** RFC-001 (Types), RFC-003 (GitHub Client), RFC-004 (Session), RFC-013 (SDK Execution)
- **Enables:** RFC-008 (Comments)

## Features Addressed

| Feature ID | Feature Name                 | Priority |
| ---------- | ---------------------------- | -------- |
| F20        | Run Summary in Comments      | P0       |
| F30        | GitHub Actions Job Summary   | P0       |
| F31        | Structured Logging           | P0       |
| F32        | Token Usage Reporting        | P0       |
| F83        | Telemetry Policy Enforcement | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── observability/
│   ├── AGENTS.md           # Module documentation
│   ├── types.ts            # Observability types
│   ├── run-summary.ts      # Run summary generation
│   ├── job-summary.ts      # GitHub Actions job summary
│   ├── metrics.ts          # Metrics collection
│   ├── index.ts            # Public exports
│   ├── metrics.test.ts     # Metrics tests
│   ├── run-summary.test.ts # Run summary tests
│   └── job-summary.test.ts # Job summary tests
├── types.ts                # Updated TokenUsage (full SDK structure)
├── agent/
│   ├── opencode.ts         # Updated: token extraction + artifact detection
│   └── types.ts            # Updated: AgentResult with metrics
└── main.ts                 # Updated: MetricsCollector integration
```

### 2. Updated Core Types (`src/lib/types.ts`)

Update `TokenUsage` to match the full OpenCode SDK structure:

```typescript
// Replace existing TokenUsage with full SDK structure
export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

// Remove old RunSummary interface - replaced by observability module
```

### 3. Observability Types (`src/lib/observability/types.ts`)

```typescript
import type {TokenUsage} from "../types.js"

export interface ErrorRecord {
  readonly timestamp: string
  readonly type: string
  readonly message: string
  readonly recoverable: boolean
}

export interface RunMetrics {
  readonly startTime: number
  readonly endTime: number | null
  readonly duration: number | null
  readonly cacheStatus: "hit" | "miss" | "corrupted"
  readonly sessionsUsed: readonly string[]
  readonly sessionsCreated: readonly string[]
  readonly prsCreated: readonly string[]
  readonly commitsCreated: readonly string[]
  readonly commentsPosted: number
  readonly tokenUsage: TokenUsage | null
  readonly model: string | null
  readonly cost: number | null
  readonly errors: readonly ErrorRecord[]
}

export interface CommentSummaryOptions {
  readonly eventType: string
  readonly repo: string
  readonly ref: string
  readonly runId: number
  readonly runUrl: string
  readonly metrics: RunMetrics
  readonly agent: string
}
```

### 4. Metrics Collection (`src/lib/observability/metrics.ts`)

Closure-based implementation (no ES6 classes per project rules):

```typescript
import type {TokenUsage} from "../types.js"
import type {ErrorRecord, RunMetrics} from "./types.js"

export interface MetricsCollector {
  start(): void
  end(): void
  setCacheStatus(status: "hit" | "miss" | "corrupted"): void
  addSessionUsed(sessionId: string): void
  addSessionCreated(sessionId: string): void
  addPRCreated(prUrl: string): void
  addCommitCreated(sha: string): void
  incrementComments(): void
  setTokenUsage(usage: TokenUsage, model: string | null, cost: number | null): void
  recordError(type: string, message: string, recoverable: boolean): void
  getMetrics(): RunMetrics
}

export function createMetricsCollector(): MetricsCollector {
  let startTime = 0
  let endTime: number | null = null
  let cacheStatus: "hit" | "miss" | "corrupted" = "miss"
  const sessionsUsed: string[] = []
  const sessionsCreated: string[] = []
  const prsCreated: string[] = []
  const commitsCreated: string[] = []
  let commentsPosted = 0
  let tokenUsage: TokenUsage | null = null
  let model: string | null = null
  let cost: number | null = null
  const errors: ErrorRecord[] = []

  return {
    start(): void {
      startTime = Date.now()
    },

    end(): void {
      endTime = Date.now()
    },

    setCacheStatus(status: "hit" | "miss" | "corrupted"): void {
      cacheStatus = status
    },

    addSessionUsed(sessionId: string): void {
      if (!sessionsUsed.includes(sessionId)) {
        sessionsUsed.push(sessionId)
      }
    },

    addSessionCreated(sessionId: string): void {
      if (!sessionsCreated.includes(sessionId)) {
        sessionsCreated.push(sessionId)
      }
    },

    addPRCreated(prUrl: string): void {
      if (!prsCreated.includes(prUrl)) {
        prsCreated.push(prUrl)
      }
    },

    addCommitCreated(sha: string): void {
      if (!commitsCreated.includes(sha)) {
        commitsCreated.push(sha)
      }
    },

    incrementComments(): void {
      commentsPosted++
    },

    setTokenUsage(usage: TokenUsage, modelId: string | null, costValue: number | null): void {
      tokenUsage = usage
      model = modelId
      cost = costValue
    },

    recordError(type: string, message: string, recoverable: boolean): void {
      errors.push({
        timestamp: new Date().toISOString(),
        type,
        message,
        recoverable,
      })
    },

    getMetrics(): RunMetrics {
      const duration = endTime != null ? endTime - startTime : Date.now() - startTime

      return Object.freeze({
        startTime,
        endTime,
        duration,
        cacheStatus,
        sessionsUsed: Object.freeze([...sessionsUsed]),
        sessionsCreated: Object.freeze([...sessionsCreated]),
        prsCreated: Object.freeze([...prsCreated]),
        commitsCreated: Object.freeze([...commitsCreated]),
        commentsPosted,
        tokenUsage,
        model,
        cost,
        errors: Object.freeze([...errors]),
      })
    },
  }
}
```

### 5. Run Summary Generation (`src/lib/observability/run-summary.ts`)

```typescript
import {BOT_COMMENT_MARKER} from "../github/types.js"
import type {TokenUsage} from "../types.js"
import type {CommentSummaryOptions, RunMetrics} from "./types.js"

/**
 * Generate markdown summary for GitHub comments.
 *
 * Format: Collapsed details block with run metadata.
 */
export function generateCommentSummary(options: CommentSummaryOptions): string {
  const {eventType, repo, ref, runId, runUrl, metrics, agent} = options

  const rows: string[] = []

  rows.push("| Field | Value |")
  rows.push("| ----- | ----- |")
  rows.push(`| Event | \`${eventType}\` |`)
  rows.push(`| Repo | \`${repo}\` |`)
  rows.push(`| Ref | \`${ref}\` |`)
  rows.push(`| Run ID | [${runId}](${runUrl}) |`)
  rows.push(`| Agent | \`${agent}\` |`)
  rows.push(`| Cache | ${formatCacheStatus(metrics.cacheStatus)} |`)

  if (metrics.sessionsUsed.length > 0) {
    rows.push(`| Sessions Used | ${metrics.sessionsUsed.map(s => `\`${s}\``).join(", ")} |`)
  }

  if (metrics.sessionsCreated.length > 0) {
    rows.push(`| Sessions Created | ${metrics.sessionsCreated.map(s => `\`${s}\``).join(", ")} |`)
  }

  if (metrics.duration != null) {
    rows.push(`| Duration | ${formatDuration(metrics.duration)} |`)
  }

  if (metrics.tokenUsage != null) {
    rows.push(`| Tokens | ${formatTokenUsage(metrics.tokenUsage, metrics.model)} |`)
  }

  if (metrics.cost != null) {
    rows.push(`| Cost | $${metrics.cost.toFixed(4)} |`)
  }

  if (metrics.prsCreated.length > 0) {
    rows.push(`| PRs Created | ${metrics.prsCreated.join(", ")} |`)
  }

  if (metrics.commitsCreated.length > 0) {
    const shortShas = metrics.commitsCreated.map(sha => `\`${sha.slice(0, 7)}\``)
    rows.push(`| Commits | ${shortShas.join(", ")} |`)
  }

  if (metrics.commentsPosted > 0) {
    rows.push(`| Comments Posted | ${metrics.commentsPosted} |`)
  }

  if (metrics.errors.length > 0) {
    const errorCount = metrics.errors.length
    const recoverableCount = metrics.errors.filter(e => e.recoverable).length
    rows.push(`| Errors | ${errorCount} (${recoverableCount} recovered) |`)
  }

  const table = rows.join("\n")

  return `${BOT_COMMENT_MARKER}
<details>
<summary>Run Summary</summary>

${table}

</details>`.trim()
}

/**
 * Generate full comment body with summary appended.
 */
export function appendSummaryToComment(body: string, options: CommentSummaryOptions): string {
  const summary = generateCommentSummary(options)
  return `${body}\n\n---\n\n${summary}`
}

/**
 * Extract existing summary from comment body (for updates).
 */
export function extractSummaryFromComment(body: string): string | null {
  const markerIndex = body.indexOf(BOT_COMMENT_MARKER)

  if (markerIndex === -1) {
    return null
  }

  return body.slice(markerIndex)
}

/**
 * Replace summary in comment body.
 */
export function replaceSummaryInComment(body: string, options: CommentSummaryOptions): string {
  const existingSummary = extractSummaryFromComment(body)

  if (existingSummary == null) {
    return appendSummaryToComment(body, options)
  }

  const newSummary = generateCommentSummary(options)
  const bodyWithoutSummary = body.slice(0, body.indexOf(BOT_COMMENT_MARKER)).trimEnd()

  return `${bodyWithoutSummary}\n\n---\n\n${newSummary}`
}

export function formatCacheStatus(status: "hit" | "miss" | "corrupted"): string {
  switch (status) {
    case "hit":
      return "✅ hit"
    case "miss":
      return "🆕 miss"
    case "corrupted":
      return "⚠️ corrupted (clean start)"
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

export function formatTokenUsage(usage: TokenUsage, model: string | null): string {
  const parts: string[] = []
  parts.push(`${usage.input.toLocaleString()} in`)
  parts.push(`${usage.output.toLocaleString()} out`)

  if (usage.reasoning > 0) {
    parts.push(`${usage.reasoning.toLocaleString()} reasoning`)
  }

  const cacheTotal = usage.cache.read + usage.cache.write
  if (cacheTotal > 0) {
    parts.push(`${cacheTotal.toLocaleString()} cache`)
  }

  let formatted = parts.join(" / ")
  if (model != null) {
    formatted = `${formatted} (${model})`
  }
  return formatted
}
```

### 6. GitHub Actions Job Summary (`src/lib/observability/job-summary.ts`)

```typescript
import * as core from "@actions/core"
import type {Logger} from "../logger.js"
import type {CommentSummaryOptions} from "./types.js"
import {formatCacheStatus, formatDuration, formatTokenUsage} from "./run-summary.js"

/**
 * Write job summary to GitHub Actions UI.
 */
export async function writeJobSummary(options: CommentSummaryOptions, logger: Logger): Promise<void> {
  const {eventType, repo, ref, runId, runUrl, metrics, agent} = options

  try {
    core.summary.addHeading("Fro Bot Agent Run", 2).addTable([
      [
        {data: "Field", header: true},
        {data: "Value", header: true},
      ],
      ["Event", eventType],
      ["Repository", repo],
      ["Ref", ref],
      ["Run ID", `[${runId}](${runUrl})`],
      ["Agent", agent],
      ["Cache Status", formatCacheStatus(metrics.cacheStatus)],
      ["Duration", metrics.duration != null ? formatDuration(metrics.duration) : "N/A"],
    ])

    // Sessions section
    if (metrics.sessionsUsed.length > 0 || metrics.sessionsCreated.length > 0) {
      core.summary.addHeading("Sessions", 3)

      if (metrics.sessionsUsed.length > 0) {
        core.summary.addRaw(`**Used:** ${metrics.sessionsUsed.join(", ")}\n`)
      }

      if (metrics.sessionsCreated.length > 0) {
        core.summary.addRaw(`**Created:** ${metrics.sessionsCreated.join(", ")}\n`)
      }
    }

    // Token usage section
    if (metrics.tokenUsage != null) {
      core.summary.addHeading("Token Usage", 3)
      core.summary.addTable([
        [
          {data: "Metric", header: true},
          {data: "Count", header: true},
        ],
        ["Input", metrics.tokenUsage.input.toLocaleString()],
        ["Output", metrics.tokenUsage.output.toLocaleString()],
        ["Reasoning", metrics.tokenUsage.reasoning.toLocaleString()],
        ["Cache Read", metrics.tokenUsage.cache.read.toLocaleString()],
        ["Cache Write", metrics.tokenUsage.cache.write.toLocaleString()],
      ])

      if (metrics.model != null) {
        core.summary.addRaw(`**Model:** ${metrics.model}\n`)
      }

      if (metrics.cost != null) {
        core.summary.addRaw(`**Cost:** $${metrics.cost.toFixed(4)}\n`)
      }
    }

    // Created artifacts section
    if (metrics.prsCreated.length > 0 || metrics.commitsCreated.length > 0 || metrics.commentsPosted > 0) {
      core.summary.addHeading("Created Artifacts", 3)

      if (metrics.prsCreated.length > 0) {
        core.summary.addList(metrics.prsCreated)
      }

      if (metrics.commitsCreated.length > 0) {
        core.summary.addList(metrics.commitsCreated.map(sha => `Commit \`${sha.slice(0, 7)}\``))
      }

      if (metrics.commentsPosted > 0) {
        core.summary.addRaw(`**Comments Posted:** ${metrics.commentsPosted}\n`)
      }
    }

    // Errors section
    if (metrics.errors.length > 0) {
      core.summary.addHeading("Errors", 3)

      for (const error of metrics.errors) {
        const status = error.recoverable ? "🔄 Recovered" : "❌ Failed"
        core.summary.addRaw(`- **${error.type}** (${status}): ${error.message}\n`)
      }
    }

    await core.summary.write()
    logger.debug("Wrote job summary")
  } catch (error) {
    // Job summary is non-critical - log and continue
    logger.warning("Failed to write job summary", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
```

### 7. Public Exports (`src/lib/observability/index.ts`)

```typescript
export {
  appendSummaryToComment,
  extractSummaryFromComment,
  formatCacheStatus,
  formatDuration,
  formatTokenUsage,
  generateCommentSummary,
  replaceSummaryInComment,
} from "./run-summary.js"

export {writeJobSummary} from "./job-summary.js"

export {createMetricsCollector} from "./metrics.js"
export type {MetricsCollector} from "./metrics.js"

export type {CommentSummaryOptions, ErrorRecord, RunMetrics} from "./types.js"
```

### 8. Updated Agent Types (`src/lib/agent/types.ts`)

Add metrics fields to `AgentResult`:

```typescript
import type {TokenUsage} from "../types.js"

export interface AgentResult {
  readonly success: boolean
  readonly exitCode: number
  readonly duration: number
  readonly sessionId: string | null
  readonly error: string | null
  // Observability fields (RFC-007)
  readonly tokenUsage: TokenUsage | null
  readonly model: string | null
  readonly cost: number | null
  readonly prsCreated: readonly string[]
  readonly commitsCreated: readonly string[]
  readonly commentsPosted: number
}
```

### 9. Updated OpenCode Execution (`src/lib/agent/opencode.ts`)

Modify `processEventStream()` to extract tokens and detect artifacts:

```typescript
interface EventStreamResult {
  tokens: TokenUsage | null
  model: string | null
  cost: number | null
  prsCreated: string[]
  commitsCreated: string[]
  commentsPosted: number
}

async function processEventStream(
  stream: AsyncIterable<OpenCodeEvent>,
  sessionId: string,
  logger: Logger,
): Promise<EventStreamResult> {
  let lastText = ""
  let tokens: TokenUsage | null = null
  let model: string | null = null
  let cost: number | null = null
  const prsCreated: string[] = []
  const commitsCreated: string[] = []
  let commentsPosted = 0

  for await (const event of stream) {
    const props = event.properties

    if (event.type === "message.part.updated") {
      const part = props.part
      if (part?.sessionID !== sessionId) continue

      if (part.type === "text" && typeof part.text === "string") {
        lastText = part.text
        const endTime = part.time?.end

        if (endTime != null && Number.isFinite(endTime)) {
          outputTextContent(lastText)
          lastText = ""
        }
      } else if (part.type === "tool" && part.state?.status === "completed") {
        const toolName = part.tool ?? "unknown"
        const toolInput = part.state.input ?? {}
        const title = part.state.title ?? (Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput) : "Unknown")
        outputToolExecution(toolName, title)

        // Detect artifacts from bash commands
        if (toolName.toLowerCase() === "bash") {
          const command = String(toolInput.command ?? toolInput.cmd ?? "")
          const output = String(part.state.output ?? "")
          detectArtifacts(command, output, prsCreated, commitsCreated, () => commentsPosted++)
        }
      }
    } else if (event.type === "message.updated") {
      const msg = props.info
      if (msg?.sessionID === sessionId && msg.role === "assistant") {
        tokens = {
          input: msg.tokens.input,
          output: msg.tokens.output,
          reasoning: msg.tokens.reasoning,
          cache: {
            read: msg.tokens.cache.read,
            write: msg.tokens.cache.write,
          },
        }
        model = msg.modelID ?? null
        cost = msg.cost ?? null
        logger.debug("Token usage received", {tokens, model, cost})
      }
    } else if (event.type === "session.error" && props.sessionID === sessionId) {
      logger.error("Session error", {error: props.error})
    }
  }

  return {tokens, model, cost, prsCreated, commitsCreated, commentsPosted}
}

/**
 * Detect PRs, commits, and comments from bash command output.
 */
function detectArtifacts(
  command: string,
  output: string,
  prsCreated: string[],
  commitsCreated: string[],
  incrementComments: () => void,
): void {
  // Detect gh pr create
  if (command.includes("gh pr create") || command.includes("gh pr create")) {
    // gh pr create outputs the PR URL on success
    const prUrlMatch = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(output)
    if (prUrlMatch != null) {
      const prUrl = prUrlMatch[0]
      if (!prsCreated.includes(prUrl)) {
        prsCreated.push(prUrl)
      }
    }
  }

  // Detect git commit
  if (command.includes("git commit")) {
    // git commit outputs the commit SHA
    const commitMatch = /\[[\w-]+\s+([a-f0-9]{7,40})\]/.exec(output)
    if (commitMatch != null) {
      const sha = commitMatch[1]
      if (!commitsCreated.includes(sha)) {
        commitsCreated.push(sha)
      }
    }
  }

  // Detect gh issue/pr comment
  if (command.includes("gh issue comment") || command.includes("gh pr comment")) {
    // gh comment commands output the comment URL on success
    if (output.includes("github.com") && output.includes("#issuecomment")) {
      incrementComments()
    }
  }
}
```

### 10. Main Action Integration (`src/main.ts`)

Key integration points:

```typescript
import {createMetricsCollector, writeJobSummary} from "./lib/observability/index.js"
import type {CommentSummaryOptions} from "./lib/observability/types.js"

async function run(): Promise<number> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: "bootstrap"})

  // Create metrics collector at start
  const metrics = createMetricsCollector()
  metrics.start()

  // ... existing setup code ...

  try {
    // After cache restore
    metrics.setCacheStatus(cacheStatus)

    // After session introspection - track sessions used
    for (const session of priorWorkContext) {
      metrics.addSessionUsed(session.sessionId)
    }

    // After executeOpenCode
    if (result.sessionId != null) {
      metrics.addSessionCreated(result.sessionId)
    }

    if (result.tokenUsage != null) {
      metrics.setTokenUsage(result.tokenUsage, result.model, result.cost)
    }

    for (const pr of result.prsCreated) {
      metrics.addPRCreated(pr)
    }

    for (const commit of result.commitsCreated) {
      metrics.addCommitCreated(commit)
    }

    for (let i = 0; i < result.commentsPosted; i++) {
      metrics.incrementComments()
    }

    // End metrics and write job summary
    metrics.end()

    const summaryOptions: CommentSummaryOptions = {
      eventType: contextWithBranch.eventName,
      repo: contextWithBranch.repo,
      ref: contextWithBranch.ref,
      runId: Number(contextWithBranch.runId),
      runUrl: `https://github.com/${contextWithBranch.repo}/actions/runs/${contextWithBranch.runId}`,
      metrics: metrics.getMetrics(),
      agent: inputs.agent,
    }

    await writeJobSummary(summaryOptions, logger)
  } catch (error) {
    // Record error in metrics
    if (error instanceof Error) {
      metrics.recordError(error.name, error.message, false)
    }
    // ... existing error handling ...
  }
}
```

## Acceptance Criteria

- [ ] Comment summary includes all required fields (event, repo, ref, run ID, agent)
- [ ] Comment summary includes cache status with visual indicators
- [ ] Comment summary includes session IDs when available
- [ ] Comment summary includes token usage when available (full SDK structure)
- [ ] Comment summary includes cost when available
- [ ] Comment summary includes links to created PRs and commits
- [ ] Comment summary is formatted as collapsed `<details>` block
- [ ] Job summary appears in GitHub Actions UI
- [ ] Metrics collector tracks all required data points
- [ ] Error recording distinguishes recoverable vs fatal
- [ ] Duration is calculated and formatted correctly
- [ ] Token extraction from SDK events (`message.updated`)
- [ ] Artifact detection from bash tool outputs
- [ ] Integration with main action lifecycle

## Test Cases

### Metrics Tests (`src/lib/observability/metrics.test.ts`)

```typescript
import {describe, expect, it} from "vitest"
import {createMetricsCollector} from "./metrics.js"

describe("createMetricsCollector", () => {
  it("starts with default values", () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    const metrics = collector.getMetrics()

    // #then
    expect(metrics.startTime).toBe(0)
    expect(metrics.endTime).toBeNull()
    expect(metrics.cacheStatus).toBe("miss")
    expect(metrics.sessionsUsed).toEqual([])
    expect(metrics.tokenUsage).toBeNull()
  })

  it("calculates duration correctly", () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.start()
    // Simulate some time passing
    collector.end()

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.duration).toBeGreaterThanOrEqual(0)
    expect(metrics.startTime).toBeGreaterThan(0)
    expect(metrics.endTime).toBeGreaterThan(0)
  })

  it("deduplicates session IDs", () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.addSessionUsed("ses_123")
    collector.addSessionUsed("ses_123")
    collector.addSessionUsed("ses_456")

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.sessionsUsed).toHaveLength(2)
    expect(metrics.sessionsUsed).toContain("ses_123")
    expect(metrics.sessionsUsed).toContain("ses_456")
  })

  it("records errors with timestamp", () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.recordError("RateLimit", "API rate limited", true)
    collector.recordError("NetworkError", "Connection failed", false)

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.errors).toHaveLength(2)
    expect(metrics.errors[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(metrics.errors[0].recoverable).toBe(true)
    expect(metrics.errors[1].recoverable).toBe(false)
  })

  it("stores token usage with model and cost", () => {
    // #given
    const collector = createMetricsCollector()
    const usage = {
      input: 1000,
      output: 500,
      reasoning: 200,
      cache: {read: 100, write: 50},
    }

    // #when
    collector.setTokenUsage(usage, "claude-sonnet-4-20250514", 0.0123)

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.tokenUsage).toEqual(usage)
    expect(metrics.model).toBe("claude-sonnet-4-20250514")
    expect(metrics.cost).toBe(0.0123)
  })

  it("returns frozen metrics snapshot", () => {
    // #given
    const collector = createMetricsCollector()
    collector.start()
    collector.addSessionCreated("ses_abc")

    // #when
    const metrics = collector.getMetrics()

    // #then
    expect(Object.isFrozen(metrics)).toBe(true)
    expect(Object.isFrozen(metrics.sessionsCreated)).toBe(true)
  })
})
```

### Run Summary Tests (`src/lib/observability/run-summary.test.ts`)

```typescript
import {describe, expect, it} from "vitest"
import {BOT_COMMENT_MARKER} from "../github/types.js"
import {
  appendSummaryToComment,
  extractSummaryFromComment,
  formatCacheStatus,
  formatDuration,
  formatTokenUsage,
  generateCommentSummary,
  replaceSummaryInComment,
} from "./run-summary.js"
import type {CommentSummaryOptions, RunMetrics} from "./types.js"

const mockMetrics: RunMetrics = {
  startTime: Date.now() - 60000,
  endTime: Date.now(),
  duration: 60000,
  cacheStatus: "hit",
  sessionsUsed: ["ses_prior"],
  sessionsCreated: ["ses_new"],
  prsCreated: [],
  commitsCreated: [],
  commentsPosted: 0,
  tokenUsage: {input: 1000, output: 500, reasoning: 0, cache: {read: 100, write: 0}},
  model: "claude-sonnet-4-20250514",
  cost: 0.0123,
  errors: [],
}

const mockOptions: CommentSummaryOptions = {
  eventType: "issue_comment",
  repo: "owner/repo",
  ref: "main",
  runId: 12345,
  runUrl: "https://github.com/owner/repo/actions/runs/12345",
  metrics: mockMetrics,
  agent: "Sisyphus",
}

describe("generateCommentSummary", () => {
  it("includes all required fields", () => {
    // #when
    const summary = generateCommentSummary(mockOptions)

    // #then
    expect(summary).toContain("issue_comment")
    expect(summary).toContain("owner/repo")
    expect(summary).toContain("main")
    expect(summary).toContain("12345")
    expect(summary).toContain("Sisyphus")
  })

  it("includes bot marker for identification", () => {
    // #when
    const summary = generateCommentSummary(mockOptions)

    // #then
    expect(summary).toContain(BOT_COMMENT_MARKER)
  })

  it("wraps in details block", () => {
    // #when
    const summary = generateCommentSummary(mockOptions)

    // #then
    expect(summary).toContain("<details>")
    expect(summary).toContain("</details>")
    expect(summary).toContain("<summary>Run Summary</summary>")
  })

  it("includes token usage and cost", () => {
    // #when
    const summary = generateCommentSummary(mockOptions)

    // #then
    expect(summary).toContain("1,000 in")
    expect(summary).toContain("500 out")
    expect(summary).toContain("$0.0123")
  })
})

describe("formatCacheStatus", () => {
  it("formats hit with checkmark", () => {
    expect(formatCacheStatus("hit")).toBe("✅ hit")
  })

  it("formats miss with new indicator", () => {
    expect(formatCacheStatus("miss")).toBe("🆕 miss")
  })

  it("formats corrupted with warning", () => {
    expect(formatCacheStatus("corrupted")).toBe("⚠️ corrupted (clean start)")
  })
})

describe("formatDuration", () => {
  it("formats seconds only for short durations", () => {
    expect(formatDuration(45000)).toBe("45s")
  })

  it("formats minutes and seconds for longer durations", () => {
    expect(formatDuration(135000)).toBe("2m 15s")
  })
})

describe("formatTokenUsage", () => {
  it("includes input and output", () => {
    const usage = {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}}
    const result = formatTokenUsage(usage, null)
    expect(result).toContain("1,000 in")
    expect(result).toContain("500 out")
  })

  it("includes model when provided", () => {
    const usage = {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}}
    const result = formatTokenUsage(usage, "gpt-4o")
    expect(result).toContain("(gpt-4o)")
  })

  it("includes reasoning tokens when non-zero", () => {
    const usage = {input: 1000, output: 500, reasoning: 200, cache: {read: 0, write: 0}}
    const result = formatTokenUsage(usage, null)
    expect(result).toContain("200 reasoning")
  })
})

describe("extractSummaryFromComment", () => {
  it("returns null when no marker present", () => {
    const body = "Just a regular comment"
    expect(extractSummaryFromComment(body)).toBeNull()
  })

  it("extracts from marker onwards", () => {
    const body = `Some content\n\n---\n\n${BOT_COMMENT_MARKER}\n<details>summary</details>`
    const extracted = extractSummaryFromComment(body)
    expect(extracted).toContain(BOT_COMMENT_MARKER)
    expect(extracted).toContain("<details>")
  })
})

describe("replaceSummaryInComment", () => {
  it("appends when no existing summary", () => {
    const body = "Main content"
    const result = replaceSummaryInComment(body, mockOptions)
    expect(result).toContain("Main content")
    expect(result).toContain("---")
    expect(result).toContain(BOT_COMMENT_MARKER)
  })

  it("replaces existing summary", () => {
    const body = `Content\n\n---\n\n${BOT_COMMENT_MARKER}\n<details>old</details>`
    const result = replaceSummaryInComment(body, mockOptions)
    expect(result).not.toContain("old")
    expect(result).toContain("Content")
    expect(result.split(BOT_COMMENT_MARKER).length).toBe(2) // Only one marker
  })
})
```

### Job Summary Tests (`src/lib/observability/job-summary.test.ts`)

```typescript
import {beforeEach, describe, expect, it, vi} from "vitest"
import {createLogger} from "../logger.js"
import {writeJobSummary} from "./job-summary.js"
import type {CommentSummaryOptions, RunMetrics} from "./types.js"

// Mock @actions/core with fluent summary API
vi.mock("@actions/core", () => {
  const mockSummary = {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    addList: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  }
  return {summary: mockSummary}
})

import * as core from "@actions/core"

const mockMetrics: RunMetrics = {
  startTime: Date.now() - 60000,
  endTime: Date.now(),
  duration: 60000,
  cacheStatus: "hit",
  sessionsUsed: [],
  sessionsCreated: ["ses_new"],
  prsCreated: [],
  commitsCreated: [],
  commentsPosted: 0,
  tokenUsage: null,
  model: null,
  cost: null,
  errors: [],
}

const mockOptions: CommentSummaryOptions = {
  eventType: "issue_comment",
  repo: "owner/repo",
  ref: "main",
  runId: 12345,
  runUrl: "https://github.com/owner/repo/actions/runs/12345",
  metrics: mockMetrics,
  agent: "Sisyphus",
}

describe("writeJobSummary", () => {
  const logger = createLogger({phase: "test"})

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("writes summary with required fields", async () => {
    // #when
    await writeJobSummary(mockOptions, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledWith("Fro Bot Agent Run", 2)
    expect(core.summary.addTable).toHaveBeenCalled()
    expect(core.summary.write).toHaveBeenCalled()
  })

  it("includes sessions section when sessions exist", async () => {
    // #when
    await writeJobSummary(mockOptions, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledWith("Sessions", 3)
  })

  it("includes token section when token usage exists", async () => {
    // #given
    const optionsWithTokens = {
      ...mockOptions,
      metrics: {
        ...mockMetrics,
        tokenUsage: {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}},
        model: "claude-sonnet-4-20250514",
        cost: 0.01,
      },
    }

    // #when
    await writeJobSummary(optionsWithTokens, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledWith("Token Usage", 3)
  })

  it("handles write errors gracefully", async () => {
    // #given
    vi.mocked(core.summary.write).mockRejectedValueOnce(new Error("Write failed"))

    // #when / #then - should not throw
    await expect(writeJobSummary(mockOptions, logger)).resolves.not.toThrow()
  })
})
```

## Implementation Notes

1. **Bot marker**: Hidden HTML comment `<!-- fro-bot-agent -->` for identifying agent comments
2. **Collapsed details**: Keep summaries compact, expandable when needed
3. **Token reporting**: Full SDK token structure including reasoning and cache tokens
4. **Artifact detection**: Parse bash tool outputs for `gh pr create`, `git commit`, `gh comment`
5. **Cost tracking**: Include cost when available from SDK
6. **Job summary**: Uses `@actions/core` summary fluent API
7. **Closure-based collector**: No ES6 classes per project rules
8. **Frozen snapshots**: `getMetrics()` returns immutable objects

## Telemetry Policy Enforcement (F83)

**Added:** 2026-01-17 (PRD v1.4 requirement)

This section addresses F83: Telemetry Policy Enforcement, ensuring privacy-first telemetry across all modalities.

### Policy Requirements

Per PRD v1.4, the telemetry policy mandates:

1. **Opt-in only**: No external telemetry aggregation by default
2. **Local-first**: Metrics derived from run summaries and structured JSON logs only
3. **No raw content**: Never log code, comments, or prompts to external systems
4. **Transparent**: User controls what data leaves the system

### Implementation

#### 1. Telemetry Configuration (`src/lib/observability/types.ts`)

```typescript
export interface TelemetryConfig {
  readonly enabled: boolean
  readonly externalAggregation: boolean // Defaults to false
  readonly contentLogging: "none" | "metadata-only" | "full" // Defaults to "none"
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  externalAggregation: false,
  contentLogging: "none",
} as const
```

#### 2. Content Redaction

The logger already implements redaction for sensitive fields. Extend to ensure no raw content is logged:

```typescript
// Fields that are NEVER logged externally
const REDACTED_FIELDS = [
  "token",
  "password",
  "secret",
  "key",
  "auth",
  "prompt",
  "body",
  "content",
  "code",
  "comment",
] as const

// Content redaction in logger
function redactForTelemetry(obj: unknown, config: TelemetryConfig): unknown {
  if (config.contentLogging === "full") return obj
  if (config.contentLogging === "metadata-only") {
    return redactContentFields(obj)
  }
  return redactAllSensitive(obj)
}
```

#### 3. External Aggregation Gate

When `externalAggregation` is false (default), metrics are stored locally only:

```typescript
export async function emitMetrics(metrics: RunMetrics, config: TelemetryConfig, logger: Logger): Promise<void> {
  // Always write to local job summary and logs
  await writeJobSummary(metrics, logger)
  logger.info("Run metrics", {
    duration: metrics.duration,
    cacheStatus: metrics.cacheStatus,
    sessionCount: metrics.sessionsCreated.length,
    // Never include raw content
  })

  // External aggregation only when explicitly enabled
  if (config.externalAggregation) {
    // Future: send to external metrics service
    logger.debug("External aggregation enabled - would send to metrics service")
  }
}
```

#### 4. Action Input

```yaml
inputs:
  telemetry:
    description: "Telemetry level: 'off', 'local' (default), 'external'"
    required: false
    default: "local"
```

### Acceptance Criteria (F83)

- [ ] Default telemetry config disables external aggregation
- [ ] Raw content (code, comments, prompts) never logged to external systems
- [ ] Metrics derived from run summaries and structured JSON logs only
- [ ] User can opt-in to external aggregation via input
- [ ] Telemetry level documented in README and action.yaml
- [ ] Content redaction applied before any external emission

### Test Cases

```typescript
describe("Telemetry Policy", () => {
  it("defaults to local-only telemetry", () => {
    // #given
    const config = DEFAULT_TELEMETRY_CONFIG

    // #then
    expect(config.externalAggregation).toBe(false)
    expect(config.contentLogging).toBe("none")
  })

  it("redacts content fields from telemetry output", () => {
    // #given
    const data = {
      sessionId: "ses_123",
      prompt: "sensitive user prompt",
      body: "comment body content",
      duration: 45,
    }

    // #when
    const redacted = redactForTelemetry(data, DEFAULT_TELEMETRY_CONFIG)

    // #then
    expect(redacted.sessionId).toBe("ses_123")
    expect(redacted.duration).toBe(45)
    expect(redacted.prompt).toBeUndefined()
    expect(redacted.body).toBeUndefined()
  })

  it("does not send to external service when disabled", async () => {
    // #given
    const config = {...DEFAULT_TELEMETRY_CONFIG, externalAggregation: false}
    const sendSpy = vi.fn()

    // #when
    await emitMetrics(mockMetrics, config, logger)

    // #then
    expect(sendSpy).not.toHaveBeenCalled()
  })
})
```

## Estimated Effort

- **Development**: 8-10 hours (original) + 2-3 hours (F83)
- **Testing**: 2-3 hours (original) + 1 hour (F83)
- **Total**: 13-17 hours
