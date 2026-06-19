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
  /** Human-readable, redaction-safe summary for the Discord embed. */
  readonly title: string
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
}

// ---------------------------------------------------------------------------
// Defensive accessors (payloads are untrusted server JSON)
// ---------------------------------------------------------------------------

function getString(value: unknown, property: string): string | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

function getObject(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null
  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
}

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
  const filepath = getString(metadata, 'filepath')
  const command = getString(metadata, 'command')
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
  const requestID = getString(payload, 'id')
  const sessionID = getString(payload, 'sessionID')
  if (requestID == null || sessionID == null) return null
  const permission = getString(payload, 'permission') ?? 'unknown'
  const patterns = getStringArray(payload, 'patterns')
  const metadata = getObject(payload, 'metadata')
  return {
    requestID,
    sessionID,
    permission,
    patterns,
    title: deriveTitle(permission, patterns, metadata),
  }
}

/** Parse a `permission.replied` `properties` payload. Returns null if unusable. */
export function parsePermissionReply(payload: unknown): PermissionReplyEvent | null {
  const requestID = getString(payload, 'requestID')
  const sessionID = getString(payload, 'sessionID')
  const reply = asReply(getObject(payload, 'reply') ?? getString(payload, 'reply'))
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

/**
 * Create a permission coordinator. One instance per run; its local promise map
 * is scoped to that run. Deadline, cascade, and rendering are owned by the registry.
 */
export function createPermissionCoordinator(deps: PermissionCoordinatorDeps): PermissionCoordinator {
  const {logger, onPending, onReplied, onDispose, onSettled} = deps
  const localMap = new Map<string, Entry>()
  /** SessionIDs seen by this coordinator instance — used by onDispose. */
  const ownedSessionIDs = new Set<string>()

  function notifyPending(request: PermissionRequest): void {
    if (onPending === undefined) return
    try {
      onPending(request)
    } catch (error) {
      logger.error(
        {requestID: request.requestID, detail: error instanceof Error ? error.message : String(error)},
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
          {requestID: event.requestID, detail: error instanceof Error ? error.message : String(error)},
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
          {requestID: event.requestID, detail: error instanceof Error ? error.message : String(error)},
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
      logger.error(
        {detail: error instanceof Error ? error.message : String(error)},
        'approvals: onDispose callback threw (ignored)',
      )
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

  function onPermissionReplied(event: PermissionReplyEvent): void {
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

  return {onPermissionAsked, onPermissionReplied, pending, dispose}
}
