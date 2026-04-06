import {describe, expect, it} from 'vitest'
import {cleanMarkdownBody, formatBytes} from './format.js'

describe('cleanMarkdownBody', () => {
  it('removes unnecessary markdown escapes for backticks and pipes', () => {
    // #given
    const text = 'Use \`code\` in table \| col'

    // #when
    const result = cleanMarkdownBody(text)

    // #then
    expect(result).toBe('Use `code` in table | col')
  })

  it('leaves unrelated content unchanged', () => {
    // #given
    const text = 'Plain markdown body'

    // #when
    const result = cleanMarkdownBody(text)

    // #then
    expect(result).toBe('Plain markdown body')
  })
})

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

  it('throws for negative bytes', () => {
    // #given
    const bytes = -500

    // #when + #then
    expect(() => formatBytes(bytes)).toThrow('Invalid bytes value: -500')
  })

  it('throws for NaN', () => {
    // #given
    const bytes = Number.NaN

    // #when + #then
    expect(() => formatBytes(bytes)).toThrow('Invalid bytes value: NaN')
  })

  it('throws for Infinity', () => {
    // #given
    const bytes = Infinity

    // #when + #then
    expect(() => formatBytes(bytes)).toThrow('Invalid bytes value: Infinity')
  })

  it('throws for negative Infinity', () => {
    // #given
    const bytes = -Infinity

    // #when + #then
    expect(() => formatBytes(bytes)).toThrow('Invalid bytes value: -Infinity')
  })
})
