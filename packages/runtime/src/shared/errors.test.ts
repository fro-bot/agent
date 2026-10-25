import {describe, expect, it} from 'vitest'
import {formatSdkError, SDK_ERROR_MAX_LENGTH, toError, toErrorMessage} from './errors.js'

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

describe('formatSdkError', () => {
  it('shows why String() is not enough: a JSON error envelope is a plain object', () => {
    // #given the shape the OpenCode SDK client returns for an HTTP error with a JSON body
    const envelope = {name: 'NotFoundError', data: {message: 'Session not found: ses_1'}}

    // #then String() hides every detail
    expect(String(envelope)).toBe('[object Object]')
  })

  it('prefers data.message (NotFoundError)', () => {
    expect(formatSdkError({name: 'NotFoundError', data: {message: 'Session not found: ses_1'}})).toBe(
      'Session not found: ses_1',
    )
  })

  it('prefers data.message (BadRequest) and ignores the rest of the data', () => {
    expect(formatSdkError({name: 'BadRequest', data: {message: 'bad body', kind: 'Body'}})).toBe('bad body')
  })

  it('prefers data.message over a top-level message when both exist', () => {
    expect(formatSdkError({message: 'outer', data: {message: 'inner'}})).toBe('inner')
  })

  it('falls back to a top-level message (the workspace proxy shape)', () => {
    expect(formatSdkError({status: 401, message: 'Unauthorized'})).toBe('Unauthorized')
  })

  it('falls back to name, then type, when there is no message', () => {
    expect(formatSdkError({name: 'UnknownError'})).toBe('UnknownError')
    expect(formatSdkError({type: 'invalid_request'})).toBe('invalid_request')
  })

  it('skips an empty or non-string message', () => {
    expect(formatSdkError({data: {message: ''}, message: 'outer'})).toBe('outer')
    expect(formatSdkError({data: {message: 42}, name: 'Odd'})).toBe('Odd')
  })

  it('serialises an unknown object as JSON', () => {
    expect(formatSdkError({code: 7, detail: 'x'})).toBe('{"code":7,"detail":"x"}')
  })

  it('bounds the JSON form', () => {
    const result = formatSdkError({blob: 'x'.repeat(5000)})

    expect(result.length).toBeLessThanOrEqual(SDK_ERROR_MAX_LENGTH)
    expect(result.endsWith('...')).toBe(true)
  })

  it('bounds a very long message too', () => {
    const result = formatSdkError({data: {message: 'm'.repeat(5000)}})

    expect(result.length).toBeLessThanOrEqual(SDK_ERROR_MAX_LENGTH)
  })

  it('returns a string body as it is', () => {
    expect(formatSdkError('Bad Gateway')).toBe('Bad Gateway')
  })

  it('returns an Error message', () => {
    expect(formatSdkError(new Error('boom'))).toBe('boom')
  })

  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [42, '42'],
    [true, 'true'],
  ])('stringifies the non-object %j', (value, expected) => {
    expect(formatSdkError(value)).toBe(expected)
  })

  it('does not throw on a circular object or a BigInt: it reports an unprintable error', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(formatSdkError(circular)).toBe('[unprintable error]')
    expect(formatSdkError({n: 1n})).toBe('[unprintable error]')
  })

  it('does not throw on a throwing getter', () => {
    const hostile = {
      get data(): never {
        throw new Error('getter')
      },
    }

    expect(formatSdkError(hostile)).toBe('[unprintable error]')
  })

  it('never includes headers or a request body: only the envelope it is given', () => {
    // #given an envelope that (wrongly) carries request material next to a message
    const result = formatSdkError({
      data: {message: 'denied'},
      request: {headers: {authorization: 'Bearer SECRET'}, body: 'PROMPT'},
    })

    // #then the message wins and nothing else is read
    expect(result).toBe('denied')
  })
})
