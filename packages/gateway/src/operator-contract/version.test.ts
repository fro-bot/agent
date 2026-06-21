import {describe, expect, it} from 'vitest'
import {OPERATOR_CONTRACT_VERSION} from './version.js'

describe('OPERATOR_CONTRACT_VERSION', () => {
  it('is pinned to 1.3.0', () => {
    // #given the contract version constant
    // #when read at import time
    // #then it is exactly the pinned literal
    expect(OPERATOR_CONTRACT_VERSION).toBe('1.3.0')
  })

  it('is importable from the contract barrel', async () => {
    // #given the public barrel for the operator-contract module
    // #when the version is imported from the barrel
    const {OPERATOR_CONTRACT_VERSION: barrelVersion} = await import('./index.js')

    // #then it equals the same constant
    expect(barrelVersion).toBe(OPERATOR_CONTRACT_VERSION)
  })
})
