import {describe, expect, it} from 'vitest'
import {buildHarnessVersion} from './version.js'

// ---------------------------------------------------------------------------
// buildHarnessVersion
// ---------------------------------------------------------------------------

describe('buildHarnessVersion', () => {
  it('normal base + commit → <baseVersion>+harness.<shortSha>', () => {
    // #given / #when
    const result = buildHarnessVersion('1.15.13', 'cafebabe12345678')

    // #then
    expect(result).toBe('1.15.13+harness.cafebabe')
  })

  it('short sha is exactly the first 8 chars of a 40-char sha', () => {
    // #given
    const fullSha = 'abcdef1234567890abcdef1234567890abcdef12'

    // #when
    const result = buildHarnessVersion('1.15.13', fullSha)

    // #then
    expect(result).toBe('1.15.13+harness.abcdef12')
    expect(result.split('+harness.')[1]).toBe(fullSha.slice(0, 8))
  })

  it('commit shorter than 8 chars → uses the full (short) commit as-is', () => {
    // #given — a commit shorter than 8 chars (e.g. a dev stub)
    const shortCommit = 'abc'

    // #when
    const result = buildHarnessVersion('1.15.13', shortCommit)

    // #then — slice(0, 8) on a 3-char string returns the full string
    expect(result).toBe('1.15.13+harness.abc')
  })
})
