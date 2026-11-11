import {describe, expect, it} from 'vitest'

import {IMAGE_OPENCODE_VERSION_ENV, readImageOpencodeVersion} from './opencode-generation.js'

describe('readImageOpencodeVersion', () => {
  it('names the image-baked variable, outside the operator-facing WORKSPACE_OPENCODE_* settings', () => {
    // #then an operator setting in compose is not mistaken for the image pin
    expect(IMAGE_OPENCODE_VERSION_ENV).toBe('WORKSPACE_IMAGE_OPENCODE_VERSION')
  })

  it.each(['2.2.6', '2.0.0', '2.2.0-rc.1', '3.0.0', '10.4.1'])('accepts the V2 version %s', version => {
    // #when
    const result = readImageOpencodeVersion({[IMAGE_OPENCODE_VERSION_ENV]: version})

    // #then
    expect(result).toEqual({success: true, data: {version}})
  })

  it('trims surrounding whitespace before it reads the version', () => {
    // #then
    expect(readImageOpencodeVersion({[IMAGE_OPENCODE_VERSION_ENV]: ' 2.2.6\n'})).toEqual({
      success: true,
      data: {version: '2.2.6'},
    })
  })

  it.each([undefined, '', '   '])(
    'refuses an image that sets no version (%j), naming the variable and the pin file',
    value => {
      // #when
      const result = readImageOpencodeVersion({[IMAGE_OPENCODE_VERSION_ENV]: value})

      // #then
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error).toContain(`${IMAGE_OPENCODE_VERSION_ENV} is not set`)
      expect(result.error).toContain('opencode-v2-pin.json')
    },
  )

  it.each(['1.19.5+harness.bf7f7dfe', '1.19.4', '1.99.99', '0.9.0'])(
    'refuses the V1 version %s: the workspace runs OpenCode V2 only',
    version => {
      // #when
      const result = readImageOpencodeVersion({[IMAGE_OPENCODE_VERSION_ENV]: version})

      // #then
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error).toContain(IMAGE_OPENCODE_VERSION_ENV)
      expect(result.error).toContain('V2 only')
    },
  )

  it.each(['v2.2.0', '2', '2.2', 'latest', '02.2.0', '2.2.0 extra', '-1.0.0', '2.x.0'])(
    'refuses a value that is set but is not a version (%s)',
    value => {
      // #when
      const result = readImageOpencodeVersion({[IMAGE_OPENCODE_VERSION_ENV]: value})

      // #then
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error).toContain(IMAGE_OPENCODE_VERSION_ENV)
    },
  )
})
