# ATTACHMENTS MODULE

**RFC:** RFC-014 File Attachment Processing
**Status:** Completed

## OVERVIEW

Processes file attachments (images, PDFs, text, etc.) extracted from GitHub issue/PR comments for multi-modal agent interactions via the OpenCode SDK.

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
| `downloader.ts` | Secure download with redirect validation (via `fetch`) |
| `validator.ts`  | MIME type and size limit enforcement                   |
| `injector.ts`   | Build SDK `FilePartInput[]` from validated attachments |

## KEY EXPORTS

```typescript
parseAttachmentUrls(body) // Extract URLs from GitHub comment
downloadAttachments(urls, token, limits, logger) // Secure download with token
validateAttachments(attachments, limits, logger) // MIME/size validation
buildAttachmentResult(body, urls, validated, skipped) // Build SDK payload
cleanupTempFiles(tempFiles, logger) // ALWAYS call in finally block
```

## SECURITY

- **URL validation**: Only `github.com/user-attachments/` URLs accepted
- **Redirect handling**: `redirect: "manual"` used to prevent secret leakage
- **Target validation**: Only `github.com` and `githubusercontent.com` allowed
- **Resource isolation**: Downloads to OS temp directory with unique names
- **Temp cleanup**: Mandatory cleanup in `finally` block to prevent disk bloat

## LIMITS

| Limit | Value |
| --- | --- |
| Max files | 5 |
| Max file size | 5 MB |
| Max total size | 15 MB |
| Allowed MIME types | image/*, text/plain, text/markdown, text/csv, application/json, application/pdf |

## ANTI-PATTERNS

| Forbidden               | Reason                                          |
| ----------------------- | ----------------------------------------------- |
| Following redirects     | Risk of leaking `GITHUB_TOKEN` to external hosts|
| Skipping cleanup        | Leaks temporary files on CI runner disk         |
| Trusting MIME headers   | Content must be validated against allowlist     |
| Permissive URL patterns | Prevents SSRF/exfiltration via untrusted hosts |
