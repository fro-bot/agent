import {describe, expect, it} from 'vitest'

import {selectOpenCodeGeneration} from './generation.js'

describe('selectOpenCodeGeneration', () => {
  it.each([
    ['2.2.0', 'v2'],
    ['v2.2.0', 'v2'],
    ['2.0.0-beta.1', 'v2'],
    ['3.0.1', 'v2'],
    ['10.4.0', 'v2'],
    ['1.19.4', 'v1'],
    ['1.19.4+harness.3', 'v1'],
    ['1.19.4+harness.5bde2635', 'v1'],
    ['0.9.0', 'v1'],
  ])('reads %s as %s', (version, generation) => {
    // #when
    const selected = selectOpenCodeGeneration(version)

    // #then
    expect(selected).toEqual({success: true, data: generation})
  })

  it('reads a missing version as V1', () => {
    // #when / #then
    expect(selectOpenCodeGeneration(undefined)).toEqual({success: true, data: 'v1'})
  })

  it.each(['', 'latest', 'dev', '2', '-1.0.0', 'x.2.0'])('rejects %j instead of guessing a generation', version => {
    // #when / #then
    expect(selectOpenCodeGeneration(version)).toEqual({success: false, error: {kind: 'unparseable-version'}})
  })
})
