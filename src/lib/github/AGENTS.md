# GITHUB MODULE KNOWLEDGE BASE

**Generated:** 2026-01-06

## OVERVIEW

Provides authenticated Octokit clients (Token/App) and strictly typed event context parsing for Actions.

## WHERE TO LOOK

| Component | File         | Purpose                                                   |
| --------- | ------------ | --------------------------------------------------------- |
| Types     | `types.ts`   | Strict interfaces for payloads (IssueComment, Discussion) |
| Client    | `client.ts`  | `createClient` (PAT) vs `createAppClient` (App auth)      |
| Context   | `context.ts` | Event parsing, target extraction, PR detection            |
| Exports   | `index.ts`   | Public API surface                                        |

## KEY FUNCTIONS

- **`createClient(options)`**: Standard token-based Octokit. Wraps logger.
- **`createAppClient(options)`**: Elevated permissions via `@octokit/auth-app`. Dynamic import.
- **`getBotLogin(client)`**: Auto-detects identity. Returns `login` or `fro-bot[bot]` on failure.
- **`parseGitHubContext(logger)`**: Converts global `github.context` to typed `GitHubContext`.
- **`classifyEventType(name)`**: Normalizes events to `issue_comment`, `discussion`, etc.
- **`getCommentTarget(ctx)`**: Extracts `{type, number, owner, repo}` from payload.
- **`isPullRequest(payload)`**: Distinguishes PR comments from Issue comments (shared event).

## PATTERNS

- **Dual Auth**: Use `createClient` for read/reaction, `createAppClient` for high-privilege writes.
- **Logger Wrapping**: `createOctokitLogger` adapts project `Logger` to Octokit's interface.
- **Dynamic Imports**: `@octokit/auth-app` is imported only when needed to save bundle size.
- **Payload Typing**: We define specific payload interfaces (`IssueCommentPayload`) vs generic `any`.

## ANTI-PATTERNS

- **Global Context**: Don't use `github.context` directly in logic; pass parsed `GitHubContext`.
- **Implicit Types**: Don't cast payloads to `any`; use `types.ts` definitions.
- **Hardcoded Bots**: Always use `getBotLogin()` instead of assuming bot name.
- **Raw Events**: Don't check `ctx.eventName` strings; use `classifyEventType()` enum.
