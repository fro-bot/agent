import {describe, expect, it} from 'vitest'

import {IMAGE_OPENCODE_VERSION_ENV, readOpencodeGeneration} from './opencode-generation.js'

describe('readOpencodeGeneration', () => {
  it('names the image-baked variable, outside the operator-facing WORKSPACE_OPENCODE_* settings', () => {
    // #then an operator setting in compose is not mistaken for the image pin
    expect(IMAGE_OPENCODE_VERSION_ENV).toBe('WORKSPACE_IMAGE_OPENCODE_VERSION')
  })

  it.each([undefined, '', '   '])('selects V1 when the image sets no version (%j)', value => {
    // #given an image that predates the variable, or leaves it blank
    const result = readOpencodeGeneration({[IMAGE_OPENCODE_VERSION_ENV]: value})

    // #then it behaves exactly as before
    expect(result).toEqual({success: true, data: {kind: 'v1'}})
  })

  it.each(['1.19.4+harness.5bde2635', '1.19.4', '1.99.99'])(
    'selects V1 for the V1 version %s and keeps it for reporting',
    version => {
      // #given a V1 image that bakes its own version
      const result = readOpencodeGeneration({[IMAGE_OPENCODE_VERSION_ENV]: version})

      // #then
      expect(result).toEqual({success: true, data: {kind: 'v1', version}})
    },
  )

  it.each(['2.2.0', '2.0.0', '2.2.0-rc.1', '3.0.0', '10.4.1'])('selects V2 for major 2 or higher (%s)', version => {
    // #when
    const result = readOpencodeGeneration({[IMAGE_OPENCODE_VERSION_ENV]: version})

    // #then
    expect(result).toEqual({success: true, data: {kind: 'v2', version}})
  })

  it('trims surrounding whitespace before it reads the version', () => {
    // #then
    expect(readOpencodeGeneration({[IMAGE_OPENCODE_VERSION_ENV]: ' 2.2.0\n'})).toEqual({
      success: true,
      data: {kind: 'v2', version: '2.2.0'},
    })
  })

  it.each(['v2.2.0', '2', '2.2', 'latest', '02.2.0', '2.2.0 extra', '-1.0.0', '2.x.0'])(
    'refuses a value that is set but is not a version (%s), instead of guessing a generation',
    value => {
      // #when
      const result = readOpencodeGeneration({[IMAGE_OPENCODE_VERSION_ENV]: value})

      // #then a wrong guess would run the V1 spawn flags against a V2 binary, or the reverse
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error).toContain(IMAGE_OPENCODE_VERSION_ENV)
    },
  )
})
