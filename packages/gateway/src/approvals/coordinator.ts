/**
 * Permission approval coordinator.
 *
 * Bridges OpenCode permission events to the Discord approval UI.
 * run-core registers a pending request on `permission.asked` and settles it on
 * `permission.replied` — the authoritative settlement signal.
 *
 * Verified against the installed SDK:
 * - `permission.asked`   → `properties.id` IS the requestID; carries
 *   `sessionID`, `permission` (gate category), `patterns`, optional `metadata`.
 * - `permission.replied` → `properties.requestID` + `properties.reply`
 *   (`"once" | "always" | "reject"`).
 *
 * ### Ownership (post-refactor)
 *
 * The coordinator is now a **thin forwarder** with a minimal local promise map.
 * ALL ownership of deadline timers, cascade, and settlement rendering has moved
 * to the registry (`ApprovalRegistry`).
 *
 * - `onPermissionAsked`: stores a resolver; calls `onPending`; NO deadline timer.
 * - `onPermissionReplied`: calls `onReplied` (wired to `registry.confirmReply`);
 *   resolves the local promise; NO cascade here.
 * - `dispose`: calls `onDispose` (wired to `registry.disposeRun`); resolves all
 *   local promises to `'reject'`.
 *
 * A process restart abandons all entries — a controlled fail-closed, never a
 * silent hang.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionReply} from '../operator-contract/approval.js'
import type {DecisionOutcome} from './registry.js'
import type {EchoWait, RunGrants} from './run-grants.js'

import {getObjectProperty, getStringProperty, toErrorMessage} from '@fro-bot/runtime'
import {startEchoWait} from './run-grants.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Re-export seam — `PermissionReply` is now solely defined in the operator
 * contract module. This re-export keeps the `coordinator.js` path valid for
 * all 9 existing import sites (launch-types.ts, registry.ts, discord-transport.ts,
 * discord/approvals.ts, and 5 test files including the `import * as coordinatorModule`
 * namespace import in run.test.ts) without a 9-file change.
 *
 * Consider migrating import sites to the contract directly in a future pass:
 *   `import type { PermissionReply } from '../operator-contract/approval.js'`
 */
export type {PermissionReply} from '../operator-contract/approval.js'

/** Parsed `permission.asked` payload — the request awaiting a decision. */
export interface PermissionRequest {
  /** `properties.id` — the requestID used as the reply path param and registry key. */
  readonly requestID: string
  /** Owning session — used for the reject cascade. */
  readonly sessionID: string
  /** Gate category, e.g. `external_directory`, `bash`. */
  readonly permission: string
  /** Patterns the gate matched, e.g. `["/tmp/x/*"]`. May be empty. */
  readonly patterns: readonly string[]
  /**
   * The patterns an `always` reply on this ask would have saved upstream: `save` on a V2 ask, `always` on a V1 one.
   * The gateway never sends `always` upstream; it keeps these as a run-local grant instead (see `run-grants.ts`).
   * Absent or empty when the ask carried none (`parsePermissionRequest` always sets it).
   */
  readonly alwaysPatterns?: readonly string[]
  /** Human-readable, redaction-safe summary for the Discord embed. */
  readonly title: string
  /**
   * Raw command string from `metadata.command` (e.g. for `bash` gates).
   * Present only when the engine supplied it. Kept raw here so the Discord
   * transport is unaffected; apply `boundApprovalDetail` at the SSE frame-build
   * site before serialising to the browser.
   */
  readonly command?: string
  /**
   * Raw filepath string from `metadata.filepath` (e.g. for `external_directory`
   * and `edit` gates). Present only when the engine supplied it. Same raw/bound
   * split as `command`.
   */
  readonly filepath?: string
}

/** Parsed `permission.replied` payload — the authoritative settlement. */
export interface PermissionReplyEvent {
  readonly sessionID: string
  readonly requestID: string
  readonly reply: PermissionReply
}

/** Why a pending entry settled — surfaced to render functions for embed updates. */
export type SettlementReason = 'replied' | 'cascade' | 'deadline' | 'disposed' | 'superseded'

/** Coordinator seam consumed by run-core and the run orchestrator. */
export interface PermissionCoordinator {
  /**
   * Register a pending request (called by run-core on `permission.asked`).
   * Returns a promise that resolves with the settled reply when
   * `permission.replied` arrives or the run is disposed.
   * NEVER rejects — resolves `"reject"` on the fail-closed paths.
   * Idempotent: a duplicate requestID returns the existing pending promise.
   */
  onPermissionAsked: (request: PermissionRequest) => Promise<PermissionReply>
  /**
   * Forward the authoritative reply (called by run-core on `permission.replied`).
   * Calls `onReplied` (wired to `registry.confirmReply`). No cascade here —
   * cascade is owned by the registry. No-op for unknown IDs.
   */
  onPermissionReplied: (event: PermissionReplyEvent) => void
  /** Open (unsettled) requestIDs — for SSE-drop reconciliation / debugging. */
  pending: () => readonly string[]
  /** Fail-close every open entry (called on run teardown). */
  dispose: (reason: string) => void
  /**
   * Register that this run owns the session identified by `sessionID` — the
   * root session, or a descendant session this run's ownership ledger has
   * adopted. Idempotent: adding an already-owned session is a no-op (backed
   * by a `Set`).
   *
   * Called by run-core for the root session immediately after session
   * creation. A later unit calls this for descendant sessions once the
   * ownership ledger adopts them; nothing does so yet.
   */
  addOwnedSession: (sessionID: string) => void
  /**
   * `true` when `sessionID` is a session this run owns — the root session,
   * or a descendant explicitly registered via `addOwnedSession` (or
   * implicitly recorded because it already asked a permission through this
   * coordinator). `false` for any other session, including one belonging to
   * a different run — the check callers use to keep a stranger's event out
   * of this run's event handling and Discord thread.
   */
  isOwned: (sessionID: string) => boolean
}

/** Dependencies injected at construction. */
export interface PermissionCoordinatorDeps {
  readonly logger: GatewayLogger
  /**
   * Invoked when a new request is registered. The caller renders the Discord
   * approval embed here AND registers the entry in the approval registry
   * (including deadlineMs — deadline ownership has moved to the registry).
   * Must not throw — wrapped defensively.
   */
  readonly onPending?: (request: PermissionRequest) => void
  /**
   * Invoked when `permission.replied` is received. The caller forwards this
   * to `registry.confirmReply`. Must not throw — wrapped defensively.
   * Replaces the old `onSettled` callback (settlement rendering is now in the
   * registry's `confirmReply` path).
   */
  readonly onReplied?: (event: PermissionReplyEvent) => void
  /**
   * Invoked when `dispose` is called (run teardown). The caller should call
   * `registry.disposeRun(sessionID, reason)` to fail-close registry entries.
   * Must not throw — wrapped defensively.
   */
  readonly onDispose?: (sessionIDs: readonly string[]) => void
  /**
   * @deprecated Use `onReplied` instead. Kept for backward compatibility with
   * existing call sites that pass `onSettled`. When present, called with
   * (requestID, reply, reason) on `permission.replied` (reason is always
   * 'replied' from the coordinator's perspective — cascade is in the registry).
   */
  readonly onSettled?: (requestID: string, reply: PermissionReply, reason: SettlementReason) => void
  /**
   * Run-local grants: lets an ask this run's earlier operator `always` already covers be answered `once` without
   * showing an approval. Absent: every ask goes to the operator, as before.
   */
  readonly runGrants?: {
    readonly grants: RunGrants
    /** Stamped on the auto-answer log line. */
    readonly runId: string
    /** Post the upstream reply for an ask: `once` for a covered ask, `reject` for one the run can no longer answer. */
    readonly answer: (request: PermissionRequest, decision: 'once' | 'reject') => Promise<{readonly ok: boolean}>
    /**
     * Settle an ask that is already open (registered with the approval UI) because a grant now covers it: wired to
     * the approval registry's claim gate, so an operator click racing it cannot cause a second upstream reply.
     */
    readonly settleCovered: (request: PermissionRequest) => Promise<DecisionOutcome>
  }
}

// ---------------------------------------------------------------------------
// Payloads are untrusted server JSON: read them through own-property accessors (`getStringProperty`,
// `getObjectProperty` from `@fro-bot/runtime`). The string-array reader below is local to this module.
// ---------------------------------------------------------------------------

function getStringArray(value: unknown, property: string): string[] {
  if (value == null || typeof value !== 'object') return []
  const raw: unknown = Object.getOwnPropertyDescriptor(value, property)?.value
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

/** A reply verb is only the strict allowlist — anything else is rejected input. */
function asReply(value: unknown): PermissionReply | null {
  return value === 'once' || value === 'always' || value === 'reject' ? value : null
}

// ---------------------------------------------------------------------------
// Parsers (raw `properties` payload → typed shape; null on malformed)
// ---------------------------------------------------------------------------

/**
 * Build a redaction-safe title from the gate category + metadata/patterns.
 * Never throws; falls back through metadata → first pattern → bare category.
 */
function deriveTitle(permission: string, patterns: readonly string[], metadata: unknown): string {
  const filepath = getStringProperty(metadata, 'filepath')
  const command = getStringProperty(metadata, 'command')
  const firstPattern = patterns[0] ?? null
  if (permission === 'external_directory') {
    return `Access outside workspace: ${filepath ?? firstPattern ?? '(unspecified path)'}`
  }
  if (permission === 'bash') {
    return `Run command: ${command ?? firstPattern ?? '(unspecified command)'}`
  }
  const detail = filepath ?? command ?? firstPattern
  return detail == null ? permission : `${permission}: ${detail}`
}

/** Parse a `permission.asked` `properties` payload. Returns null if unusable. */
export function parsePermissionRequest(payload: unknown): PermissionRequest | null {
  const requestID = getStringProperty(payload, 'id')
  const sessionID = getStringProperty(payload, 'sessionID')
  if (requestID == null || sessionID == null) return null
  const permission = getStringProperty(payload, 'permission') ?? 'unknown'
  const patterns = getStringArray(payload, 'patterns')
  const alwaysPatterns = getStringArray(payload, 'always')
  const metadata = getObjectProperty(payload, 'metadata')
  // Extract raw command/filepath via the prototype-safe accessor so prototype-
  // polluted metadata objects cannot inject values through the prototype chain.
  const rawCommand = getStringProperty(metadata, 'command')
  const rawFilepath = getStringProperty(metadata, 'filepath')
  return {
    requestID,
    sessionID,
    permission,
    patterns,
    alwaysPatterns,
    title: deriveTitle(permission, patterns, metadata),
    // Omit the optional fields entirely when absent (undefined is not emitted
    // in the object literal when the conditional spread is used).
    ...(rawCommand !== null && {command: rawCommand}),
    ...(rawFilepath !== null && {filepath: rawFilepath}),
  }
}

/** Parse a `permission.replied` `properties` payload. Returns null if unusable. */
export function parsePermissionReply(payload: unknown): PermissionReplyEvent | null {
  const requestID = getStringProperty(payload, 'requestID')
  const sessionID = getStringProperty(payload, 'sessionID')
  const reply = asReply(getObjectProperty(payload, 'reply') ?? getStringProperty(payload, 'reply'))
  if (requestID == null || sessionID == null || reply == null) return null
  return {requestID, sessionID, reply}
}

// ---------------------------------------------------------------------------
// Coordinator (thin forwarder)
// ---------------------------------------------------------------------------

/** Minimal local entry — just enough to satisfy the pending promise. */
interface Entry {
  readonly request: PermissionRequest
  resolve: (reply: PermissionReply) => void
}

export {AUTO_ANSWER_ECHO_WAIT_MS} from './run-grants.js'

/**
 * An auto-answer in flight. `echoed` is set when its `permission.replied` arrives, even before the reply call returns;
 * `wait` is the post-failure wait for the echo early (the echo arrived, or the run is disposed).
 */
interface AutoState {
  echoed: boolean
  wait: EchoWait | undefined
}

/**
 * Create a permission coordinator. One instance per run; its local promise map
 * is scoped to that run. Deadline, cascade, and rendering are owned by the registry.
 */
export function createPermissionCoordinator(deps: PermissionCoordinatorDeps): PermissionCoordinator {
  const {logger, onPending, onReplied, onDispose, onSettled} = deps
  const localMap = new Map<string, Entry>()
  /** SessionIDs seen by this coordinator instance — used by onDispose. */
  const ownedSessionIDs = new Set<string>()
  /** Asks being auto-answered from a run grant: the reply is in flight and no approval is shown for them. */
  const autoInFlight = new Map<string, AutoState>()
  /** Set when the run starts ending; from then on nothing is auto-answered. */
  let disposed = false
  if (deps.runGrants !== undefined) {
    const {runGrants} = deps
    runGrants.grants.onGranted(requestID => {
      settleCoveredOpenAsks(requestID, runGrants)
    })
  }

  function notifyPending(request: PermissionRequest): void {
    if (onPending === undefined) return
    try {
      onPending(request)
    } catch (error) {
      logger.error(
        {requestID: request.requestID, detail: toErrorMessage(error)},
        'approvals: onPending callback threw (ignored)',
      )
    }
  }

  function notifyReplied(event: PermissionReplyEvent): void {
    // Preferred path: onReplied (wired to registry.confirmReply)
    if (onReplied !== undefined) {
      try {
        onReplied(event)
      } catch (error) {
        logger.error(
          {requestID: event.requestID, detail: toErrorMessage(error)},
          'approvals: onReplied callback threw (ignored)',
        )
      }
    }
    // Legacy compat: onSettled (old API — reason is always 'replied' from coordinator's view)
    if (onSettled !== undefined) {
      try {
        onSettled(event.requestID, event.reply, 'replied')
      } catch (error) {
        logger.error(
          {requestID: event.requestID, detail: toErrorMessage(error)},
          'approvals: onSettled callback threw (ignored)',
        )
      }
    }
  }

  function notifyDispose(): void {
    if (onDispose === undefined) return
    try {
      onDispose([...ownedSessionIDs])
    } catch (error) {
      logger.error({detail: toErrorMessage(error)}, 'approvals: onDispose callback threw (ignored)')
    }
  }

  /** Open the operator path for an ask: register the local entry and hand it to the approval UI. */
  async function registerForOperator(request: PermissionRequest): Promise<PermissionReply> {
    return new Promise<PermissionReply>(resolve => {
      const entry: Entry = {request, resolve}
      localMap.set(request.requestID, entry)
      ownedSessionIDs.add(request.sessionID)
      logger.info(
        {requestID: request.requestID, sessionID: request.sessionID, permission: request.permission},
        'approvals: permission requested',
      )
      notifyPending(request)
    })
  }

  /**
   * Answer an ask the run's earlier operator `always` covers, with `once`. Exactly one reply per ask:
   * - the reply landed (or its `permission.replied` echo already arrived): done, no approval is shown;
   * - the reply failed and the run is still live: the operator decides, as for any ask;
   * - the reply failed and the run is ending: reject, because nothing will decide it any more.
   */
  async function autoAnswer(
    request: PermissionRequest,
    runGrants: NonNullable<PermissionCoordinatorDeps['runGrants']>,
  ): Promise<PermissionReply> {
    const state: AutoState = {echoed: false, wait: undefined}
    autoInFlight.set(request.requestID, state)
    let ok: boolean
    try {
      ok = (await runGrants.answer(request, 'once')).ok
    } catch {
      ok = false
    }
    if (!ok && !state.echoed && !disposed) {
      // Ambiguous: OpenCode may have accepted the once with only the response lost. Give the echo a bounded chance.
      state.wait = startEchoWait()
      await state.wait.outcome
      state.wait = undefined
    }
    autoInFlight.delete(request.requestID)
    if (ok || state.echoed) {
      logAutoAnswered(request, runGrants.runId)
      return 'once'
    }
    if (disposed) {
      await runGrants.answer(request, 'reject').catch(() => undefined)
      return 'reject'
    }
    logger.warn(
      {requestID: request.requestID, permission: request.permission},
      'approvals: run-grant auto-answer failed — asking the operator',
    )
    return registerForOperator(request)
  }

  /** The permission and run id only: the command, path and URL are never logged here. */
  function logAutoAnswered(request: PermissionRequest, runId: string): void {
    logger.info({runId, permission: request.permission, auto: 'run-grant'}, 'approvals: auto-answered')
  }

  /**
   * A grant just landed: settle every other open ask on an owned session that it now covers, through the approval
   * registry's claim gate. This is what upstream does for siblings when it stores an `always`.
   */
  function settleCoveredOpenAsks(
    grantedRequestID: string,
    runGrants: NonNullable<PermissionCoordinatorDeps['runGrants']>,
  ): void {
    // After dispose nothing runs here: dispose drops the grants (and with them the listener) and clears `localMap`.
    for (const entry of [...localMap.values()]) {
      const {request} = entry
      if (request.requestID === grantedRequestID) continue
      // Every entry in `localMap` was registered for an owned session, so covering is the only test left.
      if (!runGrants.grants.covers(request)) continue
      runGrants
        .settleCovered(request)
        .then(outcome => {
          if (outcome === 'ok') logAutoAnswered(request, runGrants.runId)
        })
        .catch((error: unknown) => {
          logger.warn(
            {requestID: request.requestID, detail: toErrorMessage(error)},
            'approvals: settling a covered ask threw (left open)',
          )
        })
    }
  }

  async function onPermissionAsked(request: PermissionRequest): Promise<PermissionReply> {
    const existing = localMap.get(request.requestID)
    if (existing !== undefined) {
      // Duplicate asked for an open request — idempotent: chain onto the existing promise.
      logger.warn({requestID: request.requestID}, 'approvals: duplicate permission.asked for open request (ignored)')
      return new Promise<PermissionReply>(resolve => {
        const prior = existing.resolve
        existing.resolve = (reply: PermissionReply) => {
          prior(reply)
          resolve(reply)
        }
      })
    }
    if (autoInFlight.has(request.requestID)) {
      // The auto-answer is already on its way: a second reply would be a double answer.
      logger.warn({requestID: request.requestID}, 'approvals: duplicate permission.asked for an auto-answer (ignored)')
      return 'once'
    }

    const {runGrants} = deps
    if (runGrants !== undefined) {
      runGrants.grants.noteAsked(request)
      // Auto-answer only for a session this run already owns (root or adopted descendant). Once teardown started the
      // grants are dropped (`dispose`), so nothing covers an ask: it follows the operator path and dispose rejects it.
      if (ownedSessionIDs.has(request.sessionID) && runGrants.grants.covers(request)) {
        return autoAnswer(request, runGrants)
      }
    }
    return registerForOperator(request)
  }

  function onPermissionReplied(event: PermissionReplyEvent): void {
    const auto = autoInFlight.get(event.requestID)
    if (auto !== undefined) {
      auto.echoed = true
      auto.wait?.end('echo')
    }
    // The echo can confirm an operator Always whose HTTP response was lost; a grant it records settles covered siblings.
    deps.runGrants?.grants.confirm(event.requestID, event.reply)
    const entry = localMap.get(event.requestID)
    if (entry === undefined) {
      logger.debug({requestID: event.requestID, reply: event.reply}, 'approvals: reply for unknown request (no-op)')
      return
    }
    // Resolve local promise and remove from map.
    localMap.delete(event.requestID)
    entry.resolve(event.reply)
    // Forward to registry (which owns rendering + cascade).
    notifyReplied(event)
  }

  function pending(): readonly string[] {
    return Array.from(localMap.keys())
  }

  function dispose(reason: string): void {
    // First: the run is over, so its grants go before anything below can run, and no ask is auto-answered again.
    disposed = true
    deps.runGrants?.grants.drop()
    // End any auto-answer waiting for its echo: it now takes the reject path.
    for (const auto of autoInFlight.values()) auto.wait?.end('cancelled')
    const open = Array.from(localMap.keys())
    if (open.length > 0) {
      logger.warn({reason, count: open.length}, 'approvals: disposing open permission requests — fail-closed')
    }
    // Resolve all local promises fail-closed.
    for (const entry of localMap.values()) {
      entry.resolve('reject')
    }
    localMap.clear()
    // Notify registry to dispose its entries.
    notifyDispose()
  }

  function addOwnedSession(sessionID: string): void {
    ownedSessionIDs.add(sessionID)
  }

  function isOwned(sessionID: string): boolean {
    return ownedSessionIDs.has(sessionID)
  }

  return {onPermissionAsked, onPermissionReplied, pending, dispose, addOwnedSession, isOwned}
}
