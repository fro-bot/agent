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
})
