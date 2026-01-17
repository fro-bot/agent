# RFC-006: Security & Permission Gating

**Status:** Completed
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2
**Completed:** 2026-01-16

---

## Summary

Implement security controls for safe operation: permission gating for fork PRs, credential handling, and authorization checks. This ensures the agent only responds to trusted users and never exposes secrets.

## Dependencies

- **Builds Upon:** RFC-001 (Types), RFC-003 (GitHub Client), RFC-005 (Triggers)
- **Enables:** RFC-008 (Comments), RFC-010 (Delegated Work)

## Features Addressed

| Feature ID | Feature Name                       | Priority |
| ---------- | ---------------------------------- | -------- |
| F46        | auth.json Exclusion (verification) | P0       |
| F47        | Fork PR Permission Gating          | P0       |
| F48        | Credential Strategy                | P0       |

## Technical Specification

### Implementation Location

Security functionality is distributed across modules by concern rather than consolidated into a separate `src/lib/security/` module. This keeps logic close to where it's contextually used.

| Concern           | Module                       | Key Functions                                                   |
| ----------------- | ---------------------------- | --------------------------------------------------------------- |
| Permission Gating | `src/lib/triggers/router.ts` | `isAuthorizedAssociation()`, skip conditions                    |
| Author Types      | `src/lib/triggers/types.ts`  | `AuthorInfo`, `ALLOWED_ASSOCIATIONS`, `ALL_AUTHOR_ASSOCIATIONS` |
| auth.json Write   | `src/lib/setup/auth-json.ts` | `populateAuthJson()`, `verifyAuthJson()`                        |
| auth.json Delete  | `src/lib/cache.ts`           | `deleteAuthJson()`, `isAuthPathSafe()`                          |
| Log Redaction     | `src/lib/logger.ts`          | `redactSensitiveFields()`                                       |
| GitHub Client     | `src/lib/github/client.ts`   | `createAppClient()`, `getBotLogin()`                            |
| Base Types        | `src/lib/types.ts`           | `ALLOWED_ASSOCIATIONS` (canonical)                              |

### 1. Permission Gating (`src/lib/triggers/router.ts`)

Permission gating is integrated into the event routing logic. When an event is routed, the author's association is checked against allowed associations.

```typescript
// Already implemented in router.ts
function isAuthorizedAssociation(association: string, allowed: readonly string[]): boolean {
  return allowed.includes(association)
}

function isBotUser(login: string): boolean {
  return login.endsWith("[bot]")
}
```

The `checkSkipConditions()` function applies these checks for each event type, returning `unauthorized_author` skip reason when denied.

### 2. Author Association Types (`src/lib/triggers/types.ts`)

```typescript
/**
 * All possible GitHub author_association values.
 *
 * Per GitHub API docs (https://docs.github.com/en/graphql/reference/enums#commentauthorassociation):
 * - OWNER: Author is the owner of the repository
 * - MEMBER: Author is a member of the organization that owns the repository
 * - COLLABORATOR: Author has been invited to collaborate on the repository
 * - CONTRIBUTOR: Author has previously committed to the repository
 * - FIRST_TIME_CONTRIBUTOR: Author has not previously committed to the repository
 * - FIRST_TIMER: Author has not previously committed to ANY repository on GitHub
 * - MANNEQUIN: Author is a placeholder for an unclaimed user
 * - NONE: Author has no association with the repository
 */
export const ALL_AUTHOR_ASSOCIATIONS = [
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "MEMBER",
  "NONE",
  "OWNER",
] as const

export type AuthorAssociation = (typeof ALL_AUTHOR_ASSOCIATIONS)[number]

/**
 * Associations allowed to trigger the agent.
 * Only trusted users (OWNER, MEMBER, COLLABORATOR) can invoke agent actions.
 * Re-exported from src/lib/types.ts (canonical source).
 */
export {ALLOWED_ASSOCIATIONS} from "../types.js"
```

### 3. auth.json Handling (`src/lib/setup/auth-json.ts`)

```typescript
/**
 * Verify auth.json exists and is readable.
 * Called before agent execution to ensure credentials are available.
 */
export async function verifyAuthJson(authPath: string, logger: Logger): Promise<boolean> {
  try {
    await fs.access(authPath, fs.constants.R_OK)
    logger.debug("auth.json verified", {path: authPath})
    return true
  } catch {
    logger.error("auth.json not found or not readable", {path: authPath})
    return false
  }
}
```

### 4. Cache Security (`src/lib/cache.ts`)

```typescript
/**
 * Check if a file path is inside a directory.
 * Prevents accidental deletion of files outside the cache scope.
 */
function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  const resolvedFile = path.resolve(filePath)
  const resolvedDir = path.resolve(directoryPath)
  return resolvedFile.startsWith(resolvedDir + path.sep)
}

/**
 * Ensure auth.json is not in a path that would be cached.
 * This is a safety check to prevent accidental credential caching.
 */
export function isAuthPathSafe(authPath: string, storagePath: string): boolean {
  return !isPathInsideDirectory(authPath, storagePath)
}
```

### 5. Log Redaction (`src/lib/logger.ts`)

Already implemented with comprehensive sensitive field detection:

```typescript
export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = [
  "token",
  "password",
  "secret",
  "key",
  "auth",
  "credential",
  "bearer",
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
  "private",
] as const

export function redactSensitiveFields<T>(value: T, sensitivePatterns: readonly string[] = DEFAULT_SENSITIVE_FIELDS): T {
  // Recursively redact sensitive fields from objects
}
```

## Acceptance Criteria

- [x] Only OWNER, MEMBER, COLLABORATOR associations are allowed
- [x] Bot accounts are always rejected (anti-loop)
- [x] Permission denials are logged with reason and context
- [x] Credential source is correctly identified (token vs app)
- [x] GitHub App clients are created when credentials provided
- [x] auth.json is written with 0o600 permissions
- [x] auth.json verification before agent execution
- [x] auth.json deletion is handled gracefully
- [x] Safety check prevents auth.json in storage path
- [x] Credentials are never logged (only masked via redaction)
- [x] ALL_AUTHOR_ASSOCIATIONS constant documents all GitHub values

## Test Cases

### Permission Tests (`src/lib/triggers/router.test.ts`)

Tests for permission gating are integrated into the router tests:

```typescript
describe("checkSkipConditions - unauthorized_author", () => {
  it("allows OWNER association", () => {
    // Context with author.association = 'OWNER'
    expect(result.shouldProcess).toBe(true)
  })

  it("allows MEMBER association", () => {
    // Context with author.association = 'MEMBER'
    expect(result.shouldProcess).toBe(true)
  })

  it("allows COLLABORATOR association", () => {
    // Context with author.association = 'COLLABORATOR'
    expect(result.shouldProcess).toBe(true)
  })

  it("denies CONTRIBUTOR association", () => {
    const result = routeEvent(context, logger, config)
    expect(result.shouldProcess).toBe(false)
    expect(result.skipReason).toBe("unauthorized_author")
  })

  it("denies NONE association", () => {
    const result = routeEvent(context, logger, config)
    expect(result.shouldProcess).toBe(false)
    expect(result.skipReason).toBe("unauthorized_author")
  })

  it("denies bot accounts regardless of association", () => {
    // author.isBot = true, author.association = 'OWNER'
    expect(result.shouldProcess).toBe(false)
    expect(result.skipReason).toBe("self_comment")
  })
})
```

### auth.json Tests (`src/lib/setup/auth-json.test.ts`)

```typescript
describe("verifyAuthJson", () => {
  it("returns true when auth.json exists and is readable", async () => {
    await fs.writeFile(authPath, "{}", {mode: 0o600})
    expect(await verifyAuthJson(authPath, logger)).toBe(true)
  })

  it("returns false when auth.json does not exist", async () => {
    expect(await verifyAuthJson("/nonexistent/path", logger)).toBe(false)
  })
})

describe("populateAuthJson", () => {
  it("writes valid auth.json with correct permissions", async () => {
    const authConfig = {anthropic: {type: "api", key: "sk-ant-xxx"}}
    await populateAuthJson(authConfig, opencodeDir, logger)
    const stat = await fs.stat(authPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
```

### Cache Security Tests (`src/lib/cache.test.ts`)

```typescript
describe("isAuthPathSafe", () => {
  it("returns true when auth.json is outside storage", () => {
    expect(isAuthPathSafe("/home/user/.config/auth.json", "/home/user/.local/share/opencode/storage")).toBe(true)
  })

  it("returns false when auth.json is inside storage", () => {
    expect(isAuthPathSafe("/storage/auth.json", "/storage")).toBe(false)
  })
})
```

## Security Considerations

1. **Least privilege**: Default GITHUB_TOKEN permissions are minimal
2. **Credential masking**: All credentials are auto-redacted in logs via `redactSensitiveFields()`
3. **File permissions**: auth.json is written with 0o600 (owner read/write only)
4. **Path safety**: `isAuthPathSafe()` validates auth.json isn't in cached paths
5. **Fork PR protection**: Strict association checking for untrusted contributors
6. **Anti-loop**: Bot accounts are always rejected via `isBotUser()` check

## Implementation Notes

### Architectural Decision

RFC-006 originally proposed a consolidated `src/lib/security/` module. During implementation analysis, we found that security functionality was already implemented across existing modules in a contextually-appropriate way:

1. **Permission gating** is handled in `triggers/router.ts` where event routing decisions are made
2. **Credential management** is split between setup (write) and cache (delete) modules
3. **Log redaction** is centralized in the logger module

Creating a separate security module would have:

- Required significant refactoring with no functional benefit
- Moved logic away from where it's contextually used
- Added indirection without improving testability

### Delta Implementation

The following utilities were added to fill gaps in the existing implementation:

- `verifyAuthJson()` in `src/lib/setup/auth-json.ts` - verification check before execution
- `isAuthPathSafe()` in `src/lib/cache.ts` - exported for explicit safety validation
- `ALL_AUTHOR_ASSOCIATIONS` in `src/lib/triggers/types.ts` - documents all GitHub values
- Deduplicated `ALLOWED_ASSOCIATIONS` - canonical source in `src/lib/types.ts`, re-exported elsewhere

## Estimated Effort

- **Original Estimate**: 8-11 hours
- **Actual (Delta)**: 3-4 hours (majority already implemented)
