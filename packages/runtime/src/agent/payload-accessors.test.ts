import {describe, expect, it} from 'vitest'

import {
  getBooleanProperty,
  getNumberProperty,
  getObjectProperty,
  getStringProperty,
  ownValue,
} from './payload-accessors.js'

const NON_OBJECTS: readonly unknown[] = [null, undefined, 'text', 42, true]

describe('ownValue', () => {
  it('reads an own property of any type', () => {
    // #given
    const value = {a: 'text', b: 0, c: false, d: {nested: true}}

    // #when / #then
    expect(ownValue(value, 'a')).toBe('text')
    expect(ownValue(value, 'b')).toBe(0)
    expect(ownValue(value, 'c')).toBe(false)
    expect(ownValue(value, 'd')).toEqual({nested: true})
  })

  it('returns undefined on a miss', () => {
    // #given
    const value = {present: 1}

    // #when / #then
    expect(ownValue(value, 'absent')).toBeUndefined()
  })

  it('misses an inherited property', () => {
    // #given
    const value = Object.create({inherited: 'x'}) as object

    // #when / #then
    expect(ownValue(value, 'inherited')).toBeUndefined()
  })

  it('returns undefined for a null or non-object value', () => {
    // #given / #when / #then
    for (const value of NON_OBJECTS) expect(ownValue(value, 'length')).toBeUndefined()
  })

  it('does not invoke a getter', () => {
    // #given
    let invoked = false
    const value = Object.defineProperty({}, 'trap', {
      enumerable: true,
      get() {
        invoked = true
        return 'secret'
      },
    })

    // #when
    const result = ownValue(value, 'trap')

    // #then
    expect(result).toBeUndefined()
    expect(invoked).toBe(false)
  })
})

describe('getStringProperty', () => {
  it('reads an own string, accepting the empty string', () => {
    // #given
    const value = {full: 'text', empty: ''}

    // #when / #then
    expect(getStringProperty(value, 'full')).toBe('text')
    expect(getStringProperty(value, 'empty')).toBe('')
  })

  it('returns null on a miss or a wrong type', () => {
    // #given
    const value = {n: 1, b: true, o: {}, u: undefined, z: null}

    // #when / #then
    expect(getStringProperty(value, 'absent')).toBeNull()
    expect(getStringProperty(value, 'n')).toBeNull()
    expect(getStringProperty(value, 'b')).toBeNull()
    expect(getStringProperty(value, 'o')).toBeNull()
    expect(getStringProperty(value, 'u')).toBeNull()
    expect(getStringProperty(value, 'z')).toBeNull()
  })

  it('misses an inherited property', () => {
    // #given
    const value = Object.create({inherited: 'x'}) as object

    // #when / #then
    expect(getStringProperty(value, 'inherited')).toBeNull()
  })

  it('returns null for a null or non-object value', () => {
    // #given / #when / #then
    for (const value of NON_OBJECTS) expect(getStringProperty(value, 'length')).toBeNull()
  })

  it('does not invoke a getter', () => {
    // #given
    let invoked = false
    const value = Object.defineProperty({}, 'trap', {
      enumerable: true,
      get() {
        invoked = true
        return 'secret'
      },
    })

    // #when / #then
    expect(getStringProperty(value, 'trap')).toBeNull()
    expect(invoked).toBe(false)
  })
})

describe('getNumberProperty', () => {
  it('reads an own number, accepting 0 and NaN', () => {
    // #given
    const value = {n: 7, zero: 0, nan: Number.NaN}

    // #when / #then
    expect(getNumberProperty(value, 'n')).toBe(7)
    expect(getNumberProperty(value, 'zero')).toBe(0)
    expect(getNumberProperty(value, 'nan')).toBeNaN()
  })

  it('returns null on a miss or a wrong type', () => {
    // #given
    const value = {s: '7', b: true}

    // #when / #then
    expect(getNumberProperty(value, 'absent')).toBeNull()
    expect(getNumberProperty(value, 's')).toBeNull()
    expect(getNumberProperty(value, 'b')).toBeNull()
  })

  it('misses an inherited property', () => {
    // #given
    const value = Object.create({inherited: 1}) as object

    // #when / #then
    expect(getNumberProperty(value, 'inherited')).toBeNull()
  })

  it('returns null for a null or non-object value', () => {
    // #given / #when / #then
    for (const value of NON_OBJECTS) expect(getNumberProperty(value, 'length')).toBeNull()
  })
})

describe('getBooleanProperty', () => {
  it('reads an own boolean, accepting false', () => {
    // #given
    const value = {yes: true, no: false}

    // #when / #then
    expect(getBooleanProperty(value, 'yes')).toBe(true)
    expect(getBooleanProperty(value, 'no')).toBe(false)
  })

  it('returns null on a miss or a wrong type', () => {
    // #given
    const value = {s: 'true', n: 1}

    // #when / #then
    expect(getBooleanProperty(value, 'absent')).toBeNull()
    expect(getBooleanProperty(value, 's')).toBeNull()
    expect(getBooleanProperty(value, 'n')).toBeNull()
  })

  it('misses an inherited property', () => {
    // #given
    const value = Object.create({inherited: true}) as object

    // #when / #then
    expect(getBooleanProperty(value, 'inherited')).toBeNull()
  })

  it('returns null for a null or non-object value', () => {
    // #given / #when / #then
    for (const value of NON_OBJECTS) expect(getBooleanProperty(value, 'length')).toBeNull()
  })
})

describe('getObjectProperty', () => {
  it('returns any non-null own value without narrowing, primitives included', () => {
    // #given
    const nested = {x: 1}
    const value = {obj: nested, arr: [1], str: 'text', empty: '', num: 0, bool: false}

    // #when / #then
    expect(getObjectProperty(value, 'obj')).toBe(nested)
    expect(getObjectProperty(value, 'arr')).toEqual([1])
    expect(getObjectProperty(value, 'str')).toBe('text')
    expect(getObjectProperty(value, 'empty')).toBe('')
    expect(getObjectProperty(value, 'num')).toBe(0)
    expect(getObjectProperty(value, 'bool')).toBe(false)
  })

  it('returns null on a miss or a null/undefined own value', () => {
    // #given
    const value = {u: undefined, z: null}

    // #when / #then
    expect(getObjectProperty(value, 'absent')).toBeNull()
    expect(getObjectProperty(value, 'u')).toBeNull()
    expect(getObjectProperty(value, 'z')).toBeNull()
  })

  it('misses an inherited property', () => {
    // #given
    const value = Object.create({inherited: {x: 1}}) as object

    // #when / #then
    expect(getObjectProperty(value, 'inherited')).toBeNull()
  })

  it('returns null for a null or non-object value', () => {
    // #given / #when / #then
    for (const value of NON_OBJECTS) expect(getObjectProperty(value, 'length')).toBeNull()
  })

  it('does not invoke a getter', () => {
    // #given
    let invoked = false
    const value = Object.defineProperty({}, 'trap', {
      enumerable: true,
      get() {
        invoked = true
        return {secret: true}
      },
    })

    // #when / #then
    expect(getObjectProperty(value, 'trap')).toBeNull()
    expect(invoked).toBe(false)
  })
})
