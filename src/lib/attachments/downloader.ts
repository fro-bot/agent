import type {Logger} from '../logger.js'
import type {AttachmentLimits, AttachmentUrl, DownloadedAttachment} from './types.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {extractFilename} from './parser.js'
import {DEFAULT_ATTACHMENT_LIMITS} from './types.js'

const ALLOWED_REDIRECT_HOSTS = ['github.com', 'githubusercontent.com'] as const

/**
 * Download attachment with GitHub token authentication.
 *
 * Performs secure download with redirect validation to prevent token leakage.
 * Enforces size limits and validates content before writing to temp file.
 *
 * @param attachment - Parsed attachment URL with metadata
 * @param index - Attachment index for filename fallback
 * @param token - GitHub token for authenticated requests
 * @param limits - Size and MIME type constraints
 * @param logger - Logger instance for debugging
 * @returns Downloaded attachment metadata or null if failed
 */
export async function downloadAttachment(
  attachment: AttachmentUrl,
  index: number,
  token: string,
  limits: AttachmentLimits,
  logger: Logger,
): Promise<DownloadedAttachment | null> {
  logger.debug('Downloading attachment', {url: attachment.url})

  try {
    const response = await fetch(attachment.url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: '*/*',
        'User-Agent': 'fro-bot-agent',
      },
      redirect: 'manual',
    })

    let finalResponse = response
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location == null) {
        logger.warning('Redirect without location', {url: attachment.url})
        return null
      }

      const redirectUrl = new URL(location)
      const isAllowedHost = ALLOWED_REDIRECT_HOSTS.some(
        host => redirectUrl.hostname === host || redirectUrl.hostname.endsWith(`.${host}`),
      )

      if (!isAllowedHost) {
        logger.warning('Redirect to non-GitHub host blocked', {
          url: attachment.url,
          redirectTo: redirectUrl.hostname,
        })
        return null
      }

      finalResponse = await fetch(location, {
        headers: {
          Accept: '*/*',
          'User-Agent': 'fro-bot-agent',
        },
        redirect: 'follow',
      })
    }

    if (!finalResponse.ok) {
      logger.warning('Attachment download failed', {
        url: attachment.url,
        status: finalResponse.status,
      })
      return null
    }

    const contentLength = finalResponse.headers.get('content-length')
    if (contentLength != null) {
      const size = Number.parseInt(contentLength, 10)
      if (size > limits.maxFileSizeBytes) {
        logger.warning('Attachment exceeds size limit (Content-Length)', {
          url: attachment.url,
          size,
          limit: limits.maxFileSizeBytes,
        })
        return null
      }
    }

    const buffer = Buffer.from(await finalResponse.arrayBuffer())

    if (buffer.length > limits.maxFileSizeBytes) {
      logger.warning('Attachment exceeds size limit', {
        url: attachment.url,
        size: buffer.length,
        limit: limits.maxFileSizeBytes,
      })
      return null
    }

    const contentType = finalResponse.headers.get('content-type') ?? 'application/octet-stream'
    const filename = extractFilename(attachment.url, attachment.altText, index)
    const mimePart = contentType.split(';')[0]
    const mime = mimePart == null ? 'application/octet-stream' : mimePart.trim()

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-attachments-'))
    const safeFilename = filename.trim().length > 0 ? filename : `attachment_${index + 1}`
    const tempPath = path.join(tempDir, safeFilename)
    await fs.writeFile(tempPath, buffer)

    logger.debug('Attachment downloaded', {
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
    logger.warning('Attachment download error', {
      url: attachment.url,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Download multiple attachments in parallel.
 *
 * Optimizes download performance by processing all attachments concurrently.
 * Individual failures are logged but don't halt other downloads.
 *
 * @param attachments - Array of parsed attachment URLs
 * @param token - GitHub token for authenticated requests
 * @param limits - Size and MIME type constraints
 * @param logger - Logger instance for debugging
 * @returns Array of downloaded attachments (null entries for failures)
 */
export async function downloadAttachments(
  attachments: readonly AttachmentUrl[],
  token: string,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
  logger: Logger,
): Promise<readonly (DownloadedAttachment | null)[]> {
  return Promise.all(
    attachments.map(async (attachment, index) => downloadAttachment(attachment, index, token, limits, logger)),
  )
}

/**
 * Clean up temporary attachment files after processing.
 *
 * Best-effort cleanup that doesn't throw errors. Removes both the temp files
 * and their containing directories.
 *
 * @param tempPaths - Array of temp file paths to remove
 * @param logger - Logger instance for debugging
 */
export async function cleanupTempFiles(tempPaths: readonly string[], logger: Logger): Promise<void> {
  for (const tempPath of tempPaths) {
    try {
      await fs.unlink(tempPath)
      const tempDir = path.dirname(tempPath)
      await fs.rmdir(tempDir).catch(() => {})
    } catch (error) {
      logger.debug('Failed to cleanup temp file', {
        path: tempPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
