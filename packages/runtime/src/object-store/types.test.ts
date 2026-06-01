import {describe, expect, it} from 'vitest'

import {createObjectStoreOperationError} from './types.js'

describe('createObjectStoreOperationError', () => {
  it('creates an error with code OBJECT_STORE_OPERATION_ERROR and the given message', () => {
    // #given / #when
    const error = createObjectStoreOperationError('something went wrong')

    // #then
    expect(error.message).toBe('something went wrong')
    expect(error.code).toBe('OBJECT_STORE_OPERATION_ERROR')
    expect(error).toBeInstanceOf(Error)
  })

  // P3: single-arg call must NOT create keys with undefined values
  it('single-arg call does NOT have errorCode, errorName, or httpStatusCode keys in the object', () => {
    // #given / #when
    const error = createObjectStoreOperationError('msg')

    // #then
    expect('errorCode' in error).toBe(false)
    expect('errorName' in error).toBe(false)
    expect('httpStatusCode' in error).toBe(false)
    // Legacy accessors still read undefined (property not set)
    expect(error.errorCode).toBeUndefined()
    expect(error.errorName).toBeUndefined()
    expect(error.httpStatusCode).toBeUndefined()
  })

  it('passes errorCode and httpStatusCode through when details are provided', () => {
    // #given / #when
    const error = createObjectStoreOperationError('msg', {errorCode: 'NoSuchKey', httpStatusCode: 404})

    // #then
    expect(error.errorCode).toBe('NoSuchKey')
    expect(error.httpStatusCode).toBe(404)
    expect(error.code).toBe('OBJECT_STORE_OPERATION_ERROR')
  })

  it('passes errorName through when provided (AWS SDK v3 shape)', () => {
    // #given / #when
    const error = createObjectStoreOperationError('msg', {errorName: 'NoSuchKey', httpStatusCode: 404})

    // #then
    expect(error.errorName).toBe('NoSuchKey')
    expect(error.httpStatusCode).toBe(404)
    expect('errorCode' in error).toBe(false)
  })

  it('passes all three structured fields when all are provided', () => {
    // #given / #when
    const error = createObjectStoreOperationError('msg', {
      errorCode: 'NoSuchKey',
      errorName: 'NoSuchKey',
      httpStatusCode: 404,
    })

    // #then
    expect(error.errorCode).toBe('NoSuchKey')
    expect(error.errorName).toBe('NoSuchKey')
    expect(error.httpStatusCode).toBe(404)
  })

  it('allows partial details (errorCode only)', () => {
    // #given / #when
    const error = createObjectStoreOperationError('msg', {errorCode: 'NoSuchKey'})

    // #then
    expect(error.errorCode).toBe('NoSuchKey')
    expect(error.httpStatusCode).toBeUndefined()
    expect('httpStatusCode' in error).toBe(false)
  })

  it('allows partial details (httpStatusCode only)', () => {
    // #given / #when
    const error = createObjectStoreOperationError('msg', {httpStatusCode: 404})

    // #then
    expect(error.errorCode).toBeUndefined()
    expect('errorCode' in error).toBe(false)
    expect(error.httpStatusCode).toBe(404)
  })
})
