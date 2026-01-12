# RFC-014: File Attachment Processing

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2

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

```typescript
import type {Logger} from "../types.js"

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
 * Downloaded attachment with metadata.
 */
export interface DownloadedAttachment {
  readonly url: string
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly content: Buffer
}

/**
 * Validated attachment ready for prompt injection.
 */
export interface ValidatedAttachment {
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly base64Content: string
}

/**
 * SDK-compatible file part.
 */
export interface FilePart {
  readonly type: "file"
  readonly filename: string
  readonly mimeType: string
  readonly content: string // base64
}

/**
 * Attachment processing result.
 */
export interface AttachmentResult {
  readonly processed: readonly ValidatedAttachment[]
  readonly skipped: readonly SkippedAttachment[]
  readonly modifiedBody: string
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

```typescript
import type {AttachmentUrl, DownloadedAttachment, Logger} from "./types.js"
import {extractFilename} from "./parser.js"

/**
 * Download attachment with GitHub token authentication.
 *
 * Uses fetch with Authorization header for private repo attachments.
 */
export async function downloadAttachment(
  attachment: AttachmentUrl,
  index: number,
  token: string,
  logger: Logger,
): Promise<DownloadedAttachment | null> {
  logger.debug("Downloading attachment", {url: attachment.url})

  try {
    const response = await fetch(attachment.url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "*/*",
        "User-Agent": "fro-bot-agent",
      },
      redirect: "follow",
    })

    if (!response.ok) {
      logger.warning("Attachment download failed", {
        url: attachment.url,
        status: response.status,
      })
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get("content-type") ?? "application/octet-stream"
    const filename = extractFilename(attachment.url, attachment.altText, index)

    logger.debug("Attachment downloaded", {
      filename,
      mimeType: contentType,
      sizeBytes: buffer.length,
    })

    return {
      url: attachment.url,
      filename,
      mimeType: contentType.split(";")[0].trim(),
      sizeBytes: buffer.length,
      content: buffer,
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
  logger: Logger,
): Promise<readonly (DownloadedAttachment | null)[]> {
  return Promise.all(attachments.map((attachment, index) => downloadAttachment(attachment, index, token, logger)))
}
```

### 5. Validator (`src/lib/attachments/validator.ts`)

```typescript
import type {DownloadedAttachment, ValidatedAttachment, SkippedAttachment, AttachmentLimits, Logger} from "./types.js"
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

    // Check individual file size
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
    if (!isMimeTypeAllowed(attachment.mimeType, limits.allowedMimeTypes)) {
      skipped.push({
        url: attachment.url,
        reason: `MIME type not allowed: ${attachment.mimeType}`,
      })
      logger.debug("Attachment skipped: MIME type", {
        url: attachment.url,
        mimeType: attachment.mimeType,
      })
      continue
    }

    // Attachment validated
    totalSize += attachment.sizeBytes
    validated.push({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      base64Content: attachment.content.toString("base64"),
    })

    logger.info("Attachment validated", {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
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
function isMimeTypeAllowed(mimeType: string, allowedTypes: readonly string[]): boolean {
  const [category, subtype] = mimeType.split("/")

  for (const allowed of allowedTypes) {
    if (allowed === mimeType) {
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

```typescript
import type {
  AttachmentUrl,
  ValidatedAttachment,
  FilePart,
  AttachmentResult,
  SkippedAttachment,
  Logger,
} from "./types.js"

/**
 * Transform validated attachments to SDK file parts.
 */
export function toFileParts(attachments: readonly ValidatedAttachment[]): readonly FilePart[] {
  return attachments.map(attachment => ({
    type: "file" as const,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    content: attachment.base64Content,
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

  return {
    processed: validated,
    skipped,
    modifiedBody,
  }
}
```

### 7. Public Exports (`src/lib/attachments/index.ts`)

```typescript
export {parseAttachmentUrls, isValidAttachmentUrl, extractFilename} from "./parser.js"
export {downloadAttachment, downloadAttachments} from "./downloader.js"
export {validateAttachments} from "./validator.js"
export {toFileParts, modifyBodyForAttachments, buildAttachmentResult} from "./injector.js"
export type {
  AttachmentUrl,
  DownloadedAttachment,
  ValidatedAttachment,
  FilePart,
  AttachmentResult,
  SkippedAttachment,
  AttachmentLimits,
} from "./types.js"
export {DEFAULT_ATTACHMENT_LIMITS} from "./types.js"
```

### 8. Integration with Main Action

Add to `src/main.ts` after context collection:

```typescript
import {
  parseAttachmentUrls,
  downloadAttachments,
  validateAttachments,
  buildAttachmentResult,
  toFileParts,
} from "./lib/attachments/index.js"

// ... in run() function, after collecting agent context ...

// Process attachments from comment body
const attachmentLogger = createLogger({phase: "attachments"})
const parsedUrls = parseAttachmentUrls(agentContext.commentBody ?? "")

let attachmentResult: AttachmentResult | null = null
let fileParts: FilePart[] = []

if (parsedUrls.length > 0) {
  attachmentLogger.info("Processing attachments", {count: parsedUrls.length})

  const token = inputs.githubToken
  const downloaded = await downloadAttachments(parsedUrls, token, attachmentLogger)
  const {validated, skipped} = validateAttachments(downloaded, undefined, attachmentLogger)

  attachmentResult = buildAttachmentResult(agentContext.commentBody ?? "", parsedUrls, validated, skipped)

  fileParts = toFileParts(validated)

  attachmentLogger.info("Attachments processed", {
    processed: validated.length,
    skipped: skipped.length,
  })
}

// Use attachmentResult.modifiedBody in prompt if attachments were processed
const promptBody = attachmentResult?.modifiedBody ?? agentContext.commentBody ?? ""
```

### 9. SDK Prompt with File Parts

Update `executeOpenCode()` to accept file parts:

```typescript
// In opencode.ts, update prompt call to include file parts
const promptResponse = await client.session.prompt<true>({
  path: {id: session.id},
  body: {
    ...(model != null && {
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }),
    agent: agent ?? undefined,
    parts: [
      {type: "text", text: prompt},
      ...fileParts, // File parts added here
    ],
  },
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
