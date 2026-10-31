import type {Logger} from '../shared/logger.js'
import type {ShellNoticeRead, ShellNoticeState, V2ShellStatus} from './shell-notice.js'
import type {SubagentNotice, SubagentNoticeRead} from './subagent-notice.js'

import {
  getBooleanProperty,
  getNumberProperty,
  getObjectProperty,
  getStringProperty,
  ownValue,
} from './payload-accessors.js'
import {classifyShellNotice, classifyShellNoticeItem, isShellStatus} from './shell-notice.js'
import {classifySubagentNotice, classifySubagentNoticeItem} from './subagent-notice.js'

/**
 * OpenCode V2 event mapper: turns parsed V2 event frames into one small, surface-neutral domain union that the Action
 * and gateway run loops consume. Pure mapping, no I/O. The transport (SSE parsing, reconnects) is the caller's.
 *
 * Wire shapes are local, minimal and read defensively with own-property accessors. They are derived from the V2 source
 * at `anomalyco/opencode@v2.2.0`, which is the contract this module is pinned to:
 * - frame envelope `{id, type, created, data, location?, metadata?, durable?}`: `packages/schema/src/event.ts`
 * - `session.*` events: `packages/schema/src/session-event.ts` (execution, text, reasoning, tool, retry, moved,
 *   synthetic), `session-inbox.ts` (inbox item shapes), `session-error.ts` (error)
 * - `permission.*`: `packages/schema/src/permission.ts`; `form.*`: `packages/schema/src/form.ts`
 * - `server.connected`: `packages/schema/src/server-event.ts`
 * - Code Mode progress `metadata.toolCalls[]`: `packages/core/src/codemode/tool.ts` (`ExecuteCall`)
 * The real frames in `event-v2.fixtures.ts` were captured from a v2.2.0 server (probes P1, P2, P5, P6, P11, P12).
 *
 * Attribution of Code Mode (`execute`) calls: `shell`, `read`, `edit`, `question` and `subagent` are direct tools, each
 * with its own tool-call id. An `execute` call is ONE tool-call id; the calls it makes inside are listed, with a status
 * each, in the `metadata.toolCalls[]` of its `session.tool.progress` and terminal events. They carry no id of their own,
 * so an inner call is identified by its position: `v2InnerCallKey(callId, index)`. A nested permission ask is a separate
 * `permission.asked` with its own request id and `source.id` equal to the `execute` call id. Replies are keyed by request
 * id, never by tool-call id.
 *
 * Events that need no consumer are ignored (mapped to `null`): `session.text.started`, `session.tool.input.delta` and
 * `.ended` (superseded by `session.tool.called`, which carries the parsed input), `session.step.started/streamed/ended`,
 * usage, rename, inbox delivered/cancelled, compaction, and the project, VCS, plugin and agent update families.
 *
 * Background `shell` jobs are not sessions and ride two streams: `shell.created` / `shell.exited` (ephemeral, keyed by
 * shell id, owner in `info.metadata.sessionID`) and the owner's completion notice (`shell-notice.ts`).
 */

/** Error fields a loop may classify on. The upstream `response.body` is deliberately not carried. */
export interface V2ErrorInfo {
  readonly type: string
  readonly message: string
  readonly status: number | null
  readonly retryAfterMs: number | null
}

export type V2InnerCallStatus = 'completed' | 'error' | 'running'

/** One call made inside an `execute` call, as listed in `metadata.toolCalls[]`. */
export interface V2InnerCall {
  /** Position in the list; stable for the life of the `execute` call. */
  readonly index: number
  /** `v2InnerCallKey(callId, index)`. */
  readonly key: string
  readonly tool: string
  readonly status: V2InnerCallStatus
  readonly input: Readonly<Record<string, unknown>> | null
}

export interface V2FormOption {
  readonly value: string
  readonly label: string
  readonly description: string | null
}

export interface V2FormField {
  readonly key: string
  readonly type: string
  readonly title: string | null
  readonly description: string | null
  readonly options: readonly V2FormOption[]
}

export type V2InterruptReason = 'inactivity' | 'shutdown' | 'superseded' | 'user'

export type V2DomainEvent =
  | {readonly kind: 'connected'}
  | {
      readonly kind: 'text_delta'
      readonly sessionId: string
      readonly messageId: string | null
      readonly ordinal: number
      readonly delta: string
    }
  | {
      readonly kind: 'text_ended'
      readonly sessionId: string
      readonly messageId: string | null
      readonly ordinal: number
      readonly text: string
    }
  /** Reasoning started, streamed or ended. Activity only: it carries no text, so it cannot reach a response. */
  | {readonly kind: 'reasoning_activity'; readonly sessionId: string; readonly messageId: string | null}
  | {
      readonly kind: 'tool_started'
      readonly sessionId: string
      readonly callId: string
      readonly messageId: string | null
      readonly name: string
    }
  | {
      readonly kind: 'tool_called'
      readonly sessionId: string
      readonly callId: string
      readonly messageId: string | null
      readonly input: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'tool_progress'
      readonly sessionId: string
      readonly callId: string
      readonly messageId: string | null
      /** Inner calls of an `execute` call, with their statuses. Empty for direct tools. */
      readonly calls: readonly V2InnerCall[]
      readonly metadata: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'tool_finished'
      readonly sessionId: string
      readonly callId: string
      readonly messageId: string | null
      readonly outcome: 'failed' | 'success'
      /** Text parts of the tool result joined with newlines, for artifact detection and titles. Empty on most failures. */
      readonly text: string
      readonly error: V2ErrorInfo | null
      readonly calls: readonly V2InnerCall[]
      readonly metadata: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'permission_asked'
      readonly requestId: string
      readonly sessionId: string
      readonly action: string
      readonly resources: readonly string[]
      /**
       * `save` as delivered on the ask: the patterns upstream would store if the operator replied `always`. Empty when
       * the ask carries none. The gateway never sends `always`; it keeps these as a run-local grant instead.
       */
      readonly save: readonly string[]
      /** The tool-call id that raised the ask. For a nested `execute` call this is the `execute` call id. */
      readonly sourceToolCallId: string | null
      readonly message: string | null
    }
  | {
      readonly kind: 'permission_replied'
      readonly sessionId: string
      readonly requestId: string
      readonly reply: string
    }
  | {
      readonly kind: 'form_asked'
      readonly formId: string
      readonly sessionId: string
      readonly title: string
      /** `metadata.kind` of the form. `question` is the model's `question` tool. `null` when absent. */
      readonly formKind: string | null
      readonly toolCallId: string | null
      readonly fields: readonly V2FormField[]
    }
  | {
      readonly kind: 'form_resolved'
      readonly formId: string
      readonly sessionId: string
      readonly outcome: 'cancelled' | 'replied'
      /** The answer of a replied form, keyed by field key. `null` for a cancelled form or an unreadable answer. */
      readonly answer: Readonly<Record<string, unknown>> | null
    }
  | {readonly kind: 'execution_started'; readonly sessionId: string}
  | {readonly kind: 'execution_succeeded'; readonly sessionId: string}
  | {readonly kind: 'execution_failed'; readonly sessionId: string; readonly error: V2ErrorInfo}
  | {readonly kind: 'execution_interrupted'; readonly sessionId: string; readonly reason: V2InterruptReason}
  | {readonly kind: 'step_failed'; readonly sessionId: string; readonly error: V2ErrorInfo}
  | {
      readonly kind: 'retry_scheduled'
      readonly sessionId: string
      readonly attempt: number
      readonly at: number
      readonly error: V2ErrorInfo
    }
  /** A session changed location. Informational on its own; `mapV2EventStream` upgrades an owned move to `fatal`. */
  | {readonly kind: 'session_moved'; readonly sessionId: string; readonly directory: string | null}
  /**
   * The parent session `sessionId` received a completion notice for a child. Read from event `metadata`, never text.
   * `inboxId` is the inbox item that carries it, when the notice arrived as an enqueued item: the item is queued, not
   * yet part of a model turn, until a matching `inbox_delivered`. `null` for a `session.synthetic` event, which is the
   * message already in the transcript.
   */
  | {
      readonly kind: 'subagent_notice'
      readonly sessionId: string
      readonly notice: SubagentNotice
      readonly inboxId: string | null
    }
  /**
   * A shell was created (`shell.created`, ephemeral). `ownerSessionId` is the session that started it, read from
   * `info.metadata.sessionID`: an opaque tag the creator sets, `null` for a shell nobody tagged (`POST /api/shell`).
   * `userCommand` is set for the shell of a user command (`POST /api/session/:id/shell`), which is awaited by the
   * request and never sends a job notice. The frame carries no pid.
   */
  | {
      readonly kind: 'shell_started'
      readonly shellId: string
      readonly ownerSessionId: string | null
      readonly userCommand: boolean
    }
  /** A shell process ended (`shell.exited`, ephemeral). It can arrive before or after the notice, and settles nothing. */
  | {
      readonly kind: 'shell_exited'
      readonly shellId: string
      readonly status: V2ShellStatus
      readonly exit: number | null
    }
  /**
   * The session `ownerSessionId` received the completion notice of a background shell job. Read from event `metadata`,
   * never text; `inboxId` as for `subagent_notice`. A user shell command's notice (no `jobID`) is not mapped.
   */
  | {
      readonly kind: 'shell_notice'
      readonly shellId: string
      readonly ownerSessionId: string
      readonly state: ShellNoticeState
      readonly inboxId: string | null
    }
  /** A queued inbox item of `sessionId` entered a model turn (`session.inbox.delivered`). */
  | {readonly kind: 'inbox_delivered'; readonly sessionId: string; readonly inboxId: string}
  /** The run must fail. Produced by `mapV2EventStream` for an owned session that moved. */
  | {
      readonly kind: 'fatal'
      readonly cause: 'session_moved'
      readonly sessionId: string
      readonly directory: string | null
    }
  /** A known event type whose payload could not be read. The consumer decides; safety-relevant ones must fail closed. */
  | {
      readonly kind: 'malformed'
      readonly eventType: string
      readonly sessionId: string | null
      readonly reason: string
      /** Set for a subagent notice that could not be read and still named its child; the loop fences that child. */
      readonly childSessionId?: string
      /** Set for a shell job notice that could not be read and still named its shell; the loop fences that shell. */
      readonly shellId?: string
    }

/** Stable identity of an inner call of an `execute` tool call. */
export function v2InnerCallKey(callId: string, index: number): string {
  return `${callId}#${index}`
}

/** Whether the run must fail on this event. */
export function isFatalV2Event(event: V2DomainEvent): boolean {
  return event.kind === 'fatal'
}

function malformed(eventType: string, data: unknown, reason: string): V2DomainEvent {
  return {kind: 'malformed', eventType, sessionId: getStringProperty(data, 'sessionID'), reason}
}

function readErrorInfo(value: unknown): V2ErrorInfo | null {
  const type = getStringProperty(value, 'type')
  const message = getStringProperty(value, 'message')
  if (type === null || message === null) return null
  return {
    type,
    message,
    status: getNumberProperty(value, 'status'),
    retryAfterMs: getNumberProperty(value, 'retryAfterMs'),
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {}
}

function readInnerCalls(callId: string, metadata: unknown): readonly V2InnerCall[] {
  const raw = ownValue(metadata, 'toolCalls')
  if (!Array.isArray(raw)) return []

  const calls: V2InnerCall[] = []
  for (const [index, entry] of raw.entries()) {
    const tool = getStringProperty(entry, 'tool')
    const status = getStringProperty(entry, 'status')
    if (tool === null || (status !== 'running' && status !== 'completed' && status !== 'error')) continue
    const input = getObjectProperty(entry, 'input')
    calls.push({index, key: v2InnerCallKey(callId, index), tool, status, input: isRecord(input) ? input : null})
  }
  return calls
}

function joinTextContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(part => (getStringProperty(part, 'type') === 'text' ? [getStringProperty(part, 'text') ?? ''] : []))
    .join('\n')
}

function readToolIds(data: unknown): {sessionId: string; callId: string; messageId: string | null} | null {
  const sessionId = getStringProperty(data, 'sessionID')
  const callId = getStringProperty(data, 'id')
  if (sessionId === null || callId === null) return null
  return {sessionId, callId, messageId: getStringProperty(data, 'assistantMessageID')}
}

function mapText(type: string, data: unknown): V2DomainEvent {
  const sessionId = getStringProperty(data, 'sessionID')
  const ordinal = getNumberProperty(data, 'ordinal')
  if (sessionId === null || ordinal === null) return malformed(type, data, 'missing sessionID or ordinal')
  const messageId = getStringProperty(data, 'assistantMessageID')

  if (type === 'session.text.delta') {
    const delta = getStringProperty(data, 'delta')
    return delta === null
      ? malformed(type, data, 'missing delta')
      : {kind: 'text_delta', sessionId, messageId, ordinal, delta}
  }
  const text = getStringProperty(data, 'text')
  return text === null
    ? malformed(type, data, 'missing text')
    : {kind: 'text_ended', sessionId, messageId, ordinal, text}
}

function mapToolEvent(type: string, data: unknown): V2DomainEvent {
  const ids = readToolIds(data)
  if (ids === null) return malformed(type, data, 'missing sessionID or tool call id')
  const {sessionId, callId, messageId} = ids

  switch (type) {
    case 'session.tool.input.started': {
      const name = getStringProperty(data, 'name')
      return name === null
        ? malformed(type, data, 'missing tool name')
        : {kind: 'tool_started', sessionId, callId, messageId, name}
    }
    case 'session.tool.called': {
      const input = getObjectProperty(data, 'input')
      return isRecord(input)
        ? {kind: 'tool_called', sessionId, callId, messageId, input}
        : malformed(type, data, 'missing input')
    }
    case 'session.tool.progress': {
      const metadata = getObjectProperty(data, 'metadata')
      return {
        kind: 'tool_progress',
        sessionId,
        callId,
        messageId,
        calls: readInnerCalls(callId, metadata),
        metadata: readRecord(metadata),
      }
    }
    case 'session.tool.success': {
      const metadata = getObjectProperty(data, 'metadata')
      return {
        kind: 'tool_finished',
        sessionId,
        callId,
        messageId,
        outcome: 'success',
        text: joinTextContent(getObjectProperty(data, 'content')),
        error: null,
        calls: readInnerCalls(callId, metadata),
        metadata: readRecord(metadata),
      }
    }
    default: {
      // session.tool.failed
      const error = readErrorInfo(getObjectProperty(data, 'error'))
      if (error === null) return malformed(type, data, 'missing error')
      const metadata = getObjectProperty(data, 'metadata')
      return {
        kind: 'tool_finished',
        sessionId,
        callId,
        messageId,
        outcome: 'failed',
        text: joinTextContent(getObjectProperty(data, 'content')),
        error,
        calls: readInnerCalls(callId, metadata),
        metadata: readRecord(metadata),
      }
    }
  }
}

function mapPermissionAsked(data: unknown): V2DomainEvent {
  const type = 'permission.asked'
  const requestId = getStringProperty(data, 'id')
  const sessionId = getStringProperty(data, 'sessionID')
  const action = getStringProperty(data, 'action')
  if (requestId === null || sessionId === null || action === null) {
    return malformed(type, data, 'missing request id, sessionID or action')
  }
  const rawResources = getObjectProperty(data, 'resources')
  const resources = Array.isArray(rawResources)
    ? rawResources.filter((resource): resource is string => typeof resource === 'string')
    : []
  const rawSave = getObjectProperty(data, 'save')
  const save = Array.isArray(rawSave) ? rawSave.filter((pattern): pattern is string => typeof pattern === 'string') : []
  return {
    kind: 'permission_asked',
    requestId,
    sessionId,
    action,
    resources,
    save,
    sourceToolCallId: getStringProperty(getObjectProperty(data, 'source'), 'id'),
    message: getStringProperty(data, 'message'),
  }
}

function readFormField(value: unknown): V2FormField | null {
  const key = getStringProperty(value, 'key')
  const type = getStringProperty(value, 'type')
  if (key === null || type === null) return null
  const rawOptions = getObjectProperty(value, 'options')
  const options: V2FormOption[] = []
  if (Array.isArray(rawOptions)) {
    for (const option of rawOptions) {
      const optionValue = getStringProperty(option, 'value')
      const label = getStringProperty(option, 'label')
      if (optionValue === null || label === null) continue
      options.push({value: optionValue, label, description: getStringProperty(option, 'description')})
    }
  }
  return {
    key,
    type,
    title: getStringProperty(value, 'title'),
    description: getStringProperty(value, 'description'),
    options,
  }
}

function mapFormCreated(data: unknown): V2DomainEvent {
  const type = 'form.created'
  const form = getObjectProperty(data, 'form')
  const formId = getStringProperty(form, 'id')
  const sessionId = getStringProperty(form, 'sessionID')
  const title = getStringProperty(form, 'title')
  const rawFields = getObjectProperty(form, 'fields')
  if (formId === null || sessionId === null || title === null || !Array.isArray(rawFields)) {
    return {
      kind: 'malformed',
      eventType: type,
      sessionId: getStringProperty(form, 'sessionID'),
      reason: 'unreadable form',
    }
  }
  const metadata = getObjectProperty(form, 'metadata')
  return {
    kind: 'form_asked',
    formId,
    sessionId,
    title,
    formKind: getStringProperty(metadata, 'kind'),
    toolCallId: getStringProperty(getObjectProperty(metadata, 'tool'), 'id'),
    fields: rawFields.flatMap(field => {
      const parsed = readFormField(field)
      return parsed === null ? [] : [parsed]
    }),
  }
}

function mapFormResolved(type: string, data: unknown): V2DomainEvent {
  const formId = getStringProperty(data, 'id')
  const sessionId = getStringProperty(data, 'sessionID')
  if (formId === null || sessionId === null) return malformed(type, data, 'missing form id or sessionID')
  const answer = getObjectProperty(data, 'answer')
  return {
    kind: 'form_resolved',
    formId,
    sessionId,
    outcome: type === 'form.replied' ? 'replied' : 'cancelled',
    answer: type === 'form.replied' && isRecord(answer) ? answer : null,
  }
}

function mapExecution(type: string, data: unknown): V2DomainEvent {
  const sessionId = getStringProperty(data, 'sessionID')
  if (sessionId === null) return malformed(type, data, 'missing sessionID')

  switch (type) {
    case 'session.execution.started':
      return {kind: 'execution_started', sessionId}
    case 'session.execution.succeeded':
      return {kind: 'execution_succeeded', sessionId}
    case 'session.execution.failed': {
      const error = readErrorInfo(getObjectProperty(data, 'error'))
      return error === null ? malformed(type, data, 'missing error') : {kind: 'execution_failed', sessionId, error}
    }
    default: {
      // session.execution.interrupted
      const reason = getStringProperty(data, 'reason')
      return reason === 'user' || reason === 'shutdown' || reason === 'superseded' || reason === 'inactivity'
        ? {kind: 'execution_interrupted', sessionId, reason}
        : malformed(type, data, 'unknown interrupt reason')
    }
  }
}

function mapSessionError(type: string, data: unknown): V2DomainEvent {
  const sessionId = getStringProperty(data, 'sessionID')
  const error = readErrorInfo(getObjectProperty(data, 'error'))
  if (sessionId === null || error === null) return malformed(type, data, 'missing sessionID or error')

  if (type === 'session.step.failed') return {kind: 'step_failed', sessionId, error}

  const attempt = getNumberProperty(data, 'attempt')
  const at = getNumberProperty(data, 'at')
  return attempt === null || at === null
    ? malformed(type, data, 'missing attempt or time')
    : {kind: 'retry_scheduled', sessionId, attempt, at, error}
}

function mapNotice(
  type: string,
  data: unknown,
  read: SubagentNoticeRead,
  inboxId: string | null,
): V2DomainEvent | null {
  const sessionId = getStringProperty(data, 'sessionID')
  if (read.kind === 'none') return null
  if (read.kind === 'notice') {
    return sessionId === null ? null : {kind: 'subagent_notice', sessionId, notice: read.notice, inboxId}
  }
  // A notice the server sent that this reader cannot take. Dropping it would leave its child unaccounted for.
  return {
    kind: 'malformed',
    eventType: type,
    sessionId,
    reason: 'unreadable subagent notice',
    ...(read.childSessionId === null ? {} : {childSessionId: read.childSessionId}),
  }
}

function mapShellNotice(
  type: string,
  data: unknown,
  read: ShellNoticeRead,
  inboxId: string | null,
): V2DomainEvent | null {
  const sessionId = getStringProperty(data, 'sessionID')
  if (read.kind === 'none') return null
  if (read.kind === 'notice') {
    return sessionId === null
      ? null
      : {
          kind: 'shell_notice',
          shellId: read.notice.shellId,
          ownerSessionId: sessionId,
          state: read.notice.state,
          inboxId,
        }
  }
  // A job notice the server sent that this reader cannot take. Dropping it would leave its shell unaccounted for.
  return {
    kind: 'malformed',
    eventType: type,
    sessionId,
    reason: 'unreadable shell notice',
    ...(read.shellId === null ? {} : {shellId: read.shellId}),
  }
}

function mapShellCreated(data: unknown): V2DomainEvent {
  const type = 'shell.created'
  const info = getObjectProperty(data, 'info')
  const metadata = getObjectProperty(info, 'metadata')
  const ownerSessionId = getStringProperty(metadata, 'sessionID')
  const shellId = getStringProperty(info, 'id')
  if (shellId === null || shellId.length === 0) {
    return {kind: 'malformed', eventType: type, sessionId: ownerSessionId, reason: 'unreadable shell'}
  }
  return {
    kind: 'shell_started',
    shellId,
    ownerSessionId,
    userCommand: getBooleanProperty(metadata, 'background') === true,
  }
}

function mapShellExited(data: unknown): V2DomainEvent {
  const type = 'shell.exited'
  const shellId = getStringProperty(data, 'id')
  const status = getStringProperty(data, 'status')
  if (shellId === null || !isShellStatus(status)) {
    return {kind: 'malformed', eventType: type, sessionId: null, reason: 'unreadable shell exit'}
  }
  return {kind: 'shell_exited', shellId, status, exit: getNumberProperty(data, 'exit')}
}

/**
 * Map one parsed V2 event frame (`{type, data, …}`) to a domain event. Returns `null` for frames no consumer needs
 * (see the module doc) and for anything that is not an event frame, such as a keepalive.
 *
 * Never throws. A known type whose payload cannot be read yields a `malformed` event naming the type and, when
 * readable, the session, so the caller can fail closed on the safety-relevant ones (asks, forms, moves).
 */
export function mapV2Event(frame: unknown): V2DomainEvent | null {
  const type = getStringProperty(frame, 'type')
  if (type === null) return null
  const data = getObjectProperty(frame, 'data')

  switch (type) {
    case 'server.connected':
      return {kind: 'connected'}

    case 'session.text.delta':
    case 'session.text.ended':
      return mapText(type, data)

    case 'session.reasoning.started':
    case 'session.reasoning.delta':
    case 'session.reasoning.ended': {
      const sessionId = getStringProperty(data, 'sessionID')
      return sessionId === null
        ? malformed(type, data, 'missing sessionID')
        : {kind: 'reasoning_activity', sessionId, messageId: getStringProperty(data, 'assistantMessageID')}
    }

    case 'session.tool.input.started':
    case 'session.tool.called':
    case 'session.tool.progress':
    case 'session.tool.success':
    case 'session.tool.failed':
      return mapToolEvent(type, data)

    case 'permission.asked':
      return mapPermissionAsked(data)

    case 'permission.replied': {
      const sessionId = getStringProperty(data, 'sessionID')
      const requestId = getStringProperty(data, 'requestID')
      const reply = getStringProperty(data, 'reply')
      return sessionId === null || requestId === null || reply === null
        ? malformed(type, data, 'missing sessionID, request id or reply')
        : {kind: 'permission_replied', sessionId, requestId, reply}
    }

    case 'form.created':
      return mapFormCreated(data)

    case 'form.replied':
    case 'form.cancelled':
      return mapFormResolved(type, data)

    case 'session.execution.started':
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      return mapExecution(type, data)

    case 'session.step.failed':
    case 'session.retry.scheduled':
      return mapSessionError(type, data)

    case 'session.moved': {
      const sessionId = getStringProperty(data, 'sessionID')
      return sessionId === null
        ? malformed(type, data, 'missing sessionID')
        : {
            kind: 'session_moved',
            sessionId,
            directory: getStringProperty(getObjectProperty(data, 'location'), 'directory'),
          }
    }

    case 'shell.created':
      return mapShellCreated(data)

    case 'shell.exited':
      return mapShellExited(data)

    case 'session.inbox.enqueued': {
      const item = getObjectProperty(data, 'item')
      const inboxId = getStringProperty(data, 'inboxID')
      const subagent = classifySubagentNoticeItem(item)
      return subagent.kind === 'none'
        ? mapShellNotice(type, data, classifyShellNoticeItem(item), inboxId)
        : mapNotice(type, data, subagent, inboxId)
    }

    case 'session.inbox.delivered': {
      const sessionId = getStringProperty(data, 'sessionID')
      const inboxId = getStringProperty(data, 'inboxID')
      return sessionId === null || inboxId === null ? null : {kind: 'inbox_delivered', sessionId, inboxId}
    }

    case 'session.synthetic': {
      const subagent = classifySubagentNotice(data)
      return subagent.kind === 'none'
        ? mapShellNotice(type, data, classifyShellNotice(data), null)
        : mapNotice(type, data, subagent, null)
    }

    default:
      return null
  }
}

export interface MapV2EventStreamOptions {
  readonly logger: Logger
  /** Whether this run owns the session (the root, or a tracked descendant). Decides whether a move is fatal. */
  readonly isOwnedSession: (sessionId: string) => boolean
}

/**
 * Map an async iterable of parsed V2 frames to domain events.
 *
 * - An owned session that moves becomes a `fatal` event: the session's "outside the checkout" rules re-base on the
 *   destination (probe P12), so the run can no longer be trusted to stay inside its sandbox. The caller must interrupt
 *   and fail.
 * - A `malformed` event is logged (type and reason only, never the payload) and still yielded.
 * - A source error propagates unchanged, so the consumer records the discontinuity as it does today.
 */
export async function* mapV2EventStream(
  frames: AsyncIterable<unknown>,
  options: MapV2EventStreamOptions,
): AsyncGenerator<V2DomainEvent> {
  const {logger, isOwnedSession} = options

  for await (const frame of frames) {
    const event = mapV2Event(frame)
    if (event === null) continue

    if (event.kind === 'malformed') {
      logger.warning('OpenCode V2 event could not be read', {eventType: event.eventType, reason: event.reason})
      yield event
      continue
    }

    if (event.kind === 'session_moved' && isOwnedSession(event.sessionId)) {
      logger.error('Owned session moved; failing the run', {sessionId: event.sessionId})
      yield {kind: 'fatal', cause: 'session_moved', sessionId: event.sessionId, directory: event.directory}
      continue
    }

    yield event
  }
}
