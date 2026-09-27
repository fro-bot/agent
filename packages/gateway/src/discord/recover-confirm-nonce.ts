/**
 * In-memory, one-shot confirmation nonce registry shared by `/fro-bot recover-checkout` and
 * `/fro-bot checkout-backup delete`.
 *
 * A nonce binds a Confirm/Delete button click to the SPECIFIC ephemeral message that showed it —
 * never to any server-side operation (the recovery preview and backup delete confirmation are both
 * stateless on the workspace side; see `previewRecovery`'s own doc comment). It lives only in this
 * process's memory: a gateway restart drops every pending nonce, and a click against an unknown
 * nonce is treated identically to expiry — release whatever resource the caller is holding, change
 * nothing, and tell the user to start over. This is deliberate (see the plan's "Open Questions —
 * Resolved During Planning": a restart must never resurrect a stale confirmation).
 */

const NONCE_TTL_MS = 60_000

/** Context a nonce is bound to. A claim must match every field exactly. */
export interface NonceBinding {
  readonly userId: string
  readonly guildId: string
  readonly channelId: string
  readonly messageId: string
}

interface NonceEntry<T> {
  readonly binding: NonceBinding
  readonly payload: T
  claimed: boolean
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * A registry of live nonces for one confirmation kind (recover-checkout confirm, backup delete
 * confirm, ...). Separate registries never share nonce strings, so a recover-checkout nonce can
 * never claim a backup-delete confirmation or vice versa.
 */
export interface NonceRegistry<T> {
  /** Mint a nonce bound to `binding`, carrying `payload`, expiring after `NONCE_TTL_MS`. */
  readonly create: (binding: NonceBinding, payload: T, onExpire: (payload: T) => void) => string
  /**
   * Atomically claim a nonce: returns the bound payload exactly once, on the first call whose
   * `binding` matches exactly, before expiry. Every other call (wrong binding, already claimed,
   * expired, or unknown) returns `null` and changes nothing.
   */
  readonly claim: (nonce: string, binding: NonceBinding) => T | null
  /** Cancel a pending nonce (e.g. the user clicked Cancel) without invoking `onExpire`. Idempotent. */
  readonly cancel: (nonce: string) => void
  /** Test-only: number of currently pending (unclaimed, unexpired) nonces. */
  readonly _pendingCount: () => number
}

export function createNonceRegistry<T>(): NonceRegistry<T> {
  const entries = new Map<string, NonceEntry<T>>()

  function create(binding: NonceBinding, payload: T, onExpire: (payload: T) => void): string {
    const nonce = crypto.randomUUID()
    const timer = setTimeout(() => {
      const entry = entries.get(nonce)
      if (entry === undefined || entry.claimed) return
      entries.delete(nonce)
      onExpire(payload)
    }, NONCE_TTL_MS)
    entries.set(nonce, {binding, payload, claimed: false, timer})
    return nonce
  }

  function claim(nonce: string, binding: NonceBinding): T | null {
    const entry = entries.get(nonce)
    if (entry === undefined || entry.claimed) return null
    if (
      entry.binding.userId !== binding.userId ||
      entry.binding.guildId !== binding.guildId ||
      entry.binding.channelId !== binding.channelId ||
      entry.binding.messageId !== binding.messageId
    ) {
      return null
    }
    entry.claimed = true
    clearTimeout(entry.timer)
    entries.delete(nonce)
    return entry.payload
  }

  function cancel(nonce: string): void {
    const entry = entries.get(nonce)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    entries.delete(nonce)
  }

  return {create, claim, cancel, _pendingCount: () => entries.size}
}
