# GITHUB MODULE

**Overview**: Authenticated Octokit clients (Token/App) and strictly typed event context parsing.

## WHERE TO LOOK

| Component | File         | Purpose                                                   |
| --------- | ------------ | --------------------------------------------------------- |
| Types     | `types.ts`   | Strict interfaces for payloads (IssueComment, Discussion) |
| Client    | `client.ts`  | `createClient` (PAT) vs `createAppClient` (App auth)      |
| Context   | `context.ts` | Event parsing, target extraction, PR detection            |
| Exports   | `index.ts`   | Public API surface                                        |

## KEY EXPORTS

```typescript
createClient(options) // Standard token-based Octokit
createAppClient(options) // Elevated permissions via @octokit/auth-app
getBotLogin(client) // Auto-detect identity (returns login or fallback)
parseGitHubContext(logger) // Convert global context to typed GitHubContext
classifyEventType(name) // Normalize to issue_comment, discussion, etc.
getCommentTarget(ctx) // Extract {type, number, owner, repo}
isPullRequest(payload) // Distinguish PR comments from Issue comments
```

## PATTERNS

- **Dual Auth**: Use `createClient` for read/reaction, `createAppClient` for high-privilege writes
- **Logger Wrapping**: `createOctokitLogger` adapts project `Logger` to Octokit's interface
- **Dynamic Imports**: `@octokit/auth-app` imported only when needed to save bundle size
- **Payload Typing**: Specific interfaces (`IssueCommentPayload`) vs generic `any`

## ANTI-PATTERNS

| Pattern            | Why                                                   |
| ------------------ | ----------------------------------------------------- |
| **Global Context** | Don't use `github.context` directly; pass parsed type |
| **Implicit Types** | Don't cast payloads to `any`; use `types.ts`          |
| **Hardcoded Bots** | Always use `getBotLogin()` instead of assuming name   |
| **Raw Events**     | Don't check `ctx.eventName` strings; use classifier   |
