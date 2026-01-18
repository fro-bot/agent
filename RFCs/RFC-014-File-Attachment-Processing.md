# RFC-014: File Attachment Processing

**Status:** Completed
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2

## Completion Note (2026-01-18)

Implementation completed with the following components:

| Component            | File                                | Tests |
| -------------------- | ----------------------------------- | ----- |
| Types & limits       | `src/lib/attachments/types.ts`      | N/A   |
| URL parsing          | `src/lib/attachments/parser.ts`     | 22    |
| Secure download      | `src/lib/attachments/downloader.ts` | 7     |
| MIME/size validation | `src/lib/attachments/validator.ts`  | 10    |
| SDK file parts       | `src/lib/attachments/injector.ts`   | 5     |
| Public API           | `src/lib/attachments/index.ts`      | N/A   |
| Module docs          | `src/lib/attachments/AGENTS.md`     | N/A   |

**Key implementation details:**

- **Temp file approach**: Downloads to temp files, uses `file://` URLs for SDK (not base64)
- **Security**: `redirect: "manual"` prevents token leakage; redirect targets validated
- **Limits enforced**: 5MB/file, 15MB total, max 5 files, MIME allowlist
- **Integration**: Step 6d in `main.ts`, cleanup in finally block
- **44 tests passing** across all attachment modules

---

## Summary

Implement file attachment processing for GitHub comment triggers. This RFC defines detection, download, validation, and prompt injection of user-uploaded files (images, documents) attached to GitHub issues and PR comments.

## Dependencies

- **Builds Upon:** RFC-003 (GitHub Client), RFC-013 (SDK Execution Mode)
- **Enables:** Enhanced multi-modal agent interactions

## Features Addressed

| Feature ID | Feature Name              | Priority |
| ---------- | ------------------------- | -------- |
| NEW        | File Attachment Detection | P0       |
| NEW        | Attachment Download       | P0       |
| NEW        | MIME Type Validation      | P0       |
| NEW        | SDK File Part Injection   | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── attachments/
│   ├── types.ts          # Attachment-related types
│   ├── parser.ts         # URL detection from comment body
│   ├── downloader.ts     # Download with auth
│   ├── validator.ts      # MIME type and size validation
│   ├── injector.ts       # Transform to SDK file parts
│   └── index.ts          # Public exports
```

### 2. Attachment Types (`src/lib/attachments/types.ts`)

> **SDK Schema Verification (2026-01-18):** Types aligned with `@opencode-ai/sdk` v1.1.x `FilePartInput` from SDK: `{ type: 'file', mime: string, url: string, filename?: string }` `TextPartInput` from SDK: `{ type: 'text', text: string }` The SDK expects `url` (file:// URL), NOT base64 `content`.
>
> **IMPORTANT:** DO NOT duplicate SDK types. Import from `@opencode-ai/sdk` directly.

```typescript
import type {Logger} from "../logger.js"
// Import SDK types directly - DO NOT duplicate
import type {FilePartInput, TextPartInput} from "@opencode-ai/sdk"

// Re-export SDK types for convenience
export type {FilePartInput, TextPartInput}

/**
 * Parsed attachment URL from comment body.
 */
export interface AttachmentUrl {
  readonly url: string
  readonly originalMarkdown: string
  readonly altText: string
  readonly type: "image" | "file"
}

/**
 * Downloaded attachment with metadata and temp file path.
 */
export interface DownloadedAttachment {
  readonly url: string
  readonly filename: string
  readonly mime: string
  readonly sizeBytes: number
  readonly tempPath: string // Local temp file path
}

/**
 * Validated attachment ready for prompt injection.
 */
export interface ValidatedAttachment {
  readonly filename: string
  readonly mime: string
  readonly sizeBytes: number
  readonly tempPath: string // Local temp file path
}

/**
 * Attachment processing result.
 */
export interface AttachmentResult {
  readonly processed: readonly ValidatedAttachment[]
  readonly skipped: readonly SkippedAttachment[]
  readonly modifiedBody: string
  readonly fileParts: readonly FilePartInput[] // Uses SDK type directly
  readonly tempFiles: readonly string[] // Paths to clean up
}

export interface SkippedAttachment {
  readonly url: string
  readonly reason: string
}

/**
 * Attachment limits configuration.
 */
export interface AttachmentLimits {
  readonly maxFiles: number // Default: 5
  readonly maxFileSizeBytes: number // Default: 5MB
  readonly maxTotalSizeBytes: number // Default: 15MB
  readonly allowedMimeTypes: readonly string[]
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFiles: 5,
  maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
  maxTotalSizeBytes: 15 * 1024 * 1024, // 15MB
  allowedMimeTypes: [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/pdf",
  ],
}
```

### 3. URL Parser (`src/lib/attachments/parser.ts`)

```typescript
import type {AttachmentUrl} from "./types.js"

/**
 * GitHub user-attachment URL patterns.
 *
 * Supported formats:
 * - Markdown images: ![alt](https://github.com/user-attachments/assets/...)
 * - HTML images: <img ... src="https://github.com/user-attachments/assets/..." />
 * - File links: [filename](https://github.com/user-attachments/files/...)
 */
const ATTACHMENT_PATTERNS = {
  // Markdown image: ![alt](url)
  markdownImage: /!\[([^\]]*)\]\((https:\/\/github\.com\/user-attachments\/assets\/[^)]+)\)/gi,

  // Markdown link: [text](url) - for files
  markdownLink: /\[([^\]]+)\]\((https:\/\/github\.com\/user-attachments\/files\/[^)]+)\)/gi,

  // HTML image: <img src="url" ...>
  htmlImage: /<img[^>]*src=["'](https:\/\/github\.com\/user-attachments\/assets\/[^"']+)["'][^>]*>/gi,
}

/**
 * Parse comment body for GitHub user-attachment URLs.
 *
 * Only extracts URLs from github.com/user-attachments/ for security.
 */
export function parseAttachmentUrls(body: string): readonly AttachmentUrl[] {
  const attachments: AttachmentUrl[] = []
  const seenUrls = new Set<string>()

  // Parse markdown images
  let match: RegExpExecArray | null
  while ((match = ATTACHMENT_PATTERNS.markdownImage.exec(body)) != null) {
    const url = match[2]
    if (!seenUrls.has(url)) {
      seenUrls.add(url)
      attachments.push({
        url,
        originalMarkdown: match[0],
        altText: match[1],
        type: "image",
      })
    }
  }

  // Reset regex lastIndex
  ATTACHMENT_PATTERNS.markdownImage.lastIndex = 0

  // Parse markdown file links
  while ((match = ATTACHMENT_PATTERNS.markdownLink.exec(body)) != null) {
    const url = match[2]
    if (!seenUrls.has(url)) {
      seenUrls.add(url)
      attachments.push({
        url,
        originalMarkdown: match[0],
        altText: match[1],
        type: "file",
      })
    }
  }

  ATTACHMENT_PATTERNS.markdownLink.lastIndex = 0

  // Parse HTML images
  while ((match = ATTACHMENT_PATTERNS.htmlImage.exec(body)) != null) {
    const url = match[1]
    if (!seenUrls.has(url)) {
      seenUrls.add(url)
      // Extract alt from alt attribute if present
      const altMatch = /alt=["']([^"']*)["']/i.exec(match[0])
      attachments.push({
        url,
        originalMarkdown: match[0],
        altText: altMatch?.[1] ?? "",
        type: "image",
      })
    }
  }

  ATTACHMENT_PATTERNS.htmlImage.lastIndex = 0

  return attachments
}

/**
 * Validate that a URL is from the allowed GitHub user-attachments domain.
 *
 * Security: Only allows github.com/user-attachments/* URLs.
 */
export function isValidAttachmentUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.startsWith("/user-attachments/")
    )
  } catch {
    return false
  }
}

/**
 * Extract filename from attachment URL or use fallback.
 */
export function extractFilename(url: string, altText: string, index: number): string {
  try {
    const parsed = new URL(url)
    const pathParts = parsed.pathname.split("/")
    const lastPart = pathParts[pathParts.length - 1]

    // If URL has a recognizable filename, use it
    if (lastPart != null && /\.[a-z0-9]+$/i.test(lastPart)) {
      return lastPart
    }

    // Use alt text if available
    if (altText.length > 0) {
      // Sanitize alt text for use as filename
      const sanitized = altText.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50)
      return sanitized.length > 0 ? sanitized : `attachment_${index + 1}`
    }

    return `attachment_${index + 1}`
  } catch {
    return `attachment_${index + 1}`
  }
}
```

### 4. Downloader (`src/lib/attachments/downloader.ts`)

> **Security Note (2026-01-18):** Downloads use `redirect: "manual"` to prevent token leakage to non-GitHub hosts. Content-Length checked before buffering to prevent memory exhaustion.

```typescript
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type {AttachmentUrl, DownloadedAttachment, AttachmentLimits} from "./types.js"
import type {Logger} from "../logger.js"
import {extractFilename} from "./parser.js"
import {DEFAULT_ATTACHMENT_LIMITS} from "./types.js"

/**
 * Download attachment with GitHub token authentication.
 *
 * Security measures:
 * - Uses redirect: "manual" to prevent token leakage on redirects
 * - Validates final URL is still github.com before following redirect
 * - Checks Content-Length before buffering to prevent memory exhaustion
 * - Saves to temp file for SDK file:// URL consumption
 */
export async function downloadAttachment(
  attachment: AttachmentUrl,
  index: number,
  token: string,
  limits: AttachmentLimits,
  logger: Logger,
): Promise<DownloadedAttachment | null> {
  logger.debug("Downloading attachment", {url: attachment.url})

  try {
    // Initial request with redirect: manual for security
    const response = await fetch(attachment.url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "*/*",
        "User-Agent": "fro-bot-agent",
      },
      redirect: "manual",
    })

    // Handle redirect manually - validate target is still github.com
    let finalResponse = response
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (location == null) {
        logger.warning("Redirect without location", {url: attachment.url})
        return null
      }

      // Validate redirect target
      const redirectUrl = new URL(location)
      if (redirectUrl.hostname !== "github.com" && !redirectUrl.hostname.endsWith(".githubusercontent.com")) {
        logger.warning("Redirect to non-GitHub host blocked", {
          url: attachment.url,
          redirectTo: redirectUrl.hostname,
        })
        return null
      }

      // Follow redirect WITHOUT auth header (token only for initial request)
      finalResponse = await fetch(location, {
        headers: {
          Accept: "*/*",
          "User-Agent": "fro-bot-agent",
        },
        redirect: "follow",
      })
    }

    if (!finalResponse.ok) {
      logger.warning("Attachment download failed", {
        url: attachment.url,
        status: finalResponse.status,
      })
      return null
    }

    // Check Content-Length before buffering
    const contentLength = finalResponse.headers.get("content-length")
    if (contentLength != null) {
      const size = parseInt(contentLength, 10)
      if (size > limits.maxFileSizeBytes) {
        logger.warning("Attachment exceeds size limit (Content-Length)", {
          url: attachment.url,
          size,
          limit: limits.maxFileSizeBytes,
        })
        return null
      }
    }

    const buffer = Buffer.from(await finalResponse.arrayBuffer())

    // Double-check size after download (Content-Length may be missing/wrong)
    if (buffer.length > limits.maxFileSizeBytes) {
      logger.warning("Attachment exceeds size limit", {
        url: attachment.url,
        size: buffer.length,
        limit: limits.maxFileSizeBytes,
      })
      return null
    }

    const contentType = finalResponse.headers.get("content-type") ?? "application/octet-stream"
    const filename = extractFilename(attachment.url, attachment.altText, index)
    const mime = contentType.split(";")[0].trim()

    // Write to temp file for SDK consumption
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fro-bot-attachments-"))
    const tempPath = path.join(tempDir, filename)
    await fs.writeFile(tempPath, buffer)

    logger.debug("Attachment downloaded", {
      filename,
      mime,
      sizeBytes: buffer.length,
      tempPath,
    })

    return {
      url: attachment.url,
      filename,
      mime,
      sizeBytes: buffer.length,
      tempPath,
    }
  } catch (error) {
    logger.warning("Attachment download error", {
      url: attachment.url,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Download multiple attachments in parallel.
 */
export async function downloadAttachments(
  attachments: readonly AttachmentUrl[],
  token: string,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
  logger: Logger,
): Promise<readonly (DownloadedAttachment | null)[]> {
  return Promise.all(
    attachments.map((attachment, index) => downloadAttachment(attachment, index, token, limits, logger)),
  )
}

/**
 * Clean up temp files after processing.
 * Call in finally block to ensure cleanup even on errors.
 */
export async function cleanupTempFiles(tempPaths: readonly string[], logger: Logger): Promise<void> {
  for (const tempPath of tempPaths) {
    try {
      await fs.unlink(tempPath)
      // Also try to remove the temp directory
      const tempDir = path.dirname(tempPath)
      await fs.rmdir(tempDir).catch(() => {}) // Ignore if not empty
    } catch (error) {
      logger.debug("Failed to cleanup temp file", {
        path: tempPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
```

### 5. Validator (`src/lib/attachments/validator.ts`)

```typescript
import type {DownloadedAttachment, ValidatedAttachment, SkippedAttachment, AttachmentLimits} from "./types.js"
import type {Logger} from "../logger.js"
import {DEFAULT_ATTACHMENT_LIMITS} from "./types.js"

interface ValidationResult {
  readonly validated: readonly ValidatedAttachment[]
  readonly skipped: readonly SkippedAttachment[]
}

/**
 * Validate downloaded attachments against limits.
 */
export function validateAttachments(
  downloaded: readonly (DownloadedAttachment | null)[],
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
  logger: Logger,
): ValidationResult {
  const validated: ValidatedAttachment[] = []
  const skipped: SkippedAttachment[] = []
  let totalSize = 0

  for (const attachment of downloaded) {
    // Skip failed downloads
    if (attachment == null) {
      continue
    }

    // Check file count limit
    if (validated.length >= limits.maxFiles) {
      skipped.push({
        url: attachment.url,
        reason: `Exceeds max file count (${limits.maxFiles})`,
      })
      logger.debug("Attachment skipped: max count", {url: attachment.url})
      continue
    }

    // Check individual file size (already checked in downloader, but double-check)
    if (attachment.sizeBytes > limits.maxFileSizeBytes) {
      skipped.push({
        url: attachment.url,
        reason: `File too large (${formatBytes(attachment.sizeBytes)} > ${formatBytes(limits.maxFileSizeBytes)})`,
      })
      logger.debug("Attachment skipped: too large", {
        url: attachment.url,
        size: attachment.sizeBytes,
      })
      continue
    }

    // Check total size limit
    if (totalSize + attachment.sizeBytes > limits.maxTotalSizeBytes) {
      skipped.push({
        url: attachment.url,
        reason: `Would exceed total size limit (${formatBytes(limits.maxTotalSizeBytes)})`,
      })
      logger.debug("Attachment skipped: total size exceeded", {url: attachment.url})
      continue
    }

    // Check MIME type
    if (!isMimeTypeAllowed(attachment.mime, limits.allowedMimeTypes)) {
      skipped.push({
        url: attachment.url,
        reason: `MIME type not allowed: ${attachment.mime}`,
      })
      logger.debug("Attachment skipped: MIME type", {
        url: attachment.url,
        mime: attachment.mime,
      })
      continue
    }

    // Attachment validated
    totalSize += attachment.sizeBytes
    validated.push({
      filename: attachment.filename,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      tempPath: attachment.tempPath,
    })

    logger.info("Attachment validated", {
      filename: attachment.filename,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
    })
  }

  return {validated, skipped}
}

/**
 * Check if MIME type is in allowed list.
 *
 * Supports wildcards (e.g., "image/*").
 */
function isMimeTypeAllowed(mime: string, allowedTypes: readonly string[]): boolean {
  const [category] = mime.split("/")

  for (const allowed of allowedTypes) {
    if (allowed === mime) {
      return true
    }

    // Check wildcard (e.g., "image/*")
    if (allowed.endsWith("/*")) {
      const allowedCategory = allowed.slice(0, -2)
      if (category === allowedCategory) {
        return true
      }
    }
  }

  return false
}

/**
 * Format bytes for human-readable display.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
```

### 6. Prompt Injector (`src/lib/attachments/injector.ts`)

> **Note:** Uses `FilePartInput` from `@opencode-ai/sdk` - do NOT duplicate the type.

```typescript
import {pathToFileURL} from "node:url"
import type {FilePartInput} from "@opencode-ai/sdk"
import type {AttachmentUrl, ValidatedAttachment, AttachmentResult, SkippedAttachment} from "./types.js"

/**
 * Transform validated attachments to SDK file parts.
 *
 * Uses file:// URLs pointing to temp files as required by SDK.
 */
export function toFileParts(attachments: readonly ValidatedAttachment[]): readonly FilePartInput[] {
  return attachments.map(attachment => ({
    type: "file" as const,
    mime: attachment.mime,
    url: pathToFileURL(attachment.tempPath).toString(),
    filename: attachment.filename,
  }))
}

/**
 * Modify comment body to replace attachment markdown with @filename references.
 *
 * This allows the agent to understand which files are being referenced.
 */
export function modifyBodyForAttachments(
  originalBody: string,
  parsedUrls: readonly AttachmentUrl[],
  validated: readonly ValidatedAttachment[],
): string {
  let modifiedBody = originalBody

  // Build URL -> filename mapping
  const urlToFilename = new Map<string, string>()
  for (const attachment of validated) {
    // Find the parsed URL that matches this filename
    const parsedUrl = parsedUrls.find(p => validated.some(v => v.filename === attachment.filename))
    if (parsedUrl != null) {
      urlToFilename.set(parsedUrl.originalMarkdown, `@${attachment.filename}`)
    }
  }

  // Replace markdown with @filename references
  for (const [originalMarkdown, reference] of urlToFilename) {
    modifiedBody = modifiedBody.replace(originalMarkdown, reference)
  }

  return modifiedBody
}

/**
 * Process attachments and return complete result.
 */
export function buildAttachmentResult(
  originalBody: string,
  parsedUrls: readonly AttachmentUrl[],
  validated: readonly ValidatedAttachment[],
  skipped: readonly SkippedAttachment[],
): AttachmentResult {
  const modifiedBody = modifyBodyForAttachments(originalBody, parsedUrls, validated)
  const fileParts = toFileParts(validated)
  const tempFiles = validated.map(v => v.tempPath)

  return {
    processed: validated,
    skipped,
    modifiedBody,
    fileParts,
    tempFiles,
  }
}
```

### 7. Public Exports (`src/lib/attachments/index.ts`)

```typescript
export {parseAttachmentUrls, isValidAttachmentUrl, extractFilename} from "./parser.js"
export {downloadAttachment, downloadAttachments, cleanupTempFiles} from "./downloader.js"
export {validateAttachments} from "./validator.js"
export {toFileParts, modifyBodyForAttachments, buildAttachmentResult} from "./injector.js"
export type {
  AttachmentUrl,
  DownloadedAttachment,
  ValidatedAttachment,
  AttachmentResult,
  SkippedAttachment,
  AttachmentLimits,
} from "./types.js"
// Re-export SDK types for convenience
export type {FilePartInput, TextPartInput} from "./types.js"
export {DEFAULT_ATTACHMENT_LIMITS} from "./types.js"
```

### 8. Integration with Main Action

Add to `src/main.ts` after context collection:

```typescript
import type {FilePartInput} from "@opencode-ai/sdk"
import {
  parseAttachmentUrls,
  downloadAttachments,
  validateAttachments,
  buildAttachmentResult,
  cleanupTempFiles,
  type AttachmentResult,
} from "./lib/attachments/index.js"

// ... in run() function, after collecting agent context ...

// Process attachments from comment body
const attachmentLogger = createLogger({phase: "attachments"})
const parsedUrls = parseAttachmentUrls(agentContext.commentBody ?? "")

let attachmentResult: AttachmentResult | null = null

if (parsedUrls.length > 0) {
  attachmentLogger.info("Processing attachments", {count: parsedUrls.length})

  const token = inputs.githubToken
  const downloaded = await downloadAttachments(parsedUrls, token, undefined, attachmentLogger)
  const {validated, skipped} = validateAttachments(downloaded, undefined, attachmentLogger)

  attachmentResult = buildAttachmentResult(agentContext.commentBody ?? "", parsedUrls, validated, skipped)

  attachmentLogger.info("Attachments processed", {
    processed: validated.length,
    skipped: skipped.length,
  })
}

// Pass attachmentResult to executeOpenCode for SDK file parts
// Cleanup temp files in finally block:
try {
  // ... execute agent ...
} finally {
  if (attachmentResult != null) {
    await cleanupTempFiles(attachmentResult.tempFiles, attachmentLogger)
  }
}
```

### 9. SDK Prompt with File Parts

Update `executeOpenCode()` to accept file parts. Import SDK types directly:

```typescript
import type {FilePartInput, TextPartInput} from "@opencode-ai/sdk"

// In PromptOptions, add fileParts field:
export interface PromptOptions {
  // ... existing fields ...
  readonly fileParts?: readonly FilePartInput[]
}

// In opencode.ts, update prompt call to include file parts:
const textPart: TextPartInput = {type: "text", text: prompt}
const parts: Array<TextPartInput | FilePartInput> = [textPart]

// Add file parts if present
if (promptOptions.fileParts != null && promptOptions.fileParts.length > 0) {
  parts.push(...promptOptions.fileParts)
}

const promptBody = {
  agent: agentName,
  parts,
  ...(config?.model != null && {
    model: {
      providerID: config.model.providerID,
      modelID: config.model.modelID,
    },
  }),
}

await client.session.prompt({
  path: {id: sessionId},
  body: promptBody,
})
```

## Acceptance Criteria

- [ ] Markdown image URLs parsed from comment body
- [ ] HTML image URLs parsed from comment body
- [ ] Markdown file link URLs parsed from comment body
- [ ] Only `github.com/user-attachments/` URLs accepted (security)
- [ ] Attachments downloaded with GitHub token authentication
- [ ] MIME type determined from response headers
- [ ] File size validated against 5MB limit per file
- [ ] Total size validated against 15MB limit
- [ ] Max 5 attachments per comment
- [ ] Only allowed MIME types accepted
- [ ] Validated attachments converted to base64
- [ ] File parts passed to SDK `prompt()` call
- [ ] Original markdown replaced with `@filename` in prompt body
- [ ] Attachments NOT persisted to cache
- [ ] Attachment metadata logged (filename, size, type)

## Test Cases

### URL Parsing Tests

```typescript
describe("parseAttachmentUrls", () => {
  it("parses markdown image URLs", () => {
    const body = "Check this: ![screenshot](https://github.com/user-attachments/assets/abc123)"
    const result = parseAttachmentUrls(body)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("image")
    expect(result[0].url).toContain("user-attachments/assets")
  })

  it("parses markdown file links", () => {
    const body = "See [log.txt](https://github.com/user-attachments/files/xyz789)"
    const result = parseAttachmentUrls(body)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("file")
  })

  it("parses HTML image tags", () => {
    const body = '<img src="https://github.com/user-attachments/assets/img123" alt="error">'
    const result = parseAttachmentUrls(body)
    expect(result).toHaveLength(1)
    expect(result[0].altText).toBe("error")
  })

  it("ignores non-GitHub URLs", () => {
    const body = "![img](https://example.com/image.png)"
    const result = parseAttachmentUrls(body)
    expect(result).toHaveLength(0)
  })

  it("deduplicates same URL appearing multiple times", () => {
    const url = "https://github.com/user-attachments/assets/same123"
    const body = `![a](${url}) and ![b](${url})`
    const result = parseAttachmentUrls(body)
    expect(result).toHaveLength(1)
  })
})
```

### Validation Tests

```typescript
describe("validateAttachments", () => {
  it("accepts attachments within limits", () => {
    const downloaded = [createMockDownload({sizeBytes: 1024, mimeType: "image/png"})]
    const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)
    expect(result.validated).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
  })

  it("rejects files exceeding size limit", () => {
    const downloaded = [createMockDownload({sizeBytes: 10 * 1024 * 1024, mimeType: "image/png"})]
    const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)
    expect(result.validated).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain("too large")
  })

  it("rejects disallowed MIME types", () => {
    const downloaded = [createMockDownload({sizeBytes: 1024, mimeType: "application/x-executable"})]
    const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)
    expect(result.validated).toHaveLength(0)
    expect(result.skipped[0].reason).toContain("MIME type not allowed")
  })

  it("enforces max file count", () => {
    const downloaded = Array.from({length: 10}, () => createMockDownload({sizeBytes: 1024, mimeType: "image/png"}))
    const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)
    expect(result.validated).toHaveLength(5)
    expect(result.skipped).toHaveLength(5)
  })

  it("enforces total size limit", () => {
    const downloaded = [
      createMockDownload({sizeBytes: 6 * 1024 * 1024, mimeType: "image/png"}),
      createMockDownload({sizeBytes: 6 * 1024 * 1024, mimeType: "image/png"}),
      createMockDownload({sizeBytes: 6 * 1024 * 1024, mimeType: "image/png"}),
    ]
    const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)
    expect(result.validated).toHaveLength(2)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain("total size")
  })
})
```

### Security Tests

```typescript
describe("isValidAttachmentUrl", () => {
  it("accepts github.com/user-attachments URLs", () => {
    expect(isValidAttachmentUrl("https://github.com/user-attachments/assets/abc")).toBe(true)
    expect(isValidAttachmentUrl("https://github.com/user-attachments/files/xyz")).toBe(true)
  })

  it("rejects non-GitHub URLs", () => {
    expect(isValidAttachmentUrl("https://malicious.com/user-attachments/assets/abc")).toBe(false)
    expect(isValidAttachmentUrl("https://github.com.evil.com/user-attachments/assets/abc")).toBe(false)
  })

  it("rejects non-user-attachments GitHub URLs", () => {
    expect(isValidAttachmentUrl("https://github.com/owner/repo/blob/main/file.png")).toBe(false)
    expect(isValidAttachmentUrl("https://raw.githubusercontent.com/owner/repo/main/file.png")).toBe(false)
  })

  it("rejects HTTP URLs", () => {
    expect(isValidAttachmentUrl("http://github.com/user-attachments/assets/abc")).toBe(false)
  })
})
```

## Security Considerations

1. **URL Allowlist**: Only `github.com/user-attachments/` URLs are processed
2. **Authentication**: Downloads use GitHub token for private repo access
3. **Size Limits**: Prevents resource exhaustion (5MB per file, 15MB total)
4. **MIME Validation**: Only allows safe content types (images, text, JSON, PDF)
5. **No Persistence**: Attachments are temp-only, never cached
6. **Log Sanitization**: Only metadata logged, never content

## Implementation Notes

1. **Temp Storage**: Downloaded files stored in temp directory, cleaned up after run
2. **Parallel Downloads**: All attachments downloaded concurrently for performance
3. **Graceful Degradation**: Failed downloads logged as warnings, not errors
4. **Base64 Encoding**: Required by SDK `type: "file"` parts
5. **Body Modification**: Original URLs replaced with `@filename` for agent context

## Estimated Effort

- **Development**: 6-8 hours
- **Testing**: 3-4 hours
- **Total**: 9-12 hours
