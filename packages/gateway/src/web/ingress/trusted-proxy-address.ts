import {Effect} from 'effect'

import {canonicalAddressEquals, parseCanonicalAddress, type CanonicalAddress} from './canonical-address.js'

declare const trustedProxyAddressBrand: unique symbol

/**
 * Opaque canonical identity for one configured trusted-proxy peer (e.g. the
 * infra reverse proxy's address). Distinct from `ResolvedClientAddress` and
 * from the (module-private) socket-address type used during traversal —
 * neither is assignable to the other, so a trusted-proxy address can never be
 * mistaken for a resolved client identity at the type level.
 *
 * Construct only via `parseTrustedProxyAddress`.
 */
export interface TrustedProxyAddress {
  readonly [trustedProxyAddressBrand]: true
  readonly canonical: CanonicalAddress
}

/** Closed rejection reason for a malformed configured trusted-proxy address. */
export interface TrustedProxyAddressRejection {
  readonly kind: 'invalid-trusted-proxy-address'
}

/**
 * Parses one configured trusted-proxy address (e.g. from `GATEWAY_OPERATOR_TRUSTED_PROXIES`)
 * through the same canonical parser used for socket and X-Forwarded-For
 * addresses, so config-time and request-time identities can never drift.
 *
 * For the config lane: build the non-empty `peers` tuple required by
 * `OperatorIngressPolicy` (kind: 'trusted-proxy') from the results of this
 * parser — an empty tuple is unrepresentable by the `OperatorIngressPolicy`
 * type, so config loading must fail before constructing the policy if no
 * peer parses successfully.
 */
export function parseTrustedProxyAddress(
  raw: string,
): Effect.Effect<TrustedProxyAddress, TrustedProxyAddressRejection> {
  const canonical = parseCanonicalAddress(raw)
  if (canonical === undefined) {
    return Effect.fail({kind: 'invalid-trusted-proxy-address'})
  }
  return Effect.succeed({canonical} as TrustedProxyAddress)
}

/** True if `candidate`'s canonical identity matches this configured trusted-proxy peer. */
export function matchesTrustedProxyAddress(candidate: CanonicalAddress, peer: TrustedProxyAddress): boolean {
  return canonicalAddressEquals(candidate, peer.canonical)
}
