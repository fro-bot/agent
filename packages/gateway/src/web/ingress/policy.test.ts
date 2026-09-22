import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

import {makeDirectIngressPolicy, makeTrustedProxyIngressPolicy} from './policy.js'
import {parseTrustedProxyAddress} from './trusted-proxy-address.js'

describe('makeDirectIngressPolicy / makeTrustedProxyIngressPolicy', () => {
  // #given no arguments
  // #when a direct policy is built
  // #then its kind is 'direct' and it carries no other fields
  it('builds a direct policy', () => {
    const policy = makeDirectIngressPolicy()
    expect(policy).toEqual({kind: 'direct'})
  })

  // #given a non-empty peer tuple
  // #when a trusted-proxy policy is built
  // #then its kind is 'trusted-proxy' and it carries the peers
  it('builds a trusted-proxy policy carrying the peers', async () => {
    const peer = await Effect.runPromise(parseTrustedProxyAddress('203.0.113.10'))
    const policy = makeTrustedProxyIngressPolicy([peer])
    expect(policy).toEqual({kind: 'trusted-proxy', peers: [peer]})
  })
})
