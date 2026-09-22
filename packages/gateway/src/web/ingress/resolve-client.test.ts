import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

import {
  asCanonicalHttpsOrigin,
  makeDirectIngressPolicy,
  makeTrustedProxyIngressPolicy,
  type OperatorIngressPolicy,
} from './policy.js'
import {resolveClient, type RawIngressInput} from './resolve-client.js'
import {parseTrustedProxyAddress, type TrustedProxyAddress} from './trusted-proxy-address.js'

const ORIGIN = asCanonicalHttpsOrigin('https://operator.example.com')

function peer(raw: string): TrustedProxyAddress {
  return Effect.runSync(parseTrustedProxyAddress(raw))
}

function trustedProxyPolicy(...peers: readonly [string, ...string[]]): OperatorIngressPolicy {
  const [first, ...rest] = peers
  return makeTrustedProxyIngressPolicy(ORIGIN, [peer(first), ...rest.map(peer)])
}

function input(socketAddress: string | undefined, forwardedForHeaders: readonly string[] = []): RawIngressInput {
  return {socketAddress, forwardedForHeaders}
}

async function resolve(rawInput: RawIngressInput, policy: OperatorIngressPolicy) {
  return Effect.runPromise(Effect.either(resolveClient(rawInput, policy)))
}

/** Unwraps a `Left` for assertion — throws (failing the test) if given a `Right`, so callers never need a conditional `expect`. */
function expectLeft<L>(either: {readonly _tag: 'Left'; readonly left: L} | {readonly _tag: 'Right'}): L {
  if (either._tag !== 'Left') throw new Error('expected a Left result')
  return either.left
}

const P1 = '10.0.0.1'
const P2 = '10.0.0.2'
const CLIENT = '203.0.113.9'
const FORGED = '198.51.100.1'

describe('resolveClient — worked cases', () => {
  // #given socket P2, XFF "forged, C, P1", trusted {P1, P2}
  // #when resolved
  // #then the first untrusted address walking from the socket leftward (C) is selected — the forged leftmost claim is never reached
  it('selects the first untrusted address walking from the socket, ignoring an earlier forged claim', async () => {
    const policy = trustedProxyPolicy(P1, P2)
    const result = await resolve(input(P2, [`${FORGED}, ${CLIENT}, ${P1}`]), policy)
    expect(result._tag).toBe('Right')
    expect(result._tag === 'Right' ? result.right.canonical : undefined).toBe(CLIENT)
  })

  // #given socket P1, XFF "C", trusted {P1}
  // #when resolved
  // #then C is selected
  it('selects the client behind a single trusted proxy hop', async () => {
    const policy = trustedProxyPolicy(P1)
    const result = await resolve(input(P1, [CLIENT]), policy)
    expect(result._tag).toBe('Right')
    expect(result._tag === 'Right' ? result.right.canonical : undefined).toBe(CLIENT)
  })

  // #given socket C (untrusted), any XFF content, trusted {P1}
  // #when resolved
  // #then C is selected directly and the XFF header is ignored entirely (even if garbage)
  it('ignores X-Forwarded-For entirely when the socket is untrusted', async () => {
    const policy = trustedProxyPolicy(P1)
    const result = await resolve(input(CLIENT, ['not a valid address, also not valid, unknown']), policy)
    expect(result._tag).toBe('Right')
    expect(result._tag === 'Right' ? result.right.canonical : undefined).toBe(CLIENT)
  })

  // #given socket P2, XFF "P1", trusted {P1, P2}
  // #when resolved
  // #then every address in the chain is trusted — rejected
  it('rejects when every address in the chain is trusted', async () => {
    const policy = trustedProxyPolicy(P1, P2)
    const result = await resolve(input(P2, [P1]), policy)
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'no-untrusted-client'}})
  })

  // #given socket P1 (trusted), XFF absent
  // #when resolved
  // #then rejected — a trusted socket requires a non-empty XFF
  it('rejects a trusted socket with an absent X-Forwarded-For header', async () => {
    const policy = trustedProxyPolicy(P1)
    const result = await resolve(input(P1, []), policy)
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'missing-forwarded-for'}})
  })

  // #given socket P1 (trusted), XFF present but empty
  // #when resolved
  // #then rejected — same as absent
  it('rejects a trusted socket with an empty X-Forwarded-For header', async () => {
    const policy = trustedProxyPolicy(P1)
    const result = await resolve(input(P1, ['']), policy)
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'missing-forwarded-for'}})
  })

  // #given socket P1 (trusted), XFF "unknown, C"
  // #when resolved
  // #then the whole chain is rejected — a malformed entry is never skipped
  it('rejects the whole chain on one malformed entry, even with a valid entry present', async () => {
    const policy = trustedProxyPolicy(P1)
    const result = await resolve(input(P1, [`unknown, ${CLIENT}`]), policy)
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'forwarded-for-malformed'}})
  })
})

describe('resolveClient — socket handling', () => {
  // #given no socket address (unavailable)
  // #when resolved
  // #then it fails with a distinct reason — never falls back to an "unknown" key
  it('fails (does not fall back to a key) when the socket address is unavailable', async () => {
    const policy = trustedProxyPolicy(P1)
    const result = await resolve(input(undefined), policy)
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'socket-unavailable'}})
  })

  // #given an unparseable socket address string
  // #when resolved
  // #then it fails with a distinct reason
  it('fails on an invalid socket address', async () => {
    const policy = trustedProxyPolicy(P1)
    const result = await resolve(input('not-an-address'), policy)
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'socket-invalid'}})
  })

  // #given a 'direct' policy (no trusted proxies configured)
  // #when resolved
  // #then the socket is always selected and XFF is always ignored
  it('always selects the socket under a direct policy, ignoring XFF', async () => {
    const policy = makeDirectIngressPolicy(ORIGIN)
    const result = await resolve(input(CLIENT, [P1]), policy)
    expect(result._tag).toBe('Right')
    expect(result._tag === 'Right' ? result.right.canonical : undefined).toBe(CLIENT)
  })
})

describe('resolveClient — X-Forwarded-For bounds', () => {
  // #given a trusted socket and 33 comma-separated valid XFF entries
  // #when resolved
  // #then it rejects rather than truncating to the first 32
  it('rejects a 33rd X-Forwarded-For entry rather than truncating', async () => {
    const policy = trustedProxyPolicy(P1)
    const entries = Array.from({length: 33}, (_, index) => `10.1.1.${(index % 250) + 1}`)
    const result = await resolve(input(P1, [entries.join(', ')]), policy)
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'forwarded-for-too-many-entries'}})
  })

  // #given a trusted socket and 32 comma-separated valid XFF entries (at the boundary)
  // #when resolved
  // #then it is accepted (the leftmost untrusted entry is selected)
  it('accepts exactly 32 X-Forwarded-For entries', async () => {
    const policy = trustedProxyPolicy(P1)
    const entries = [CLIENT, ...Array.from({length: 31}, (_, index) => `10.1.1.${(index % 250) + 1}`)]
    const result = await resolve(input(P1, [entries.join(', ')]), policy)
    expect(result._tag).toBe('Right')
  })

  // #given a trusted socket and a combined X-Forwarded-For header over 4 KiB
  // #when resolved
  // #then it rejects
  it('rejects a combined X-Forwarded-For header over 4 KiB', async () => {
    const policy = trustedProxyPolicy(P1)
    const oversized = 'x'.repeat(4097)
    const result = await resolve(input(P1, [oversized]), policy)
    expect(result).toMatchObject({_tag: 'Left', left: {kind: 'forwarded-for-too-large'}})
  })
})

describe('resolveClient — canonical identity stability', () => {
  // #given the same client written as IPv4 in one request and as IPv4-mapped IPv6 in another
  // #when resolved through the same trusted proxy
  // #then both resolve to the same canonical value (a mismatch here silently reintroduces the socket-key collapse)
  it('resolves IPv4 and IPv4-mapped-IPv6 forms of the same client to the same canonical value', async () => {
    const policy = trustedProxyPolicy(P1)
    const viaIpv4 = await resolve(input(P1, ['127.0.0.1']), policy)
    const viaMappedIpv6 = await resolve(input(P1, ['::ffff:7f00:1']), policy)
    expect(viaIpv4._tag).toBe('Right')
    expect(viaMappedIpv6._tag).toBe('Right')
    expect(viaIpv4._tag === 'Right' ? viaIpv4.right.canonical : undefined).toBe(
      viaMappedIpv6._tag === 'Right' ? viaMappedIpv6.right.canonical : undefined,
    )
  })

  // #given the same client starting through proxy A and, on a later request (e.g. the OAuth callback), through proxy B
  // #when resolved
  // #then both resolve to the same canonical value
  it('resolves the same client to the same canonical value across two different trusted-proxy hops', async () => {
    const policy = trustedProxyPolicy(P1, P2)
    const start = await resolve(input(P1, [CLIENT]), policy)
    const callback = await resolve(input(P2, [CLIENT]), policy)
    expect(start._tag).toBe('Right')
    expect(callback._tag).toBe('Right')
    expect(start._tag === 'Right' ? start.right.canonical : undefined).toBe(
      callback._tag === 'Right' ? callback.right.canonical : undefined,
    )
  })
})

describe('resolveClient — rejection shape', () => {
  // #given any rejection path
  // #when inspected
  // #then it carries only a closed 'kind' reason and no client value
  it('every rejection carries a closed reason and no usable client value', async () => {
    const policy = trustedProxyPolicy(P1)
    const result = await resolve(input(P1, []), policy)
    const left = expectLeft(result)
    expect(Object.keys(left)).toEqual(['kind'])
    expect(left).not.toHaveProperty('canonical')
  })
})
