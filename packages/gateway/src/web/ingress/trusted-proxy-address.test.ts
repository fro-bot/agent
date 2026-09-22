import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

import {parseTrustedProxyAddress} from './trusted-proxy-address.js'

describe('parseTrustedProxyAddress', () => {
  // #given a well-formed IPv4 address
  // #when parsed
  // #then it succeeds
  it('accepts a well-formed IPv4 address', async () => {
    const result = await Effect.runPromise(Effect.either(parseTrustedProxyAddress('10.0.0.5')))
    expect(result._tag).toBe('Right')
  })

  // #given a malformed address
  // #when parsed
  // #then it fails with a closed rejection reason
  it('rejects a malformed address', async () => {
    const result = await Effect.runPromise(Effect.either(parseTrustedProxyAddress('not-an-address')))
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'invalid-trusted-proxy-address'}})
  })
})
