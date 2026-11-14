import type {KeyProxyProviderPlan} from '../../services/setup/key-proxy-providers.js'
import type {Logger} from '../../shared/logger.js'
import {buildKeyProxyUpstream} from '@fro-bot/runtime'

/**
 * Start-up probe of an `isolate-agent` run: one bounded `GET` to the selected provider's models route, through the owned
 * key proxy with the run's placeholder. It tells a rejected key from a working one before the model starts.
 *
 * A 2xx only means the upstream did not reject the key: some gateways serve the model list without auth. Only a 401 fails
 * the run. A 403 is not proof of a bad key (it can be a scope, project or organization limit on the models route), so
 * it warns, like every other outcome: one warning with its class, and the run continues. The first model request
 * surfaces any real problem. A response body is never read, logged or put in a message.
 */

export const KEY_PROXY_PROBE_TIMEOUT_MS = 10_000

export type KeyProxyProbeWarningClass = 'forbidden' | 'rate-limited' | 'unreachable' | 'unverifiable'

export type KeyProxyProbeResult =
  | {readonly status: 'passed'}
  /** The upstream rejected the key (401): the run must fail. */
  | {readonly status: 'failed'; readonly class: 'auth-rejected'; readonly message: string}
  /** The probe could not prove the key good or bad: log and continue. */
  | {readonly status: 'warned'; readonly class: KeyProxyProbeWarningClass}
  /** The run's own signal aborted the probe. Not a verdict on the provider. */
  | {readonly status: 'aborted'; readonly message: string}

export interface ProbeKeyProxyOptions {
  readonly plan: KeyProxyProviderPlan
  readonly proxy: {readonly baseUrl: (providerId: string) => string; readonly placeholder: string}
  readonly logger: Logger
  /** The run's signal. */
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export async function probeKeyProxy(options: ProbeKeyProxyOptions): Promise<KeyProxyProbeResult> {
  const {plan, proxy, logger} = options
  const providerId = plan.providerId
  const warn = (probeClass: KeyProxyProbeWarningClass): KeyProxyProbeResult => {
    logger.warning('Key proxy probe could not verify the provider; continuing', {
      provider: providerId,
      class: probeClass,
    })
    return {status: 'warned', class: probeClass}
  }
  const aborted = (): KeyProxyProbeResult => ({
    status: 'aborted',
    message: `Key proxy probe for provider "${providerId}" was aborted with the run`,
  })

  const runAborted = (): boolean => options.signal?.aborted === true
  if (runAborted()) return aborted()

  const upstream = buildKeyProxyUpstream({providerId, baseUrl: plan.baseUrl, protocols: plan.protocols})
  const route = upstream.success ? upstream.data.routes.find(entry => entry.kind === 'models') : undefined
  if (route === undefined) return warn('unverifiable')

  const timeout = AbortSignal.timeout(options.timeoutMs ?? KEY_PROXY_PROBE_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  // The forwarder copies the OpenAI routing headers on Bearer routes only, so the probe carries them there only.
  const credential =
    route.auth === 'x-api-key'
      ? {'x-api-key': proxy.placeholder}
      : {...plan.routingHeaders, authorization: `Bearer ${proxy.placeholder}`}

  let status: number
  try {
    const response = await fetch(`${proxy.baseUrl(providerId)}${route.path}`, {
      method: 'GET',
      headers: credential,
      redirect: 'manual',
      signal,
    })
    status = response.status
    // The body is never read: drop it so the connection is released.
    await response.body?.cancel().catch(() => undefined)
  } catch {
    if (runAborted()) return aborted()
    return warn(timeout.aborted ? 'unreachable' : 'unverifiable')
  }

  if (status >= 200 && status < 300) {
    logger.info('Key proxy probe passed', {provider: providerId, status})
    return {status: 'passed'}
  }
  if (status === 401) {
    return {
      status: 'failed',
      class: 'auth-rejected',
      message: `Provider "${providerId}" rejected its key at start-up (auth-rejected, HTTP ${status}). Check the key for it in the auth-json input.`,
    }
  }
  if (status === 403) return warn('forbidden')
  return warn(status === 429 ? 'rate-limited' : 'unverifiable')
}
