import {describe, expect, it} from 'vitest'

import {mapSdkTodos} from './storage-mappers.js'

describe('mapSdkTodos', () => {
  it('returns an empty array for a non-array payload', () => {
    // #given: storage.ts hoists the logged version of this check to its own call site
    // (getSessionTodos) since a logger is in scope there and not in this pure-mapping module —
    // this guard exists so mapSdkTodos's contract holds for any future caller that doesn't
    // pre-check, not because the current call site relies on it.
    const payload: unknown = {not: 'an array'}

    // #when
    const result = mapSdkTodos(payload)

    // #then
    expect(result).toEqual([])
  })
})
