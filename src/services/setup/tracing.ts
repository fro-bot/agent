import type {Result} from '@bfra.me/es/result'
import type {OpenCodeV2ActionTracingHost, TraceRelayHeader, TracingRunIdentity} from '@fro-bot/runtime'
import type {TracingInputs} from '../../shared/types.js'
import {err, ok} from '@bfra.me/es/result'
import {ACTION_TRACING_OFF, isUsableTracingIdentity} from '@fro-bot/runtime'

/**
 * Turns the parsed tracing inputs and the facts of a routed run into the two things the rest of the run needs: the relay's
 * config (the collector URL and its credential headers, for the relay alone) and the plugin's host declaration (the relay's
 * port and the run's identity, for the launcher variable).
 *
 * The two never meet. The credential is in the first and not the second, so the launcher document, the server environment
 * and the plugin can never hold it.
 */

/** What the relay is started with. Already validated by the input parser, and validated again by the supervisor and the child. */
export interface TraceRelayRequest {
  readonly url: string
  readonly headers: readonly TraceRelayHeader[]
}

/** The relay's config for the parsed inputs, or null when tracing is off (so no relay starts). */
export function relayRequestFromInputs(inputs: TracingInputs): TraceRelayRequest | null {
  if (!inputs.enabled) return null
  return {url: inputs.url, headers: inputs.headers.map(({name, value}) => ({name, value}))}
}

/**
 * Where each field comes from is the caller's to say; this only shapes and checks them. `job` is null outside a runner.
 * `attempt` is a number because the Action reads `GITHUB_RUN_ATTEMPT` as one.
 */
export interface TracingRunFacts {
  readonly repository: string
  readonly runId: string
  readonly attempt: number
  readonly job: string | null
  readonly trigger: string
}

/**
 * The run identity every span of this run carries. `incomplete` when a field is missing or one the plugin would refuse: the
 * run then goes untraced rather than export spans with a guessed or empty identity.
 */
export function buildTracingRunIdentity(facts: TracingRunFacts): Result<TracingRunIdentity, 'incomplete'> {
  if (facts.job === null || !Number.isSafeInteger(facts.attempt) || facts.attempt < 1) return err('incomplete')
  const identity: TracingRunIdentity = {
    repository: facts.repository,
    runId: facts.runId,
    attempt: String(facts.attempt),
    job: facts.job,
    trigger: facts.trigger,
  }
  return isUsableTracingIdentity(identity) ? ok(identity) : err('incomplete')
}

/**
 * What the plugin is told. On only with a relay that is running (its port) and a complete identity; anything else is off, so
 * a relay that failed to start or a bundle that failed its check means the launcher says off.
 */
export function buildActionTracingHost(
  relayPort: number | null,
  identity: TracingRunIdentity | null,
): OpenCodeV2ActionTracingHost {
  if (relayPort === null || identity === null) return ACTION_TRACING_OFF
  return {host: 'action', tracing: 'on', relayPort, identity}
}
