# GITHUB MODULE

**Scope:** Authenticated Octokit clients, `NormalizedEvent` discriminated union for typed webhook processing, and GitHub-specific utility functions.

## WHERE TO LOOK

| Component   | File         | Purpose                                                          |
| ----------- | ------------ | ---------------------------------------------------------------- |
| **Types**   | `types.ts`   | `NormalizedEvent` (8 variants), `GitHubContext`, `CommentTarget` |
| **Client**  | `client.ts`  | `createClient` (PAT) vs `createAppClient` (App auth)             |
| **Context** | `context.ts` | `normalizeEvent()`, `parseGitHubContext()`, target extraction    |
| **API**     | `api.ts`     | Reactions, labels, branch discovery, user lookups (255 L)        |
| **URLs**    | `urls.ts`    | Secure URL validation (attachments), SHA extraction              |
| **Utils**   | `utils.ts`   | HTTP error handling (ignoreNotFound)                             |
| **Exports** | `index.ts`   | Public API surface                                               |

## KEY EXPORTS

```typescript
// Event normalization (core abstraction)
normalizeEvent(eventName, eventType, payload) // Raw payload → NormalizedEvent
parseGitHubContext(logger) // Global context → typed GitHubContext (calls normalizeEvent)
classifyEventType(name) // Raw event name → EventType enum value

// Client creation
createClient(options) // Standard token-based Octokit
createAppClient(options) // Elevated via @octokit/auth-app

// API operations
createCommentReaction(client) // Add emojis (+1, eyes, rocket)
ensureLabelExists(client) // Idempotent label creation
getCommentTarget(context) // GitHubContext → CommentTarget for posting
isPullRequest(context) // Check if event relates to PR

// URL/HTTP utilities
isValidAttachmentUrl(url) // Strict github.com/user-attachments/ check
ignoreNotFound(promise) // Wrap API calls to handle 404 gracefully
```

## NORMALIZED EVENT SYSTEM

Raw webhook payloads are normalized into a discriminated union before any downstream processing. The router and prompt builder never touch raw payloads.

```
GitHub webhook payload
        ↓
classifyEventType(eventName) → EventType
        ↓
normalizeEvent(eventName, eventType, payload) → NormalizedEvent
        ↓
parseGitHubContext(logger) → GitHubContext { event: NormalizedEvent, ... }
```

### NormalizedEvent Variants

| Variant | Discriminator | Key Fields |
| --- | --- | --- |
| `NormalizedIssueCommentEvent` | `type: 'issue_comment'` | `issue`, `comment` (body, author, authorAssociation) |
| `NormalizedDiscussionCommentEvent` | `type: 'discussion_comment'` | `discussion`, `comment` |
| `NormalizedIssuesEvent` | `type: 'issues'` | `issue` (with authorAssociation), `sender` |
| `NormalizedPullRequestEvent` | `type: 'pull_request'` | `pullRequest` (with draft, authorAssociation) |
| `NormalizedPullRequestReviewCommentEvent` | `type: 'pull_request_review_comment'` | `pullRequest`, `comment` (path, line, diffHunk, commitId) |
| `NormalizedWorkflowDispatchEvent` | `type: 'workflow_dispatch'` | `inputs.prompt` |
| `NormalizedScheduleEvent` | `type: 'schedule'` | `schedule` |
| `NormalizedUnsupportedEvent` | `type: 'unsupported'` | (no fields) |

All fields are `readonly`. Narrow via `event.type` before accessing variant-specific fields.

## PATTERNS

- **Dual Auth**: `createClient` for read/reaction, `createAppClient` for high-privilege writes
- **NormalizedEvent layer**: ALL downstream code consumes `NormalizedEvent`, never raw `context.payload`
- **Logger Wrapping**: `createOctokitLogger` adapts project Logger to Octokit interface
- **Dynamic Imports**: `@octokit/auth-app` imported only when needed for bundle size
- **Idempotency**: API helpers handle 422/404 explicitly (e.g., `ensureLabelExists`)
- **Strict URLs**: Use `isGithubUrl()` to prevent hostname spoofing in attachment processing
- **Redaction Interceptor**: Octokit clients wrap logger with auto-redaction for security

## ANTI-PATTERNS

| Forbidden           | Reason                                                              |
| ------------------- | ------------------------------------------------------------------- |
| Raw payload access  | Always use `NormalizedEvent`; never read `context.payload` directly |
| Global context      | Never use `github.context` directly; use `parseGitHubContext()`     |
| Implicit types      | Never cast payloads to `any`; use strict interfaces                 |
| Hardcoded bots      | Never hardcode login; use `getBotLogin()` for identity              |
| Raw event strings   | Never check `eventName` strings; use `classifyEventType()`          |
| Manual `owner/repo` | Never split manually; use `parseRepoString()`                       |
