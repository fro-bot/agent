/**
 * SSRF-conservative validation for browser-supplied push subscription endpoint
 * URLs, applied before any endpoint value reaches the subscription store.
 *
 * A push endpoint is normally a push-service origin (e.g. Google FCM,
 * Mozilla autopush) chosen by the browser, not the operator. Accepting it
 * without validation would let a malicious or compromised browser register
 * an endpoint pointing at an internal service — the dispatch path would
 * then issue an authenticated-looking HTTPS POST to that URL. This module
 * rejects the classes of URL that would make that dangerous.
 *
 * Architectural boundary: this is a parse-time literal-address guard. It
 * classifies the hostname as written in the URL and cannot defend against
 * DNS rebinding, where a hostname resolves to a public IP at validation
 * time and to a private or metadata IP at fetch/dispatch time. The push
 * dispatch path (`push-sender.ts`) additionally validates the RESOLVED IP
 * at connect time via `isBlockedResolvedAddress` from `ip-classification.ts`
 * to close that gap; this module only stops literal-address bypasses.
 *
 * IPv6 posture: IPv6 literals are rejected wholesale — push service
 * endpoints are DNS hostnames, so any IPv6 literal is treated as an SSRF
 * risk and denied; specific internal forms are still classified for
 * logging granularity.
 *
 * Security invariant: the endpoint value itself must NEVER be echoed in a
 * thrown reason or a log line — only the coarse rejection class name.
 */

import type {EndpointRejectionReason} from './ip-classification.js'
import {classifyIpv4, classifyIpv6} from './ip-classification.js'

export type {EndpointRejectionReason} from './ip-classification.js'

export interface EndpointValidationResult {
  readonly ok: boolean
  readonly reason?: EndpointRejectionReason
}

const LOOPBACK_HOSTNAMES = new Set(['localhost'])

/**
 * Validate a push subscription endpoint URL against an SSRF-conservative
 * allowlist posture: HTTPS-only, no loopback, no private/link-local network,
 * no bare/local hostnames.
 *
 * Never includes the endpoint value in the returned reason — callers must
 * not log the endpoint alongside the rejection.
 */
export function validateEndpointUrl(endpoint: string): EndpointValidationResult {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return {ok: false, reason: 'unparseable'}
  }

  if (url.protocol !== 'https:') {
    return {ok: false, reason: 'not-https'}
  }

  const rawHostname = url.hostname.toLowerCase()

  if (LOOPBACK_HOSTNAMES.has(rawHostname)) {
    return {ok: false, reason: 'loopback'}
  }

  // WHATWG URL.hostname keeps the brackets for an IPv6 literal (e.g. "[::1]").
  const isIpv6Literal = rawHostname.startsWith('[') && rawHostname.endsWith(']')
  const hostname = isIpv6Literal ? rawHostname.slice(1, -1) : rawHostname

  if (isIpv6Literal) {
    // Every IPv6 literal is rejected — classifyIpv6 is total.
    return {ok: false, reason: classifyIpv6(hostname)}
  }
  const ipv4Reason = classifyIpv4(hostname)
  if (ipv4Reason !== null) return {ok: false, reason: ipv4Reason}

  // A trailing dot is a valid FQDN root marker ("foo.internal.") that Node
  // fetch still resolves, but it defeats a naive suffix/no-dot check. Strip
  // it before those checks — never before IP literal parsing above, since
  // IP literals don't carry a trailing dot.
  const normalizedHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname

  if (normalizedHostname.endsWith('.local') || normalizedHostname.endsWith('.internal')) {
    return {ok: false, reason: 'no-dot-hostname'}
  }

  // Bare hostname / local service name — no dot at all (e.g. "workspace").
  // IPv6 literals already returned above, so only DNS-style hosts reach here.
  if (normalizedHostname.includes('.') === false) {
    return {ok: false, reason: 'no-dot-hostname'}
  }

  return {ok: true}
}
