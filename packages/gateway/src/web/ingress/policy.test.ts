import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

import {asCanonicalHttpsOrigin, makeDirectIngressPolicy, makeTrustedProxyIngressPolicy} from './policy.js'
import {parseTrustedProxyAddress} from './trusted-proxy-address.js'

describe('asCanonicalHttpsOrigin', () => {
  // #given a bare https origin with no path
  // #when branded
  // #then it succeeds and returns the normalized origin
  it('accepts a canonical https origin', () => {
    expect(asCanonicalHttpsOrigin('https://operator.example.com')).toBe('https://operator.example.com')
  })

  // #given an https origin with an explicit non-default port
  // #when branded
  // #then the port is preserved
  it('accepts a canonical https origin with an explicit port', () => {
    expect(asCanonicalHttpsOrigin('https://operator.example.com:8443')).toBe('https://operator.example.com:8443')
  })

  // #given a trailing-slash-only origin
  // #when branded
  // #then the trailing slash is normalized away
  it('normalizes a trailing-slash-only origin', () => {
    expect(asCanonicalHttpsOrigin('https://operator.example.com/')).toBe('https://operator.example.com')
  })

  // #given an http:// (non-TLS) origin
  // #when branded
  // #then it throws \u2014 the brand cannot be produced from a non-https string
  it('rejects http:// (non-TLS)', () => {
    expect(() => asCanonicalHttpsOrigin('http://operator.example.com')).toThrow(/https:\/\//)
  })

  // #given a string that is not a valid URL at all
  // #when branded
  // #then it throws rather than blindly casting
  it('rejects a string that is not a valid URL', () => {
    expect(() => asCanonicalHttpsOrigin('not-a-url')).toThrow(/not a valid URL/)
  })

  // #given an origin with a path beyond /
  // #when branded
  // #then it throws
  it('rejects a path beyond /', () => {
    expect(() => asCanonicalHttpsOrigin('https://operator.example.com/some/path')).toThrow(/path/)
  })

  // #given an origin with a query string
  // #when branded
  // #then it throws
  it('rejects a query string', () => {
    expect(() => asCanonicalHttpsOrigin('https://operator.example.com?foo=bar')).toThrow(/query/)
  })

  // #given an origin with a hash fragment
  // #when branded
  // #then it throws
  it('rejects a hash fragment', () => {
    expect(() => asCanonicalHttpsOrigin('https://operator.example.com#section')).toThrow(/hash/)
  })

  // #given an origin with userinfo (username)
  // #when branded
  // #then it throws
  it('rejects a username (userinfo)', () => {
    expect(() => asCanonicalHttpsOrigin('https://user@operator.example.com')).toThrow(/userinfo/)
  })

  // #given an origin with userinfo (username + password)
  // #when branded
  // #then it throws
  it('rejects a username and password (userinfo)', () => {
    expect(() => asCanonicalHttpsOrigin('https://user:pass@operator.example.com')).toThrow(/userinfo/)
  })

  // #given an arbitrary, unvalidated string with no https shape at all
  // #when branded
  // #then it is rejected \u2014 proving no route brands an arbitrary string.
  // (Type-level proof that `CanonicalHttpsOrigin` cannot be constructed via
  // a bare `as` cast from outside this module was checked as a standalone
  // compile probe and is not committed \u2014 see the task report.)
  it('rejects an arbitrary non-URL string outright', () => {
    expect(() => asCanonicalHttpsOrigin('totally not an origin')).toThrow()
  })
})

describe('makeDirectIngressPolicy / makeTrustedProxyIngressPolicy', () => {
  const origin = asCanonicalHttpsOrigin('https://operator.example.com')

  // #given a validated origin
  // #when a direct policy is built
  // #then its kind is 'direct' and carries the origin
  it('builds a direct policy carrying the validated origin', () => {
    const policy = makeDirectIngressPolicy(origin)
    expect(policy).toEqual({kind: 'direct', publicOrigin: origin})
  })

  // #given a validated origin and a non-empty peer tuple
  // #when a trusted-proxy policy is built
  // #then its kind is 'trusted-proxy' and carries the origin and peers
  it('builds a trusted-proxy policy carrying the validated origin and peers', async () => {
    const peer = await Effect.runPromise(parseTrustedProxyAddress('203.0.113.10'))
    const policy = makeTrustedProxyIngressPolicy(origin, [peer])
    expect(policy).toEqual({kind: 'trusted-proxy', publicOrigin: origin, peers: [peer]})
  })
})
