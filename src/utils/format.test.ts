import {describe, expect, it} from 'vitest'
import {formatBytes} from './format.js'

describe('formatBytes', () => {
  it('formats bytes under 1KB', () => {
    // #given
    const bytes = 512

    // #when
    const result = formatBytes(bytes)

    // #then
    expect(result).toBe('512B')
  })

  it('formats exactly 0 bytes', () => {
    // #given
    const bytes = 0

    // #when
    const result = formatBytes(bytes)

    // #then
    expect(result).toBe('0B')
  })

  it('formats kilobytes', () => {
    // #given
    const bytes = 1024

    // #when
    const result = formatBytes(bytes)

    // #then
    expect(result).toBe('1.0KB')
  })

  it('formats fractional kilobytes', () => {
    // #given
    const bytes = 1536

    // #when
    const result = formatBytes(bytes)

    // #then
    expect(result).toBe('1.5KB')
  })

  it('formats megabytes', () => {
    // #given
    const bytes = 1024 * 1024

    // #when
    const result = formatBytes(bytes)

    // #then
    expect(result).toBe('1.0MB')
  })

  it('formats fractional megabytes', () => {
    // #given
    const bytes = 5 * 1024 * 1024

    // #when
    const result = formatBytes(bytes)

    // #then
    expect(result).toBe('5.0MB')
  })

  it('formats large megabytes', () => {
    // #given
    const bytes = 15 * 1024 * 1024

    // #when
    const result = formatBytes(bytes)

    // #then
    expect(result).toBe('15.0MB')
  })
})
