/**
 * Permission approval coordinator.
 *
 * Bridges OpenCode permission events to the Discord approval UI.
 * run-core registers a pending request on `permission.asked` and settles it on
 * `permission.replied` — the authoritative settlement signal, NOT the button
 * click alone.
 *
 * Verified against the installed SDK @ 1.14.41:
 * - `permission.asked`   → `properties.id` IS the requestID; carries
 *   `sessionID`, `permission` (gate category), `patterns`, optional `metadata`.
 * - `permission.replied` → `properties.requestID` + `properties.reply`
 *   (`"once" | "always" | "reject"`).
 * - A `"reject"` reply CASCADES server-side: all other pending permissions in
 *   the SAME session are rejected. The coordinator mirrors that cascade so the
 *   sibling embeds are settled too.
 *
 * Ownership boundary:
 * - Owns: the in-memory registry (keyed by `requestID`), the pending promises,
 *   per-entry deadline timers, and same-session cascade reconciliation.
 * - Does NOT own: Discord rendering, the HTTP reply POST, S3, the lock, or
 *   run-state. The caller wires the embed renderer (`onPending`/`onSettled`) and
 *   posts the reply; run.ts owns run-abort on deadline.
 *
 * A process restart abandons all entries — a controlled fail-closed (the
 * deadline / run teardown rejects pending tools), never a silent hang.
 */

import type {GatewayLogger} from '../discord/client.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reply verbs accepted by the OpenCode permission reply endpoint @ 1.14.41. */
export type PermissionReply = 'once' | 'always' | 'reject'

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

/** Why a pending entry settled — surfaced to `onSettled` for embed updates. */
export type SettlementReason = 'replied' | 'cascade' | 'deadline' | 'disposed'

/** Coordinator seam consumed by run-core and the run orchestrator. */
export interface PermissionCoordinator {
  /**
   * Register a pending request (called by run-core on `permission.asked`).
   * Returns a promise that resolves with the settled reply when
   * `permission.replied` arrives, the deadline fires, or the run is disposed.
   * NEVER rejects — resolves `"reject"` on the fail-closed paths.
   * Idempotent: a duplicate requestID returns the existing pending promise.
   */
  onPermissionAsked: (request: PermissionRequest) => Promise<PermissionReply>
  /**
   * Settle the matching entry (called by run-core on `permission.replied`).
   * On a `"reject"` reply, cascade-settles every other open entry in the same
   * session (the server already rejected them). No-op for unknown/settled IDs.
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
   * approval embed here. Must not throw — wrapped defensively.
   */
  readonly onPending?: (request: PermissionRequest) => void
  /**
   * Invoked when an entry settles (any reason). The caller updates/withdraws the
   * embed here. Must not throw — wrapped defensively.
   */
  readonly onSettled?: (requestID: string, reply: PermissionReply, reason: SettlementReason) => void
  /**
   * Optional per-request deadline (ms). On expiry the entry fail-closes to
   * `"reject"`. Must be a sub-deadline of the run wall-clock; run.ts owns the
   * actual run-abort. Omit to disable per-entry deadlines.
   */
  readonly deadlineMs?: number
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
// Coordinator
// ---------------------------------------------------------------------------

interface Entry {
  readonly request: PermissionRequest
  readonly resolve: (reply: PermissionReply) => void
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Create a permission coordinator. One instance per run; its registry is
 * scoped to that run (single-process gateway — no cross-replica concern).
 */
export function createPermissionCoordinator(deps: PermissionCoordinatorDeps): PermissionCoordinator {
  const {logger, onPending, onSettled, deadlineMs} = deps
  const registry = new Map<string, Entry>()

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

  function notifySettled(requestID: string, reply: PermissionReply, reason: SettlementReason): void {
    if (onSettled === undefined) return
    try {
      onSettled(requestID, reply, reason)
    } catch (error) {
      logger.error(
        {requestID, detail: error instanceof Error ? error.message : String(error)},
        'approvals: onSettled callback threw (ignored)',
      )
    }
  }

  /** Resolve an entry exactly once and run its settlement side effects. */
  function settle(entry: Entry, reply: PermissionReply, reason: SettlementReason): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
    }
    entry.resolve(reply)
    notifySettled(entry.request.requestID, reply, reason)
  }

  async function onPermissionAsked(request: PermissionRequest): Promise<PermissionReply> {
    const existing = registry.get(request.requestID)
    if (existing !== undefined && !existing.settled) {
      // Duplicate asked for an open request — idempotent: reuse the pending
      // promise rather than registering a second entry.
      logger.warn({requestID: request.requestID}, 'approvals: duplicate permission.asked for open request (ignored)')
      return new Promise<PermissionReply>(resolve => {
        const prior = existing.resolve
        // Chain onto the prior resolver so both awaiters settle together.
        Object.assign(existing, {
          resolve: (reply: PermissionReply) => {
            prior(reply)
            resolve(reply)
          },
        })
      })
    }

    return new Promise<PermissionReply>(resolve => {
      const entry: Entry = {request, resolve, settled: false, timer: null}
      if (deadlineMs !== undefined && deadlineMs > 0) {
        entry.timer = setTimeout(() => {
          logger.warn({requestID: request.requestID, deadlineMs}, 'approvals: request deadline expired — fail-closed')
          settle(entry, 'reject', 'deadline')
        }, deadlineMs)
        // Do not keep the event loop alive solely for an approval timer.
        entry.timer.unref?.()
      }
      registry.set(request.requestID, entry)
      logger.info(
        {requestID: request.requestID, sessionID: request.sessionID, permission: request.permission},
        'approvals: permission requested',
      )
      notifyPending(request)
    })
  }

  function onPermissionReplied(event: PermissionReplyEvent): void {
    const entry = registry.get(event.requestID)
    if (entry === undefined || entry.settled) {
      logger.debug(
        {requestID: event.requestID, reply: event.reply},
        'approvals: reply for unknown/settled request (no-op)',
      )
      return
    }
    settle(entry, event.reply, 'replied')

    if (event.reply === 'reject') {
      // Server cascade-rejects all other pending permissions in this session.
      for (const sibling of registry.values()) {
        if (!sibling.settled && sibling.request.sessionID === event.sessionID) {
          logger.info(
            {requestID: sibling.request.requestID, sessionID: event.sessionID},
            'approvals: cascade-rejecting sibling permission',
          )
          settle(sibling, 'reject', 'cascade')
        }
      }
    }
  }

  function pending(): readonly string[] {
    const open: string[] = []
    for (const [requestID, entry] of registry) {
      if (!entry.settled) open.push(requestID)
    }
    return open
  }

  function dispose(reason: string): void {
    const open = pending()
    if (open.length > 0) {
      logger.warn({reason, count: open.length}, 'approvals: disposing open permission requests — fail-closed')
    }
    for (const entry of registry.values()) {
      settle(entry, 'reject', 'disposed')
    }
  }

  return {onPermissionAsked, onPermissionReplied, pending, dispose}
}
