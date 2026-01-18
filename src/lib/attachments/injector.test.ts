import type {AttachmentUrl, SkippedAttachment, ValidatedAttachment} from './types.js'
import {describe, expect, it} from 'vitest'
import {buildAttachmentResult, modifyBodyForAttachments, toFileParts} from './injector.js'

function createMockValidated(overrides: Partial<ValidatedAttachment> = {}): ValidatedAttachment {
  return {
    filename: 'test.png',
    mime: 'image/png',
    sizeBytes: 1024,
    tempPath: '/tmp/test.png',
    ...overrides,
  }
}

function createMockParsedUrl(overrides: Partial<AttachmentUrl> = {}): AttachmentUrl {
  return {
    url: 'https://github.com/user-attachments/assets/abc123',
    originalMarkdown: '![test](https://github.com/user-attachments/assets/abc123)',
    altText: 'test',
    type: 'image',
    ...overrides,
  }
}

describe('toFileParts', () => {
  it('transforms validated attachments to SDK file parts', () => {
    // #given
    const validated = [createMockValidated({tempPath: '/tmp/file.png', mime: 'image/png', filename: 'file.png'})]

    // #when
    const result = toFileParts(validated)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('file')
    expect(result[0]?.mime).toBe('image/png')
    expect(result[0]?.url).toContain('file://')
    expect(result[0]?.filename).toBe('file.png')
  })

  it('returns empty array for no attachments', () => {
    // #given
    const validated: ValidatedAttachment[] = []

    // #when
    const result = toFileParts(validated)

    // #then
    expect(result).toHaveLength(0)
  })
})

describe('modifyBodyForAttachments', () => {
  it('replaces markdown with @filename references', () => {
    // #given
    const body = 'Check this: ![screenshot](https://github.com/user-attachments/assets/abc123)'
    const parsedUrls = [
      createMockParsedUrl({
        originalMarkdown: '![screenshot](https://github.com/user-attachments/assets/abc123)',
      }),
    ]
    const validated = [createMockValidated({filename: 'screenshot.png'})]

    // #when
    const result = modifyBodyForAttachments(body, parsedUrls, validated)

    // #then
    expect(result).toBe('Check this: @screenshot.png')
  })

  it('leaves body unchanged if no validated attachments', () => {
    // #given
    const body = 'Some text with ![img](https://github.com/user-attachments/assets/abc)'
    const parsedUrls = [createMockParsedUrl()]
    const validated: ValidatedAttachment[] = []

    // #when
    const result = modifyBodyForAttachments(body, parsedUrls, validated)

    // #then
    expect(result).toBe(body)
  })
})

describe('buildAttachmentResult', () => {
  it('builds complete attachment result', () => {
    // #given
    const body = '![test](https://github.com/user-attachments/assets/abc123)'
    const parsedUrls = [
      createMockParsedUrl({
        originalMarkdown: '![test](https://github.com/user-attachments/assets/abc123)',
      }),
    ]
    const validated = [createMockValidated({filename: 'test.png', tempPath: '/tmp/test.png'})]
    const skipped: SkippedAttachment[] = [{url: 'https://example.com/skipped', reason: 'Too large'}]

    // #when
    const result = buildAttachmentResult(body, parsedUrls, validated, skipped)

    // #then
    expect(result.processed).toHaveLength(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.modifiedBody).toBe('@test.png')
    expect(result.fileParts).toHaveLength(1)
    expect(result.tempFiles).toEqual(['/tmp/test.png'])
  })
})
