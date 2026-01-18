# Attachments Module

**RFC:** RFC-014 File Attachment Processing
**Status:** Completed

## Overview

Processes file attachments from GitHub issue/PR comments for multi-modal agent interactions. Downloads, validates, and injects attachments as SDK file parts.

## Architecture

```
Comment body → parseAttachmentUrls() → downloadAttachments() → validateAttachments() → buildAttachmentResult()
                     ↓                        ↓                       ↓                        ↓
              AttachmentUrl[]        DownloadedAttachment[]   ValidatedAttachment[]    AttachmentResult
                                           ↓
                                     cleanupTempFiles() [in finally block]
```

## Files

| File            | Purpose                                                |
| --------------- | ------------------------------------------------------ |
| `types.ts`      | Type definitions, limits, SDK type re-exports          |
| `parser.ts`     | Extract attachment URLs from markdown/HTML             |
| `downloader.ts` | Secure download with redirect validation               |
| `validator.ts`  | MIME type and size limit enforcement                   |
| `injector.ts`   | Build SDK `FilePartInput[]` from validated attachments |
| `index.ts`      | Public API exports                                     |

## Public API

```typescript
// Parse URLs from comment body
parseAttachmentUrls(body: string): readonly AttachmentUrl[]

// Download with authorization
downloadAttachments(
  urls: readonly AttachmentUrl[],
  token: string,
  limits?: AttachmentLimits,
  logger?: Logger,
): Promise<readonly DownloadedAttachment[]>

// Validate MIME types and sizes
validateAttachments(
  attachments: readonly DownloadedAttachment[],
  limits?: AttachmentLimits,
  logger?: Logger,
): { validated: ValidatedAttachment[], skipped: SkippedAttachment[] }

// Build final result for SDK prompt
buildAttachmentResult(
  originalBody: string,
  parsedUrls: readonly AttachmentUrl[],
  validated: readonly ValidatedAttachment[],
  skipped: readonly SkippedAttachment[],
): AttachmentResult

// Cleanup temp files (call in finally block)
cleanupTempFiles(tempFiles: readonly string[], logger?: Logger): Promise<void>
```

## Security

- **URL validation**: Only `github.com/user-attachments/` URLs accepted
- **Redirect handling**: `redirect: "manual"` prevents token leakage
- **Redirect target validation**: Only github.com and githubusercontent.com allowed
- **Size limits**: 5MB/file, 15MB total, max 5 files
- **MIME validation**: Allowlist-based (images, text, JSON, PDF)
- **Temp cleanup**: Always runs in finally block (survives errors/timeouts)

## Usage in main.ts

```typescript
// Step 6d: Process attachments
const attachmentLogger = createLogger({phase: 'attachments'})
const parsedUrls = parseAttachmentUrls(commentBody)

if (parsedUrls.length > 0) {
  const downloaded = await downloadAttachments(parsedUrls, token, undefined, logger)
  const {validated, skipped} = validateAttachments(downloaded, undefined, logger)
  attachmentResult = buildAttachmentResult(commentBody, parsedUrls, validated, skipped)
}

// Pass to prompt options
const promptOptions: PromptOptions = {
  // ...
  fileParts: attachmentResult?.fileParts,
}

// Cleanup in finally block
finally {
  if (attachmentResult != null) {
    await cleanupTempFiles(attachmentResult.tempFiles, logger)
  }
}
```

## Limits

| Limit | Value |
| --- | --- |
| Max files | 5 |
| Max file size | 5 MB |
| Max total size | 15 MB |
| Allowed MIME types | image/png, image/jpeg, image/gif, image/webp, image/svg+xml, text/plain, text/markdown, text/csv, application/json, application/pdf |

## Tests

- `parser.test.ts` - 22 tests (URL extraction, markdown/HTML patterns)
- `downloader.test.ts` - 7 tests (download, redirect handling, cleanup)
- `validator.test.ts` - 10 tests (MIME validation, size limits)
- `injector.test.ts` - 5 tests (file part building, body modification)
