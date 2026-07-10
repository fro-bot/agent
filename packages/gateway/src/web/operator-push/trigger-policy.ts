/**
 * Pure eligibility decision for whether an active subscription record
 * should receive a push dispatch, given the currently-configured VAPID key
 * rotation state.
 *
 * A subscription record carries the `keyVersion` it was created/refreshed
 * under. If the Gateway's VAPID keys have rotated since, a record signed
 * under a version that is neither the current nor the (optional) previous
 * rollout key can no longer be delivered to correctly — that browser's
 * subscription must first be silently re-registered against the new public
 * key before it is safe to relay through. Sending it anyway would use the
 * wrong VAPID signature for a stale keyVersion and reliably fail upstream.
 */

export type TriggerDecision = 'send' | 'skip-stale-key'

export interface TriggerPolicyRecord {
  readonly keyVersion: string
}

export interface TriggerPolicyKeyVersions {
  readonly current: string
  /** Present only during a key-rotation rollout window. */
  readonly previous?: string
}

/**
 * Decides whether `record` is eligible for dispatch under the configured
 * VAPID key rotation state. `kind` is accepted for signature symmetry with
 * future per-kind policy but does not currently affect the decision.
 */
export function shouldNotify(
  _kind: 'approval' | 'run_failed',
  record: TriggerPolicyRecord,
  keyVersions: TriggerPolicyKeyVersions,
): TriggerDecision {
  if (record.keyVersion === keyVersions.current) {
    return 'send'
  }
  if (keyVersions.previous !== undefined && record.keyVersion === keyVersions.previous) {
    return 'send'
  }
  return 'skip-stale-key'
}
