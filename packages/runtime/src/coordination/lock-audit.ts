import type {ConfirmExpiredHolder, CoordinationConfig, LockLogger, LockRecord, RepoQuiescence} from './types.js'

import {getRunKey, parseRunState} from './run-state.js'

/** Deadline for the corroboration callback; slower or hung callbacks block the takeover. */
export const CONFIRMATION_DEADLINE_MS = 5_000
/** Deadline for the diagnostic RunState read; it never authorizes or blocks a takeover. */
export const EVIDENCE_DEADLINE_MS = 2_000
/** Max session ids written to an audit event. */
export const MAX_AUDIT_SESSION_IDS = 32

export type TakeoverOperation = 'acquire' | 'operator-release'

export type TakeoverDecision =
  'pending' | 'taken-over' | 'blocked-busy' | 'blocked-unknown' | 'cas-conflict' | 'lock-vanished' | 'store-error'

/** Last-seen state of the old holder's RunState. Diagnostic only: neither authorizes nor prevents takeover. */
export type HolderRunEvidence =
  | {
      readonly kind: 'known'
      readonly phase: string
      readonly lastHeartbeat: string
      readonly quarantined: boolean | null
      readonly quarantineReason: string | null
      readonly quarantineHoldUntil: string | null
      /** Ownership as persisted by the old run — a claim, not verified state. */
      readonly persistedRootSessionId: string | null
      readonly persistedOwnedSessionCount: number | null
    }
  | {readonly kind: 'unknown'; readonly reason: string}

export type ConfirmationSource = RepoQuiescence['source'] | 'holder-surface-reclaimable' | 'no-corroborator'

export interface TakeoverAuditContext {
  readonly operation: TakeoverOperation
  readonly correlationId: string
  readonly repo: string
  readonly holder: LockRecord
  readonly evidence: HolderRunEvidence
  readonly now: Date
  readonly replacement: {readonly holderId: string; readonly runId: string; readonly surface: string} | null
}

function unknownQuiescence(reason: string): RepoQuiescence {
  return {kind: 'unknown', source: 'unavailable', directory: null, reason}
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Validates the callback's return value; anything malformed is `unknown`, never `clear`. */
function normalizeQuiescence(value: unknown): RepoQuiescence {
  if (typeof value !== 'object' || value == null) return unknownQuiescence('confirmation-malformed')
  const candidate = value as Record<string, unknown>
  const sourceOk = candidate.source === 'opencode-session-status'

  if (candidate.kind === 'clear' && sourceOk && isString(candidate.directory) && isString(candidate.checkedAt)) {
    return {
      kind: 'clear',
      source: 'opencode-session-status',
      directory: candidate.directory,
      checkedAt: candidate.checkedAt,
    }
  }
  if (
    candidate.kind === 'busy' &&
    sourceOk &&
    isString(candidate.directory) &&
    isString(candidate.checkedAt) &&
    Array.isArray(candidate.sessionIds) &&
    candidate.sessionIds.every(isString)
  ) {
    return {
      kind: 'busy',
      source: 'opencode-session-status',
      directory: candidate.directory,
      checkedAt: candidate.checkedAt,
      sessionIds: candidate.sessionIds,
    }
  }
  if (
    candidate.kind === 'unknown' &&
    (candidate.source === 'opencode-session-status' || candidate.source === 'unavailable') &&
    (candidate.directory === null || isString(candidate.directory)) &&
    isString(candidate.reason)
  ) {
    return {kind: 'unknown', source: candidate.source, directory: candidate.directory, reason: candidate.reason}
  }
  return unknownQuiescence('confirmation-malformed')
}

/**
 * Runs the corroboration callback under a hard deadline. The deadline is enforced by racing, so a callback
 * that ignores the abort signal cannot stall the caller; its late result is dropped. Never rejects.
 */
export async function confirmWithDeadline(
  confirm: ConfirmExpiredHolder,
  repo: string,
  holder: LockRecord,
  deadlineMs: number = CONFIRMATION_DEADLINE_MS,
): Promise<RepoQuiescence> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<RepoQuiescence>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(unknownQuiescence('confirmation-timeout'))
    }, deadlineMs)
  })

  const call = (async () => confirm({repo, holder, signal: controller.signal}))().then(
    normalizeQuiescence,
    (): RepoQuiescence => unknownQuiescence('confirmation-failed'),
  )

  try {
    return await Promise.race([call, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function readString(details: Record<string, unknown>, key: string): string | null {
  const value = details[key]
  return typeof value === 'string' ? value : null
}

/** Best-effort, bounded read of the old holder's RunState. Action holders never write one. */
export async function collectHolderEvidence(
  config: CoordinationConfig,
  repo: string,
  holder: LockRecord,
  deadlineMs: number = EVIDENCE_DEADLINE_MS,
): Promise<HolderRunEvidence> {
  if (holder.surface === 'github') return {kind: 'unknown', reason: 'not-written-by-action'}

  const getObject = config.storeAdapter.getObject
  if (getObject == null) return {kind: 'unknown', reason: 'adapter-lacks-getObject'}

  const key = getRunKey(config, holder.holder_id, repo, holder.run_id)
  if (key.success === false) return {kind: 'unknown', reason: 'run-state-key-invalid'}

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<HolderRunEvidence>(resolve => {
    timer = setTimeout(() => resolve({kind: 'unknown', reason: 'run-state-read-timeout'}), deadlineMs)
  })

  const read = (async (): Promise<HolderRunEvidence> => {
    const fetched = await getObject(key.data)
    if (fetched.success === false) return {kind: 'unknown', reason: 'run-state-unavailable'}
    const parsed = parseRunState(fetched.data.data)
    if (parsed.success === false) return {kind: 'unknown', reason: 'run-state-malformed'}

    const {details} = parsed.data
    const owned = details.ownedSessionIds
    return {
      kind: 'known',
      phase: parsed.data.phase,
      lastHeartbeat: parsed.data.last_heartbeat,
      quarantined: typeof details.quarantined === 'boolean' ? details.quarantined : null,
      quarantineReason: readString(details, 'failureKind'),
      quarantineHoldUntil: readString(details, 'quarantineHoldUntil'),
      persistedRootSessionId: readString(details, 'rootSessionId'),
      persistedOwnedSessionCount: Array.isArray(owned) ? owned.length : null,
    }
  })().catch((): HolderRunEvidence => ({kind: 'unknown', reason: 'run-state-read-failed'}))

  try {
    return await Promise.race([read, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function confirmationFields(
  source: ConfirmationSource | null,
  confirmation: RepoQuiescence | null,
): Record<string, unknown> {
  if (confirmation === null) {
    return {
      confirmationSource: source,
      confirmationDirectory: null,
      confirmationCheckedAt: null,
      confirmationBusyCount: null,
      confirmationBusySessionIds: null,
      confirmationUnknownReason: null,
    }
  }
  return {
    confirmationSource: source,
    confirmationDirectory: confirmation.directory,
    confirmationCheckedAt: confirmation.kind === 'unknown' ? null : confirmation.checkedAt,
    confirmationBusyCount: confirmation.kind === 'busy' ? confirmation.sessionIds.length : null,
    confirmationBusySessionIds:
      confirmation.kind === 'busy' ? confirmation.sessionIds.slice(0, MAX_AUDIT_SESSION_IDS) : null,
    confirmationUnknownReason: confirmation.kind === 'unknown' ? confirmation.reason : null,
  }
}

function evidenceFields(evidence: HolderRunEvidence): Record<string, unknown> {
  if (evidence.kind === 'unknown') return {oldRunState: `unknown: ${evidence.reason}`}
  return {
    oldRunState: 'known',
    oldRunPhase: evidence.phase,
    oldRunLastHeartbeat: evidence.lastHeartbeat,
    oldRunQuarantined: evidence.quarantined,
    oldRunQuarantineReason: evidence.quarantineReason,
    oldRunQuarantineHoldUntil: evidence.quarantineHoldUntil,
    oldRunPersistedRootSessionId: evidence.persistedRootSessionId,
    oldRunPersistedOwnedSessionCount: evidence.persistedOwnedSessionCount,
  }
}

/** Emits one structured INFO audit event. Only allow-listed fields are ever written. */
export function emitTakeoverAudit(
  logger: LockLogger,
  event: 'lock-takeover-attempt' | 'lock-takeover-outcome',
  context: TakeoverAuditContext,
  decision: TakeoverDecision,
  source: ConfirmationSource | null,
  confirmation: RepoQuiescence | null,
): void {
  const {holder, now, replacement} = context
  const expiresAtMs = new Date(holder.acquired_at).getTime() + holder.ttl_seconds * 1000
  logger.info(event, {
    operation: context.operation,
    correlationId: context.correlationId,
    repo: context.repo,
    oldHolderId: holder.holder_id,
    oldRunId: holder.run_id,
    oldSurface: holder.surface,
    oldAcquiredAt: holder.acquired_at,
    oldTtlSeconds: holder.ttl_seconds,
    oldExpiryAgeMs: now.getTime() - expiresAtMs,
    newHolderId: replacement?.holderId ?? null,
    newRunId: replacement?.runId ?? null,
    newSurface: replacement?.surface ?? null,
    ...evidenceFields(context.evidence),
    decision,
    ...confirmationFields(source, confirmation),
  })
}

export function decisionForBlocked(confirmation: RepoQuiescence): TakeoverDecision {
  return confirmation.kind === 'busy' ? 'blocked-busy' : 'blocked-unknown'
}
