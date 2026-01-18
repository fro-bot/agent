import type {AttachmentUrl} from './types.js'
import {isValidAttachmentUrl} from '../github/urls.js'

const ATTACHMENT_PATTERNS = {
  markdownImage: /!\[([^\]]*)\]\((https:\/\/github\.com\/user-attachments\/assets\/[^)]+)\)/gi,
  markdownLink: /\[([^\]]+)\]\((https:\/\/github\.com\/user-attachments\/files\/[^)]+)\)/gi,
  htmlImage: /<img[^>]*src=["'](https:\/\/github\.com\/user-attachments\/assets\/[^"']+)["'][^>]*>/gi,
} as const

function execPattern(pattern: RegExp, body: string, callback: (match: RegExpExecArray) => void): void {
  pattern.lastIndex = 0
  let match = pattern.exec(body)
  while (match != null) {
    callback(match)
    match = pattern.exec(body)
  }
  pattern.lastIndex = 0
}

/**
 * Parse comment body for GitHub user-attachment URLs.
 *
 * Extracts markdown images, markdown links, and HTML image tags that reference
 * GitHub attachment URLs. Deduplicates URLs and validates against security constraints.
 *
 * @param body - GitHub comment body (markdown + HTML)
 * @returns Array of parsed attachment URLs with metadata
 */
export function parseAttachmentUrls(body: string): readonly AttachmentUrl[] {
  const attachments: AttachmentUrl[] = []
  const seenUrls = new Set<string>()

  execPattern(ATTACHMENT_PATTERNS.markdownImage, body, match => {
    const url = match[2]
    const altText = match[1]
    const original = match[0]
    if (url != null && altText != null && !seenUrls.has(url) && isValidAttachmentUrl(url)) {
      seenUrls.add(url)
      attachments.push({
        url,
        originalMarkdown: original,
        altText,
        type: 'image',
      })
    }
  })

  execPattern(ATTACHMENT_PATTERNS.markdownLink, body, match => {
    const url = match[2]
    const altText = match[1]
    const original = match[0]
    if (url != null && altText != null && !seenUrls.has(url) && isValidAttachmentUrl(url)) {
      seenUrls.add(url)
      attachments.push({
        url,
        originalMarkdown: original,
        altText,
        type: 'file',
      })
    }
  })

  execPattern(ATTACHMENT_PATTERNS.htmlImage, body, match => {
    const url = match[1]
    const original = match[0]
    if (url != null && !seenUrls.has(url) && isValidAttachmentUrl(url)) {
      seenUrls.add(url)
      const altMatch = /alt=["']([^"']*)["']/i.exec(original)
      attachments.push({
        url,
        originalMarkdown: original,
        altText: altMatch?.[1] ?? '',
        type: 'image',
      })
    }
  })
  ATTACHMENT_PATTERNS.htmlImage.lastIndex = 0

  return attachments
}

/**
 * Extract filename from attachment URL or generate fallback.
 *
 * Attempts to extract a filename from the URL path. Falls back to sanitized
 * alt text if available, or a numbered attachment name otherwise.
 *
 * @param url - Attachment URL
 * @param altText - Alt text from markdown/HTML
 * @param index - Attachment index for fallback naming
 * @returns Extracted or generated filename
 */
export function extractFilename(url: string, altText: string, index: number): string {
  try {
    const parsed = new URL(url)
    const pathParts = parsed.pathname.split('/')
    const lastPart = pathParts.at(-1)

    if (lastPart != null && /\.[a-z0-9]+$/i.test(lastPart)) {
      return lastPart
    }

    if (altText.trim().length > 0) {
      const sanitized = altText.replaceAll(/[^\w.-]/g, '_').slice(0, 50)
      return sanitized.trim().length > 0 ? sanitized : `attachment_${index + 1}`
    }

    return `attachment_${index + 1}`
  } catch {
    return `attachment_${index + 1}`
  }
}
