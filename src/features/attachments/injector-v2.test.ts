import type {ValidatedAttachment} from './types.js'
import {describe, expect, it} from 'vitest'
import {toFileAttachmentsV2} from './injector-v2.js'

function validated(overrides: Partial<ValidatedAttachment> = {}): ValidatedAttachment {
  return {filename: 'shot.png', mime: 'image/png', sizeBytes: 2048, tempPath: '/tmp/run/shot.png', ...overrides}
}

describe('toFileAttachmentsV2', () => {
  it('maps a validated attachment to a V2 file input: a file: URI and a name, with no V1 part fields', () => {
    // #given / #when
    const [input] = toFileAttachmentsV2([validated()])

    // #then
    expect(input).toEqual({uri: 'file:///tmp/run/shot.png', name: 'shot.png'})
    expect(input).not.toHaveProperty('type')
    expect(input).not.toHaveProperty('mime')
    expect(input).not.toHaveProperty('url')
    expect(input).not.toHaveProperty('filename')
  })

  it('percent-encodes a path the way the server decodes it back', () => {
    const [input] = toFileAttachmentsV2([
      validated({tempPath: '/tmp/run/with space #1.png', filename: 'with space #1.png'}),
    ])

    expect(input?.uri).toBe('file:///tmp/run/with%20space%20%231.png')
    expect(new URL(input?.uri ?? '').pathname).toBe('/tmp/run/with%20space%20%231.png')
    expect(decodeURIComponent(new URL(input?.uri ?? '').pathname)).toBe('/tmp/run/with space #1.png')
  })

  it('returns an empty list for no attachments and keeps order', () => {
    expect(toFileAttachmentsV2([])).toEqual([])
    expect(
      toFileAttachmentsV2([validated({filename: 'a'}), validated({filename: 'b'})]).map(input => input.name),
    ).toEqual(['a', 'b'])
  })
})
