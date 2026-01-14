# RFC-005: GitHub Triggers & Event Handling

**Status:** Completed
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2
**Completed:** 2026-01-12

---

## Summary

Implement comprehensive event handling for GitHub Actions triggers: `issue_comment`, `discussion`, and `workflow_dispatch`. This RFC establishes the event routing and payload processing infrastructure.

## Dependencies

- **Builds Upon:** RFC-001 (Types), RFC-003 (GitHub Client)
- **Enables:** RFC-006 (Security), RFC-008 (Comments), RFC-009 (Reviews)

## Features Addressed

| Feature ID | Feature Name                  | Priority |
| ---------- | ----------------------------- | -------- |
| F1         | GitHub Action Trigger Support | P0       |
| F9         | Anti-Loop Protection          | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── triggers/
│   ├── types.ts          # Trigger-related types
│   ├── router.ts         # Event routing logic
│   ├── issue-comment.ts  # issue_comment handler
│   ├── discussion.ts     # discussion handler
│   ├── dispatch.ts       # workflow_dispatch handler
│   └── index.ts          # Public exports
```

### 2. Trigger Types (`src/lib/triggers/types.ts`)

```typescript
import type {GitHubContext, Octokit} from "../github/types.js"
import type {Logger} from "../types.js"

export type TriggerType = "issue_comment" | "discussion_comment" | "workflow_dispatch" | "unsupported"

export interface TriggerContext {
  readonly type: TriggerType
  readonly context: GitHubContext
  readonly target: TriggerTarget
  readonly author: AuthorInfo | null
  readonly shouldProcess: boolean
  readonly skipReason: string | null
}

export interface TriggerTarget {
  readonly kind: "issue" | "pr" | "discussion" | "manual"
  readonly number: number | null
  readonly title: string
  readonly body: string
}

export interface AuthorInfo {
  readonly login: string
  readonly association: string
  readonly isBot: boolean
}

export interface TriggerHandler {
  readonly type: TriggerType
  process(context: TriggerContext, octokit: Octokit, logger: Logger): Promise<TriggerResult>
}

export interface TriggerResult {
  readonly handled: boolean
  readonly error: Error | null
  readonly output: TriggerOutput | null
}

export interface TriggerOutput {
  readonly action: "comment" | "review" | "pr" | "none"
  readonly commentId: number | null
  readonly prNumber: number | null
}
```

### 3. Event Router (`src/lib/triggers/router.ts`)

```typescript
import type {GitHubContext, Octokit, IssueCommentPayload} from "../github/types.js"
import type {TriggerContext, TriggerType, TriggerTarget, AuthorInfo, Logger} from "./types.js"
import {BOT_COMMENT_MARKER} from "../github/types.js"
import {getBotLogin, isPullRequest} from "../github/index.js"

/**
 * Route incoming event to appropriate handler.
 */
export async function routeEvent(
  context: GitHubContext,
  octokit: Octokit,
  botLogin: string,
  logger: Logger,
): Promise<TriggerContext> {
  const type = classifyTrigger(context.eventName)

  logger.info("Routing event", {eventName: context.eventName, type})

  switch (type) {
    case "issue_comment":
      return buildIssueCommentContext(context, botLogin, logger)

    case "discussion_comment":
      return buildDiscussionContext(context, botLogin, logger)

    case "workflow_dispatch":
      return buildDispatchContext(context, logger)

    default:
      return {
        type: "unsupported",
        context,
        target: {kind: "manual", number: null, title: "", body: ""},
        author: null,
        shouldProcess: false,
        skipReason: `Unsupported event: ${context.eventName}`,
      }
  }
}

/**
 * Classify event name to trigger type.
 */
function classifyTrigger(eventName: string): TriggerType {
  switch (eventName) {
    case "issue_comment":
      return "issue_comment"
    case "discussion":
    case "discussion_comment":
      return "discussion_comment"
    case "workflow_dispatch":
      return "workflow_dispatch"
    default:
      return "unsupported"
  }
}

/**
 * Build context for issue_comment events.
 */
function buildIssueCommentContext(context: GitHubContext, botLogin: string, logger: Logger): TriggerContext {
  const payload = context.payload as IssueCommentPayload

  // Determine if this is an issue or PR
  const isPR = isPullRequest(payload)
  const kind = isPR ? "pr" : "issue"

  // Extract author info
  const author: AuthorInfo = {
    login: payload.comment.user.login,
    association: payload.comment.author_association,
    isBot: payload.comment.user.login.endsWith("[bot]"),
  }

  // Build target
  const target: TriggerTarget = {
    kind,
    number: payload.issue.number,
    title: payload.issue.title,
    body: payload.comment.body,
  }

  // Check skip conditions
  const skipConditions = checkSkipConditions(author, botLogin, payload, logger)

  return {
    type: "issue_comment",
    context,
    target,
    author,
    shouldProcess: skipConditions.shouldProcess,
    skipReason: skipConditions.reason,
  }
}

/**
 * Build context for discussion events.
 */
function buildDiscussionContext(context: GitHubContext, botLogin: string, logger: Logger): TriggerContext {
  const payload = context.payload as Record<string, unknown>
  const discussion = payload["discussion"] as Record<string, unknown> | undefined
  const comment = payload["comment"] as Record<string, unknown> | undefined

  if (discussion == null) {
    return {
      type: "discussion_comment",
      context,
      target: {kind: "discussion", number: null, title: "", body: ""},
      author: null,
      shouldProcess: false,
      skipReason: "Invalid discussion payload",
    }
  }

  const author: AuthorInfo | null =
    comment != null
      ? {
          login: String((comment["user"] as Record<string, unknown>)?.["login"] ?? ""),
          association: String(comment["author_association"] ?? ""),
          isBot: String((comment["user"] as Record<string, unknown>)?.["login"] ?? "").endsWith("[bot]"),
        }
      : null

  const target: TriggerTarget = {
    kind: "discussion",
    number: Number(discussion["number"] ?? 0),
    title: String(discussion["title"] ?? ""),
    body: comment != null ? String(comment["body"] ?? "") : String(discussion["body"] ?? ""),
  }

  // Check skip conditions
  let shouldProcess = true
  let skipReason: string | null = null

  if (author != null) {
    if (author.login === botLogin || author.login === `${botLogin}[bot]`) {
      shouldProcess = false
      skipReason = "Comment from bot itself (anti-loop)"
    }
  }

  return {
    type: "discussion_comment",
    context,
    target,
    author,
    shouldProcess,
    skipReason,
  }
}

/**
 * Build context for workflow_dispatch events.
 */
function buildDispatchContext(context: GitHubContext, logger: Logger): TriggerContext {
  const payload = context.payload as Record<string, unknown>
  const inputs = payload["inputs"] as Record<string, string> | undefined

  const target: TriggerTarget = {
    kind: "manual",
    number: null,
    title: "Manual workflow dispatch",
    body: inputs?.["prompt"] ?? "",
  }

  logger.info("Workflow dispatch triggered", {inputs})

  return {
    type: "workflow_dispatch",
    context,
    target,
    author: {login: context.actor, association: "OWNER", isBot: false},
    shouldProcess: true,
    skipReason: null,
  }
}

/**
 * Check conditions that would cause us to skip processing.
 */
function checkSkipConditions(
  author: AuthorInfo,
  botLogin: string,
  payload: IssueCommentPayload,
  logger: Logger,
): {shouldProcess: boolean; reason: string | null} {
  // Anti-loop: skip our own comments
  if (author.login === botLogin || author.login === `${botLogin}[bot]`) {
    logger.info("Skipping self-comment (anti-loop)", {author: author.login})
    return {shouldProcess: false, reason: "Comment from bot itself (anti-loop)"}
  }

  // Skip if issue is locked
  if (payload.issue.locked) {
    logger.info("Skipping locked issue", {issueNumber: payload.issue.number})
    return {shouldProcess: false, reason: "Issue is locked"}
  }

  // Skip if action is not 'created' (e.g., edited, deleted)
  if (payload.action !== "created") {
    logger.debug("Skipping non-created comment action", {action: payload.action})
    return {shouldProcess: false, reason: `Comment action is '${payload.action}', not 'created'`}
  }

  return {shouldProcess: true, reason: null}
}

/**
 * Check if comment body contains bot mention.
 */
export function hasBotMention(body: string, botLogin: string): boolean {
  const mentionPattern = new RegExp(`@${botLogin}(?:\\[bot\\])?\\b`, "i")
  return mentionPattern.test(body)
}

/**
 * Extract command from comment body (if any).
 */
export function extractCommand(body: string, botLogin: string): string | null {
  // Pattern: @bot command args
  const pattern = new RegExp(`@${botLogin}(?:\\[bot\\])?\\s+(.+)`, "i")
  const match = pattern.exec(body)
  return match != null ? match[1].trim() : null
}
```

### 4. Issue Comment Handler (`src/lib/triggers/issue-comment.ts`)

```typescript
import type {TriggerContext, TriggerResult, TriggerOutput} from "./types.js"
import type {Octokit} from "../github/types.js"
import type {Logger} from "../types.js"
import {hasBotMention, extractCommand} from "./router.js"

export async function handleIssueComment(
  triggerContext: TriggerContext,
  octokit: Octokit,
  botLogin: string,
  logger: Logger,
): Promise<TriggerResult> {
  const {target, author, shouldProcess, skipReason} = triggerContext

  if (!shouldProcess) {
    logger.info("Skipping issue comment", {reason: skipReason})
    return {
      handled: false,
      error: null,
      output: null,
    }
  }

  // Check if we're mentioned
  const mentioned = hasBotMention(target.body, botLogin)
  if (!mentioned) {
    logger.debug("Bot not mentioned, skipping")
    return {
      handled: false,
      error: null,
      output: null,
    }
  }

  // Extract command
  const command = extractCommand(target.body, botLogin)
  logger.info("Processing issue comment", {
    issueNumber: target.number,
    author: author?.login,
    command,
  })

  // TODO: Dispatch to agent for processing
  // This will be implemented in RFC-008

  return {
    handled: true,
    error: null,
    output: {
      action: "comment",
      commentId: null, // Will be set after posting
      prNumber: null,
    },
  }
}
```

### 5. Public Exports (`src/lib/triggers/index.ts`)

```typescript
export {routeEvent, hasBotMention, extractCommand} from "./router.js"
export {handleIssueComment} from "./issue-comment.js"
export type {TriggerType, TriggerContext, TriggerTarget, AuthorInfo, TriggerResult, TriggerOutput} from "./types.js"
```

## Acceptance Criteria

- [ ] `issue_comment` events are correctly classified
- [ ] `discussion` events are correctly classified
- [ ] `workflow_dispatch` events are correctly classified
- [ ] Anti-loop protection skips bot's own comments
- [ ] Locked issues are skipped with appropriate logging
- [ ] Only `created` actions are processed (not `edited`/`deleted`)
- [ ] Bot mention detection works with and without `[bot]` suffix
- [ ] Command extraction parses `@bot command args` correctly
- [ ] Issue vs PR detection works correctly
- [ ] All skip reasons are logged clearly

## Test Cases

### Event Classification Tests

```typescript
describe("classifyTrigger", () => {
  it("classifies issue_comment correctly", () => {
    expect(classifyTrigger("issue_comment")).toBe("issue_comment")
  })

  it("classifies discussion events", () => {
    expect(classifyTrigger("discussion")).toBe("discussion_comment")
    expect(classifyTrigger("discussion_comment")).toBe("discussion_comment")
  })

  it("classifies workflow_dispatch", () => {
    expect(classifyTrigger("workflow_dispatch")).toBe("workflow_dispatch")
  })

  it("marks unknown events as unsupported", () => {
    expect(classifyTrigger("push")).toBe("unsupported")
  })
})
```

### Anti-Loop Tests

```typescript
describe("checkSkipConditions", () => {
  it("skips comments from bot login", () => {
    const result = checkSkipConditions(
      {login: "fro-bot", association: "NONE", isBot: false},
      "fro-bot",
      mockPayload,
      logger,
    )
    expect(result.shouldProcess).toBe(false)
    expect(result.reason).toContain("anti-loop")
  })

  it("skips comments from bot[bot] login", () => {
    const result = checkSkipConditions(
      {login: "fro-bot[bot]", association: "NONE", isBot: true},
      "fro-bot",
      mockPayload,
      logger,
    )
    expect(result.shouldProcess).toBe(false)
  })

  it("allows comments from other users", () => {
    const result = checkSkipConditions(
      {login: "contributor", association: "MEMBER", isBot: false},
      "fro-bot",
      mockPayload,
      logger,
    )
    expect(result.shouldProcess).toBe(true)
  })
})
```

### Mention Detection Tests

```typescript
describe("hasBotMention", () => {
  it("detects @bot mention", () => {
    expect(hasBotMention("@fro-bot please help", "fro-bot")).toBe(true)
  })

  it("detects @bot[bot] mention", () => {
    expect(hasBotMention("@fro-bot[bot] review this", "fro-bot")).toBe(true)
  })

  it("returns false when not mentioned", () => {
    expect(hasBotMention("Just a regular comment", "fro-bot")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(hasBotMention("@FRO-BOT help", "fro-bot")).toBe(true)
  })
})

describe("extractCommand", () => {
  it("extracts command after mention", () => {
    expect(extractCommand("@fro-bot review this PR", "fro-bot")).toBe("review this PR")
  })

  it("returns null when no command after mention", () => {
    expect(extractCommand("@fro-bot", "fro-bot")).toBe(null)
  })
})
```

## Mock Event Support (Local Development)

### Overview

Enable local development and testing by supporting mock GitHub event payloads via environment variables.

### Environment Variables

```typescript
/**
 * Mock event environment variables.
 *
 * MOCK_EVENT: JSON payload matching GitHub webhook schema
 * MOCK_TOKEN: Authentication token for local testing
 */
interface MockEventConfig {
  readonly eventName: string
  readonly payload: Record<string, unknown>
  readonly repo: {owner: string; repo: string}
  readonly actor: string
}
```

### Implementation (`src/lib/triggers/mock.ts`)

```typescript
import type {GitHubContext} from "../github/types.js"
import type {Logger} from "../types.js"

/**
 * Check if mock event mode is enabled.
 *
 * Mock mode is only enabled when:
 * - MOCK_EVENT env var is set, AND
 * - CI env var is NOT 'true', OR allow-mock-event input is true
 */
export function isMockEventEnabled(allowMockEvent: boolean): boolean {
  const mockEvent = process.env["MOCK_EVENT"]
  const isCI = process.env["CI"] === "true"

  if (mockEvent == null || mockEvent.length === 0) {
    return false
  }

  // In CI, only allow if explicitly enabled
  if (isCI && !allowMockEvent) {
    return false
  }

  return true
}

/**
 * Parse mock event from environment.
 *
 * @throws Error if MOCK_EVENT is malformed
 */
export function parseMockEvent(logger: Logger): GitHubContext | null {
  const mockEventJson = process.env["MOCK_EVENT"]

  if (mockEventJson == null || mockEventJson.length === 0) {
    return null
  }

  try {
    const parsed = JSON.parse(mockEventJson) as {
      eventName?: string
      payload?: Record<string, unknown>
      repo?: {owner?: string; repo?: string}
      actor?: string
    }

    // Validate required fields
    if (parsed.eventName == null || parsed.eventName.length === 0) {
      throw new Error("MOCK_EVENT missing required field: eventName")
    }

    if (parsed.payload == null || typeof parsed.payload !== "object") {
      throw new Error("MOCK_EVENT missing required field: payload")
    }

    if (parsed.repo?.owner == null || parsed.repo?.repo == null) {
      throw new Error("MOCK_EVENT missing required field: repo.owner or repo.repo")
    }

    if (parsed.actor == null || parsed.actor.length === 0) {
      throw new Error("MOCK_EVENT missing required field: actor")
    }

    logger.warning("Mock event mode active - DO NOT USE IN PRODUCTION", {
      eventName: parsed.eventName,
      actor: parsed.actor,
    })

    return {
      eventName: parsed.eventName,
      payload: parsed.payload,
      repo: {
        owner: parsed.repo.owner,
        repo: parsed.repo.repo,
      },
      actor: parsed.actor,
      ref: (parsed.payload["ref"] as string | undefined) ?? "refs/heads/main",
      sha: (parsed.payload["sha"] as string | undefined) ?? "mock-sha",
      workflow: "mock-workflow",
      runId: 0,
      runNumber: 0,
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`MOCK_EVENT is not valid JSON: ${error.message}`)
    }
    throw error
  }
}

/**
 * Get mock token from environment.
 */
export function getMockToken(): string | null {
  return process.env["MOCK_TOKEN"] ?? null
}

/**
 * Get share URL base based on mock mode.
 */
export function getShareUrlBase(isMockMode: boolean): string {
  return isMockMode ? "https://dev.opencode.ai" : "https://opencode.ai"
}
```

### Security Constraints

| Constraint                | Implementation                                       |
| ------------------------- | ---------------------------------------------------- |
| Disabled in CI by default | Check `CI !== 'true'` OR `allow-mock-event: true`    |
| Explicit opt-in required  | `allow-mock-event` input must be `true` in workflows |
| Warning logged            | Always log warning when mock mode is active          |
| Production guard          | Document as development-only feature                 |

### Action Input

```yaml
inputs:
  allow-mock-event:
    description: "Allow MOCK_EVENT env var for local testing (default: false)"
    required: false
    default: "false"
```

### Test Cases

```typescript
describe("isMockEventEnabled", () => {
  it("returns false when MOCK_EVENT not set", () => {
    delete process.env["MOCK_EVENT"]
    expect(isMockEventEnabled(false)).toBe(false)
  })

  it("returns true when MOCK_EVENT set and not in CI", () => {
    process.env["MOCK_EVENT"] = '{"eventName":"issue_comment"}'
    delete process.env["CI"]
    expect(isMockEventEnabled(false)).toBe(true)
  })

  it("returns false in CI without explicit allow", () => {
    process.env["MOCK_EVENT"] = '{"eventName":"issue_comment"}'
    process.env["CI"] = "true"
    expect(isMockEventEnabled(false)).toBe(false)
  })

  it("returns true in CI with explicit allow", () => {
    process.env["MOCK_EVENT"] = '{"eventName":"issue_comment"}'
    process.env["CI"] = "true"
    expect(isMockEventEnabled(true)).toBe(true)
  })
})

describe("parseMockEvent", () => {
  it("parses valid mock event", () => {
    process.env["MOCK_EVENT"] = JSON.stringify({
      eventName: "issue_comment",
      payload: {action: "created"},
      repo: {owner: "test", repo: "repo"},
      actor: "user",
    })
    const result = parseMockEvent(mockLogger)
    expect(result?.eventName).toBe("issue_comment")
  })

  it("throws on invalid JSON", () => {
    process.env["MOCK_EVENT"] = "not-json"
    expect(() => parseMockEvent(mockLogger)).toThrow(/not valid JSON/)
  })

  it("throws on missing required fields", () => {
    process.env["MOCK_EVENT"] = JSON.stringify({eventName: "test"})
    expect(() => parseMockEvent(mockLogger)).toThrow(/missing required field/)
  })
})
```

---

## Implementation Notes

1. **Event payload typing**: GitHub payloads are complex; types cover common fields
2. **Mention patterns**: Support both `@bot` and `@bot[bot]` for GitHub Apps
3. **Extensibility**: Router pattern allows easy addition of new triggers
4. **Mock event security**: Disabled in CI by default, requires explicit opt-in

---

## Estimated Effort

- **Development**: 4-6 hours
- **Testing**: 2-3 hours
- **Total**: 6-9 hours
