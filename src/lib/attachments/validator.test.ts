import type {AttachmentLimits, DownloadedAttachment} from './types.js'
import {describe, expect, it} from 'vitest'
import {createMockLogger} from '../test-helpers.js'
import {DEFAULT_ATTACHMENT_LIMITS} from './types.js'
import {validateAttachments} from './validator.js'

function createMockDownload(overrides: Partial<DownloadedAttachment> = {}): DownloadedAttachment {
  return {
    url: 'https://github.com/user-attachments/assets/test123',
    filename: 'test.png',
    mime: 'image/png',
    sizeBytes: 1024,
    tempPath: '/tmp/test.png',
    ...overrides,
  }
}

describe('validateAttachments', () => {
  const mockLogger = createMockLogger()

  describe('accepts valid attachments', () => {
    it('accepts single attachment within limits', () => {
      // #given
      const downloaded = [createMockDownload()]

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated).toHaveLength(1)
      expect(result.skipped).toHaveLength(0)
    })

    it('accepts multiple valid attachments', () => {
      // #given
      const downloaded = [
        createMockDownload({filename: 'a.png'}),
        createMockDownload({filename: 'b.png'}),
        createMockDownload({filename: 'c.png'}),
      ]

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated).toHaveLength(3)
    })
  })

  describe('file count limits', () => {
    it('enforces max file count', () => {
      // #given
      const downloaded = Array.from({length: 10}, (_, i) =>
        createMockDownload({filename: `file${i}.png`, sizeBytes: 1024}),
      )

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated).toHaveLength(5)
      expect(result.skipped).toHaveLength(5)
      expect(result.skipped[0]?.reason).toContain('max file count')
    })
  })

  describe('file size limits', () => {
    it('rejects files exceeding individual size limit', () => {
      // #given
      const downloaded = [createMockDownload({sizeBytes: 10 * 1024 * 1024})]

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated).toHaveLength(0)
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]?.reason).toContain('too large')
    })

    it('enforces total size limit', () => {
      // #given
      const downloaded = [
        createMockDownload({filename: 'a.png', sizeBytes: 4.5 * 1024 * 1024}),
        createMockDownload({filename: 'b.png', sizeBytes: 4.5 * 1024 * 1024}),
        createMockDownload({filename: 'c.png', sizeBytes: 4.5 * 1024 * 1024}),
        createMockDownload({filename: 'd.png', sizeBytes: 4.5 * 1024 * 1024}),
      ]

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated).toHaveLength(3)
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]?.reason).toContain('total size')
    })
  })

  describe('MIME type validation', () => {
    it('rejects disallowed MIME types', () => {
      // #given
      const downloaded = [createMockDownload({mime: 'application/x-executable'})]

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated).toHaveLength(0)
      expect(result.skipped[0]?.reason).toContain('MIME type not allowed')
    })

    it('accepts allowed MIME types', () => {
      // #given
      const allowedTypes = ['image/png', 'image/jpeg', 'application/json', 'text/plain']
      const downloaded = allowedTypes.map((mime, i) => createMockDownload({filename: `file${i}`, mime}))

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated).toHaveLength(4)
    })

    it('accepts wildcard MIME type matches', () => {
      // #given
      const limits: AttachmentLimits = {
        ...DEFAULT_ATTACHMENT_LIMITS,
        allowedMimeTypes: ['image/*'],
      }
      const downloaded = [
        createMockDownload({mime: 'image/png'}),
        createMockDownload({mime: 'image/jpeg', filename: 'b.jpg'}),
        createMockDownload({mime: 'image/gif', filename: 'c.gif'}),
      ]

      // #when
      const result = validateAttachments(downloaded, limits, mockLogger)

      // #then
      expect(result.validated).toHaveLength(3)
    })
  })

  describe('null handling', () => {
    it('skips null downloads', () => {
      // #given
      const downloaded: (DownloadedAttachment | null)[] = [
        createMockDownload(),
        null,
        createMockDownload({filename: 'b.png'}),
      ]

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated).toHaveLength(2)
    })
  })

  describe('preserves attachment data', () => {
    it('copies all fields to validated attachment', () => {
      // #given
      const downloaded = [
        createMockDownload({
          filename: 'special.png',
          mime: 'image/png',
          sizeBytes: 2048,
          tempPath: '/custom/path.png',
        }),
      ]

      // #when
      const result = validateAttachments(downloaded, DEFAULT_ATTACHMENT_LIMITS, mockLogger)

      // #then
      expect(result.validated[0]).toEqual({
        filename: 'special.png',
        mime: 'image/png',
        sizeBytes: 2048,
        tempPath: '/custom/path.png',
      })
    })
  })
})
