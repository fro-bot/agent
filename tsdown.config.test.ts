import {describe, expect, it} from 'vitest'
import {assertVersionPresent} from './tsdown.config.js'

describe('assertVersionPresent', () => {
  it('throws when the expected version is absent from every chunk', () => {
    // #given chunks that do not contain the harness version string
    const expected = '1.17.3+harness.2c9cdbd2'
    const chunkContents = ['var a="1.17.3"', 'other']

    // #when asserting version presence
    // #then throws with a message mentioning the version
    expect(() => assertVersionPresent(expected, chunkContents)).toThrowError('1.17.3+harness.2c9cdbd2')
  })

  it('does not throw when the expected version is present in any chunk', () => {
    // #given chunks where the second contains the full harness version string
    const expected = '1.17.3+harness.2c9cdbd2'
    const chunkContents = ['noise', 'x="1.17.3+harness.2c9cdbd2"']

    // #when asserting version presence
    // #then no throw
    expect(() => assertVersionPresent(expected, chunkContents)).not.toThrow()
  })

  it('does not throw when the expected version is present in the first chunk', () => {
    // #given chunks where the first contains the full harness version string
    const expected = '1.17.3+harness.2c9cdbd2'
    const chunkContents = ['var v="1.17.3+harness.2c9cdbd2"', 'other chunk']

    // #when asserting version presence
    // #then no throw
    expect(() => assertVersionPresent(expected, chunkContents)).not.toThrow()
  })

  it('throws on an empty chunk list', () => {
    // #given no chunks at all
    const expected = '1.17.3+harness.2c9cdbd2'
    const chunkContents: string[] = []

    // #when asserting version presence against empty list
    // #then throws because no chunk can contain the version
    expect(() => assertVersionPresent(expected, chunkContents)).toThrowError('1.17.3+harness.2c9cdbd2')
  })
})
