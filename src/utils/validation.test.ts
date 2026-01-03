import {describe, expect, it} from 'vitest'
import {validateJsonString, validateNonEmptyString, validatePositiveInteger} from './validation.js'

describe('validateJsonString', () => {
  it('accepts valid JSON object', () => {
    expect(() => validateJsonString('{"key":"value"}', 'test')).not.toThrow()
  })

  it('accepts valid JSON array', () => {
    expect(() => validateJsonString('[1,2,3]', 'test')).not.toThrow()
  })

  it('accepts valid JSON primitive', () => {
    expect(() => validateJsonString('"hello"', 'test')).not.toThrow()
    expect(() => validateJsonString('123', 'test')).not.toThrow()
    expect(() => validateJsonString('true', 'test')).not.toThrow()
    expect(() => validateJsonString('null', 'test')).not.toThrow()
  })

  it('rejects invalid JSON', () => {
    expect(() => validateJsonString('not json', 'test')).toThrow('test must be valid JSON')
  })

  it('rejects empty string', () => {
    expect(() => validateJsonString('', 'test')).toThrow('test must be valid JSON')
  })

  it('rejects malformed JSON', () => {
    expect(() => validateJsonString('{key: "value"}', 'config')).toThrow('config must be valid JSON')
  })
})

describe('validatePositiveInteger', () => {
  it('parses valid positive integer', () => {
    expect(validatePositiveInteger('50', 'test')).toBe(50)
  })

  it('parses single digit', () => {
    expect(validatePositiveInteger('1', 'test')).toBe(1)
  })

  it('parses large number', () => {
    expect(validatePositiveInteger('1000000', 'test')).toBe(1000000)
  })

  it('rejects zero', () => {
    expect(() => validatePositiveInteger('0', 'count')).toThrow('count must be a positive integer, received: 0')
  })

  it('rejects negative numbers', () => {
    expect(() => validatePositiveInteger('-5', 'count')).toThrow('count must be a positive integer, received: -5')
  })

  it('rejects non-numeric strings', () => {
    expect(() => validatePositiveInteger('abc', 'count')).toThrow('count must be a positive integer, received: abc')
  })

  it('rejects floating point numbers', () => {
    expect(() => validatePositiveInteger('3.14', 'count')).toThrow('count must be a positive integer, received: 3.14')
  })

  it('rejects empty string', () => {
    expect(() => validatePositiveInteger('', 'count')).toThrow('count must be a positive integer, received: ')
  })

  it('rejects whitespace-only string', () => {
    expect(() => validatePositiveInteger('   ', 'count')).toThrow('count must be a positive integer, received:    ')
  })
})

describe('validateNonEmptyString', () => {
  it('accepts non-empty string', () => {
    expect(validateNonEmptyString('hello', 'name')).toBe('hello')
  })

  it('accepts string with whitespace', () => {
    expect(validateNonEmptyString('  hello  ', 'name')).toBe('  hello  ')
  })

  it('rejects empty string', () => {
    expect(() => validateNonEmptyString('', 'name')).toThrow('name cannot be empty')
  })

  it('rejects whitespace-only string', () => {
    expect(() => validateNonEmptyString('   ', 'name')).toThrow('name cannot be empty')
  })

  it('rejects non-string types - number', () => {
    expect(() => validateNonEmptyString(123 as unknown, 'name')).toThrow('name must be a string, received number')
  })

  it('rejects non-string types - null', () => {
    expect(() => validateNonEmptyString(null as unknown, 'name')).toThrow('name must be a string, received object')
  })

  it('rejects non-string types - undefined', () => {
    expect(() => validateNonEmptyString(undefined as unknown, 'name')).toThrow(
      'name must be a string, received undefined',
    )
  })

  it('rejects non-string types - object', () => {
    expect(() => validateNonEmptyString({} as unknown, 'name')).toThrow('name must be a string, received object')
  })
})
