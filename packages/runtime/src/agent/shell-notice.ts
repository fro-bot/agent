import type {V2DomainEvent} from './event-v2.js'
import type {OwnershipLedger} from './ownership-ledger.js'

import {shellLedgerKey} from './ownership-ledger.js'
import {getObjectProperty, getStringProperty, ownValue} from './payload-accessors.js'

/**
 * Background `shell` job notices for OpenCode V2 (v2.2.0): the sibling of `subagent-notice.ts`.
 *
 * A background shell is a server job whose id is the shell id (`sh_…`). It is not a session, so `session.active` never
 * lists it, and a session interrupt does not stop it (`Job.cancel(sessionID)` finds no job under a session id). When it
 * ends, the tool enqueues a synthetic message on the CALLING session and wakes it, exactly as a subagent does
 * (`packages/core/src/tool/plugin/shell.ts` `notifyWhenDone`, `shell/result.ts` `notification`). Its structured
 * `metadata` is `{source: "shell", shellID, jobID, state, …}` and the model-visible text embeds command output, so this
 * reader NEVER parses text. Captured on stock v2.2.0 in the bgshell probes p20 and p22.
 *
 * A notice with `source: "shell"` and NO `jobID` is the notice of a user-initiated shell command
 * (`POST /api/session/:id/shell`, `userNotification`). That is not a job and is delivered with `resume: false`; it is
 * not a notice here.
 */

/** `Job.status` minus `running`, which is never delivered as a notice. A DELETEd shell ends as `error`. */
export type ShellNoticeState = 'cancelled' | 'completed' | 'error'

export interface ShellNotice {
  /** The shell (and job) that ended. */
  readonly shellId: string
  readonly state: ShellNoticeState
}

/** `Shell.Status` (`packages/schema/src/shell.ts`). */
export type V2ShellStatus = 'exited' | 'killed' | 'running' | 'timeout'

export function isShellStatus(value: string | null): value is V2ShellStatus {
  return value === 'running' || value === 'exited' || value === 'timeout' || value === 'killed'
}

function isNoticeState(value: string | null): value is ShellNoticeState {
  return value === 'completed' || value === 'error' || value === 'cancelled'
}

/** How a synthetic message or inbox item reads as a shell job notice. */
export type ShellNoticeRead =
  | {readonly kind: 'none'}
  | {readonly kind: 'notice'; readonly notice: ShellNotice}
  /**
   * The server marked it as a job notice (`source: "shell"` with a `jobID`), but this reader cannot take it: an unknown
   * state or a changed shape. The shell it names, when readable, is no longer known to be running or ended.
   */
  | {readonly kind: 'unreadable'; readonly shellId: string | null}

function nonEmpty(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value
}

/**
 * Read a shell job notice from any object that carries the server's `metadata`: a `session.synthetic` event's `data`,
 * or a synthetic inbox item's `payload`. A `type` property, when present, must be `synthetic`.
 */
export function classifyShellNotice(value: unknown): ShellNoticeRead {
  const type = getStringProperty(value, 'type')
  if (type !== null && type !== 'synthetic') return {kind: 'none'}
  const metadata = getObjectProperty(value, 'metadata')
  if (getStringProperty(metadata, 'source') !== 'shell') return {kind: 'none'}
  // No `jobID` key: the notice of a user shell command, which is not a job.
  if (ownValue(metadata, 'jobID') === undefined) return {kind: 'none'}

  const jobId = nonEmpty(getStringProperty(metadata, 'jobID'))
  const shellId = nonEmpty(getStringProperty(metadata, 'shellID'))
  const state = getStringProperty(metadata, 'state')
  // The job id IS the shell id. A notice that disagrees with itself is not taken at its word.
  if (jobId !== null && (shellId === null || shellId === jobId) && isNoticeState(state)) {
    return {kind: 'notice', notice: {shellId: jobId, state}}
  }
  return {kind: 'unreadable', shellId: jobId ?? shellId}
}

/** Like `classifyShellNotice` for a `session.inbox.enqueued` item. Only `synthetic` items are considered. */
export function classifyShellNoticeItem(item: unknown): ShellNoticeRead {
  if (getStringProperty(item, 'type') !== 'synthetic') return {kind: 'none'}
  return classifyShellNotice(getObjectProperty(item, 'payload'))
}

export interface ShellNoticeSettlement {
  readonly shellId: string
  readonly state: ShellNoticeState
  /** `false` when the ledger never tracked the shell; nothing was changed. */
  readonly tracked: boolean
}

/**
 * Apply a notice to the ownership ledger. Every terminal state settles the entry: the notice is the server's own
 * statement that the job ended. A shell the ledger never adopted is NOT adopted here: a notice proves a shell ended, not
 * that this run owns it. The entry is looked up in the shell key space, so a notice can never settle a session.
 */
export function settleLedgerFromShellNotice(ledger: OwnershipLedger, notice: ShellNotice): ShellNoticeSettlement {
  const key = shellLedgerKey(notice.shellId)
  const tracked = ledger.isTracked(key)
  if (tracked) ledger.settle(key)
  return {shellId: notice.shellId, state: notice.state, tracked}
}

/** The `shellID` a `shell` tool call's progress or terminal `metadata` carries, or `null`. */
export function readToolShellId(metadata: unknown): string | null {
  return nonEmpty(getStringProperty(metadata, 'shellID'))
}

export interface BackgroundShellDispatch {
  readonly shellId: string
}

/**
 * Whether a `shell` tool event is the result of a backgrounded call. Only a successful terminal event with
 * `metadata.status === "running"` and a `shellID` proves it: a call that was backgrounded at launch, or moved there
 * later by `POST /api/session/:id/background`, returns `backgroundResult` as its tool result
 * (`packages/core/src/tool/plugin/shell.ts`); a foreground call that finishes returns `status: "completed"`. The progress
 * event carries a `shellID` for both, so it proves nothing.
 *
 * The caller supplies the tool name (correlated from `session.tool.input.started`); the success event does not carry it.
 */
export function readBackgroundShellDispatch(toolName: string, event: V2DomainEvent): BackgroundShellDispatch | null {
  if (toolName !== 'shell') return null
  if (event.kind !== 'tool_finished' || event.outcome !== 'success') return null
  if (getStringProperty(event.metadata, 'status') !== 'running') return null

  const shellId = readToolShellId(event.metadata)
  return shellId === null ? null : {shellId}
}
