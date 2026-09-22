import type {TrustedProxyAddress} from './trusted-proxy-address.js'

declare const canonicalHttpsOriginBrand: unique symbol

/**
 * Branded https:// origin string. This module does not itself validate origin
 * shape (protocol/host/port/path) — that validation lives in config loading
 * (`config.ts`, owned by a later lane). `asCanonicalHttpsOrigin` trusts the
 * caller to have already validated the string; it exists so
 * `OperatorIngressPolicy` cannot be constructed with an arbitrary unchecked
 * string in `publicOrigin`.
 */
export type CanonicalHttpsOrigin = string & {readonly [canonicalHttpsOriginBrand]: true}

/** Brands an already-validated https:// origin string. Caller is responsible for validation. */
export function asCanonicalHttpsOrigin(origin: string): CanonicalHttpsOrigin {
  return origin as CanonicalHttpsOrigin
}

/**
 * The operator ingress trust policy: either no reverse proxy is trusted
 * (`'direct'` — the TCP socket address is always the client) or a non-empty
 * set of reverse-proxy peers is trusted (`'trusted-proxy'` — X-Forwarded-For
 * is consulted, but only once the socket itself is a trusted peer).
 *
 * `peers` is a non-empty tuple by type: `readonly [TrustedProxyAddress, ...TrustedProxyAddress[]]`.
 * A `'trusted-proxy'` policy with zero peers is not a value this type can
 * express — construct policies only via `makeDirectIngressPolicy` /
 * `makeTrustedProxyIngressPolicy` below, which both require the tuple shape
 * at the call site.
 */
export type OperatorIngressPolicy =
  | {readonly kind: 'direct'; readonly publicOrigin: CanonicalHttpsOrigin}
  | {
      readonly kind: 'trusted-proxy'
      readonly publicOrigin: CanonicalHttpsOrigin
      readonly peers: readonly [TrustedProxyAddress, ...TrustedProxyAddress[]]
    }

/** No reverse proxy is trusted — the TCP socket address is always the resolved client. */
export function makeDirectIngressPolicy(publicOrigin: CanonicalHttpsOrigin): OperatorIngressPolicy {
  return {kind: 'direct', publicOrigin}
}

/**
 * A reverse proxy is trusted at the given peer address(es). `peers` must be
 * non-empty — enforced by the parameter type, not by a runtime check.
 */
export function makeTrustedProxyIngressPolicy(
  publicOrigin: CanonicalHttpsOrigin,
  peers: readonly [TrustedProxyAddress, ...TrustedProxyAddress[]],
): OperatorIngressPolicy {
  return {kind: 'trusted-proxy', publicOrigin, peers}
}
