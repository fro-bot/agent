import type {Logger} from '../logger.js'
import type {AttachmentUrl} from './types.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanupTempFiles, downloadAttachment} from './downloader.js'
import {DEFAULT_ATTACHMENT_LIMITS} from './types.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createMockAttachmentUrl(overrides: Partial<AttachmentUrl> = {}): AttachmentUrl {
  return {
    url: 'https://github.com/user-attachments/assets/test123',
    originalMarkdown: '![test](https://github.com/user-attachments/assets/test123)',
    altText: 'test',
    type: 'image',
    ...overrides,
  }
}

describe('downloadAttachment', () => {
  const mockLogger = createMockLogger()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('successful downloads', () => {
    it('downloads and saves attachment to temp file', async () => {
      // #given
      const mockResponse = new Response(Buffer.from('test content'), {
        status: 200,
        headers: {'content-type': 'image/png'},
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

      // #when
      const result = await downloadAttachment(
        createMockAttachmentUrl(),
        0,
        'test-token',
        DEFAULT_ATTACHMENT_LIMITS,
        mockLogger,
      )

      // #then
      expect(result).not.toBeNull()
      expect(result?.mime).toBe('image/png')
      expect(result?.sizeBytes).toBe(12)

      if (result != null) {
        await fs.unlink(result.tempPath).catch(() => {})
      }
    })
  })

  describe('redirect handling', () => {
    it('follows redirects to allowed GitHub hosts', async () => {
      // #given
      const redirectResponse = new Response(null, {
        status: 302,
        headers: {location: 'https://objects.githubusercontent.com/file'},
      })
      const finalResponse = new Response(Buffer.from('content'), {
        status: 200,
        headers: {'content-type': 'image/png'},
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse)

      // #when
      const result = await downloadAttachment(
        createMockAttachmentUrl(),
        0,
        'test-token',
        DEFAULT_ATTACHMENT_LIMITS,
        mockLogger,
      )

      // #then
      expect(result).not.toBeNull()

      if (result != null) {
        await fs.unlink(result.tempPath).catch(() => {})
      }
    })

    it('blocks redirects to non-GitHub hosts', async () => {
      // #given
      const redirectResponse = new Response(null, {
        status: 302,
        headers: {location: 'https://evil.com/malware'},
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(redirectResponse)

      // #when
      const result = await downloadAttachment(
        createMockAttachmentUrl(),
        0,
        'test-token',
        DEFAULT_ATTACHMENT_LIMITS,
        mockLogger,
      )

      // #then
      expect(result).toBeNull()
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Redirect to non-GitHub host blocked',
        expect.objectContaining({redirectTo: 'evil.com'}),
      )
    })
  })

  describe('size limits', () => {
    it('rejects downloads exceeding Content-Length limit', async () => {
      // #given
      const mockResponse = new Response(null, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(10 * 1024 * 1024),
        },
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

      // #when
      const result = await downloadAttachment(
        createMockAttachmentUrl(),
        0,
        'test-token',
        DEFAULT_ATTACHMENT_LIMITS,
        mockLogger,
      )

      // #then
      expect(result).toBeNull()
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Attachment exceeds size limit (Content-Length)',
        expect.any(Object),
      )
    })
  })

  describe('error handling', () => {
    it('returns null on network error', async () => {
      // #given
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

      // #when
      const result = await downloadAttachment(
        createMockAttachmentUrl(),
        0,
        'test-token',
        DEFAULT_ATTACHMENT_LIMITS,
        mockLogger,
      )

      // #then
      expect(result).toBeNull()
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Attachment download error',
        expect.objectContaining({error: 'Network error'}),
      )
    })

    it('returns null on non-200 response', async () => {
      // #given
      const mockResponse = new Response(null, {status: 404})
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

      // #when
      const result = await downloadAttachment(
        createMockAttachmentUrl(),
        0,
        'test-token',
        DEFAULT_ATTACHMENT_LIMITS,
        mockLogger,
      )

      // #then
      expect(result).toBeNull()
    })
  })
})

describe('cleanupTempFiles', () => {
  it('removes temp files without error', async () => {
    // #given
    const mockLogger = createMockLogger()
    const tempPaths = ['/nonexistent/path1', '/nonexistent/path2']

    // #when - should not throw
    await cleanupTempFiles(tempPaths, mockLogger)

    // #then
    expect(mockLogger.debug).toHaveBeenCalled()
  })
})
