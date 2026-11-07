/**
 * Attachment types for RFC-014 File Attachment Processing.
 *
 * @module attachments/types
 */

// The prompt part shapes are owned by the runtime package; re-exported here for attachment callers.
import type {FilePartInput, TextPartInput} from '@fro-bot/runtime'

export type {FilePartInput, TextPartInput}

/**
 * Parsed attachment URL from comment body.
 */
export interface AttachmentUrl {
  readonly url: string
  readonly originalMarkdown: string
  readonly altText: string
  readonly type: 'image' | 'file'
}

/**
 * Downloaded attachment with metadata and temp file path.
 */
export interface DownloadedAttachment {
  readonly url: string
  readonly filename: string
  readonly mime: string
  readonly sizeBytes: number
  readonly tempPath: string
}

/**
 * Validated attachment ready for prompt injection.
 */
export interface ValidatedAttachment {
  readonly filename: string
  readonly mime: string
  readonly sizeBytes: number
  readonly tempPath: string
}

/**
 * Skipped attachment with reason.
 */
export interface SkippedAttachment {
  readonly url: string
  readonly reason: string
}

/**
 * Attachment processing result.
 */
export interface AttachmentResult {
  readonly processed: readonly ValidatedAttachment[]
  readonly skipped: readonly SkippedAttachment[]
  readonly modifiedBody: string
  readonly fileParts: readonly FilePartInput[]
  readonly tempFiles: readonly string[]
}

/**
 * Attachment limits configuration.
 */
export interface AttachmentLimits {
  readonly maxFiles: number
  readonly maxFileSizeBytes: number
  readonly maxTotalSizeBytes: number
  readonly allowedMimeTypes: readonly string[]
}

/**
 * Default attachment limits per RFC-014.
 */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFiles: 5,
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxTotalSizeBytes: 15 * 1024 * 1024,
  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/pdf',
  ],
}
