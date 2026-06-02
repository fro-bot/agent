/**
 * Program-scoped approval registry bridge (Unit 3b).
 *
 * Maps requestID → approval context across all in-flight runs so the Discord
 * button handler can: verify channel binding, claim exactly once
 * (single-winner), and POST the reply to OpenCode. All Discord/SDK side
 * effects are injected as closures — this module is pure and unit-testable.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionReply, PermissionRequest, SettlementReason} from './coordinator.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApprovalSideEffects {
  /** POST the decision to OpenCode's reply endpoint. Injected by run.ts. */
  postReply: (
    requestID: string,
    directory: string,
    decision: PermissionReply,
  ) => Promise<{readonly ok: boolean; readonly error?: string}>
  /** Edit the posted Discord approval message to a settled embed. Injected by run.ts. */
  renderSettled: (
    request: PermissionRequest,
    decision: PermissionReply,
    decidedBy: string | null,
    reason: SettlementReason,
  ) => Promise<void>
}

export interface RegisterParams {
  readonly requestID: string
  readonly sessionID: string
  /** Thread/channel id where the embed was posted — the binding. */
  readonly channelID: string
  /** Workspace dir for reply routing. */
  readonly directory: string
  readonly request: PermissionRequest
  readonly effects: ApprovalSideEffects
}

export type DecisionOutcome = 'ok' | 'not-found' | 'channel-mismatch' | 'already-claimed' | 'reply-failed'

export interface ApprovalRegistry {
  register: (params: RegisterParams) => void
  has: (requestID: string) => boolean
  pending: () => readonly string[]
  /** Button path: enforce channel binding, single-winner claim, POST reply. Does NOT edit the embed. */
  handleButtonDecision: (args: {
    readonly requestID: string
    readonly channelID: string
    readonly decision: PermissionReply
    readonly decidedBy: string
  }) => Promise<DecisionOutcome>
  /** Settlement application (called from coordinator.onSettled via run.ts). Idempotent. */
  applySettlement: (args: {
    readonly requestID: string
    readonly decision: PermissionReply
    readonly reason: SettlementReason
  }) => Promise<void>
  /** Fail-close every open entry (shutdown / run teardown). */
  disposeAll: (reason: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Internal entry shape
// ---------------------------------------------------------------------------

interface RegistryEntry {
  readonly request: PermissionRequest
  readonly sessionID: string
  readonly channelID: string
  readonly directory: string
  readonly effects: ApprovalSideEffects
  claimed: boolean
  decidedBy: string | null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApprovalRegistry(deps: {readonly logger: GatewayLogger}): ApprovalRegistry {
  const {logger} = deps
  const entries = new Map<string, RegistryEntry>()

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  function register(params: RegisterParams): void {
    const {requestID, sessionID, channelID, directory, request, effects} = params
    if (entries.has(requestID)) {
      logger.warn({requestID}, 'ApprovalRegistry: duplicate requestID — overwriting (re-ask)')
    }
    entries.set(requestID, {request, sessionID, channelID, directory, effects, claimed: false, decidedBy: null})
  }

  // -------------------------------------------------------------------------
  // has / pending
  // -------------------------------------------------------------------------

  function has(requestID: string): boolean {
    return entries.has(requestID)
  }

  function pending(): readonly string[] {
    return Array.from(entries.keys())
  }

  // -------------------------------------------------------------------------
  // handleButtonDecision
  // -------------------------------------------------------------------------

  async function handleButtonDecision(args: {
    readonly requestID: string
    readonly channelID: string
    readonly decision: PermissionReply
    readonly decidedBy: string
  }): Promise<DecisionOutcome> {
    const {requestID, channelID, decision, decidedBy} = args

    const entry = entries.get(requestID)
    if (entry === undefined) {
      return 'not-found'
    }

    if (entry.channelID !== channelID) {
      logger.warn(
        {requestID, expected: entry.channelID, received: channelID},
        'ApprovalRegistry: channel mismatch — ignoring button click',
      )
      return 'channel-mismatch'
    }

    if (entry.claimed) {
      return 'already-claimed'
    }

    // Claim the slot
    entry.claimed = true
    entry.decidedBy = decidedBy

    let result: {readonly ok: boolean; readonly error?: string}
    try {
      result = await entry.effects.postReply(requestID, entry.directory, decision)
    } catch (error) {
      logger.error({requestID, err: error}, 'ApprovalRegistry: postReply threw — resetting claim')
      entry.claimed = false
      entry.decidedBy = null
      return 'reply-failed'
    }

    if (!result.ok) {
      logger.error({requestID, error: result.error}, 'ApprovalRegistry: postReply returned ok:false — resetting claim')
      entry.claimed = false
      entry.decidedBy = null
      return 'reply-failed'
    }

    return 'ok'
  }

  // -------------------------------------------------------------------------
  // applySettlement
  // -------------------------------------------------------------------------

  async function applySettlement(args: {
    readonly requestID: string
    readonly decision: PermissionReply
    readonly reason: SettlementReason
  }): Promise<void> {
    const {requestID, decision, reason} = args

    const entry = entries.get(requestID)
    if (entry === undefined) {
      // Already settled/unregistered — idempotent no-op
      return
    }

    // For non-replied reasons on unclaimed entries: best-effort postReply
    if (reason !== 'replied' && !entry.claimed) {
      entry.claimed = true
      try {
        const r = await entry.effects.postReply(requestID, entry.directory, decision)
        if (!r.ok) {
          logger.warn(
            {requestID, reason, error: r.error},
            'ApprovalRegistry: best-effort postReply on settlement returned ok:false — continuing',
          )
        }
      } catch (error) {
        logger.warn(
          {requestID, reason, err: error},
          'ApprovalRegistry: best-effort postReply on settlement threw — continuing',
        )
      }
    }

    // Render the settled embed — defensive wrap; Discord edit failure must not propagate
    try {
      await entry.effects.renderSettled(entry.request, decision, entry.decidedBy, reason)
    } catch (error) {
      logger.error(
        {requestID, reason, err: error},
        'ApprovalRegistry: renderSettled threw during settlement — continuing',
      )
    }

    // Unregister
    entries.delete(requestID)
  }

  // -------------------------------------------------------------------------
  // disposeAll
  // -------------------------------------------------------------------------

  async function disposeAll(_reason: string): Promise<void> {
    // Snapshot keys before iteration so deletion during iteration is safe
    const snapshot = Array.from(entries.keys())
    await Promise.all(
      snapshot.map(async requestID => {
        try {
          await applySettlement({requestID, decision: 'reject', reason: 'disposed'})
        } catch (error) {
          logger.error({requestID, err: error}, 'ApprovalRegistry: disposeAll — applySettlement threw — continuing')
        }
      }),
    )
  }

  return {register, has, pending, handleButtonDecision, applySettlement, disposeAll}
}
