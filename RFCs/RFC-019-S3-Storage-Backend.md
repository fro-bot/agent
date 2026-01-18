# RFC-019: S3 Storage Backend

**Status:** Pending
**Priority:** MUST
**Complexity:** High
**Phase:** 4

---

## Summary

Implement S3 write-through backup for OpenCode storage, enabling cross-runner persistence and serving as the primary storage backend for Discord Bot (which operates outside GitHub Actions cache). This RFC extends RFC-002 (Cache Infrastructure) with a durable S3 layer.

## Dependencies

- **Builds Upon:** RFC-002 (Cache Infrastructure), RFC-001 (Foundation)
- **Enables:** Discord Bot modality (F12-F16), Cross-runner portability (F67)

## Features Addressed

| Feature ID | Feature Name             | Priority |
| ---------- | ------------------------ | -------- |
| F20        | S3 Write-Through Backup  | P0       |
| F67        | Cross-Runner Portability | P2       |

## Rationale

### Why S3 is Required

1. **Discord Bot**: Runs as long-lived daemon outside GitHub Actions - no access to GHA cache
2. **Cache Eviction**: GitHub Actions cache has 7-day eviction for unused keys; S3 provides durability
3. **Cross-Platform**: Enables memory sharing between GitHub Action and Discord Bot modalities
4. **Disaster Recovery**: Backup layer for corrupted or evicted cache entries

### Classification

| Modality      | S3 Status                       |
| ------------- | ------------------------------- |
| GitHub Action | **Optional** (cache is primary) |
| Discord Bot   | **Required** (no GHA cache)     |

## Technical Specification

### 1. File Structure

```
src/lib/
├── storage/
│   ├── AGENTS.md           # Module documentation
│   ├── types.ts            # Storage types
│   ├── s3.ts               # S3 client operations
│   ├── sync.ts             # Sync orchestration
│   ├── index.ts            # Public exports
│   ├── s3.test.ts          # S3 operation tests
│   └── sync.test.ts        # Sync tests
├── cache.ts                # Updated: S3 fallback integration
└── types.ts                # Updated: S3Config type
```

### 2. Types (`src/lib/storage/types.ts`)

```typescript
export interface S3Config {
  readonly enabled: boolean
  readonly bucket: string
  readonly region: string
  readonly prefix: string
  readonly accessKeyId?: string // From env if not provided
  readonly secretAccessKey?: string // From env if not provided
}

export interface S3SyncOptions {
  readonly config: S3Config
  readonly storagePath: string
  readonly agentIdentity: AgentIdentity
  readonly repo: string
  readonly logger: Logger
}

export interface S3SyncResult {
  readonly success: boolean
  readonly objectCount: number
  readonly totalBytes: number
  readonly error?: string
}

export type SyncDirection = "upload" | "download"
```

### 3. S3 Key Structure

S3 objects use prefix isolation by agent identity and repository:

```
{prefix}/{agentIdentity}/{sanitizedRepo}/storage/
├── .version
├── sessions/
│   ├── ses_abc123/
│   │   ├── messages.json
│   │   └── metadata.json
│   └── ses_def456/
│       └── ...
└── ...
```

**Key Pattern:**

```
opencode-storage/{github|discord}/{owner-repo}/storage/...
```

### 4. S3 Client Operations (`src/lib/storage/s3.ts`)

```typescript
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {Logger} from "../logger.js"
import type {S3Config} from "./types.js"

/**
 * Create S3 client from config.
 *
 * Credentials come from:
 * 1. Explicit config (if provided)
 * 2. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 3. IAM role (for EC2/ECS/Lambda)
 */
export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.accessKeyId != null &&
      config.secretAccessKey != null && {
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      }),
  })
}

/**
 * Build S3 key prefix for storage.
 */
export function buildS3Prefix(config: S3Config, agentIdentity: string, repo: string): string {
  const sanitizedRepo = repo.replace(/\//g, "-")
  return `${config.prefix}/${agentIdentity}/${sanitizedRepo}/storage`
}

/**
 * List all objects under a prefix.
 */
export async function listObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  logger: Logger,
): Promise<readonly string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )

    for (const obj of response.Contents ?? []) {
      if (obj.Key != null) {
        keys.push(obj.Key)
      }
    }

    continuationToken = response.NextContinuationToken
  } while (continuationToken != null)

  logger.debug("Listed S3 objects", {bucket, prefix, count: keys.length})
  return keys
}

/**
 * Upload a single file to S3.
 */
export async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  filePath: string,
  logger: Logger,
): Promise<void> {
  const content = await fs.readFile(filePath)

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
    }),
  )

  logger.debug("Uploaded to S3", {key, size: content.length})
}

/**
 * Download a single file from S3.
 */
export async function downloadFile(
  client: S3Client,
  bucket: string,
  key: string,
  filePath: string,
  logger: Logger,
): Promise<void> {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  )

  if (response.Body == null) {
    throw new Error(`Empty response body for ${key}`)
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), {recursive: true})

  // Stream to file
  const bytes = await response.Body.transformToByteArray()
  await fs.writeFile(filePath, bytes)

  logger.debug("Downloaded from S3", {key, size: bytes.length})
}

/**
 * Delete objects by keys.
 */
export async function deleteObjects(
  client: S3Client,
  bucket: string,
  keys: readonly string[],
  logger: Logger,
): Promise<void> {
  if (keys.length === 0) return

  // S3 DeleteObjects supports up to 1000 keys per request
  const chunks = chunkArray(keys, 1000)

  for (const chunk of chunks) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map(key => ({Key: key})),
        },
      }),
    )
  }

  logger.debug("Deleted S3 objects", {count: keys.length})
}

function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size) as T[])
  }
  return chunks
}
```

### 5. Sync Orchestration (`src/lib/storage/sync.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {Logger} from "../logger.js"
import {buildS3Prefix, createS3Client, deleteObjects, downloadFile, listObjects, uploadFile} from "./s3.js"
import type {S3SyncOptions, S3SyncResult, SyncDirection} from "./types.js"

/**
 * Sync storage to S3 (upload).
 *
 * Uploads all files from local storage to S3, preserving directory structure.
 */
export async function syncToS3(options: S3SyncOptions): Promise<S3SyncResult> {
  const {config, storagePath, agentIdentity, repo, logger} = options

  if (!config.enabled) {
    return {success: true, objectCount: 0, totalBytes: 0}
  }

  logger.info("Syncing storage to S3", {bucket: config.bucket, repo})

  try {
    const client = createS3Client(config)
    const prefix = buildS3Prefix(config, agentIdentity, repo)

    // Get all local files
    const localFiles = await walkDirectory(storagePath)

    let totalBytes = 0

    for (const localFile of localFiles) {
      const relativePath = path.relative(storagePath, localFile)
      const s3Key = `${prefix}/${relativePath}`

      await uploadFile(client, config.bucket, s3Key, localFile, logger)

      const stat = await fs.stat(localFile)
      totalBytes += stat.size
    }

    logger.info("S3 sync complete (upload)", {
      objectCount: localFiles.length,
      totalBytes,
    })

    return {
      success: true,
      objectCount: localFiles.length,
      totalBytes,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error("S3 sync failed", {error: message})
    return {
      success: false,
      objectCount: 0,
      totalBytes: 0,
      error: message,
    }
  }
}

/**
 * Sync storage from S3 (download).
 *
 * Downloads all files from S3 to local storage.
 */
export async function syncFromS3(options: S3SyncOptions): Promise<S3SyncResult> {
  const {config, storagePath, agentIdentity, repo, logger} = options

  if (!config.enabled) {
    return {success: true, objectCount: 0, totalBytes: 0}
  }

  logger.info("Syncing storage from S3", {bucket: config.bucket, repo})

  try {
    const client = createS3Client(config)
    const prefix = buildS3Prefix(config, agentIdentity, repo)

    // List all S3 objects
    const s3Keys = await listObjects(client, config.bucket, prefix, logger)

    if (s3Keys.length === 0) {
      logger.info("No S3 objects found - starting fresh")
      return {success: true, objectCount: 0, totalBytes: 0}
    }

    let totalBytes = 0

    for (const s3Key of s3Keys) {
      const relativePath = s3Key.slice(prefix.length + 1) // Remove prefix/
      const localPath = path.join(storagePath, relativePath)

      await downloadFile(client, config.bucket, s3Key, localPath, logger)

      const stat = await fs.stat(localPath)
      totalBytes += stat.size
    }

    logger.info("S3 sync complete (download)", {
      objectCount: s3Keys.length,
      totalBytes,
    })

    return {
      success: true,
      objectCount: s3Keys.length,
      totalBytes,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error("S3 sync failed", {error: message})
    return {
      success: false,
      objectCount: 0,
      totalBytes: 0,
      error: message,
    }
  }
}

/**
 * Walk directory recursively and return all file paths.
 */
async function walkDirectory(dirPath: string): Promise<string[]> {
  const files: string[] = []

  try {
    const entries = await fs.readdir(dirPath, {withFileTypes: true})

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)

      if (entry.isDirectory()) {
        const subFiles = await walkDirectory(fullPath)
        files.push(...subFiles)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  return files
}
```

### 6. Cache Integration (`src/lib/cache.ts` updates)

Add S3 fallback to `restoreCache`:

```typescript
import {syncFromS3, syncToS3} from "./storage/index.js"
import type {S3Config} from "./storage/types.js"

export interface RestoreCacheOptions {
  readonly components: CacheKeyComponents
  readonly s3Config?: S3Config
  readonly logger: Logger
}

export async function restoreCache(options: RestoreCacheOptions): Promise<CacheResult> {
  const {components, s3Config, logger} = options

  // Try GitHub Actions cache first
  const ghaResult = await restoreFromGHACache(components, logger)

  if (ghaResult.hit && !ghaResult.corrupted) {
    return ghaResult
  }

  // Fall back to S3 if configured and GHA cache missed/corrupted
  if (s3Config?.enabled === true) {
    logger.info("GHA cache miss/corrupted - trying S3 fallback")

    const s3Result = await syncFromS3({
      config: s3Config,
      storagePath: getOpenCodeStoragePath(),
      agentIdentity: components.agentIdentity,
      repo: components.repo,
      logger,
    })

    if (s3Result.success && s3Result.objectCount > 0) {
      return {
        hit: true,
        key: `s3:${components.repo}`,
        restoredPath: getOpenCodeStoragePath(),
        corrupted: false,
        source: "s3",
      }
    }
  }

  return ghaResult
}

export interface SaveCacheOptions {
  readonly components: CacheKeyComponents
  readonly runId: number
  readonly s3Config?: S3Config
  readonly logger: Logger
}

export async function saveCache(options: SaveCacheOptions): Promise<boolean> {
  const {components, runId, s3Config, logger} = options

  // Save to GHA cache
  const ghaSaved = await saveToGHACache(components, runId, logger)

  // Also sync to S3 if configured (write-through)
  if (s3Config?.enabled === true) {
    const s3Result = await syncToS3({
      config: s3Config,
      storagePath: getOpenCodeStoragePath(),
      agentIdentity: components.agentIdentity,
      repo: components.repo,
      logger,
    })

    if (!s3Result.success) {
      logger.warning("S3 write-through failed", {error: s3Result.error})
    }
  }

  return ghaSaved
}
```

### 7. Action Inputs (`action.yaml` updates)

```yaml
inputs:
  s3-backup:
    description: "Enable S3 write-through backup (true/false)"
    required: false
    default: "false"
  s3-bucket:
    description: "S3 bucket name for backup"
    required: false
  s3-region:
    description: "AWS region for S3 bucket"
    required: false
    default: "us-east-1"
  s3-prefix:
    description: "S3 key prefix for storage"
    required: false
    default: "opencode-storage"
```

### 8. Input Parsing (`src/lib/inputs.ts` updates)

```typescript
import type {S3Config} from "./storage/types.js"

export interface ActionInputs {
  // ... existing fields ...
  readonly s3Config: S3Config
}

export function parseActionInputs(): Result<ActionInputs, InputError> {
  // ... existing parsing ...

  const s3Enabled = core.getInput("s3-backup") === "true"
  const s3Bucket = core.getInput("s3-bucket")
  const s3Region = core.getInput("s3-region") || "us-east-1"
  const s3Prefix = core.getInput("s3-prefix") || "opencode-storage"

  // Validate S3 config if enabled
  if (s3Enabled && s3Bucket.length === 0) {
    return {ok: false, error: createInputError("s3-bucket required when s3-backup is enabled")}
  }

  const s3Config: S3Config = {
    enabled: s3Enabled,
    bucket: s3Bucket,
    region: s3Region,
    prefix: s3Prefix,
    // Credentials from environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
  }

  return {
    ok: true,
    value: {
      // ... existing fields ...
      s3Config,
    },
  }
}
```

### 9. New Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0"
  }
}
```

Update `tsdown.config.ts` to bundle:

```typescript
noExternal: [
  // ... existing ...
  "@aws-sdk/client-s3",
],
```

## Security Considerations

### IAM Policy (Least Privilege)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${BUCKET_NAME}", "arn:aws:s3:::${BUCKET_NAME}/opencode-storage/*"]
    }
  ]
}
```

### Credential Handling

1. **Never log credentials**: Access keys redacted in logs
2. **Environment variables**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` from secrets
3. **IAM roles preferred**: For EC2/ECS deployments, use instance roles
4. **Bucket isolation**: Separate buckets or prefixes per environment

### Prefix Isolation

S3 keys include agent identity and repo to prevent cross-contamination:

```
opencode-storage/github/owner-repo/storage/...
opencode-storage/discord/owner-repo/storage/...
```

## Acceptance Criteria

- [ ] S3 client created with configurable credentials
- [ ] S3 key prefix includes agent identity and repo
- [ ] Upload syncs all local files to S3
- [ ] Download syncs all S3 objects to local
- [ ] Cache restore falls back to S3 on GHA miss
- [ ] Cache save performs write-through to S3
- [ ] S3 failures are logged but don't fail the run
- [ ] IAM policy documented with least privilege
- [ ] Credentials never appear in logs
- [ ] Unit tests for S3 operations (mocked)
- [ ] Integration test with LocalStack or real S3

## Test Cases

### S3 Client Tests (`src/lib/storage/s3.test.ts`)

```typescript
import {describe, expect, it, vi} from "vitest"
import {buildS3Prefix, createS3Client} from "./s3.js"

describe("buildS3Prefix", () => {
  it("builds correct prefix with agent identity and repo", () => {
    // #given
    const config = {enabled: true, bucket: "bucket", region: "us-east-1", prefix: "opencode-storage"}

    // #when
    const prefix = buildS3Prefix(config, "github", "owner/repo")

    // #then
    expect(prefix).toBe("opencode-storage/github/owner-repo/storage")
  })

  it("sanitizes repo name with slashes", () => {
    // #given
    const config = {enabled: true, bucket: "bucket", region: "us-east-1", prefix: "storage"}

    // #when
    const prefix = buildS3Prefix(config, "discord", "org/nested/repo")

    // #then
    expect(prefix).toBe("storage/discord/org-nested-repo/storage")
  })
})

describe("createS3Client", () => {
  it("creates client with explicit credentials when provided", () => {
    // #given
    const config = {
      enabled: true,
      bucket: "bucket",
      region: "eu-west-1",
      prefix: "storage",
      accessKeyId: "AKIA...",
      secretAccessKey: "secret",
    }

    // #when
    const client = createS3Client(config)

    // #then
    expect(client).toBeDefined()
  })
})
```

### Sync Tests (`src/lib/storage/sync.test.ts`)

```typescript
import {describe, expect, it, vi} from "vitest"
import {syncFromS3, syncToS3} from "./sync.js"
import {createLogger} from "../logger.js"

// Mock S3 client
vi.mock("./s3.js", () => ({
  createS3Client: vi.fn(() => ({})),
  buildS3Prefix: vi.fn(() => "prefix"),
  listObjects: vi.fn(() => []),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
}))

describe("syncToS3", () => {
  const logger = createLogger({phase: "test"})

  it("returns early when not enabled", async () => {
    // #given
    const options = {
      config: {enabled: false, bucket: "", region: "", prefix: ""},
      storagePath: "/tmp/storage",
      agentIdentity: "github" as const,
      repo: "owner/repo",
      logger,
    }

    // #when
    const result = await syncToS3(options)

    // #then
    expect(result.success).toBe(true)
    expect(result.objectCount).toBe(0)
  })
})

describe("syncFromS3", () => {
  const logger = createLogger({phase: "test"})

  it("returns early when not enabled", async () => {
    // #given
    const options = {
      config: {enabled: false, bucket: "", region: "", prefix: ""},
      storagePath: "/tmp/storage",
      agentIdentity: "github" as const,
      repo: "owner/repo",
      logger,
    }

    // #when
    const result = await syncFromS3(options)

    // #then
    expect(result.success).toBe(true)
    expect(result.objectCount).toBe(0)
  })
})
```

## Implementation Notes

1. **AWS SDK v3**: Use modular SDK (`@aws-sdk/client-s3`) for smaller bundle
2. **Streaming**: For large files, consider streaming uploads/downloads
3. **Retry logic**: AWS SDK has built-in retry; additional retry for network issues
4. **Bucket versioning**: Recommended for rollback capability
5. **LocalStack**: Use for local development and CI testing

## Estimated Effort

- **Development**: 12-16 hours
- **Testing**: 4-6 hours
- **Total**: 16-22 hours

## Compatibility

- RFC-001: Uses Logger type ✅
- RFC-002: Extends cache infrastructure ✅
- RFC-004: Session storage unaffected ✅
