# RFC-006: Security & Permission Gating

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2

---

## Summary

Implement security controls for safe operation: permission gating for fork PRs, credential handling, and authorization checks. This ensures the agent only responds to trusted users and never exposes secrets.

## Dependencies

- **Builds Upon:** RFC-001 (Types), RFC-003 (GitHub Client), RFC-005 (Triggers)
- **Enables:** RFC-008 (Comments), RFC-010 (Delegated Work)

## Features Addressed

| Feature ID | Feature Name                       | Priority |
| ---------- | ---------------------------------- | -------- |
| F26        | Fork PR Permission Gating          | P0       |
| F27        | Credential Strategy                | P0       |
| F25        | auth.json Exclusion (verification) | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── security/
│   ├── types.ts          # Security-related types
│   ├── permissions.ts    # Permission checking
│   ├── credentials.ts    # Credential management
│   ├── auth-json.ts      # auth.json handling
│   └── index.ts          # Public exports
```

### 2. Security Types (`src/lib/security/types.ts`)

```typescript
import type {ALLOWED_ASSOCIATIONS} from "../types.js"

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
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
] as const

export type AuthorAssociation = (typeof ALL_AUTHOR_ASSOCIATIONS)[number]

/**
 * Associations allowed to trigger the agent.
 * Only trusted users (OWNER, MEMBER, COLLABORATOR) can invoke agent actions.
 */
export type AllowedAssociation = (typeof ALLOWED_ASSOCIATIONS)[number]

export interface PermissionCheck {
  readonly allowed: boolean
  readonly reason: string
  readonly association: string
}

export interface CredentialSource {
  readonly type: "token" | "app" | "none"
  readonly elevated: boolean
  readonly source: string
}

/**
 * OAuth authentication (e.g., GitHub Copilot).
 */
export interface OAuthAuth {
  readonly type: "oauth"
  readonly refresh: string
  readonly access: string
  readonly expires: number
  readonly enterpriseUrl?: string
}

/**
 * API key authentication (e.g., Anthropic).
 */
export interface ApiAuth {
  readonly type: "api"
  readonly key: string
}

/**
 * Well-known authentication (e.g., custom providers).
 */
export interface WellKnownAuth {
  readonly type: "wellknown"
  readonly key: string
  readonly token: string
}

/**
 * Union of all authentication types.
 */
export type AuthInfo = OAuthAuth | ApiAuth | WellKnownAuth

/**
 * Full auth.json structure: Record<providerID, AuthInfo>
 *
 * Example:
 * {
 *   "anthropic": { "type": "api", "key": "sk-ant-..." },
 *   "github-copilot": { "type": "oauth", "refresh": "ghu_...", "access": "tid=...", "expires": 1767460221000 }
 * }
 */
export type AuthConfig = Record<string, AuthInfo>

export const PERMISSION_DENIED_REASONS = {
  UNAUTHORIZED_ASSOCIATION: "User association not in allowed list",
  FORK_PR_UNTRUSTED: "Fork PR from untrusted contributor",
  BOT_COMMENT: "Comment from bot account (anti-loop)",
  LOCKED_ISSUE: "Issue is locked",
} as const

export type PermissionDeniedReason = (typeof PERMISSION_DENIED_REASONS)[keyof typeof PERMISSION_DENIED_REASONS]
```

### 3. Permission Checking (`src/lib/security/permissions.ts`)

```typescript
import type {AuthorInfo, TriggerContext} from "../triggers/types.js"
import type {IssueCommentPayload} from "../github/types.js"
import type {PermissionCheck, Logger} from "./types.js"
import {ALLOWED_ASSOCIATIONS} from "../types.js"
import {PERMISSION_DENIED_REASONS} from "./types.js"

/**
 * Check if the author has permission to trigger the agent.
 *
 * For fork PRs, only OWNER, MEMBER, or COLLABORATOR associations are allowed.
 * This prevents untrusted contributors from triggering agent actions.
 */
export function checkAuthorPermission(author: AuthorInfo, logger: Logger): PermissionCheck {
  const {login, association, isBot} = author

  // Bots are never allowed (anti-loop)
  if (isBot) {
    logger.info("Permission denied: bot account", {login})
    return {
      allowed: false,
      reason: PERMISSION_DENIED_REASONS.BOT_COMMENT,
      association,
    }
  }

  // Check association against allowed list
  const isAllowed = isAuthorizedAssociation(association)

  if (!isAllowed) {
    logger.info("Permission denied: unauthorized association", {login, association})
    return {
      allowed: false,
      reason: PERMISSION_DENIED_REASONS.UNAUTHORIZED_ASSOCIATION,
      association,
    }
  }

  logger.debug("Permission granted", {login, association})
  return {
    allowed: true,
    reason: "Authorized",
    association,
  }
}

/**
 * Check if association is in the allowed list.
 */
export function isAuthorizedAssociation(association: string): boolean {
  return (ALLOWED_ASSOCIATIONS as readonly string[]).includes(association)
}

/**
 * Check if this is a fork PR context.
 */
export function isForkPR(payload: IssueCommentPayload): boolean {
  // If there's a pull_request field and it's from a fork
  // Note: The full PR object isn't in issue_comment payload,
  // so we need to make an API call to check
  return payload.issue.pull_request != null
}

/**
 * Perform full permission check for a trigger context.
 */
export function checkTriggerPermissions(context: TriggerContext, logger: Logger): PermissionCheck {
  const {author, target} = context

  // No author info (e.g., workflow_dispatch) - allow
  if (author == null) {
    return {
      allowed: true,
      reason: "No author to check (system trigger)",
      association: "SYSTEM",
    }
  }

  // Check author permission
  const authorCheck = checkAuthorPermission(author, logger)
  if (!authorCheck.allowed) {
    return authorCheck
  }

  // For PRs, we might want additional checks in the future
  // (e.g., checking if the PR is from a fork and applying stricter rules)

  return authorCheck
}

/**
 * Log permission denial in a consistent format.
 */
export function logPermissionDenial(check: PermissionCheck, context: TriggerContext, logger: Logger): void {
  logger.warning("Permission denied", {
    reason: check.reason,
    association: check.association,
    targetType: context.target.kind,
    targetNumber: context.target.number,
    author: context.author?.login ?? "unknown",
  })
}
```

### 4. Credential Management (`src/lib/security/credentials.ts`)

```typescript
import * as core from "@actions/core"
import type {CredentialSource, Logger} from "./types.js"
import {createClient, createAppClient} from "../github/client.js"
import type {Octokit} from "../github/types.js"

export interface CredentialConfig {
  readonly token: string
  readonly appId: string | null
  readonly privateKey: string | null
}

/**
 * Determine credential source based on available inputs.
 */
export function determineCredentialSource(config: CredentialConfig): CredentialSource {
  const {token, appId, privateKey} = config

  // Check for GitHub App credentials
  if (appId != null && appId.length > 0 && privateKey != null && privateKey.length > 0) {
    return {
      type: "app",
      elevated: true,
      source: "GitHub App",
    }
  }

  // Fall back to token
  if (token.length > 0) {
    // Check if it's an elevated token (PAT vs GITHUB_TOKEN)
    // PATs typically start with 'ghp_' or 'github_pat_'
    const isPAT = token.startsWith("ghp_") || token.startsWith("github_pat_")
    return {
      type: "token",
      elevated: isPAT,
      source: isPAT ? "Personal Access Token" : "GITHUB_TOKEN",
    }
  }

  return {
    type: "none",
    elevated: false,
    source: "None",
  }
}

/**
 * Create clients based on available credentials.
 *
 * Returns both standard and elevated clients where available.
 */
export async function createClients(
  config: CredentialConfig,
  logger: Logger,
): Promise<{standard: Octokit; elevated: Octokit | null}> {
  const source = determineCredentialSource(config)

  logger.info("Credential source", {
    type: source.type,
    elevated: source.elevated,
    source: source.source,
  })

  // Always create standard client with token
  const standard = createClient({token: config.token, logger})

  // Try to create elevated client if app credentials are available
  let elevated: Octokit | null = null

  if (source.type === "app" && config.appId != null && config.privateKey != null) {
    elevated = await createAppClient({
      appId: config.appId,
      privateKey: config.privateKey,
      logger,
    })
  }

  return {standard, elevated}
}

/**
 * Get appropriate client for operation.
 *
 * Uses elevated client for write operations, standard for reads.
 */
export function getClientForScope(
  clients: {standard: Octokit; elevated: Octokit | null},
  scope: "read" | "write",
  logger: Logger,
): Octokit {
  if (scope === "write" && clients.elevated != null) {
    logger.debug("Using elevated client for write operation")
    return clients.elevated
  }

  return clients.standard
}

/**
 * Mask sensitive values for logging.
 */
export function maskCredential(value: string): string {
  if (value.length <= 8) {
    return "***"
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}
```

### 5. auth.json Handling (`src/lib/security/auth-json.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {AuthConfig, AuthInfo, Logger} from "./types.js"
import {getOpenCodeAuthPath, getXdgDataHome} from "../../utils/env.js"

/**
 * Validate that a value is a valid AuthInfo object.
 */
function isValidAuthInfo(value: unknown): value is AuthInfo {
  if (typeof value !== "object" || value == null) {
    return false
  }

  const obj = value as Record<string, unknown>

  switch (obj.type) {
    case "api":
      return typeof obj.key === "string" && obj.key.length > 0

    case "oauth":
      return typeof obj.refresh === "string" && typeof obj.access === "string" && typeof obj.expires === "number"

    case "wellknown":
      return typeof obj.key === "string" && typeof obj.token === "string"

    default:
      return false
  }
}

/**
 * Write auth.json from input secret.
 *
 * This is called at the start of each run to hydrate credentials.
 * The file is deleted before cache save (handled in cache module).
 *
 * Expected format (Record<providerID, AuthInfo>):
 * {
 *   "anthropic": { "type": "api", "key": "sk-ant-..." },
 *   "github-copilot": { "type": "oauth", "refresh": "ghu_...", "access": "tid=...", "expires": 1767460221000 }
 * }
 */
export async function writeAuthJson(authJsonInput: string, logger: Logger): Promise<void> {
  const authPath = getOpenCodeAuthPath()

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(authJsonInput)
  } catch {
    throw new Error("auth-json input is not valid JSON")
  }

  // Validate structure
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error("auth-json must be an object mapping provider IDs to auth configs")
  }

  const config = parsed as Record<string, unknown>
  const providerIds = Object.keys(config)

  if (providerIds.length === 0) {
    throw new Error("auth-json must contain at least one provider")
  }

  // Validate each provider entry
  const validatedConfig: AuthConfig = {}
  for (const [providerId, authInfo] of Object.entries(config)) {
    if (!isValidAuthInfo(authInfo)) {
      throw new Error(
        `Invalid auth config for provider "${providerId}". ` +
          `Expected { type: "api", key: string } or ` +
          `{ type: "oauth", refresh: string, access: string, expires: number } or ` +
          `{ type: "wellknown", key: string, token: string }`,
      )
    }
    validatedConfig[providerId] = authInfo
  }

  // Ensure directory exists
  const authDir = path.dirname(authPath)
  await fs.mkdir(authDir, {recursive: true})

  // Write file with restricted permissions (0o600 = owner read/write only)
  await fs.writeFile(authPath, JSON.stringify(validatedConfig, null, 2), {mode: 0o600})

  logger.info("auth.json written", {
    providers: providerIds,
    providerCount: providerIds.length,
  })
}

/**
 * Verify auth.json exists and is readable.
 */
export async function verifyAuthJson(logger: Logger): Promise<boolean> {
  const authPath = getOpenCodeAuthPath()

  try {
    await fs.access(authPath, fs.constants.R_OK)
    logger.debug("auth.json verified")
    return true
  } catch {
    logger.error("auth.json not found or not readable")
    return false
  }
}

/**
 * Delete auth.json (called before cache save).
 */
export async function deleteAuthJson(logger: Logger): Promise<void> {
  const authPath = getOpenCodeAuthPath()

  try {
    await fs.unlink(authPath)
    logger.debug("auth.json deleted")
  } catch (error) {
    // File doesn't exist - that's fine
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warning("Failed to delete auth.json", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * Ensure auth.json is not in a path that would be cached.
 *
 * This is a safety check to prevent accidental credential caching.
 */
export function isAuthPathSafe(): boolean {
  const authPath = getOpenCodeAuthPath()
  const xdgDataHome = getXdgDataHome()
  const storagePath = path.join(xdgDataHome, "opencode", "storage")

  // auth.json should NOT be under storage/
  return !authPath.startsWith(storagePath)
}
```

### 6. Public Exports (`src/lib/security/index.ts`)

```typescript
export {
  checkAuthorPermission,
  isAuthorizedAssociation,
  isForkPR,
  checkTriggerPermissions,
  logPermissionDenial,
} from "./permissions.js"

export {determineCredentialSource, createClients, getClientForScope, maskCredential} from "./credentials.js"

export {writeAuthJson, verifyAuthJson, deleteAuthJson, isAuthPathSafe} from "./auth-json.js"

export type {
  AuthorAssociation,
  PermissionCheck,
  CredentialSource,
  AuthConfig,
  AuthInfo,
  OAuthAuth,
  ApiAuth,
  WellKnownAuth,
} from "./types.js"

export {PERMISSION_DENIED_REASONS} from "./types.js"
```

## Acceptance Criteria

- [ ] Only OWNER, MEMBER, COLLABORATOR associations are allowed
- [ ] Bot accounts are always rejected (anti-loop)
- [ ] Permission denials are logged with reason and context
- [ ] Credential source is correctly identified (token vs app)
- [ ] GitHub App clients are created when credentials provided
- [ ] auth.json is written with 0o600 permissions
- [ ] auth.json is verified before agent execution
- [ ] auth.json deletion is handled gracefully
- [ ] Safety check prevents auth.json in storage path
- [ ] Credentials are never logged (only masked)

## Test Cases

### Permission Tests

```typescript
describe("checkAuthorPermission", () => {
  it("allows OWNER association", () => {
    const result = checkAuthorPermission({login: "owner", association: "OWNER", isBot: false}, logger)
    expect(result.allowed).toBe(true)
  })

  it("allows MEMBER association", () => {
    const result = checkAuthorPermission({login: "member", association: "MEMBER", isBot: false}, logger)
    expect(result.allowed).toBe(true)
  })

  it("allows COLLABORATOR association", () => {
    const result = checkAuthorPermission({login: "collab", association: "COLLABORATOR", isBot: false}, logger)
    expect(result.allowed).toBe(true)
  })

  it("denies CONTRIBUTOR association", () => {
    const result = checkAuthorPermission({login: "contrib", association: "CONTRIBUTOR", isBot: false}, logger)
    expect(result.allowed).toBe(false)
  })

  it("denies NONE association", () => {
    const result = checkAuthorPermission({login: "random", association: "NONE", isBot: false}, logger)
    expect(result.allowed).toBe(false)
  })

  it("denies bot accounts regardless of association", () => {
    const result = checkAuthorPermission({login: "other-bot[bot]", association: "OWNER", isBot: true}, logger)
    expect(result.allowed).toBe(false)
  })
})
```

### Credential Tests

```typescript
describe("determineCredentialSource", () => {
  it("identifies GitHub App credentials", () => {
    const source = determineCredentialSource({
      token: "ghs_xxx",
      appId: "12345",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
    })
    expect(source.type).toBe("app")
    expect(source.elevated).toBe(true)
  })

  it("identifies PAT", () => {
    const source = determineCredentialSource({
      token: "ghp_abcdefg",
      appId: null,
      privateKey: null,
    })
    expect(source.type).toBe("token")
    expect(source.elevated).toBe(true)
  })

  it("identifies GITHUB_TOKEN", () => {
    const source = determineCredentialSource({
      token: "ghs_abcdefg",
      appId: null,
      privateKey: null,
    })
    expect(source.type).toBe("token")
    expect(source.elevated).toBe(false)
  })
})

describe("maskCredential", () => {
  it("masks long credentials", () => {
    expect(maskCredential("ghp_abcdefghijklmnop")).toBe("ghp_...mnop")
  })

  it("fully masks short credentials", () => {
    expect(maskCredential("short")).toBe("***")
  })
})
```

### auth.json Tests

```typescript
describe("writeAuthJson", () => {
  it("writes valid auth.json with correct permissions", async () => {
    const authJson = JSON.stringify({
      anthropic: {type: "api", key: "sk-ant-xxx"},
    })
    await writeAuthJson(authJson, logger)
    const stat = await fs.stat(getOpenCodeAuthPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it("accepts multiple providers", async () => {
    const authJson = JSON.stringify({
      anthropic: {type: "api", key: "sk-ant-xxx"},
      "github-copilot": {type: "oauth", refresh: "ghu_xxx", access: "tid=xxx", expires: 1767460221000},
    })
    await writeAuthJson(authJson, logger)
    const content = await fs.readFile(getOpenCodeAuthPath(), "utf-8")
    const parsed = JSON.parse(content)
    expect(Object.keys(parsed)).toHaveLength(2)
  })

  it("accepts wellknown auth type", async () => {
    const authJson = JSON.stringify({
      "custom-provider": {type: "wellknown", key: "key123", token: "token456"},
    })
    await writeAuthJson(authJson, logger)
    // Should not throw
  })

  it("throws on invalid JSON", async () => {
    await expect(writeAuthJson("not json", logger)).rejects.toThrow("not valid JSON")
  })

  it("throws on empty object", async () => {
    await expect(writeAuthJson("{}", logger)).rejects.toThrow("at least one provider")
  })

  it("throws on invalid auth type", async () => {
    const authJson = JSON.stringify({
      "bad-provider": {type: "invalid", foo: "bar"},
    })
    await expect(writeAuthJson(authJson, logger)).rejects.toThrow("Invalid auth config")
  })

  it("throws on api type missing key", async () => {
    const authJson = JSON.stringify({
      anthropic: {type: "api"},
    })
    await expect(writeAuthJson(authJson, logger)).rejects.toThrow("Invalid auth config")
  })

  it("throws on oauth type missing required fields", async () => {
    const authJson = JSON.stringify({
      "github-copilot": {type: "oauth", refresh: "ghu_xxx"},
    })
    await expect(writeAuthJson(authJson, logger)).rejects.toThrow("Invalid auth config")
  })
})

describe("isAuthPathSafe", () => {
  it("returns true when auth.json is outside storage", () => {
    expect(isAuthPathSafe()).toBe(true)
  })
})
```

## Security Considerations

1. **Least privilege**: Default GITHUB_TOKEN permissions are minimal
2. **Credential masking**: All credentials are masked in logs
3. **File permissions**: auth.json is written with 0o600 (owner read/write only)
4. **Path safety**: Validation ensures auth.json isn't in cached paths
5. **Fork PR protection**: Strict association checking for untrusted contributors

## Estimated Effort

- **Development**: 5-7 hours
- **Testing**: 3-4 hours
- **Total**: 8-11 hours
