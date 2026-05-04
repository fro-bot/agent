import {describe, expect, it} from 'vitest'
import {deepMerge} from './omo-config.js'

describe('deepMerge', () => {
  it('merges top-level keys from both objects', () => {
    // #given
    const target = {a: 1, b: 2}
    const source = {b: 3, c: 4}

    // #when
    const result = deepMerge(target, source)

    // #then - source values win on conflict
    expect(result).toEqual({a: 1, b: 3, c: 4})
  })

  it('recursively merges nested objects', () => {
    // #given
    const target = {a: {x: 1, y: 2}, b: 'keep'}
    const source = {a: {y: 99, z: 3}}

    // #when
    const result = deepMerge(target, source)

    // #then - nested merge preserves unaffected keys
    expect(result).toEqual({a: {x: 1, y: 99, z: 3}, b: 'keep'})
  })

  it('overwrites arrays rather than merging them', () => {
    // #given
    const target = {arr: [1, 2, 3]}
    const source = {arr: [4, 5]}

    // #when
    const result = deepMerge(target, source)

    // #then - source array replaces target array
    expect(result).toEqual({arr: [4, 5]})
  })

  it('returns target unchanged when source is empty object', () => {
    // #given
    const target = {a: 1}

    // #when
    const result = deepMerge(target, {})

    // #then
    expect(result).toEqual({a: 1})
  })

  it('ignores prototype pollution keys during merge', () => {
    // #given
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"oops":true}},"safe":1}') as {
      __proto__?: unknown
      constructor?: unknown
      safe: number
    }

    // #when
    const result = deepMerge({}, source)

    // #then
    expect(result.safe).toBe(1)
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(Object.prototype).not.toHaveProperty('oops')
  })

  it('does not mutate target or source objects', () => {
    // #given
    const target = {a: {x: 1}}
    const source = {a: {y: 2}}
    const targetCopy = JSON.parse(JSON.stringify(target)) as typeof target
    const sourceCopy = JSON.parse(JSON.stringify(source)) as typeof source

    // #when
    deepMerge(target, source)

    // #then - originals unchanged
    expect(target).toEqual(targetCopy)
    expect(source).toEqual(sourceCopy)
  })

  it('source primitive overwrites target object', () => {
    // #given
    const target = {a: {x: 1}}
    const source = {a: 'string'}

    // #when
    const result = deepMerge(target, source)

    // #then - source wins
    expect(result).toEqual({a: 'string'})
  })

  it('handles deeply nested merge', () => {
    // #given
    const target = {level1: {level2: {level3: {keep: true, override: 'old'}}}}
    const source = {level1: {level2: {level3: {override: 'new'}, extra: 42}}}

    // #when
    const result = deepMerge(target, source)

    // #then
    expect(result).toEqual({level1: {level2: {level3: {keep: true, override: 'new'}, extra: 42}}})
  })
})
