import type {OperatorIngressPolicy} from './policy.js'

import {Buffer} from 'node:buffer'
import {Effect} from 'effect'
import {canonicalAddressToString, parseCanonicalAddress, type CanonicalAddress} from './canonical-address.js'
import {matchesTrustedProxyAddress} from './trusted-proxy-address.js'

declare const resolvedClientBrand: unique symbol

/**
 * The result of trusted-proxy-aware client-address resolution. Opaque and
 * module-private to construct: the brand field and the object literal shape
 * that satisfies it are never exported, so no code outside this file can
 * fabricate one from a raw string. `resolveClient` (below) is the only
 * production operation that returns one.
 */
export interface ResolvedClientAddress {
  readonly [resolvedClientBrand]: true
  readonly canonical: string
}

declare const socketAddressBrand: unique symbol

/**
 * Opaque canonical identity for the TCP socket peer address. Module-private —
 * distinct from `TrustedProxyAddress` and from `ResolvedClientAddress`; never
 * exported, so it cannot be confused with either at a call boundary outside
 * this module.
 */
interface SocketAddress {
  readonly [socketAddressBrand]: true
  readonly canonical: CanonicalAddress
}

function toSocketAddress(canonical: CanonicalAddress): SocketAddress {
  return {canonical} as SocketAddress
}

/**
 * Raw, unvalidated ingress input for one request: the TCP socket's remote
 * address (as read from the connection — `undefined` when socket info is
 * unavailable, e.g. no real socket in a test harness) and every received
 * instance of the X-Forwarded-For header, in receipt order, each still in its
 * raw unsplit/unparsed form.
 */
export interface RawIngressInput {
  readonly socketAddress: string | undefined
  readonly forwardedForHeaders: readonly string[]
}

/**
 * Closed set of reasons `resolveClient` can reject a request. No variant
 * carries a usable client value — a rejection is never partially successful.
 */
export type IngressRejection =
  | {readonly kind: 'socket-unavailable'}
  | {readonly kind: 'socket-invalid'}
  | {readonly kind: 'missing-forwarded-for'}
  | {readonly kind: 'forwarded-for-too-large'}
  | {readonly kind: 'forwarded-for-too-many-entries'}
  | {readonly kind: 'forwarded-for-malformed'}
  | {readonly kind: 'no-untrusted-client'}

const MAX_FORWARDED_FOR_BYTES = 4096
const MAX_FORWARDED_FOR_ENTRIES = 32

function isTrusted(candidate: CanonicalAddress, policy: OperatorIngressPolicy): boolean {
  if (policy.kind === 'direct') return false
  return policy.peers.some(peer => matchesTrustedProxyAddress(candidate, peer))
}

function toResolved(canonical: CanonicalAddress): ResolvedClientAddress {
  return {canonical: canonicalAddressToString(canonical)} as ResolvedClientAddress
}

/**
 * Resolves the trust-aware client address for one request.
 *
 * Algorithm:
 *   1. Normalize the socket address (failure — missing/invalid/unavailable —
 *      is an ingress rejection, never a fallback "unknown" key).
 *   2. If the socket is NOT a trusted-proxy peer, select it directly and
 *      ignore X-Forwarded-For entirely (an untrusted party cannot inject a
 *      client identity via a spoofable header).
 *   3. If the socket IS a trusted-proxy peer, require a non-empty combined
 *      X-Forwarded-For header, bounded to 4 KiB / 32 comma-separated entries
 *      (a 33rd entry rejects — never truncates), with every entry parsed as
 *      a strict address (an empty entry, malformed address, or non-address
 *      token rejects the whole chain, rather than skipping it).
 *   4. Conceptually walk the chain `XFF-leftmost, …, XFF-rightmost, socket`
 *      from the socket end leftward, selecting the FIRST untrusted address
 *      encountered — the socket itself is already known-trusted at this
 *      point, so the walk starts at the rightmost XFF entry. Traversal stops
 *      there; addresses further left (including a forged leftmost claim) are
 *      never consulted. If every address in the chain is trusted, reject.
 *
 * Note: the rightmost XFF entry is the proxy's own record of the address it
 * received a connection from — NOT necessarily the proxy itself, and with
 * exactly one reverse proxy hop it is normally the real client. A
 * rightmost-XFF-is-the-proxy assumption is wrong and is NOT what this
 * function does.
 */
export function resolveClient(
  input: RawIngressInput,
  policy: OperatorIngressPolicy,
): Effect.Effect<ResolvedClientAddress, IngressRejection> {
  if (input.socketAddress === undefined) {
    return Effect.fail({kind: 'socket-unavailable'})
  }

  const socketCanonical = parseCanonicalAddress(input.socketAddress)
  if (socketCanonical === undefined) {
    return Effect.fail({kind: 'socket-invalid'})
  }
  const socket = toSocketAddress(socketCanonical)

  if (isTrusted(socket.canonical, policy) === false) {
    return Effect.succeed(toResolved(socket.canonical))
  }

  const combined = input.forwardedForHeaders.join(', ')
  if (combined.trim() === '') {
    return Effect.fail({kind: 'missing-forwarded-for'})
  }
  if (Buffer.byteLength(combined, 'utf8') > MAX_FORWARDED_FOR_BYTES) {
    return Effect.fail({kind: 'forwarded-for-too-large'})
  }

  const rawEntries = combined.split(',')
  if (rawEntries.length > MAX_FORWARDED_FOR_ENTRIES) {
    return Effect.fail({kind: 'forwarded-for-too-many-entries'})
  }

  const entries: CanonicalAddress[] = []
  for (const rawEntry of rawEntries) {
    const parsed = parseCanonicalAddress(rawEntry)
    if (parsed === undefined) {
      return Effect.fail({kind: 'forwarded-for-malformed'})
    }
    entries.push(parsed)
  }

  // Walk right-to-left starting at the rightmost XFF entry (the socket,
  // one step further right, is already known-trusted). Select the first
  // untrusted address; never traverse past it toward the leftmost entry.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]
    if (candidate === undefined) continue
    if (isTrusted(candidate, policy) === false) {
      return Effect.succeed(toResolved(candidate))
    }
  }

  return Effect.fail({kind: 'no-untrusted-client'})
}
