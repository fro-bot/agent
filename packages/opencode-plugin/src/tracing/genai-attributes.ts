/**
 * Span records to GenAI-convention attributes.
 *
 * Pinned to the OpenTelemetry GenAI semantic conventions at `open-telemetry/semantic-conventions-genai` commit
 * `76e0c19` (attribute registry `docs/registry/attributes/gen-ai.md`; JSON shapes `model/gen-ai/gen-ai-input-messages.json`,
 * `-output-messages.json`, `-system-instructions.json`, `-tool-definitions.json`, `-tool-call-arguments.json`,
 * `-tool-call-result.json`). The conventions are in Development: a revision bump is a deliberate change here.
 *
 * What follows from that revision:
 * - Span names: `chat {model}`, `invoke_agent {agent}`, `execute_tool {tool}`.
 * - `gen_ai.usage.input_tokens` includes cached tokens (`cache_read` and `cache_write` are included in it) and
 *   `gen_ai.usage.output_tokens` includes reasoning tokens. OpenCode reports them split, so they are summed here.
 * - Content (`gen_ai.input.messages`, `output.messages`, `system_instructions`, `tool.definitions`, `tool.call.arguments`,
 *   `tool.call.result`) is an AnyValue; the JavaScript SDK carries attributes as primitives, so each is a JSON string
 *   conforming to the schema, which Langfuse and Tempo both read.
 * - `gen_ai.response.finish_reasons` carries the provider's reason; for a failed generation the revision says to report
 *   `error` rather than omit, and `interrupted` for one that was cut short.
 *
 * An uncaptured field sets no attribute: it is named in `fro_bot.span.gaps` instead. Identity and markers outside the
 * convention use the `fro_bot.` prefix, so they never collide with OpenCode's own `opencode.*` attributes.
 */

import type {ActionIdentity, ActionRunContext} from './settings.js'
import type {ChatRecord, InvokeRecord, SpanRecord, ToolRecord} from './turn-model.js'

import {
  actionIdentityAttributes,
  CONTENT_MAX_CHARS,
  contentAttribute,
  extractInputMessages,
  extractOutputMessages,
  extractPromptMessage,
  extractSystemInstructions,
  extractToolArguments,
  extractToolDefinitions,
  extractToolResult,
  MARKER,
  scrubSpan,
  type ContentLimits,
  type PendingAttributeValue,
  type PendingSpan,
  type ScrubbedSpan,
  type Scrubber,
} from './content.js'
import {omittedReason} from './snapshot.js'

export const GENAI_SEMCONV_REVISION = 'open-telemetry/semantic-conventions-genai@76e0c19'

export interface AttributeOptions extends ActionRunContext {
  /** Set in Action mode: repository and run identity go on every span. Absent in local mode: none do. */
  readonly identity?: ActionIdentity | undefined
  /** The plugin's own version: Langfuse's `release`, on each trace's root span. Absent when it could not be read. */
  readonly release?: string | undefined
}

type Attributes = Record<string, PendingAttributeValue>

/** Set only when the value is defined: an uncaptured field sets no attribute. */
function set(attributes: Attributes, name: string, value: PendingAttributeValue | undefined): void {
  if (value !== undefined) attributes[name] = value
}

function identityAttributes(record: SpanRecord, options: AttributeOptions): Attributes {
  const attributes: Attributes = {
    'session.id': record.sessionId,
    'gen_ai.conversation.id': record.sessionId,
    'fro_bot.root_session.id': record.rootSessionId,
    // Langfuse's OTLP ingestion reads the session from `langfuse.session.id` first and from `session.id` only when that is absent
    // (`extractSessionId` in langfuse/langfuse `OtelIngestionProcessor.ts`; the keys are listed in that order, and the docs'
    // attribute-mapping table names both), and it groups its Sessions view by it. Every span of a tree carries the ROOT session's
    // id here, so a subagent shows under its parent's session; `session.id` stays each span's own session. It is set on every span,
    // not only the root: Langfuse filters and aggregates per observation. The turn model sets `rootSessionId` when a child's
    // dispatch link resolves (a child that finished before its link is replayed with it), and an unlinked session is its own root.
    // An Action run overrides it with the launcher's session id, which the Action computed (`<owner>/<repo>:<logical key>`) so the
    // run's own trace and every turn trace share one Langfuse session. It is used verbatim: never derived or altered here.
    'langfuse.session.id': options.sessionId ?? record.rootSessionId,
  }
  set(attributes, 'gen_ai.agent.name', record.agent)
  // Langfuse reads `release` from the span (then the resource) of each observation it ingests, and takes the trace's from the root.
  // `service.version` on the resource feeds its `version`, a different field, so the release is said here, on the span.
  if (record.parentSpanId === undefined) set(attributes, 'langfuse.release', options.release)
  if (options.identity !== undefined) {
    Object.assign(attributes, actionIdentityAttributes(options.identity, options.invocationId))
  }
  return attributes
}

function outcomeAttributes(record: SpanRecord): Attributes {
  const attributes: Attributes = {'fro_bot.outcome': record.status}
  if (record.marks.length > 0) attributes['fro_bot.span.marks'] = record.marks
  if (record.gaps.length > 0) attributes['fro_bot.span.gaps'] = record.gaps
  if (record.status === 'error' && record.error?.type !== undefined) attributes['error.type'] = record.error.type
  return attributes
}

function statusOf(record: SpanRecord): PendingSpan['status'] {
  if (record.status !== 'error') return {code: 'unset'}
  return {code: 'error', message: record.error?.message ?? record.error?.type ?? 'error'}
}

function eventsOf(record: SpanRecord): PendingSpan['events'] {
  if (record.status !== 'error' || record.error === undefined) return []
  const attributes: Record<string, string> = {'exception.type': record.error.type}
  if (record.error.message !== undefined) attributes['exception.message'] = record.error.message
  return [{name: 'exception', timeMs: record.end, attributes}]
}

/** OpenCode's split counts to the convention's totals. */
function usageAttributes(usage: ChatRecord['usage']): Attributes {
  if (usage === undefined) return {}
  const attributes: Attributes = {
    'gen_ai.usage.input_tokens': usage.input + usage.cacheRead + usage.cacheWrite,
    'gen_ai.usage.output_tokens': usage.output + usage.reasoning,
  }
  if (usage.cacheRead > 0) attributes['gen_ai.usage.cache_read.input_tokens'] = usage.cacheRead
  if (usage.cacheWrite > 0) attributes['gen_ai.usage.cache_write.input_tokens'] = usage.cacheWrite
  if (usage.reasoning > 0) attributes['gen_ai.usage.reasoning.output_tokens'] = usage.reasoning
  return attributes
}

function finishReasons(record: ChatRecord): readonly string[] | undefined {
  // A span whose step data was withheld (binding uncertain) has an unknown response, not an interrupted one.
  if (record.gaps.includes('step-binding-uncertain')) return undefined
  const reported = record.rawFinishReason ?? record.finishReason
  if (reported !== undefined) return [reported]
  if (record.status === 'error') return ['error']
  if (record.status === 'interrupted') return ['interrupted']
  return undefined
}

/**
 * The value of a snapshot field, or undefined when the snapshot could not take it: the omission is then recorded under the
 * attribute's name, and the span says so in its markers.
 */
function noting(value: unknown, attribute: string, omitted: string[]): unknown {
  const reason = omittedReason(value)
  if (reason === undefined) return value
  omitted.push(`${attribute}:${reason}`)
  return undefined
}

function chatSpan(record: ChatRecord, options: AttributeOptions): PendingSpan {
  const omitted: string[] = []
  const preDropped: Record<string, number> = {}
  const attributes: Attributes = {
    'gen_ai.operation.name': 'chat',
    ...identityAttributes(record, options),
    ...outcomeAttributes(record),
    'fro_bot.request.kind': record.requestKind,
    // The request content is what the hook saw when it fired. A later plugin's edits are not in it.
    'fro_bot.content.view': 'hook-time',
  }
  set(attributes, 'gen_ai.provider.name', record.provider)
  set(attributes, 'gen_ai.request.model', record.model)
  if (record.requestKind === 'primary') attributes['fro_bot.request.attempt'] = record.attempt
  // Retried below the hook where nothing observes it: one span stands for however many provider attempts there were.
  if (record.attemptCountUnknown) attributes['fro_bot.request.attempt_count_unknown'] = true
  set(attributes, 'gen_ai.response.finish_reasons', finishReasons(record))
  Object.assign(attributes, usageAttributes(record.usage))
  if (record.cost !== undefined) attributes['fro_bot.usage.cost_usd'] = record.cost
  if (record.followOnOf.length > 0) attributes['fro_bot.turn.follow_on_of'] = record.followOnOf

  // Content, in the order the span's budget is spent: the small values first, the long history last. The request is the
  // hook-time snapshot; a field it could not take is a sentinel, which becomes a marker on the span.
  const request = (record.request ?? {}) as {
    system?: unknown
    messages?: unknown
    tools?: unknown
    droppedMessages?: unknown
  }
  const system = extractSystemInstructions(noting(request.system, 'gen_ai.system_instructions', omitted))
  if (system !== undefined)
    attributes['gen_ai.system_instructions'] = contentAttribute(system, CONTENT_MAX_CHARS.systemInstructions)
  const definitions = extractToolDefinitions(noting(request.tools, 'gen_ai.tool.definitions', omitted))
  if (definitions !== undefined)
    attributes['gen_ai.tool.definitions'] = contentAttribute(definitions, CONTENT_MAX_CHARS.toolDefinitions)
  const output = extractOutputMessages({texts: record.texts, reasoning: record.reasoning, toolCalls: record.toolCalls})
  if (output !== undefined)
    attributes['gen_ai.output.messages'] = contentAttribute(output, CONTENT_MAX_CHARS.outputMessages)
  const input = extractInputMessages(noting(request.messages, 'gen_ai.input.messages', omitted))
  if (typeof request.droppedMessages === 'number' && request.droppedMessages > 0) {
    preDropped['gen_ai.input.messages'] = request.droppedMessages
  }
  if (input !== undefined) {
    if (input.omittedParts > 0) attributes['fro_bot.content.parts_omitted'] = input.omittedParts
    attributes['gen_ai.input.messages'] = contentAttribute(input.messages, CONTENT_MAX_CHARS.inputMessages, true)
  }

  return {
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    name: `chat ${record.model ?? record.requestKind}`,
    kind: 'client',
    startMs: record.start,
    endMs: record.end,
    attributes,
    status: statusOf(record),
    events: eventsOf(record),
    ...(omitted.length === 0 ? {} : {omitted}),
    ...(Object.keys(preDropped).length === 0 ? {} : {dropped: preDropped}),
  }
}

function toolSpan(record: ToolRecord, options: AttributeOptions): PendingSpan {
  const attributes: Attributes = {
    'gen_ai.operation.name': 'execute_tool',
    ...identityAttributes(record, options),
    ...outcomeAttributes(record),
    'gen_ai.tool.name': record.tool,
    'gen_ai.tool.call.id': record.callId,
    'gen_ai.tool.type': 'function',
    'fro_bot.tool.outcome': record.outcome,
  }
  set(attributes, 'fro_bot.tool.error_type', record.errorType)
  set(attributes, 'fro_bot.subagent.session_id', record.childSessionId)
  if (record.providerExecuted) attributes['fro_bot.tool.provider_executed'] = true

  const omitted: string[] = []
  const args = extractToolArguments(noting(record.input, 'gen_ai.tool.call.arguments', omitted))
  if (args !== undefined)
    attributes['gen_ai.tool.call.arguments'] = contentAttribute(args, CONTENT_MAX_CHARS.toolArguments)
  const result = extractToolResult(noting(record.result, 'gen_ai.tool.call.result', omitted))
  if (result !== undefined)
    attributes['gen_ai.tool.call.result'] = contentAttribute(result.value, CONTENT_MAX_CHARS.toolResult)
  // The tool cut its own output: said apart from this plugin's truncation (`fro_bot.content.truncated`).
  if (record.toolTruncated === true || result?.ownTruncation === true)
    attributes['fro_bot.tool.output_truncated'] = true

  return {
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    name: `execute_tool ${record.tool}`,
    kind: 'internal',
    startMs: record.start,
    endMs: record.end,
    attributes,
    status: statusOf(record),
    events: eventsOf(record),
    ...(omitted.length === 0 ? {} : {omitted}),
  }
}

/**
 * A turn's root span links to the Action run's root span: a link, not a parent, because the turn is a trace of its own (Langfuse
 * ignores links; Tempo follows them). Any other span of the turn is reached through its root. The link is its two ids and
 * nothing else, as the shared core's `SpanLink` is.
 */
function runLinks(record: InvokeRecord, options: AttributeOptions): Pick<PendingSpan, 'links'> {
  if (record.role !== 'root' || options.rootSpan === undefined) return {}
  return {links: [{traceId: options.rootSpan.traceId, spanId: options.rootSpan.spanId}]}
}

function invokeSpan(record: InvokeRecord, options: AttributeOptions): PendingSpan {
  const omitted: string[] = []
  const attributes: Attributes = {
    'gen_ai.operation.name': 'invoke_agent',
    ...identityAttributes(record, options),
    ...outcomeAttributes(record),
    'fro_bot.agent.role': record.role,
  }
  if (record.standalone !== undefined) attributes['fro_bot.turn.standalone'] = record.standalone
  set(attributes, 'fro_bot.turn.continuation_of', record.continuationOf)
  set(attributes, 'fro_bot.turn.report_delivered_in', record.reportDeliveredInTrace)
  if (record.prompts.length > 0) {
    attributes['fro_bot.prompt.count'] = record.prompts.length
    if (record.prompts.some(prompt => prompt.midTurn)) attributes['fro_bot.prompt.mid_turn'] = true
    const messages = record.prompts.flatMap(prompt => {
      const text = (prompt.content as {text?: unknown} | undefined)?.text
      const reason = omittedReason(text)
      if (reason !== undefined) omitted.push(`gen_ai.input.messages:${reason}`)
      const message = extractPromptMessage(prompt.content)
      return message === undefined ? [] : [message]
    })
    if (messages.length > 0)
      attributes['gen_ai.input.messages'] = contentAttribute(messages, CONTENT_MAX_CHARS.prompt, true)
  }

  return {
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    name: `invoke_agent ${record.agent ?? 'unknown'}`,
    kind: 'internal',
    startMs: record.start,
    endMs: record.end,
    attributes,
    status: statusOf(record),
    events: eventsOf(record),
    ...runLinks(record, options),
    ...(omitted.length === 0 ? {} : {omitted}),
  }
}

/** The span as it would be exported if nothing needed scrubbing. Not exportable: `toExportSpan` is. */
export function toPendingSpan(record: SpanRecord, options: AttributeOptions = {}): PendingSpan {
  switch (record.kind) {
    case 'chat':
      return chatSpan(record, options)
    case 'execute_tool':
      return toolSpan(record, options)
    case 'invoke_agent':
      return invokeSpan(record, options)
  }
}

const SESSION_ATTRIBUTE = 'langfuse.session.id'

/**
 * The trace's name in Langfuse, whose OTLP ingestion reads it from this attribute on the trace's root span (the span names
 * `invoke_agent <agent>` name observations, not the trace). One fixed string for every trace, so it holds no content.
 */
export const TRACE_NAME_ATTRIBUTE = 'langfuse.trace.name'
export const TRACE_NAME = 'fro-bot run'

/**
 * Names the trace on a span that is its root, and on nothing else. A span with no parent is the root: the turn model opens
 * every trace with a parentless `invoke_agent` (a continuation of a closed trace included) and gives every other span a parent.
 *
 * Added after the scrub, never through it: the string is fixed text, and a scrubber that rewrote it (a registered value that
 * happens to match a word of it) would split one name into several in Langfuse. A span that is not a root is returned as is.
 */
function withTraceName(span: ScrubbedSpan): ScrubbedSpan {
  if (span.parentSpanId !== undefined) return span
  return {...span, attributes: {...span.attributes, [TRACE_NAME_ATTRIBUTE]: TRACE_NAME}}
}

/**
 * Whether the span carries the launcher's session id exactly as given. Equal text is not enough: a value the scrubber withheld
 * is exported as the fixed marker `[omitted]`, so an id that is literally `[omitted]` would equal its own withheld form. The
 * omission status the scrub wrote (`<attribute>:<reason>`) is what says whether it was withheld.
 */
function sessionIdExportedAsGiven(span: ScrubbedSpan, sessionId: string): boolean {
  if (span.attributes[SESSION_ATTRIBUTE] !== sessionId) return false
  const omitted = span.attributes[MARKER.omitted]
  return !(
    Array.isArray(omitted) &&
    omitted.some((entry: unknown) => typeof entry === 'string' && entry.startsWith(`${SESSION_ATTRIBUTE}:`))
  )
}

/**
 * Record to an exportable span: attributes, then the one scrubbing pass.
 *
 * The launcher's session id is the one value exported as given or not at all. The exporter scrubs every string, and a redacted
 * session id (`acme/password-manager:[REDACTED]`) would merge conversations into one Langfuse session. So when the scrub changed
 * it, or withheld or cut it, the span is built again with OpenCode's root session in its place. Everything else on the span is
 * scrubbed as before.
 */
export function toExportSpan(
  record: SpanRecord,
  options: AttributeOptions,
  scrubber: Scrubber,
  limits?: ContentLimits,
): ScrubbedSpan {
  const span = scrubSpan(toPendingSpan(record, options), scrubber, limits)
  if (options.sessionId === undefined || sessionIdExportedAsGiven(span, options.sessionId)) return withTraceName(span)
  return withTraceName(scrubSpan(toPendingSpan(record, {...options, sessionId: undefined}), scrubber, limits))
}
