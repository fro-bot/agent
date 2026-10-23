/**
 * Best-effort disposal of OpenCode's cached per-directory instance.
 *
 * OpenCode keeps one instance per resolved directory (its file index included) for the life of the
 * server. When recovery replaces a checkout IN PLACE the directory path is unchanged, so the cached
 * instance survives the swap and keeps serving the OLD tree: `/find/file` lists files that no longer
 * exist and misses new ones, and a new session in that directory inherits it. A live probe against
 * OpenCode 1.19.0 showed `POST /instance/dispose?directory=<abs path>` (no body, 200 `true`)
 * re-initialises the instance from the new tree; the next request after it was fresh.
 *
 * The call goes straight to the loopback upstream, not through the :9200 bearer proxy, and carries no
 * credentials: the upstream is loopback-only and the proxy itself forwards without any. It is purely
 * advisory - the recovery has already succeeded and nothing here may fail it - so every failure is
 * reported as a value for the caller to log, never thrown.
 */

/** Short on purpose: dispose is a hint, and the caller still holds the per-repo mutex while waiting. */
export const DEFAULT_INSTANCE_DISPOSE_TIMEOUT_MS = 5_000

export type InstanceDisposeOutcome =
  | {readonly kind: 'disposed'}
  /** OpenCode is not running (not started yet, down or degraded), so there is no instance to dispose. */
  | {readonly kind: 'skipped'}
  | {
      readonly kind: 'failed'
      readonly reason: 'timeout' | 'network-error' | 'http-error'
      /** Present only for `http-error`. */
      readonly status?: number
    }

/** Disposes the instance OpenCode caches for `directory`. Resolves to an outcome; never rejects. */
export type InstanceDisposer = (directory: string) => Promise<InstanceDisposeOutcome>

export interface CreateInstanceDisposerOptions {
  /** Loopback URL of the OpenCode server, e.g. `http://127.0.0.1:54321`. */
  readonly upstreamUrl: string
  /** When provided and false, no request is sent and the outcome is `skipped`. */
  readonly isRunning?: () => boolean
  readonly timeoutMs?: number
  /** Test seam; defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch
}

export function createInstanceDisposer(options: CreateInstanceDisposerOptions): InstanceDisposer {
  const {upstreamUrl, isRunning, timeoutMs = DEFAULT_INSTANCE_DISPOSE_TIMEOUT_MS, fetchFn = fetch} = options

  return async directory => {
    if (isRunning !== undefined && !isRunning()) return {kind: 'skipped'}

    // `searchParams` percent-encodes the directory, so any path round-trips exactly.
    const url = new URL('/instance/dispose', upstreamUrl)
    url.searchParams.set('directory', directory)

    // A `setTimeout`-driven abort, like the gateway client's, so the ceiling is fake-timer testable.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchFn(url, {method: 'POST', signal: controller.signal})
      // The body is `true`; nothing reads it, so release the connection without buffering it.
      await response.body?.cancel().catch(() => {})
      if (response.status >= 200 && response.status < 300) return {kind: 'disposed'}
      return {kind: 'failed', reason: 'http-error', status: response.status}
    } catch (error) {
      return {
        kind: 'failed',
        reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network-error',
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
