import type {TrustedProxyAddress} from './trusted-proxy-address.js'

declare const canonicalHttpsOriginBrand: unique symbol

/**
 * Branded https:// origin string, guaranteed canonical: https:// scheme, host,
 * optional port, no path beyond `/`, no query, no hash, no userinfo.
 *
 * The brand can only be produced by `asCanonicalHttpsOrigin` below — there is
 * no separate raw constructor, so a caller cannot brand an arbitrary,
 * unchecked string. `asCanonicalHttpsOrigin` performs the validation itself
 * (mirroring the canonical-origin checks `config.ts` already applies when
 * reading `GATEWAY_OPERATOR_PUBLIC_ORIGIN`) and brands only `URL#origin` of a
 * value that has already passed every check — never the raw input.
 */
export type CanonicalHttpsOrigin = string & {readonly [canonicalHttpsOriginBrand]: true}

/**
 * Validates `origin` as a canonical https:// origin and brands the
 * normalized result. Throws on anything that is not a valid URL, does not
 * use `https:`, or carries a path beyond `/`, a query string, a hash
 * fragment, or userinfo (username/password).
 */
export function asCanonicalHttpsOrigin(origin: string): CanonicalHttpsOrigin {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`asCanonicalHttpsOrigin: "${origin}" is not a valid URL`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`asCanonicalHttpsOrigin: "${origin}" must use https://`)
  }
  if (parsed.pathname !== '/') {
    throw new Error(`asCanonicalHttpsOrigin: "${origin}" must be a canonical origin (no path beyond /)`)
  }
  if (parsed.search !== '') {
    throw new Error(`asCanonicalHttpsOrigin: "${origin}" must be a canonical origin (no query string)`)
  }
  if (parsed.hash !== '') {
    throw new Error(`asCanonicalHttpsOrigin: "${origin}" must be a canonical origin (no hash fragment)`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`asCanonicalHttpsOrigin: "${origin}" must be a canonical origin (no userinfo)`)
  }
  return parsed.origin as CanonicalHttpsOrigin
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
