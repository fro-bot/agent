/**
 * Best-effort disposal of a stock OpenCode V2 server's cached location: the sibling of `opencode-instance.ts`.
 *
 * Probe P3 (v2.2.0): after a checkout is swapped in place, `fs/find` already returned the new tree within a few
 * milliseconds with no action at all, so neither refresh is required for correctness. Where a disposer is still
 * wired, this uses the narrower of the two that work: `DELETE /api/debug/location?location[directory]=<dir>` evicts
 * one location. `POST /api/location/reload` rebuilds every loaded location and cancels pending permissions and
 * forms, which is wider than a recovery should ever be. The V1 route (`/instance/dispose`) does not exist on V2.
 *
 * The call goes straight to the loopback upstream, not through the :9200 proxy, and it must authenticate as the
 * server that is running now, so it reads the same credential holder the proxy reads. It is purely advisory (the
 * recovery has already succeeded), so every failure is a value for the caller to log, never a throw.
 */

import type {InstanceDisposeOutcome, InstanceDisposer} from './opencode-instance.js'
import type {UpstreamCredentials} from './opencode-server-v2.js'

/** Short on purpose: the caller still holds the per-repo mutex while it waits. */
export const DEFAULT_INSTANCE_DISPOSE_TIMEOUT_MS_V2 = 5000

export interface CreateInstanceDisposerV2Options {
  /** Loopback URL of the OpenCode server, e.g. `http://127.0.0.1:54321`. */
  readonly upstreamUrl: string
  /** The credential of the server that is ready now. Without one no request is sent. */
  readonly credentials: UpstreamCredentials
  /** When provided and false, no request is sent and the outcome is `skipped`. */
  readonly isRunning?: () => boolean
  readonly timeoutMs?: number
  /** Test seam; defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch
}

export function createInstanceDisposerV2(options: CreateInstanceDisposerV2Options): InstanceDisposer {
  const {
    upstreamUrl,
    credentials,
    isRunning,
    timeoutMs = DEFAULT_INSTANCE_DISPOSE_TIMEOUT_MS_V2,
    fetchFn = fetch,
  } = options

  return async (directory): Promise<InstanceDisposeOutcome> => {
    if (isRunning !== undefined && !isRunning()) return {kind: 'skipped'}
    const authorization = credentials.authorization()
    // No server has published a credential, so there is no server this request could usefully reach.
    if (authorization === undefined) return {kind: 'skipped'}

    // The query is a deepObject (`location[directory]=`); `searchParams` percent-encodes any path so it round-trips.
    const url = new URL('/api/debug/location', upstreamUrl)
    url.searchParams.set('location[directory]', directory)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchFn(url, {method: 'DELETE', headers: {authorization}, signal: controller.signal})
      // The body is empty (204); release the connection without buffering anything.
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
