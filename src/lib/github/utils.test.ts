import {describe, expect, it} from 'vitest'
import {ignoreNotFound, isNotFoundError} from './utils.js'

describe('isNotFoundError', () => {
  it('returns true for object with status 404', () => {
    // #given
    const error = {status: 404}

    // #when
    const result = isNotFoundError(error)

    // #then
    expect(result).toBe(true)
  })

  it('returns true for Error with status 404', () => {
    // #given
    const error = Object.assign(new Error('Not Found'), {status: 404})

    // #when
    const result = isNotFoundError(error)

    // #then
    expect(result).toBe(true)
  })

  it('returns false for non-404 status', () => {
    // #given
    const error = {status: 500}

    // #when
    const result = isNotFoundError(error)

    // #then
    expect(result).toBe(false)
  })

  it('returns false for object without status', () => {
    // #given
    const error = {message: 'error'}

    // #when
    const result = isNotFoundError(error)

    // #then
    expect(result).toBe(false)
  })

  it('returns false for null', () => {
    // #given
    const error = null

    // #when
    const result = isNotFoundError(error)

    // #then
    expect(result).toBe(false)
  })

  it('returns false for string', () => {
    // #given
    const error = 'Not Found'

    // #when
    const result = isNotFoundError(error)

    // #then
    expect(result).toBe(false)
  })
})

describe('ignoreNotFound', () => {
  it('returns value on success', async () => {
    // #given
    const promise = Promise.resolve({data: 'test'})

    // #when
    const result = await ignoreNotFound(promise)

    // #then
    expect(result).toEqual({data: 'test'})
  })

  it('returns null on 404 error', async () => {
    // #given
    const error = Object.assign(new Error('Not Found'), {status: 404})
    const promise = Promise.reject(error)

    // #when
    const result = await ignoreNotFound(promise)

    // #then
    expect(result).toBeNull()
  })

  it('rethrows non-404 errors', async () => {
    // #given
    const error = new Error('Server Error')
    const promise = Promise.reject(error)

    // #when / #then
    await expect(ignoreNotFound(promise)).rejects.toThrow('Server Error')
  })

  it('rethrows 500 errors', async () => {
    // #given
    const error = Object.assign(new Error('Internal'), {status: 500})
    const promise = Promise.reject(error)

    // #when / #then
    await expect(ignoreNotFound(promise)).rejects.toThrow('Internal')
  })
})
