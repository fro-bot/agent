# RFC-003: GitHub API Client Layer

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 1

---

## Summary

Implement a typed GitHub API client layer using `@actions/github` (Octokit). This provides the foundation for all GitHub interactions: reading context, posting comments, and creating PRs.

## Dependencies

- **Builds Upon:** RFC-001 (Foundation & Core Types)
- **Enables:** RFC-005 (Triggers), RFC-006 (Security), RFC-008 (Comments), RFC-009 (Reviews), RFC-010 (Delegated Work)

## Features Addressed

| Feature ID | Feature Name                                | Priority |
| ---------- | ------------------------------------------- | -------- |
| F2         | Issue Comment Interaction (foundation)      | P0       |
| F3         | Discussion Comment Interaction (foundation) | P0       |
| F4         | PR Conversation Comments (foundation)       | P0       |
| F27        | Credential Strategy                         | P0       |

## Technical Specification

### 1. New Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@actions/github": "^6.0.0"
  }
}
```

### 2. File Structure

```
src/lib/
├── github/
│   ├── client.ts         # Octokit client factory
│   ├── context.ts        # GitHub context parsing
│   ├── types.ts          # GitHub-specific types
│   └── index.ts          # Public exports
```

### 3. GitHub Types (`src/lib/github/types.ts`)

```typescript
import type {GitHub} from "@actions/github/lib/utils"

export type Octokit = InstanceType<typeof GitHub>

// Event payloads
export interface IssueCommentPayload {
  readonly action: string
  readonly issue: {
    readonly number: number
    readonly title: string
    readonly body: string | null
    readonly state: string
    readonly user: {readonly login: string}
    readonly pull_request?: {readonly url: string}
    readonly locked: boolean
  }
  readonly comment: {
    readonly id: number
    readonly body: string
    readonly user: {readonly login: string}
    readonly author_association: string
  }
  readonly repository: {
    readonly owner: {readonly login: string}
    readonly name: string
    readonly full_name: string
  }
  readonly sender: {readonly login: string}
}

export interface DiscussionCommentPayload {
  readonly action: string
  readonly discussion: {
    readonly number: number
    readonly title: string
    readonly body: string
    readonly category: {readonly name: string}
  }
  readonly comment?: {
    readonly id: number
    readonly body: string
    readonly user: {readonly login: string}
    readonly author_association: string
  }
  readonly repository: {
    readonly owner: {readonly login: string}
    readonly name: string
  }
}

// Context types
export type EventType = "issue_comment" | "discussion" | "workflow_dispatch" | "unknown"

export interface GitHubContext {
  readonly eventName: string
  readonly eventType: EventType
  readonly repo: {readonly owner: string; readonly repo: string}
  readonly ref: string
  readonly sha: string
  readonly runId: number
  readonly actor: string
  readonly payload: unknown
}

// Comment types
export interface CommentTarget {
  readonly type: "issue" | "pr" | "discussion"
  readonly number: number
  readonly owner: string
  readonly repo: string
}

export interface Comment {
  readonly id: number
  readonly body: string
  readonly author: string
  readonly authorAssociation: string
  readonly createdAt: string
  readonly updatedAt: string
}

// Bot identification
export const BOT_COMMENT_MARKER = "<!-- fro-bot-agent -->" as const
```

### 4. Client Factory (`src/lib/github/client.ts`)

```typescript
import * as github from "@actions/github"
import * as core from "@actions/core"
import type {Octokit} from "./types.js"
import type {Logger} from "../types.js"

export interface ClientOptions {
  readonly token: string
  readonly logger: Logger
}

export interface AppClientOptions {
  readonly appId: string
  readonly privateKey: string
  readonly installationId?: number
  readonly logger: Logger
}

/**
 * Create Octokit client with standard token.
 * Used for basic operations and when GitHub App is not configured.
 */
export function createClient(options: ClientOptions): Octokit {
  const {token, logger} = options

  logger.debug("Creating GitHub client with token")

  return github.getOctokit(token, {
    log: {
      debug: (msg: string) => logger.debug(msg),
      info: (msg: string) => logger.info(msg),
      warn: (msg: string) => logger.warning(msg),
      error: (msg: string) => logger.error(msg),
    },
  })
}

/**
 * Get the bot's login name for self-detection.
 * Handles both regular users and GitHub Apps (with [bot] suffix).
 */
export async function getBotLogin(client: Octokit, logger: Logger): Promise<string> {
  try {
    const {data: user} = await client.rest.users.getAuthenticated()
    logger.debug("Authenticated as", {login: user.login, type: user.type})
    return user.login
  } catch (error) {
    // For GitHub App tokens, the above may fail
    // Fall back to the app's slug with [bot] suffix
    logger.debug("Failed to get authenticated user, may be app token")
    return "fro-bot[bot]" // Fallback
  }
}

/**
 * Create elevated client from GitHub App credentials.
 * Used for push/PR operations that need higher permissions.
 */
export async function createAppClient(options: AppClientOptions): Promise<Octokit | null> {
  const {appId, privateKey, installationId, logger} = options

  if (appId.length === 0 || privateKey.length === 0) {
    logger.debug("GitHub App credentials not provided")
    return null
  }

  try {
    // Dynamic import to avoid bundling when not used
    const {createAppAuth} = await import("@octokit/auth-app")

    const auth = createAppAuth({
      appId,
      privateKey,
      installationId,
    })

    const {token} = await auth({type: "installation"})

    logger.info("Created GitHub App client", {appId})

    return github.getOctokit(token)
  } catch (error) {
    logger.error("Failed to create GitHub App client", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Get the appropriate client for the operation.
 * Uses App client for elevated operations, falls back to token.
 */
export function getClientForOperation(standardClient: Octokit, appClient: Octokit | null, elevated: boolean): Octokit {
  if (elevated && appClient != null) {
    return appClient
  }
  return standardClient
}
```

### 5. Context Parsing (`src/lib/github/context.ts`)

```typescript
import * as github from "@actions/github"
import type {GitHubContext, EventType, IssueCommentPayload, CommentTarget} from "./types.js"
import type {Logger} from "../types.js"

/**
 * Parse GitHub Actions context into typed structure.
 */
export function parseGitHubContext(logger: Logger): GitHubContext {
  const ctx = github.context

  const eventType = classifyEventType(ctx.eventName)

  logger.debug("Parsed GitHub context", {
    eventName: ctx.eventName,
    eventType,
    repo: `${ctx.repo.owner}/${ctx.repo.repo}`,
  })

  return {
    eventName: ctx.eventName,
    eventType,
    repo: ctx.repo,
    ref: ctx.ref,
    sha: ctx.sha,
    runId: ctx.runId,
    actor: ctx.actor,
    payload: ctx.payload,
  }
}

/**
 * Classify event name into simplified type.
 */
function classifyEventType(eventName: string): EventType {
  switch (eventName) {
    case "issue_comment":
      return "issue_comment"
    case "discussion":
    case "discussion_comment":
      return "discussion"
    case "workflow_dispatch":
      return "workflow_dispatch"
    default:
      return "unknown"
  }
}

/**
 * Determine if the issue_comment is on a PR or issue.
 */
export function isPullRequest(payload: IssueCommentPayload): boolean {
  return payload.issue.pull_request != null
}

/**
 * Extract comment target from payload.
 */
export function getCommentTarget(context: GitHubContext): CommentTarget | null {
  const {eventType, payload, repo} = context

  if (eventType === "issue_comment") {
    const p = payload as IssueCommentPayload
    return {
      type: isPullRequest(p) ? "pr" : "issue",
      number: p.issue.number,
      owner: repo.owner,
      repo: repo.repo,
    }
  }

  if (eventType === "discussion") {
    // Discussion handling - requires GraphQL
    // TODO: Implement in RFC-008
    return null
  }

  return null
}

/**
 * Get author association from comment payload.
 */
export function getAuthorAssociation(payload: IssueCommentPayload): string {
  return payload.comment.author_association
}

/**
 * Get comment author login.
 */
export function getCommentAuthor(payload: IssueCommentPayload): string {
  return payload.comment.user.login
}

/**
 * Check if issue/PR is locked.
 */
export function isIssueLocked(payload: IssueCommentPayload): boolean {
  return payload.issue.locked
}
```

### 6. Public Exports (`src/lib/github/index.ts`)

```typescript
export {createClient, createAppClient, getBotLogin, getClientForOperation} from "./client.js"
export {
  parseGitHubContext,
  isPullRequest,
  getCommentTarget,
  getAuthorAssociation,
  getCommentAuthor,
  isIssueLocked,
} from "./context.js"
export type {
  Octokit,
  GitHubContext,
  EventType,
  IssueCommentPayload,
  DiscussionCommentPayload,
  CommentTarget,
  Comment,
} from "./types.js"
export {BOT_COMMENT_MARKER} from "./types.js"
```

### 7. Update tsdown.config.ts

Add `@actions/github` to bundled dependencies:

```typescript
export default defineConfig({
  // ... existing config
  noExternal: ["@actions/core", "@actions/cache", "@actions/github"],
})
```

## Acceptance Criteria

- [x] `@actions/github` dependency added and bundled
- [x] Octokit client factory creates clients with logging
- [ ] GitHub App client creation works (when credentials provided)
- [x] Context parsing extracts event type, repo, and payload
- [x] Issue vs PR detection works correctly
- [x] Author association is extracted from payloads
- [x] Bot login detection handles both users and apps
- [x] All types are properly exported
- [x] Unit tests cover client creation and context parsing

## Test Cases

### Client Tests

```typescript
describe("createClient", () => {
  it("creates Octokit instance with token", () => {
    const client = createClient({token: "test-token", logger})
    expect(client).toBeDefined()
    expect(client.rest).toBeDefined()
  })
})

describe("getBotLogin", () => {
  it("returns login for authenticated user", async () => {
    // Mock authenticated user response
    const login = await getBotLogin(mockClient, logger)
    expect(login).toBe("test-bot")
  })

  it("falls back to default for app tokens", async () => {
    // Mock failure scenario
    const login = await getBotLogin(mockClient, logger)
    expect(login).toContain("[bot]")
  })
})
```

### Context Tests

```typescript
describe("parseGitHubContext", () => {
  it("classifies issue_comment event correctly", () => {
    // Mock github.context
    const ctx = parseGitHubContext(logger)
    expect(ctx.eventType).toBe("issue_comment")
  })

  it("classifies workflow_dispatch event", () => {
    const ctx = parseGitHubContext(logger)
    expect(ctx.eventType).toBe("workflow_dispatch")
  })
})

describe("isPullRequest", () => {
  it("returns true when pull_request field exists", () => {
    const payload = {issue: {pull_request: {url: "..."}}}
    expect(isPullRequest(payload as IssueCommentPayload)).toBe(true)
  })

  it("returns false for regular issues", () => {
    const payload = {issue: {}}
    expect(isPullRequest(payload as IssueCommentPayload)).toBe(false)
  })
})
```

## Implementation Notes

1. **Lazy loading**: `@octokit/auth-app` is dynamically imported to avoid bundling when not used
2. **Type safety**: All payloads are typed to ensure correct field access
3. **Fallback handling**: Bot login detection handles both token types gracefully
4. **Logging integration**: Octokit logs are piped through our structured logger

## Security Considerations

1. **Token handling**: Tokens are never logged
2. **App credentials**: Private key is never exposed in logs
3. **Minimal permissions**: Default client uses GITHUB_TOKEN; App client only when needed

## Estimated Effort

- **Development**: 4-6 hours
- **Testing**: 2-3 hours
- **Total**: 6-9 hours
