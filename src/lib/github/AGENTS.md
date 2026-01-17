# GITHUB MODULE

**Overview**: Authenticated Octokit clients (Token/App) and strictly typed event context parsing.

## WHERE TO LOOK

| Component | File         | Purpose                                                   |
| --------- | ------------ | --------------------------------------------------------- |
| Types     | `types.ts`   | Strict interfaces for payloads (IssueComment, Discussion) |
| Client    | `client.ts`  | `createClient` (PAT) vs `createAppClient` (App auth)      |
| Context   | `context.ts` | Event parsing, target extraction, PR detection            |
| API       | `api.ts`     | Helpers for reactions, labels, and user lookups           |
| Exports   | `index.ts`   | Public API surface                                        |

## KEY EXPORTS

```typescript
createClient(options) // Standard token-based Octokit
createAppClient(options) // Elevated permissions via @octokit/auth-app
parseGitHubContext(logger) // Convert global context to typed GitHubContext
classifyEventType(name) // Normalize to issue_comment, discussion, etc.
createCommentReaction(client) // Add emojis (+1, eyes, rocket)
ensureLabelExists(client) // Idempotent label creation
getBotLogin(client) // Auto-detect identity (returns login or fallback)
```

## PATTERNS

- **Dual Auth**: Use `createClient` for read/reaction, `createAppClient` for high-privilege writes
- **Logger Wrapping**: `createOctokitLogger` adapts project `Logger` to Octokit's interface
- **Dynamic Imports**: `@octokit/auth-app` imported only when needed to save bundle size
- **Payload Typing**: Specific interfaces (`IssueCommentPayload`) vs generic `any`
- **Idempotency**: API helpers (`ensureLabelExists`) handle 422/404 explicitly

## ANTI-PATTERNS

| Pattern            | Why                                                      |
| ------------------ | -------------------------------------------------------- |
| **Global Context** | Don't use `github.context` directly; pass parsed type    |
| **Implicit Types** | Don't cast payloads to `any`; use `types.ts`             |
| **Hardcoded Bots** | Always use `getBotLogin()` instead of assuming name      |
| **Raw Events**     | Don't check `ctx.eventName` strings; use classifier      |
| **String Parsing** | Don't split `owner/repo` manually; use `parseRepoString` |
