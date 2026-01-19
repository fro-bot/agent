# GITHUB MODULE

**Scope:** Authenticated Octokit clients (Token/App) and strictly typed event context parsing.

## WHERE TO LOOK

| Component   | File         | Purpose                                                    |
| ----------- | ------------ | ---------------------------------------------------------- |
| **Types**   | `types.ts`   | Strict interfaces for payloads (IssueComment, Discussion)  |
| **Client**  | `client.ts`  | `createClient` (PAT) vs `createAppClient` (App auth)       |
| **Context** | `context.ts` | Event parsing, target extraction, PR detection, classifier |
| **API**     | `api.ts`     | Reactions, labels, user lookups                            |
| **Exports** | `index.ts`   | Public API surface                                         |

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

- **Dual Auth**: `createClient` for read/reaction, `createAppClient` for high-privilege writes
- **Logger Wrapping**: `createOctokitLogger` adapts project Logger to Octokit interface
- **Dynamic Imports**: `@octokit/auth-app` imported only when needed for bundle size
- **Payload Typing**: Specific interfaces (IssueComment, Discussion) vs generic `any`
- **Idempotency**: API helpers handle 422/404 explicitly (e.g., `ensureLabelExists`)
- **Redaction Interceptor**: Octokit clients wrap logger with auto-redaction for security

## ANTI-PATTERNS

| Forbidden      | Reason                                                     |
| -------------- | ---------------------------------------------------------- |
| Global context | Never use `github.context` directly; use parsed type       |
| Implicit types | Never cast payloads to `any`; use strict interfaces        |
| Hardcoded bots | Never hardcode login; use `getBotLogin()` for identity     |
| Raw events     | Never check `eventName` strings; use `classifyEventType()` |
| String parsing | Never split `owner/repo` manually; use `parseRepoString()` |
