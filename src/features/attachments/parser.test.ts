import {describe, expect, it} from 'vitest'
import {extractFilename, parseAttachmentUrls} from './parser.js'

describe('parseAttachmentUrls', () => {
  describe('markdown images', () => {
    it('parses markdown image with alt text', () => {
      // #given
      const body = 'Check this: ![screenshot](https://github.com/user-attachments/assets/abc123)'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
      const first = result[0]!
      expect(first.type).toBe('image')
      expect(first.url).toBe('https://github.com/user-attachments/assets/abc123')
      expect(first.altText).toBe('screenshot')
      expect(first.originalMarkdown).toBe('![screenshot](https://github.com/user-attachments/assets/abc123)')
    })

    it('parses markdown image without alt text', () => {
      // #given
      const body = '![](https://github.com/user-attachments/assets/empty-alt)'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
      expect(result[0]!.altText).toBe('')
    })

    it('parses multiple markdown images', () => {
      // #given
      const body = `
        ![first](https://github.com/user-attachments/assets/img1)
        Some text
        ![second](https://github.com/user-attachments/assets/img2)
      `

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(2)
      expect(result[0]!.altText).toBe('first')
      expect(result[1]!.altText).toBe('second')
    })
  })

  describe('markdown file links', () => {
    it('parses markdown file link', () => {
      // #given
      const body = 'See [log.txt](https://github.com/user-attachments/files/xyz789)'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
      const first = result[0]!
      expect(first.type).toBe('file')
      expect(first.url).toBe('https://github.com/user-attachments/files/xyz789')
      expect(first.altText).toBe('log.txt')
    })
  })

  describe('HTML images', () => {
    it('parses HTML img tag with double quotes', () => {
      // #given
      const body = '<img src="https://github.com/user-attachments/assets/html123" alt="error">'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
      const first = result[0]!
      expect(first.type).toBe('image')
      expect(first.url).toBe('https://github.com/user-attachments/assets/html123')
      expect(first.altText).toBe('error')
    })

    it('parses HTML img tag with single quotes', () => {
      // #given
      const body = "<img src='https://github.com/user-attachments/assets/single' alt='test'>"

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
      expect(result[0]!.url).toBe('https://github.com/user-attachments/assets/single')
    })

    it('parses self-closing HTML img tag', () => {
      // #given
      const body = '<img src="https://github.com/user-attachments/assets/selfclose" />'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
    })

    it('extracts alt text from HTML img', () => {
      // #given
      const body = '<img alt="my-alt" src="https://github.com/user-attachments/assets/altfirst">'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
      expect(result[0]!.altText).toBe('my-alt')
    })
  })

  describe('security - URL filtering', () => {
    it('ignores non-GitHub URLs', () => {
      // #given
      const body = '![img](https://example.com/image.png)'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(0)
    })

    it('ignores GitHub URLs not in user-attachments', () => {
      // #given
      const body = '![img](https://github.com/owner/repo/blob/main/file.png)'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(0)
    })

    it('ignores raw.githubusercontent.com URLs', () => {
      // #given
      const body = '![img](https://raw.githubusercontent.com/owner/repo/main/file.png)'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(0)
    })
  })

  describe('deduplication', () => {
    it('deduplicates same URL appearing multiple times', () => {
      // #given
      const url = 'https://github.com/user-attachments/assets/same123'
      const body = `![a](${url}) and ![b](${url})`

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
    })

    it('deduplicates URL appearing in both markdown and HTML', () => {
      // #given
      const url = 'https://github.com/user-attachments/assets/both'
      const body = `![md](${url}) and <img src="${url}">`

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
    })
  })

  describe('edge cases', () => {
    it('returns empty array for body without attachments', () => {
      // #given
      const body = 'Just some regular text without any images'

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(0)
    })

    it('returns empty array for empty body', () => {
      // #given
      const body = ''

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(0)
    })

    it('handles mixed content with regular URLs and attachments', () => {
      // #given
      const body = `
        Check out https://example.com
        ![valid](https://github.com/user-attachments/assets/valid)
        And [link](https://google.com)
      `

      // #when
      const result = parseAttachmentUrls(body)

      // #then
      expect(result).toHaveLength(1)
      expect(result[0]!.url).toContain('user-attachments')
    })
  })
})

describe('extractFilename', () => {
  it('extracts filename from URL with extension', () => {
    // #given
    const url = 'https://github.com/user-attachments/assets/12345/screenshot.png'

    // #when
    const result = extractFilename(url, '', 0)

    // #then
    expect(result).toBe('screenshot.png')
  })

  it('uses alt text when URL has no filename', () => {
    // #given
    const url = 'https://github.com/user-attachments/assets/12345'

    // #when
    const result = extractFilename(url, 'my-screenshot', 0)

    // #then
    expect(result).toBe('my-screenshot')
  })

  it('sanitizes alt text for use as filename', () => {
    // #given
    const url = 'https://github.com/user-attachments/assets/12345'

    // #when
    const result = extractFilename(url, 'my file (1).png', 0)

    // #then
    expect(result).toBe('my_file__1_.png')
  })

  it('uses fallback with index when no filename or alt', () => {
    // #given
    const url = 'https://github.com/user-attachments/assets/12345'

    // #when
    const result = extractFilename(url, '', 2)

    // #then
    expect(result).toBe('attachment_3')
  })

  it('truncates long alt text', () => {
    // #given
    const url = 'https://github.com/user-attachments/assets/12345'
    const longAlt = 'a'.repeat(100)

    // #when
    const result = extractFilename(url, longAlt, 0)

    // #then
    expect(result.length).toBeLessThanOrEqual(50)
  })

  it('handles invalid URL gracefully', () => {
    // #given
    const url = 'not-a-valid-url'

    // #when
    const result = extractFilename(url, '', 5)

    // #then
    expect(result).toBe('attachment_6')
  })
})
