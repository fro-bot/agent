# GITHUB MODULE

**Scope:** Authenticated Octokit clients (Token/App) and strictly typed event context parsing.

## WHERE TO LOOK

| Component   | File         | Purpose                                                   |
| ----------- | ------------ | --------------------------------------------------------- |
| **Types**   | `types.ts`   | Strict interfaces for payloads (IssueComment, Discussion) |
| **Client**  | `client.ts`  | `createClient` (PAT) vs `createAppClient` (App auth)      |
| **Context** | `context.ts` | Event parsing, target extraction, PR detection            |
| **API**     | `api.ts`     | Reactions, labels, user lookups                           |
| **Exports** | `index.ts`   | Public API surface                                        |

## KEY EXPORTS

```typescript
createClient(options) // Standard token-based Octokit
createAppClient(options) // Elevated via @octokit/auth-app
parseGitHubContext(logger) // Convert global context to typed GitHubContext
classifyEventType(name) // Normalize to issue_comment, discussion, etc.
createCommentReaction(client) // Add emojis (+1, eyes, rocket)
ensureLabelExists(client) // Idempotent label creation
getBotLogin(client) // Auto-detect bot identity
```

## PATTERNS

- **Dual Auth**: Use `createClient` for read/reaction, `createAppClient` for high-privilege writes
- **Logger Wrapping**: `createOctokitLogger` adapts project Logger to Octokit's interface
- **Dynamic Imports**: `@octokit/auth-app` imported only when needed (bundle size)
- **Payload Typing**: Specific interfaces (`IssueCommentPayload`) vs generic `any`
- **Idempotency**: API helpers (`ensureLabelExists`) handle 422/404 explicitly

## ANTI-PATTERNS

| Forbidden      | Reason                                                   |
| -------------- | -------------------------------------------------------- |
| Global context | Don't use `github.context` directly; pass parsed type    |
| Implicit types | Don't cast payloads to `any`; use `types.ts`             |
| Hardcoded bots | Always use `getBotLogin()` instead of assuming name      |
| Raw events     | Don't check `ctx.eventName` strings; use classifier      |
| String parsing | Don't split `owner/repo` manually; use `parseRepoString` |
