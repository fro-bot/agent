# ATTACHMENTS MODULE

**RFC:** RFC-014 File Attachment Processing
**Status:** Completed

## OVERVIEW

Processes file attachments from GitHub issue/PR comments for multi-modal agent interactions.

## ARCHITECTURE

```
Comment body → parseAttachmentUrls() → downloadAttachments() → validateAttachments() → buildAttachmentResult()
                     ↓                        ↓                       ↓                        ↓
              AttachmentUrl[]        DownloadedAttachment[]   ValidatedAttachment[]    AttachmentResult
                                           ↓
                                     cleanupTempFiles() [in finally block]
```

## WHERE TO LOOK

| File            | Purpose                                                |
| --------------- | ------------------------------------------------------ |
| `types.ts`      | Type definitions, limits, SDK type re-exports          |
| `parser.ts`     | Extract attachment URLs from markdown/HTML             |
| `downloader.ts` | Secure download with redirect validation               |
| `validator.ts`  | MIME type and size limit enforcement                   |
| `injector.ts`   | Build SDK `FilePartInput[]` from validated attachments |

## KEY EXPORTS

```typescript
parseAttachmentUrls(body) // Extract URLs from comment
downloadAttachments(urls, token, limits, logger) // Secure download
validateAttachments(attachments, limits, logger) // MIME/size validation
buildAttachmentResult(body, urls, validated, skipped) // Build SDK parts
cleanupTempFiles(tempFiles, logger) // Cleanup in finally block
```

## SECURITY

- **URL validation**: Only `github.com/user-attachments/` URLs accepted
- **Redirect handling**: `redirect: "manual"` prevents token leakage
- **Redirect target validation**: Only github.com and githubusercontent.com allowed
- **Size limits**: 5MB/file, 15MB total, max 5 files
- **MIME validation**: Allowlist-based (images, text, JSON, PDF)
- **Temp cleanup**: Always runs in finally block (survives errors/timeouts)

## LIMITS

| Limit | Value |
| --- | --- |
| Max files | 5 |
| Max file size | 5 MB |
| Max total size | 15 MB |
| Allowed MIME types | image/png, image/jpeg, image/gif, image/webp, image/svg+xml, text/plain, text/markdown, text/csv, application/json, application/pdf |

## ANTI-PATTERNS

| Forbidden               | Reason                                      |
| ----------------------- | ------------------------------------------- |
| Skipping URL validation | Only trusted github.com URLs                |
| Following redirects     | Use `redirect: "manual"` to prevent leakage |
| Missing cleanup         | Always call `cleanupTempFiles` in finally   |
| Trusting MIME headers   | Validate against allowlist                  |
