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
 *
 * An "on" document may also carry three optional fields that tie a turn trace to the run: `rootSpan` (the run's root span, to
 * link to), `sessionId` (the telemetry session, used verbatim) and `invocationId`. None is required, and a document without
 * them reads as it always has; any other key makes the plugin refuse the document.
 */

export const TRACING_LAUNCHER_VERSION = 1

/** The longest identity field the plugin accepts. A longer one would make the plugin refuse the whole document. */
export const TRACING_IDENTITY_FIELD_MAX_CHARS = 200

/**
 * The longest launcher document the plugin reads, counted in characters of the serialized value. Longer is malformed there
 * (`MAX_LAUNCHER_CHARS`; a parity test keeps the two equal). The fields' own limits do not bound it: a lone surrogate is one
 * character in a field and a six-character escape in the document, so the writer checks the serialized length.
 */
export const TRACING_LAUNCHER_MAX_CHARS = 4096

const LOOPBACK = '127.0.0.1'

/** The Action run's root span, which each turn's root span links to. Hex, as OTLP writes ids. */
export interface TracingRootSpanContext {
  /** 32 lower-case hex characters, not all zero. */
  readonly traceId: string
  /** 16 lower-case hex characters, not all zero. */
  readonly spanId: string
}

/**
 * What ties a turn trace to the run that started it. Every field is optional and is passed through untouched: the Action
 * computes the session id (`<owner>/<repo>:<logical key>`) and the plugin uses it verbatim, never deriving or altering it.
 */
export interface TracingRunLink {
  readonly rootSpan?: TracingRootSpanContext | undefined
  readonly sessionId?: string | undefined
  readonly invocationId?: string | undefined
}

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
  | ({
      readonly host: 'action'
      readonly tracing: 'on'
      /** The loopback port of the running relay. The path is the relay's own. */
      readonly relayPort: number
      readonly identity: TracingRunIdentity
    } & TracingRunLink)

/** Who launches the server, and what it says about tracing. Required by `startOpenCodeV2Server`, with no default. */
export type OpenCodeV2TracingHost = OpenCodeV2ActionTracingHost | {readonly host: 'workspace'}

/**
 * What a late decision settles, once, right before the child is spawned: the launcher's host and, when the decision changes
 * it, the config content the child receives. Everything that depends on whether tracing is on (the launcher document and the
 * plugin list are the two today) must be in this one value, so a decision cannot be half applied.
 */
export interface OpenCodeV2TracingDecision {
  readonly host: OpenCodeV2TracingHost
  /** Replaces the start's `config` for this child. Absent: the start's own `config` (the tracing-off content) is used. */
  readonly config?: Readonly<Record<string, unknown>>
}

/**
 * What a start is given: a plain host, or a resolver the start calls once, after its port allocation and immediately before
 * the spawn. A launcher that can learn something between preparing the start and spawning (the Action's relay can exit) passes
 * the resolver; one that cannot (the workspace) passes its host. Either way the declaration is required.
 */
export type OpenCodeV2TracingSetting = OpenCodeV2TracingHost | (() => OpenCodeV2TracingDecision)

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

/** Whether `value` is a string the plugin would accept as a field: non-empty, bounded, free of control characters. */
export function isUsableTracingField(value: unknown): value is string {
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
    isUsableTracingField(identity.repository) &&
    isUsableTracingField(identity.runId) &&
    isUsableTracingField(identity.attempt) &&
    isUsableTracingField(identity.job) &&
    isUsableTracingField(identity.trigger)
  )
}

const TRACE_ID = /^[\da-f]{32}$/
const SPAN_ID = /^[\da-f]{16}$/
const NON_ZERO = /[1-9a-f]/

/** Whether both ids are lower-case hex of the right length and not all zero, which W3C trace context makes invalid. */
export function isUsableTracingRootSpan(rootSpan: unknown): rootSpan is TracingRootSpanContext {
  // An untyped caller may pass anything: `null` and every non-object are refused, never thrown on.
  if (typeof rootSpan !== 'object' || rootSpan === null) return false
  const {traceId, spanId} = rootSpan as {readonly traceId?: unknown; readonly spanId?: unknown}
  return (
    typeof traceId === 'string' &&
    typeof spanId === 'string' &&
    TRACE_ID.test(traceId) &&
    SPAN_ID.test(spanId) &&
    NON_ZERO.test(traceId) &&
    NON_ZERO.test(spanId)
  )
}

/** Whether every field that is present is one the plugin would accept. Absent fields are fine: all three are optional. */
function isUsableTracingRunLink(link: TracingRunLink): boolean {
  return (
    (link.rootSpan === undefined || isUsableTracingRootSpan(link.rootSpan)) &&
    (link.sessionId === undefined || isUsableTracingField(link.sessionId)) &&
    (link.invocationId === undefined || isUsableTracingField(link.invocationId))
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
  if (
    host.tracing === 'on' &&
    isUsablePort(host.relayPort) &&
    isUsableTracingIdentity(host.identity) &&
    isUsableTracingRunLink(host)
  ) {
    const {repository, runId, attempt, job, trigger} = host.identity
    const value = JSON.stringify({
      version: TRACING_LAUNCHER_VERSION,
      host: 'action',
      tracing: 'on',
      relay: tracingRelayUrl(host.relayPort),
      identity: {repository, runId, attempt, job, trigger},
      ...(host.rootSpan === undefined
        ? {}
        : {rootSpan: {traceId: host.rootSpan.traceId, spanId: host.rootSpan.spanId}}),
      ...(host.sessionId === undefined ? {} : {sessionId: host.sessionId}),
      ...(host.invocationId === undefined ? {} : {invocationId: host.invocationId}),
    })
    // Measured on the serialized value: escapes make it longer than its fields, and the plugin refuses a document over its ceiling.
    if (value.length <= TRACING_LAUNCHER_MAX_CHARS) return value
  }
  return JSON.stringify({version: TRACING_LAUNCHER_VERSION, host: 'action', tracing: 'off'})
}
