# RFC-007: Observability & Run Summary

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2

---

## Summary

Implement comprehensive observability: structured run summaries in GitHub comments, job summaries in Actions UI, and consistent logging. Every agent interaction must be traceable and auditable.

## Dependencies

- **Builds Upon:** RFC-001 (Types), RFC-003 (GitHub Client), RFC-004 (Session)
- **Enables:** RFC-008 (Comments)

## Features Addressed

| Feature ID | Feature Name               | Priority |
| ---------- | -------------------------- | -------- |
| F20        | Run Summary in Comments    | P0       |
| F30        | GitHub Actions Job Summary | P0       |
| F31        | Structured Logging         | P0       |
| F32        | Token Usage Reporting      | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── observability/
│   ├── types.ts          # Observability types
│   ├── run-summary.ts    # Run summary generation
│   ├── job-summary.ts    # GitHub Actions job summary
│   ├── metrics.ts        # Metrics collection
│   └── index.ts          # Public exports
```

### 2. Observability Types (`src/lib/observability/types.ts`)

```typescript
export interface RunMetrics {
  readonly startTime: number
  readonly endTime: number | null
  readonly duration: number | null
  readonly cacheStatus: "hit" | "miss" | "corrupted"
  readonly sessionsUsed: string[]
  readonly sessionsCreated: string[]
  readonly prsCreated: string[]
  readonly commitsCreated: string[]
  readonly commentsPosted: number
  readonly tokenUsage: TokenUsage | null
  readonly errors: ErrorRecord[]
}

export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly model: string | null
}

export interface ErrorRecord {
  readonly timestamp: string
  readonly type: string
  readonly message: string
  readonly recoverable: boolean
}

export interface RunSummaryOptions {
  readonly eventType: string
  readonly repo: string
  readonly ref: string
  readonly runId: number
  readonly runUrl: string
  readonly metrics: RunMetrics
}
```

### 3. Run Summary Generation (`src/lib/observability/run-summary.ts`)

```typescript
import type {RunSummaryOptions, RunMetrics} from "./types.js"
import {BOT_COMMENT_MARKER} from "../github/types.js"

/**
 * Generate markdown summary for GitHub comments.
 *
 * Format: Collapsed details block with run metadata.
 */
export function generateCommentSummary(options: RunSummaryOptions): string {
  const {eventType, repo, ref, runId, runUrl, metrics} = options

  const rows: string[] = []

  rows.push(`| Field | Value |`)
  rows.push(`| ----- | ----- |`)
  rows.push(`| Event | \`${eventType}\` |`)
  rows.push(`| Repo | \`${repo}\` |`)
  rows.push(`| Ref | \`${ref}\` |`)
  rows.push(`| Run ID | [${runId}](${runUrl}) |`)
  rows.push(`| Cache | ${formatCacheStatus(metrics.cacheStatus)} |`)

  if (metrics.sessionsUsed.length > 0) {
    rows.push(`| Sessions Used | ${metrics.sessionsUsed.join(", ")} |`)
  }

  if (metrics.sessionsCreated.length > 0) {
    rows.push(`| Sessions Created | ${metrics.sessionsCreated.join(", ")} |`)
  }

  if (metrics.duration != null) {
    rows.push(`| Duration | ${formatDuration(metrics.duration)} |`)
  }

  if (metrics.tokenUsage != null) {
    rows.push(`| Tokens | ${formatTokenUsage(metrics.tokenUsage)} |`)
  }

  if (metrics.prsCreated.length > 0) {
    rows.push(`| PRs Created | ${metrics.prsCreated.map(pr => `#${pr}`).join(", ")} |`)
  }

  if (metrics.commitsCreated.length > 0) {
    const shortShas = metrics.commitsCreated.map(sha => sha.slice(0, 7))
    rows.push(`| Commits | ${shortShas.join(", ")} |`)
  }

  if (metrics.errors.length > 0) {
    const errorCount = metrics.errors.length
    const recoverableCount = metrics.errors.filter(e => e.recoverable).length
    rows.push(`| Errors | ${errorCount} (${recoverableCount} recovered) |`)
  }

  const table = rows.join("\n")

  return `
${BOT_COMMENT_MARKER}
<details>
<summary>Run Summary</summary>

${table}

</details>
`.trim()
}

/**
 * Generate full comment body with summary appended.
 */
export function appendSummaryToComment(body: string, options: RunSummaryOptions): string {
  const summary = generateCommentSummary(options)
  return `${body}\n\n---\n\n${summary}`
}

/**
 * Extract existing summary from comment body (for updates).
 */
export function extractSummaryFromComment(body: string): string | null {
  const marker = BOT_COMMENT_MARKER
  const markerIndex = body.indexOf(marker)

  if (markerIndex === -1) {
    return null
  }

  return body.slice(markerIndex)
}

/**
 * Replace summary in comment body.
 */
export function replaceSummaryInComment(body: string, options: RunSummaryOptions): string {
  const existingSummary = extractSummaryFromComment(body)

  if (existingSummary == null) {
    return appendSummaryToComment(body, options)
  }

  const newSummary = generateCommentSummary(options)
  const bodyWithoutSummary = body.slice(0, body.indexOf(BOT_COMMENT_MARKER)).trimEnd()

  return `${bodyWithoutSummary}\n\n---\n\n${newSummary}`
}

function formatCacheStatus(status: "hit" | "miss" | "corrupted"): string {
  switch (status) {
    case "hit":
      return "✅ hit"
    case "miss":
      return "🆕 miss"
    case "corrupted":
      return "⚠️ corrupted (clean start)"
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

function formatTokenUsage(usage: TokenUsage): string {
  const total = usage.input + usage.output
  const formatted = `${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out`
  if (usage.model != null) {
    return `${formatted} (${usage.model})`
  }
  return formatted
}
```

### 4. GitHub Actions Job Summary (`src/lib/observability/job-summary.ts`)

```typescript
import * as core from "@actions/core"
import type {RunSummaryOptions, RunMetrics} from "./types.js"

/**
 * Write job summary to GitHub Actions UI.
 */
export async function writeJobSummary(options: RunSummaryOptions): Promise<void> {
  const {eventType, repo, ref, runId, metrics} = options

  const summary = core.summary.addHeading("Fro Bot Agent Run", 2).addTable([
    [
      {data: "Field", header: true},
      {data: "Value", header: true},
    ],
    ["Event", eventType],
    ["Repository", repo],
    ["Ref", ref],
    ["Run ID", String(runId)],
    ["Cache Status", metrics.cacheStatus],
    ["Duration", metrics.duration != null ? `${Math.round(metrics.duration / 1000)}s` : "N/A"],
  ])

  // Sessions section
  if (metrics.sessionsUsed.length > 0 || metrics.sessionsCreated.length > 0) {
    summary.addHeading("Sessions", 3)

    if (metrics.sessionsUsed.length > 0) {
      summary.addRaw(`**Used:** ${metrics.sessionsUsed.join(", ")}\n`)
    }

    if (metrics.sessionsCreated.length > 0) {
      summary.addRaw(`**Created:** ${metrics.sessionsCreated.join(", ")}\n`)
    }
  }

  // Token usage section
  if (metrics.tokenUsage != null) {
    summary.addHeading("Token Usage", 3)
    summary.addTable([
      [
        {data: "Direction", header: true},
        {data: "Count", header: true},
      ],
      ["Input", metrics.tokenUsage.input.toLocaleString()],
      ["Output", metrics.tokenUsage.output.toLocaleString()],
      ["Total", (metrics.tokenUsage.input + metrics.tokenUsage.output).toLocaleString()],
    ])

    if (metrics.tokenUsage.model != null) {
      summary.addRaw(`Model: ${metrics.tokenUsage.model}\n`)
    }
  }

  // Created artifacts section
  if (metrics.prsCreated.length > 0 || metrics.commitsCreated.length > 0) {
    summary.addHeading("Created Artifacts", 3)

    if (metrics.prsCreated.length > 0) {
      summary.addList(metrics.prsCreated.map(pr => `PR #${pr}`))
    }

    if (metrics.commitsCreated.length > 0) {
      summary.addList(metrics.commitsCreated.map(sha => `Commit \`${sha.slice(0, 7)}\``))
    }
  }

  // Errors section
  if (metrics.errors.length > 0) {
    summary.addHeading("Errors", 3)

    for (const error of metrics.errors) {
      const status = error.recoverable ? "🔄 Recovered" : "❌ Failed"
      summary.addRaw(`- **${error.type}** (${status}): ${error.message}\n`)
    }
  }

  await summary.write()
}
```

### 5. Metrics Collection (`src/lib/observability/metrics.ts`)

```typescript
import type {RunMetrics, TokenUsage, ErrorRecord} from "./types.js"

/**
 * Create a new metrics collector.
 */
export function createMetricsCollector(): MetricsCollector {
  return new MetricsCollectorImpl()
}

export interface MetricsCollector {
  start(): void
  end(): void
  setCacheStatus(status: "hit" | "miss" | "corrupted"): void
  addSessionUsed(sessionId: string): void
  addSessionCreated(sessionId: string): void
  addPRCreated(prNumber: string): void
  addCommitCreated(sha: string): void
  incrementComments(): void
  setTokenUsage(usage: TokenUsage): void
  recordError(type: string, message: string, recoverable: boolean): void
  getMetrics(): RunMetrics
}

class MetricsCollectorImpl implements MetricsCollector {
  private startTime: number = 0
  private endTime: number | null = null
  private cacheStatus: "hit" | "miss" | "corrupted" = "miss"
  private sessionsUsed: string[] = []
  private sessionsCreated: string[] = []
  private prsCreated: string[] = []
  private commitsCreated: string[] = []
  private commentsPosted: number = 0
  private tokenUsage: TokenUsage | null = null
  private errors: ErrorRecord[] = []

  start(): void {
    this.startTime = Date.now()
  }

  end(): void {
    this.endTime = Date.now()
  }

  setCacheStatus(status: "hit" | "miss" | "corrupted"): void {
    this.cacheStatus = status
  }

  addSessionUsed(sessionId: string): void {
    if (!this.sessionsUsed.includes(sessionId)) {
      this.sessionsUsed.push(sessionId)
    }
  }

  addSessionCreated(sessionId: string): void {
    if (!this.sessionsCreated.includes(sessionId)) {
      this.sessionsCreated.push(sessionId)
    }
  }

  addPRCreated(prNumber: string): void {
    if (!this.prsCreated.includes(prNumber)) {
      this.prsCreated.push(prNumber)
    }
  }

  addCommitCreated(sha: string): void {
    if (!this.commitsCreated.includes(sha)) {
      this.commitsCreated.push(sha)
    }
  }

  incrementComments(): void {
    this.commentsPosted++
  }

  setTokenUsage(usage: TokenUsage): void {
    this.tokenUsage = usage
  }

  recordError(type: string, message: string, recoverable: boolean): void {
    this.errors.push({
      timestamp: new Date().toISOString(),
      type,
      message,
      recoverable,
    })
  }

  getMetrics(): RunMetrics {
    const duration = this.endTime != null ? this.endTime - this.startTime : Date.now() - this.startTime

    return {
      startTime: this.startTime,
      endTime: this.endTime,
      duration,
      cacheStatus: this.cacheStatus,
      sessionsUsed: [...this.sessionsUsed],
      sessionsCreated: [...this.sessionsCreated],
      prsCreated: [...this.prsCreated],
      commitsCreated: [...this.commitsCreated],
      commentsPosted: this.commentsPosted,
      tokenUsage: this.tokenUsage,
      errors: [...this.errors],
    }
  }
}
```

### 6. Public Exports (`src/lib/observability/index.ts`)

```typescript
export {
  generateCommentSummary,
  appendSummaryToComment,
  extractSummaryFromComment,
  replaceSummaryInComment,
} from "./run-summary.js"

export {writeJobSummary} from "./job-summary.js"

export {createMetricsCollector, type MetricsCollector} from "./metrics.js"

export type {RunMetrics, TokenUsage, ErrorRecord, RunSummaryOptions} from "./types.js"
```

## Acceptance Criteria

- [ ] Comment summary includes all required fields (event, repo, ref, run ID)
- [ ] Comment summary includes cache status with visual indicators
- [ ] Comment summary includes session IDs when available
- [ ] Comment summary includes token usage when available
- [ ] Comment summary includes links to created PRs and commits
- [ ] Comment summary is formatted as collapsed `<details>` block
- [ ] Job summary appears in GitHub Actions UI
- [ ] Metrics collector tracks all required data points
- [ ] Error recording distinguishes recoverable vs fatal
- [ ] Duration is calculated and formatted correctly

## Test Cases

### Summary Generation Tests

```typescript
describe("generateCommentSummary", () => {
  it("includes all required fields", () => {
    const summary = generateCommentSummary({
      eventType: "issue_comment",
      repo: "owner/repo",
      ref: "main",
      runId: 12345,
      runUrl: "https://github.com/...",
      metrics: mockMetrics,
    })

    expect(summary).toContain("issue_comment")
    expect(summary).toContain("owner/repo")
    expect(summary).toContain("main")
    expect(summary).toContain("12345")
  })

  it("includes bot marker for identification", () => {
    const summary = generateCommentSummary(options)
    expect(summary).toContain(BOT_COMMENT_MARKER)
  })

  it("formats cache status with icons", () => {
    const hitSummary = generateCommentSummary({...options, metrics: {...metrics, cacheStatus: "hit"}})
    expect(hitSummary).toContain("✅")

    const missSummary = generateCommentSummary({...options, metrics: {...metrics, cacheStatus: "miss"}})
    expect(missSummary).toContain("🆕")
  })
})

describe("appendSummaryToComment", () => {
  it("appends summary after separator", () => {
    const body = "Main comment content"
    const result = appendSummaryToComment(body, options)

    expect(result).toContain("Main comment content")
    expect(result).toContain("---")
    expect(result).toContain("<details>")
  })
})

describe("replaceSummaryInComment", () => {
  it("replaces existing summary", () => {
    const existingBody = `Content\n\n---\n\n${BOT_COMMENT_MARKER}\n<details>old</details>`
    const result = replaceSummaryInComment(existingBody, options)

    expect(result).not.toContain("old")
    expect(result).toContain("Content")
  })
})
```

### Metrics Tests

```typescript
describe("MetricsCollector", () => {
  it("calculates duration correctly", () => {
    const collector = createMetricsCollector()
    collector.start()
    // Simulate passage of time
    collector.end()

    const metrics = collector.getMetrics()
    expect(metrics.duration).toBeGreaterThan(0)
  })

  it("deduplicates session IDs", () => {
    const collector = createMetricsCollector()
    collector.addSessionUsed("ses_123")
    collector.addSessionUsed("ses_123")

    const metrics = collector.getMetrics()
    expect(metrics.sessionsUsed).toHaveLength(1)
  })

  it("records errors with timestamp", () => {
    const collector = createMetricsCollector()
    collector.recordError("RateLimit", "API rate limited", true)

    const metrics = collector.getMetrics()
    expect(metrics.errors).toHaveLength(1)
    expect(metrics.errors[0].timestamp).toBeDefined()
    expect(metrics.errors[0].recoverable).toBe(true)
  })
})
```

## Implementation Notes

1. **Bot marker**: Hidden HTML comment for identifying agent comments
2. **Collapsed details**: Keep summaries compact, expandable when needed
3. **Token reporting**: Depends on LLM provider exposing usage data
4. **Job summary**: Uses `@actions/core` summary API

## Estimated Effort

- **Development**: 4-6 hours
- **Testing**: 2-3 hours
- **Total**: 6-9 hours
