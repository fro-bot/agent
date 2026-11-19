import {TRACE_RELAY_PATH} from './trace-relay-wire.js'

/**
 * What a launcher tells the fro-bot plugin about its host, as one JSON document in one environment variable
 * (`FRO_BOT_TRACING_LAUNCHER_ENV`). The plugin's `resolveTracingSettings` reads the same document; its tests round-trip this
 * module's output, and an equality test keeps the variable name in step.
 *
 * Every launcher of a server declares its host (`startOpenCodeV2Server` requires one), so the plugin never has to guess:
 * - the Action, with tracing off, or on with the relay's loopback port and the run's identity;
 * - the workspace, where tracing stays off.
 *
 * The document never carries a credential, a collector address or a header: the Action's relay holds those.
 */

export const TRACING_LAUNCHER_VERSION = 1

/** The longest identity field the plugin accepts. A longer one would make the plugin refuse the whole document. */
export const TRACING_IDENTITY_FIELD_MAX_CHARS = 200

const LOOPBACK = '127.0.0.1'

/** The run identity every span of an Action run carries. All strings, as the plugin's attributes are. */
export interface TracingRunIdentity {
  readonly repository: string
  readonly runId: string
  /** `GITHUB_RUN_ATTEMPT`, which the agent environment does not admit, so it travels here. */
  readonly attempt: string
  readonly job: string
  readonly trigger: string
}

export type OpenCodeV2ActionTracingHost =
  | {readonly host: 'action'; readonly tracing: 'off'}
  | {
      readonly host: 'action'
      readonly tracing: 'on'
      /** The loopback port of the running relay. The path is the relay's own. */
      readonly relayPort: number
      readonly identity: TracingRunIdentity
    }

/** Who launches the server, and what it says about tracing. Required by `startOpenCodeV2Server`, with no default. */
export type OpenCodeV2TracingHost = OpenCodeV2ActionTracingHost | {readonly host: 'workspace'}

export const ACTION_TRACING_OFF: OpenCodeV2ActionTracingHost = {host: 'action', tracing: 'off'}

/** The workspace service: the plugin stays off there (gateway tracing is a later release). */
export const WORKSPACE_TRACING_HOST: OpenCodeV2TracingHost = {host: 'workspace'}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isUsableField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= TRACING_IDENTITY_FIELD_MAX_CHARS &&
    !hasControlCharacter(value)
  )
}

/** Whether every field is one the plugin would accept: non-empty, bounded, free of control characters. */
export function isUsableTracingIdentity(identity: TracingRunIdentity): boolean {
  return (
    isUsableField(identity.repository) &&
    isUsableField(identity.runId) &&
    isUsableField(identity.attempt) &&
    isUsableField(identity.job) &&
    isUsableField(identity.trigger)
  )
}

/** The address the plugin's exporter posts to: the relay's loopback port and the one path the relay serves. */
export function tracingRelayUrl(port: number): string {
  return `http://${LOOPBACK}:${port}${TRACE_RELAY_PATH}`
}

function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535
}

/**
 * The launcher variable's value for `host`. Total and fail-closed: an "on" host whose port or identity the plugin would
 * refuse becomes the Action's "off" document, so a value the plugin cannot read never reaches it.
 */
export function buildTracingLauncherValue(host: OpenCodeV2TracingHost): string {
  if (host.host === 'workspace') {
    return JSON.stringify({version: TRACING_LAUNCHER_VERSION, host: 'workspace', tracing: 'off'})
  }
  if (host.tracing === 'on' && isUsablePort(host.relayPort) && isUsableTracingIdentity(host.identity)) {
    const {repository, runId, attempt, job, trigger} = host.identity
    return JSON.stringify({
      version: TRACING_LAUNCHER_VERSION,
      host: 'action',
      tracing: 'on',
      relay: tracingRelayUrl(host.relayPort),
      identity: {repository, runId, attempt, job, trigger},
    })
  }
  return JSON.stringify({version: TRACING_LAUNCHER_VERSION, host: 'action', tracing: 'off'})
}
