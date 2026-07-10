/**
 * The ONLY module in the Gateway operator push surface allowed to import
 * `web-push`. Wraps `webpush.sendNotification` with:
 *
 *   1. A connect-time SSRF guard — a custom `https.Agent` whose DNS lookup
 *      is intercepted so the address that gets classified is the EXACT
 *      address the socket then connects to, with no re-resolution in
 *      between. This closes the DNS-rebinding gap the parse-time validator
 *      in `validate-endpoint.ts` explicitly cannot close (see that
 *      module's docstring).
 *   2. Response classification into a closed `PushRelayResult` union so
 *      callers (the dispatcher) never see a raw `WebPushError`, an
 *      endpoint, a response body, or headers.
 *
 * Security invariant: `PushRelayResult` and every log line in this module
 * NEVER carry the endpoint, subscription keys, VAPID keys, payload,
 * response body, or response headers — only a coarse outcome and,
 * where safe, the numeric status code.
 */

import type {LookupFunction} from 'node:net'
import type {PushSubscription, RequestOptions} from 'web-push'
import dns from 'node:dns'
import https from 'node:https'
import webpush, {WebPushError} from 'web-push'
import {isBlockedResolvedAddress} from './ip-classification.js'

export interface PushSenderLogger {
  readonly warn: (context: Record<string, unknown>, message: string) => void
}

/** Socket timeout for a single relay attempt. */
const DEFAULT_SEND_TIMEOUT_MS = 10_000

export interface PushVapidDispatchConfig {
  readonly subject: string
  readonly publicKey: string
  readonly privateKey: string
}

export type PushRelayResult =
  | {readonly outcome: 'accepted'; readonly statusCode: number}
  | {readonly outcome: 'dead-subscription'; readonly statusCode: number}
  | {readonly outcome: 'retryable'; readonly statusCode: number}
  | {readonly outcome: 'payload-too-large'}
  | {readonly outcome: 'error'}

export interface PushSender {
  sendNotification: (
    subscription: PushSubscription,
    payload: string,
    vapidConfig: PushVapidDispatchConfig,
  ) => Promise<PushRelayResult>
}

export interface CreatePushSenderDeps {
  readonly logger: PushSenderLogger
  readonly timeoutMs?: number
}

/**
 * Builds the guarded DNS lookup used by the connect-time SSRF agent: it
 * resolves the hostname exactly once via Node's real `dns.lookup`, classifies
 * the RESOLVED address, and either passes that same address straight through
 * to the socket connector (no re-resolution — the validated address IS the
 * connected address) or aborts the connection before any socket opens.
 */
function createGuardedLookup(): LookupFunction {
  return (hostname, options, callback) => {
    const lookupFamily = options.family
    const family = lookupFamily === 'IPv4' ? 4 : lookupFamily === 'IPv6' ? 6 : lookupFamily
    dns.lookup(hostname, {all: false, family}, (error, address, resolvedFamily) => {
      if (error !== null) {
        callback(error, '', 0)
        return
      }
      if (isBlockedResolvedAddress(address, resolvedFamily)) {
        callback(new Error('push relay destination blocked'), '', 0)
        return
      }
      callback(null, address, resolvedFamily)
    })
  }
}

/**
 * Builds the `https.Agent` passed as `options.agent` to `webpush.sendNotification`.
 *
 * Deliberately never paired with `options.proxy` — web-push IGNORES the
 * agent entirely when a proxy is configured, which would silently reopen
 * the SSRF gap this agent exists to close. Callers of this module must
 * never set `proxy`.
 */
function createGuardedAgent(): https.Agent {
  const agent = new https.Agent({keepAlive: false})
  const guardedLookup = createGuardedLookup()
  const baseCreateConnection = agent.createConnection.bind(agent)
  // https.Agent#createConnection ultimately forwards its options to
  // tls.connect / net.connect, both of which honor a `lookup` override for
  // hostname resolution. Injecting it here — rather than passing `lookup`
  // to `webpush.sendNotification` (which has no such option) — is what lets
  // one custom agent enforce the guard for every request it services.
  agent.createConnection = (...args: Parameters<typeof baseCreateConnection>) => {
    const [options, callback] = args
    const guardedOptions = {...options, lookup: guardedLookup}
    return baseCreateConnection(guardedOptions, callback)
  }
  return agent
}

function classifyWebPushError(error: WebPushError): PushRelayResult {
  const statusCode = error.statusCode
  if (statusCode === 410 || statusCode === 404) {
    return {outcome: 'dead-subscription', statusCode}
  }
  if (statusCode === 413) {
    return {outcome: 'payload-too-large'}
  }
  if (statusCode === 429 || statusCode >= 500) {
    return {outcome: 'retryable', statusCode}
  }
  return {outcome: 'error'}
}

/**
 * Factory for the push relay adapter. Each call to `sendNotification`
 * builds a fresh guarded agent so a blocked-destination lookup can never
 * leak across unrelated sends via connection pooling.
 */
export function createPushSender(deps: CreatePushSenderDeps): PushSender {
  const {logger} = deps
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS

  async function sendNotification(
    subscription: PushSubscription,
    payload: string,
    vapidConfig: PushVapidDispatchConfig,
  ): Promise<PushRelayResult> {
    const agent = createGuardedAgent()
    try {
      const options: RequestOptions = {
        vapidDetails: {
          subject: vapidConfig.subject,
          publicKey: vapidConfig.publicKey,
          privateKey: vapidConfig.privateKey,
        },
        timeout: timeoutMs,
        agent,
        // NEVER set `proxy` here — web-push ignores `agent` entirely when
        // `proxy` is set, which would bypass the connect-time SSRF guard.
      }
      const result = await webpush.sendNotification(subscription, payload, options)
      return {outcome: 'accepted', statusCode: result.statusCode}
    } catch (error: unknown) {
      if (error instanceof WebPushError) {
        return classifyWebPushError(error)
      }
      // Includes the guarded-lookup SSRF block and any network/timeout
      // failure. Coarse log only — never the endpoint or error message,
      // which could embed request detail.
      logger.warn({}, 'operator push: relay send failed')
      return {outcome: 'error'}
    } finally {
      agent.destroy()
    }
  }

  return {sendNotification}
}
