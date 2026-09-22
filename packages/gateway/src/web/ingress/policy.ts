import type {TrustedProxyAddress} from './trusted-proxy-address.js'

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
  | {readonly kind: 'direct'}
  | {
      readonly kind: 'trusted-proxy'
      readonly peers: readonly [TrustedProxyAddress, ...TrustedProxyAddress[]]
    }

/** No reverse proxy is trusted — the TCP socket address is always the resolved client. */
export function makeDirectIngressPolicy(): OperatorIngressPolicy {
  return {kind: 'direct'}
}

/**
 * A reverse proxy is trusted at the given peer address(es). `peers` must be
 * non-empty — enforced by the parameter type, not by a runtime check.
 */
export function makeTrustedProxyIngressPolicy(
  peers: readonly [TrustedProxyAddress, ...TrustedProxyAddress[]],
): OperatorIngressPolicy {
  return {kind: 'trusted-proxy', peers}
}
