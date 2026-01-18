import type {Logger} from '../logger.js'
import type {AttachmentLimits, DownloadedAttachment, SkippedAttachment, ValidatedAttachment} from './types.js'
import {DEFAULT_ATTACHMENT_LIMITS} from './types.js'

interface ValidationResult {
  readonly validated: readonly ValidatedAttachment[]
  readonly skipped: readonly SkippedAttachment[]
}

/**
 * Validate downloaded attachments against size and MIME type constraints.
 *
 * Enforces per-file and total size limits, MIME type allowlists, and file count caps.
 * Skipped attachments are tracked with reason codes for user feedback.
 *
 * @param downloaded - Array of downloaded attachments (nulls from failed downloads)
 * @param limits - Size and MIME type constraints
 * @param logger - Logger instance for validation events
 * @returns Validated and skipped attachment lists
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
    if (attachment == null) {
      continue
    }

    if (validated.length >= limits.maxFiles) {
      skipped.push({
        url: attachment.url,
        reason: `Exceeds max file count (${limits.maxFiles})`,
      })
      logger.debug('Attachment skipped: max count', {url: attachment.url})
      continue
    }

    if (attachment.sizeBytes > limits.maxFileSizeBytes) {
      skipped.push({
        url: attachment.url,
        reason: `File too large (${formatBytes(attachment.sizeBytes)} > ${formatBytes(limits.maxFileSizeBytes)})`,
      })
      logger.debug('Attachment skipped: too large', {
        url: attachment.url,
        size: attachment.sizeBytes,
      })
      continue
    }

    if (totalSize + attachment.sizeBytes > limits.maxTotalSizeBytes) {
      skipped.push({
        url: attachment.url,
        reason: `Would exceed total size limit (${formatBytes(limits.maxTotalSizeBytes)})`,
      })
      logger.debug('Attachment skipped: total size exceeded', {url: attachment.url})
      continue
    }

    if (!isMimeTypeAllowed(attachment.mime, limits.allowedMimeTypes)) {
      skipped.push({
        url: attachment.url,
        reason: `MIME type not allowed: ${attachment.mime}`,
      })
      logger.debug('Attachment skipped: MIME type', {
        url: attachment.url,
        mime: attachment.mime,
      })
      continue
    }

    totalSize += attachment.sizeBytes
    validated.push({
      filename: attachment.filename,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      tempPath: attachment.tempPath,
    })

    logger.info('Attachment validated', {
      filename: attachment.filename,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
    })
  }

  return {validated, skipped}
}

function isMimeTypeAllowed(mime: string, allowedTypes: readonly string[]): boolean {
  const [category] = mime.split('/')

  for (const allowed of allowedTypes) {
    if (allowed === mime) {
      return true
    }

    if (allowed.endsWith('/*') && category != null) {
      const allowedCategory = allowed.slice(0, -2)
      if (category === allowedCategory) {
        return true
      }
    }
  }

  return false
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
