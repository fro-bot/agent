import type {V2DomainEvent} from './event-v2.js'
import type {OwnershipLedger} from './ownership-ledger.js'

import {getObjectProperty, getStringProperty} from './payload-accessors.js'

/**
 * Subagent completion notices for OpenCode V2 (v2.2.0).
 *
 * When a background subagent finishes, the server enqueues a synthetic message on the PARENT session. Its text is
 * `<subagent sessionID="…" state="…" description="…">…</subagent>`, and its structured `metadata` is
 * `{source: "subagent", childID, agent, state}` (`packages/core/src/session/subagent-completion.ts:37-44`; captured
 * in probe P2). The model-visible text embeds child output, so it can be forged by any content a child produced.
 * This reader therefore NEVER parses text: only the `metadata` object settles anything.
 *
 * This is the V2 sibling of `task-notice.ts`. The V1 reader stays in place until the V1 code is deleted.
 */

/** `Job.status` minus `running`, which is never delivered as a notice (`packages/core/src/job.ts:27`). */
export type SubagentNoticeState = 'cancelled' | 'completed' | 'error'

export interface SubagentNotice {
  /** The child session that finished. */
  readonly childSessionId: string
  readonly state: SubagentNoticeState
  /** Display name of the child's agent (`General`, not the id `general`). `null` when metadata omits it. */
  readonly agent: string | null
  readonly description: string | null
}

function isNoticeState(value: string | null): value is SubagentNoticeState {
  return value === 'completed' || value === 'error' || value === 'cancelled'
}

/**
 * Read a notice from any object that carries the server's `metadata`: a persisted synthetic message, a
 * `session.synthetic` event's `data`, or a synthetic inbox item's `payload`.
 *
 * A `type` property, when present, must be `synthetic`. Returns `null` for anything that is not a well-formed
 * subagent notice, including `state: "running"` (never delivered) and any unknown state.
 */
export function readSubagentNotice(value: unknown): SubagentNotice | null {
  const type = getStringProperty(value, 'type')
  if (type !== null && type !== 'synthetic') return null

  const metadata = getObjectProperty(value, 'metadata')
  if (getStringProperty(metadata, 'source') !== 'subagent') return null

  const childSessionId = getStringProperty(metadata, 'childID')
  if (childSessionId === null || childSessionId.length === 0) return null

  const state = getStringProperty(metadata, 'state')
  if (!isNoticeState(state)) return null

  return {
    childSessionId,
    state,
    agent: getStringProperty(metadata, 'agent'),
    description: getStringProperty(value, 'description') ?? getStringProperty(metadata, 'description'),
  }
}

/**
 * Read a notice from a `session.inbox.enqueued` item. Only `synthetic` items are considered: a user prompt's
 * `payload.metadata` is client-supplied and must never be trusted as a subagent notice.
 */
export function readSubagentNoticeItem(item: unknown): SubagentNotice | null {
  if (getStringProperty(item, 'type') !== 'synthetic') return null
  return readSubagentNotice(getObjectProperty(item, 'payload'))
}

/** How a synthetic message or inbox item reads as a subagent notice. */
export type SubagentNoticeRead =
  | {readonly kind: 'none'}
  | {readonly kind: 'notice'; readonly notice: SubagentNotice}
  /**
   * The server marked it as a subagent notice (`metadata.source === 'subagent'`), but this reader cannot take it: an
   * unknown state or a changed shape. The child it names, when readable, is no longer known to be running or ended.
   */
  | {readonly kind: 'unreadable'; readonly childSessionId: string | null}

/** Like `readSubagentNotice`, but tells a message that is not a notice from a notice that cannot be read. */
export function classifySubagentNotice(value: unknown): SubagentNoticeRead {
  const notice = readSubagentNotice(value)
  if (notice !== null) return {kind: 'notice', notice}

  const type = getStringProperty(value, 'type')
  if (type !== null && type !== 'synthetic') return {kind: 'none'}
  const metadata = getObjectProperty(value, 'metadata')
  if (getStringProperty(metadata, 'source') !== 'subagent') return {kind: 'none'}

  const childSessionId = getStringProperty(metadata, 'childID')
  return {
    kind: 'unreadable',
    childSessionId: childSessionId === null || childSessionId.length === 0 ? null : childSessionId,
  }
}

/** Like `readSubagentNoticeItem`, with the same distinction. Only `synthetic` items are considered. */
export function classifySubagentNoticeItem(item: unknown): SubagentNoticeRead {
  if (getStringProperty(item, 'type') !== 'synthetic') return {kind: 'none'}
  return classifySubagentNotice(getObjectProperty(item, 'payload'))
}

export interface SubagentNoticeSettlement {
  readonly childSessionId: string
  readonly state: SubagentNoticeState
  /** `false` when the ledger never tracked the child; nothing was changed. */
  readonly tracked: boolean
}

/**
 * Apply a notice to the ownership ledger. Every terminal state (`completed`, `error`, `cancelled`) settles the entry:
 * the notice is the server's own statement that the child's execution ended. The ledger has no cancelled state, so the
 * caller reads `state` from the result to report a cancelled child as cancelled.
 *
 * A child the ledger never adopted is NOT adopted here: a notice proves a child ended, not that this run owns it.
 */
export function settleLedgerFromSubagentNotice(
  ledger: OwnershipLedger,
  notice: SubagentNotice,
): SubagentNoticeSettlement {
  const tracked = ledger.isTracked(notice.childSessionId)
  if (tracked) ledger.settle(notice.childSessionId)
  return {childSessionId: notice.childSessionId, state: notice.state, tracked}
}

export interface BackgroundDispatch {
  readonly childSessionId: string
}

/**
 * Whether a `subagent` tool event is the result of a background dispatch.
 *
 * `packages/core/src/tool/plugin/subagent.ts` emits `context.progress({sessionID, status: "running"})` at `:201` for
 * foreground AND background calls, before it branches on `background` (`:229`). A failed call also keeps that progress
 * snapshot as its `metadata` (`packages/core/src/session/runner/publish-llm-event.ts:109-112`). So running metadata
 * alone proves nothing. Only a successful terminal event does: a backgrounded call returns `backgroundResult`
 * (`status: "running"`, `:19-21,231,243`) as its tool result, and a foreground call that finishes returns
 * `status: "completed"` (`:254`; probe P6 capture).
 *
 * The caller supplies the tool name (correlated from `session.tool.input.started`); the success event does not carry it.
 */
export function readBackgroundDispatch(toolName: string, event: V2DomainEvent): BackgroundDispatch | null {
  if (toolName !== 'subagent') return null
  if (event.kind !== 'tool_finished' || event.outcome !== 'success') return null
  if (getStringProperty(event.metadata, 'status') !== 'running') return null

  const childSessionId = getStringProperty(event.metadata, 'sessionID')
  if (childSessionId === null || childSessionId.length === 0) return null
  return {childSessionId}
}
