import {describe, expect, it} from 'vitest'
import {toError, toErrorMessage} from './errors.js'

describe('toErrorMessage', () => {
  it('extracts message from Error instance', () => {
    // #given
    const error = new Error('Something went wrong')

    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('Something went wrong')
  })

  it('converts string to message', () => {
    // #given
    const error = 'Plain string error'

    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('Plain string error')
  })

  it('converts number to string', () => {
    // #given
    const error = 42

    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('42')
  })

  it('converts null to string', () => {
    // #given
    const error = null

    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('null')
  })

  it('converts undefined to string', () => {
    // #given
    const error = undefined

    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('undefined')
  })

  it('converts object to string', () => {
    // #given
    const error = {code: 'ERR_NETWORK'}

    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('[object Object]')
  })

  it.each([
    ['a JSON-parsed object whose own toString is not callable', JSON.parse('{"toString":"x"}') as unknown],
    ['a null-prototype object with no coercion methods at all', Object.create(null) as unknown],
    [
      'an object whose toString throws during coercion',
      {
        toString() {
          throw new Error('boom')
        },
      },
    ],
  ])('returns the fallback instead of throwing for %s', (_label, error) => {
    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('[unprintable error]')
  })

  it('preserves a custom toString instead of falling back', () => {
    // #given: a valid custom coercion, not a broken one -- the fallback must not fire here
    const error = {toString: () => 'custom'}

    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('custom')
  })

  it('returns the fallback when reading Error.message throws', () => {
    // #given
    const error = new Error('base')
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('message getter boom')
      },
    })

    // #when
    const result = toErrorMessage(error)

    // #then
    expect(result).toBe('[unprintable error]')
  })
})

describe('toError', () => {
  it('returns same Error instance', () => {
    // #given
    const error = new Error('Original error')

    // #when
    const result = toError(error)

    // #then
    expect(result).toBe(error)
  })

  it('wraps string in Error', () => {
    // #given
    const error = 'String error'

    // #when
    const result = toError(error)

    // #then
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('String error')
  })

  it('wraps number in Error', () => {
    // #given
    const error = 500

    // #when
    const result = toError(error)

    // #then
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('500')
  })

  it('wraps an unprintable non-Error value using the hardened fallback', () => {
    // #given a payload whose own toString is not callable
    const error: unknown = JSON.parse('{"toString":"x"}')

    // #when
    const result = toError(error)

    // #then
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('[unprintable error]')
  })
})
