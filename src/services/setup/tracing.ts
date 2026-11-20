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
 * What a server start is given to decide, at its own moment, what the plugin is told: a plain host, or a source read right
 * before each spawn. A relay can die between the moment it reported ready and the moment the server is spawned (cache restore,
 * database repair and server preparation are awaited in between), so a run with a relay passes a source and the spawn reads it.
 */
export type ActionTracingSource = OpenCodeV2ActionTracingHost | (() => OpenCodeV2ActionTracingHost)

/** The host a source stands for right now. A plain host is returned as it is; a function is called, every time. */
export function resolveActionTracing(source: ActionTracingSource): OpenCodeV2ActionTracingHost {
  return typeof source === 'function' ? source() : source
}

/** The two things of a running relay the plugin's host depends on. */
export interface TraceRelayLiveness {
  readonly port: number
  /** The relay exited without being asked to, after it was ready. Latched by the supervisor. */
  readonly crashed: () => boolean
}

/**
 * A source that says on while the relay lives and off as soon as it has crashed (and so for good: a dead relay is never
 * named to the plugin, whose port may by now belong to another process). Each read looks at the relay then.
 */
export function liveActionTracingHost(
  relay: TraceRelayLiveness,
  identity: TracingRunIdentity,
): () => OpenCodeV2ActionTracingHost {
  let dead = false
  return () => {
    dead ||= relay.crashed()
    return buildActionTracingHost(dead ? null : relay.port, identity)
  }
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
