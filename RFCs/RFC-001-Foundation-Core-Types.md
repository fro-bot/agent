# RFC-001: Foundation & Core Types

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 1

---

## Summary

Establish the foundational infrastructure for the Fro Bot Agent: shared type definitions, utility functions, constants, and the restructured project layout. This RFC creates the skeleton that all subsequent RFCs will build upon.

## Dependencies

- **Builds Upon:** None (this is the first RFC)
- **Enables:** All subsequent RFCs (RFC-002 through RFC-014)

## Features Addressed

| Feature ID | Feature Name                    | Priority |
| ---------- | ------------------------------- | -------- |
| F37        | Action Inputs Configuration     | P0       |
| F31        | Structured Logging (foundation) | P0       |

## Technical Specification

### 1. Project Structure

Restructure `src/` to support the full agent:

```
src/
├── main.ts                 # Action entry point (refactored)
├── lib/
│   ├── types.ts            # Shared type definitions
│   ├── constants.ts        # Configuration constants
│   ├── inputs.ts           # Action input parsing
│   ├── outputs.ts          # Action output handling
│   └── logger.ts           # Structured logging utility
├── utils/
│   ├── validation.ts       # Input validation utilities
│   └── env.ts              # Environment variable helpers
└── index.ts                # Public API exports
```

### 2. Type Definitions (`src/lib/types.ts`)

```typescript
// Agent identity for cache scoping
export type AgentIdentity = "github" | "discord"

// Cache restore result
export interface CacheResult {
  readonly hit: boolean
  readonly key: string | null
  readonly restoredPath: string | null
  readonly corrupted: boolean
}

// Run context from GitHub Actions
export interface RunContext {
  readonly eventName: string
  readonly repo: string
  readonly ref: string
  readonly runId: number
  readonly actor: string
  readonly agentIdentity: AgentIdentity
}

// Author association for permission gating
export const ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const
export type AuthorAssociation = (typeof ALLOWED_ASSOCIATIONS)[number]

// Session pruning configuration
export interface PruningConfig {
  readonly maxSessions: number
  readonly maxAgeDays: number
}

// Action inputs (parsed and validated)
export interface ActionInputs {
  readonly authJson: string
  readonly appId: string | null
  readonly privateKey: string | null
  readonly prompt: string | null
  readonly sessionRetention: number
  readonly s3Backup: boolean
  readonly s3Bucket: string | null
  readonly awsRegion: string | null
}

// Run summary data
export interface RunSummary {
  readonly eventType: string
  readonly repo: string
  readonly ref: string
  readonly runId: number
  readonly cacheStatus: "hit" | "miss" | "corrupted"
  readonly sessionIds: readonly string[]
  readonly createdPRs: readonly string[]
  readonly createdCommits: readonly string[]
  readonly duration: number
  readonly tokenUsage: TokenUsage | null
}

export interface TokenUsage {
  readonly input: number
  readonly output: number
}

// Result type for recoverable errors
export type Result<T, E = Error> = {readonly ok: true; readonly value: T} | {readonly ok: false; readonly error: E}
```

### 3. Constants (`src/lib/constants.ts`)

```typescript
// Storage paths
export const OPENCODE_STORAGE_PATH = "~/.local/share/opencode/storage" as const
export const OPENCODE_AUTH_PATH = "~/.local/share/opencode/auth.json" as const

// Files to exclude from cache
export const CACHE_EXCLUSIONS = ["auth.json", ".env", "*.key", "*.pem"] as const

// Default configuration
export const DEFAULT_SESSION_RETENTION = 50
export const DEFAULT_MAX_AGE_DAYS = 30

// Retry configuration
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const
export const LLM_RETRY_DELAY_MS = 10_000

// Cache key components
export const CACHE_PREFIX = "opencode-storage" as const

// Storage version (increment on breaking changes)
export const STORAGE_VERSION = 1
```

### 4. Input Parsing (`src/lib/inputs.ts`)

```typescript
import * as core from "@actions/core"
import type {ActionInputs} from "./types.js"
import {DEFAULT_SESSION_RETENTION} from "./constants.js"
import {validatePositiveInteger, validateJsonString} from "../utils/validation.js"

export function parseActionInputs(): ActionInputs {
  const authJson = core.getInput("auth-json", {required: true})
  validateJsonString(authJson, "auth-json")

  const appId = core.getInput("app-id") || null
  const privateKey = core.getInput("private-key") || null
  const prompt = core.getInput("prompt") || null

  const sessionRetentionRaw = core.getInput("session-retention")
  const sessionRetention =
    sessionRetentionRaw !== ""
      ? validatePositiveInteger(sessionRetentionRaw, "session-retention")
      : DEFAULT_SESSION_RETENTION

  const s3Backup = core.getInput("s3-backup") === "true"
  const s3Bucket = core.getInput("s3-bucket") || null
  const awsRegion = core.getInput("aws-region") || null

  return {
    authJson,
    appId,
    privateKey,
    prompt,
    sessionRetention,
    s3Backup,
    s3Bucket,
    awsRegion,
  }
}
```

### 5. Validation Utilities (`src/utils/validation.ts`)

```typescript
export function validateJsonString(value: string, fieldName: string): void {
  try {
    JSON.parse(value)
  } catch {
    throw new Error(`${fieldName} must be valid JSON`)
  }
}

export function validatePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer, received: ${value}`)
  }
  return parsed
}

export function validateNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string, received ${typeof value}`)
  }
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} cannot be empty`)
  }
  return value
}
```

### 6. Structured Logger (`src/lib/logger.ts`)

```typescript
import * as core from "@actions/core"

export interface LogContext {
  readonly sessionId?: string
  readonly runId?: number
  readonly repo?: string
  readonly [key: string]: unknown
}

interface StructuredLog {
  readonly timestamp: string
  readonly level: "debug" | "info" | "warning" | "error"
  readonly message: string
  readonly context: LogContext
}

function formatLog(log: StructuredLog): string {
  return JSON.stringify(log)
}

export function createLogger(baseContext: LogContext = {}) {
  return {
    debug(message: string, context: LogContext = {}): void {
      const log: StructuredLog = {
        timestamp: new Date().toISOString(),
        level: "debug",
        message,
        context: {...baseContext, ...context},
      }
      core.debug(formatLog(log))
    },

    info(message: string, context: LogContext = {}): void {
      const log: StructuredLog = {
        timestamp: new Date().toISOString(),
        level: "info",
        message,
        context: {...baseContext, ...context},
      }
      core.info(formatLog(log))
    },

    warning(message: string, context: LogContext = {}): void {
      const log: StructuredLog = {
        timestamp: new Date().toISOString(),
        level: "warning",
        message,
        context: {...baseContext, ...context},
      }
      core.warning(formatLog(log))
    },

    error(message: string, context: LogContext = {}): void {
      const log: StructuredLog = {
        timestamp: new Date().toISOString(),
        level: "error",
        message,
        context: {...baseContext, ...context},
      }
      core.error(formatLog(log))
    },
  }
}

export type Logger = ReturnType<typeof createLogger>
```

### 7. Environment Utilities (`src/utils/env.ts`)

```typescript
import * as os from "node:os"
import * as path from "node:path"

export function getXdgDataHome(): string {
  const xdgDataHome = process.env["XDG_DATA_HOME"]
  if (xdgDataHome != null && xdgDataHome.length > 0) {
    return xdgDataHome
  }
  return path.join(os.homedir(), ".local", "share")
}

export function getOpenCodeStoragePath(): string {
  return path.join(getXdgDataHome(), "opencode", "storage")
}

export function getOpenCodeAuthPath(): string {
  return path.join(getXdgDataHome(), "opencode", "auth.json")
}

export function getRunnerOS(): string {
  const runnerOs = process.env["RUNNER_OS"]
  if (runnerOs != null && runnerOs.length > 0) {
    return runnerOs
  }
  // Fallback for local testing
  const platform = os.platform()
  switch (platform) {
    case "darwin":
      return "macOS"
    case "win32":
      return "Windows"
    default:
      return "Linux"
  }
}
```

### 8. Updated action.yaml

```yaml
name: "Fro Bot Agent"
description: "AI agent with persistent memory for GitHub automation"
author: "Fro Bot <agent@fro.bot>"

inputs:
  auth-json:
    description: |
      JSON object mapping provider IDs to auth configs. Supports three auth types:
      - api: { "type": "api", "key": "sk-..." }
      - oauth: { "type": "oauth", "refresh": "...", "access": "...", "expires": 1234567890 }
      - wellknown: { "type": "wellknown", "key": "...", "token": "..." }
      Example: { "anthropic": { "type": "api", "key": "sk-ant-..." } }
    required: true
  app-id:
    description: "GitHub App ID for elevated operations"
    required: false
  private-key:
    description: "GitHub App private key for elevated operations"
    required: false
  prompt:
    description: "Custom prompt for the agent"
    required: false
  session-retention:
    description: "Number of sessions to retain (default: 50)"
    required: false
    default: "50"
  s3-backup:
    description: "Enable S3 write-through backup"
    required: false
    default: "false"
  s3-bucket:
    description: "S3 bucket for backup (required if s3-backup is true)"
    required: false
  aws-region:
    description: "AWS region for S3 bucket"
    required: false

outputs:
  session-id:
    description: "OpenCode session ID used for this run"
  cache-status:
    description: "Cache restore status (hit/miss/corrupted)"
  duration:
    description: "Run duration in seconds"

runs:
  using: "node24"
  main: "dist/main.js"
```

## Acceptance Criteria

- [ ] Project structure reorganized with `lib/` and `utils/` directories
- [ ] All type definitions exported from `src/lib/types.ts`
- [ ] Constants defined with `as const` assertions
- [ ] Input parsing validates all action inputs
- [ ] Validation utilities cover JSON, integers, and non-empty strings
- [ ] Structured logger outputs JSON format
- [ ] Environment utilities resolve XDG paths correctly
- [ ] `action.yaml` updated with new inputs/outputs
- [ ] All new code has corresponding unit tests
- [ ] `pnpm build && pnpm check-types && pnpm lint && pnpm test` passes

## Test Cases

### Input Validation Tests

```typescript
describe("validateJsonString", () => {
  it("accepts valid JSON object", () => {
    expect(() => validateJsonString('{"key":"value"}', "test")).not.toThrow()
  })

  it("rejects invalid JSON", () => {
    expect(() => validateJsonString("not json", "test")).toThrow("test must be valid JSON")
  })
})

describe("validatePositiveInteger", () => {
  it("parses valid positive integer", () => {
    expect(validatePositiveInteger("50", "test")).toBe(50)
  })

  it("rejects zero", () => {
    expect(() => validatePositiveInteger("0", "test")).toThrow()
  })

  it("rejects negative numbers", () => {
    expect(() => validatePositiveInteger("-5", "test")).toThrow()
  })
})
```

### Logger Tests

```typescript
describe("createLogger", () => {
  it("includes base context in all logs", () => {
    const logger = createLogger({runId: 123})
    // Verify JSON output contains runId
  })

  it("merges additional context", () => {
    const logger = createLogger({runId: 123})
    logger.info("test", {sessionId: "abc"})
    // Verify both runId and sessionId present
  })
})
```

## Implementation Notes

1. **Preserve existing functionality**: The current `wait.ts` can remain for now; it will be removed in a later RFC
2. **No external dependencies added yet**: This RFC uses only `@actions/core` and Node.js built-ins
3. **ESM-only**: All imports use `.js` extension for ESM compatibility
4. **Strict booleans**: All checks use explicit `!= null` or length comparisons

## Estimated Effort

- **Development**: 4-6 hours
- **Testing**: 2-3 hours
- **Total**: 6-9 hours
