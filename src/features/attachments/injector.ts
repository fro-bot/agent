import type {FilePartInput} from '@opencode-ai/sdk'
import type {AttachmentResult, AttachmentUrl, SkippedAttachment, ValidatedAttachment} from './types.js'
import {pathToFileURL} from 'node:url'

/**
 * Transform validated attachments to SDK file parts.
 *
 * Converts temp file paths to file:// URLs as required by OpenCode SDK.
 * File parts can be passed directly to session.prompt() for multi-modal input.
 *
 * @param attachments - Validated attachments with temp file paths
 * @returns Array of SDK-compatible file parts
 */
export function toFileParts(attachments: readonly ValidatedAttachment[]): readonly FilePartInput[] {
  return attachments.map(attachment => ({
    type: 'file' as const,
    mime: attachment.mime,
    url: pathToFileURL(attachment.tempPath).toString(),
    filename: attachment.filename,
  }))
}

/**
 * Modify comment body to replace attachment markdown with @filename references.
 *
 * Transforms markdown images/links into simple @filename mentions that agents
 * can reference when discussing attachments in their prompt context.
 *
 * @param originalBody - Original GitHub comment body
 * @param parsedUrls - Parsed attachment URLs from body
 * @param validated - Successfully validated attachments
 * @returns Modified body with attachment references replaced
 */
export function modifyBodyForAttachments(
  originalBody: string,
  parsedUrls: readonly AttachmentUrl[],
  validated: readonly ValidatedAttachment[],
): string {
  let modifiedBody = originalBody

  const filenameSet = new Set(validated.map(v => v.filename))
  for (const parsedUrl of parsedUrls) {
    const matchingAttachment = validated.find(v => filenameSet.has(v.filename))
    if (matchingAttachment != null) {
      modifiedBody = modifiedBody.replace(parsedUrl.originalMarkdown, `@${matchingAttachment.filename}`)
    }
  }

  return modifiedBody
}

/**
 * Build complete attachment processing result.
 *
 * Combines parsed, validated, and skipped attachments into a single result
 * object with modified body text and SDK file parts ready for prompt injection.
 *
 * @param originalBody - Original GitHub comment body
 * @param parsedUrls - Parsed attachment URLs from body
 * @param validated - Successfully validated attachments
 * @param skipped - Attachments skipped during validation
 * @returns Complete attachment processing result
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
