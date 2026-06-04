/**
 * OpenCode SDK server lifecycle for the workspace-agent.
 *
 * Spawns `opencode serve` bound to loopback (127.0.0.1) only — never on
 * `sandbox-net` or host-published. The bearer-token proxy in opencode-proxy.ts
 * is the sole externally-reachable surface.
 *
 * SECURITY INVARIANTS:
 * 1. Binds to 127.0.0.1 only — raw OpenCode port is never on sandbox-net.
 * 2. No token or credential is logged.
 * 3. Spawn failure is caught and reflected as 'down' status; no crash-loop.
 */

import {spawn as nodeSpawn} from 'node:child_process'
import process from 'node:process'
import {setTimeout as sleep} from 'node:timers/promises'

export interface Logger {
  readonly info: (msg: string, meta?: Record<string, unknown>) => void
  readonly warn: (msg: string, meta?: Record<string, unknown>) => void
  readonly error: (msg: string, meta?: Record<string, unknown>) => void
}

/** Minimal child process handle used by this module. */
export interface ChildHandle {
  readonly kill: (signal?: string) => boolean
  readonly on: (event: string | symbol, listener: (...args: unknown[]) => void) => void
}

/** Simplified spawn signature for dependency injection. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {readonly cwd?: string; readonly env?: NodeJS.ProcessEnv},
) => ChildHandle

/** Readiness probe — return true if the server is accepting connections. */
export type PollReadyFn = (url: string, signal?: AbortSignal) => Promise<boolean>

export interface OpencodeServerHandle {
  /** Loopback URL, e.g. http://127.0.0.1:54321 */
  readonly url: string
  /** Terminate the OpenCode process. */
  readonly close: () => void
}

export interface StartOpencodeServerOptions {
  /** Repo root directory passed to opencode serve. */
  readonly rootDir: string
  readonly logger: Logger
  /** Optional abort signal — on abort the server is closed. */
  readonly signal?: AbortSignal
  /** Hostname to bind. Default: '127.0.0.1' (loopback only). */
  readonly hostname?: string
  /** Port to bind. Default: 54321 (OpenCode default). */
  readonly port?: number
  /** How long to wait for the server to become ready. Default: 15000ms. */
  readonly readyTimeoutMs?: number
  /** Poll interval in ms. Default: 250ms. */
  readonly pollIntervalMs?: number
  /** Injected spawn function for testing. Defaults to node:child_process.spawn. */
  readonly spawnFn?: SpawnFn
  /** Injected readiness poll function for testing. */
  readonly pollReadyFn?: PollReadyFn
}

/** Options for the default readiness probe. */
export interface DefaultPollReadyOptions {
  /**
   * Injected fetch function for testing. Defaults to global fetch.
   * Receives the same signal that is passed to the underlying fetch call
   * (the composed per-probe + caller signal).
   */
  readonly fetchFn?: (url: string, init?: RequestInit) => Promise<Response>
  /**
   * Per-probe timeout in milliseconds. Each attempt gets its own AbortController
   * with this deadline. On timeout the attempt returns false (not ready yet) so
   * the outer deadline loop can retry. Default: 3000ms.
   */
  readonly probeTimeoutMs?: number
}

/**
 * Default readiness probe: fetch the URL, succeed on any HTTP response.
 *
 * Each attempt gets its own AbortController with a short per-probe deadline
 * (default 3s) composed with any caller signal. This prevents a hung TCP
 * connection from stalling the readiness loop forever.
 *
 * - Per-probe timeout fires → returns false (not ready yet; outer loop retries).
 * - Caller signal aborts → re-throws the abort error (propagates to caller).
 * - Any HTTP response (res.status > 0) → returns true (ready).
 */
export async function defaultPollReady(
  url: string,
  callerSignal?: AbortSignal,
  options?: DefaultPollReadyOptions,
): Promise<boolean> {
  const {fetchFn = fetch, probeTimeoutMs = 3_000} = options ?? {}

  // Per-probe AbortController with a short deadline.
  const probeController = new AbortController()
  const probeTimer = setTimeout(() => probeController.abort(), probeTimeoutMs)

  // Compose the per-probe signal with the caller signal (if any) so that
  // either an external abort or the per-probe timeout cancels the fetch.
  const composedSignal =
    callerSignal === undefined ? probeController.signal : AbortSignal.any([callerSignal, probeController.signal])

  try {
    const res = await fetchFn(url, {signal: composedSignal})
    // Any HTTP response means the server is up (even 404/500)
    return res.status > 0
  } catch (error) {
    // Distinguish caller abort (propagate) from per-probe timeout (retry).
    if (callerSignal?.aborted === true) {
      // Caller explicitly aborted — propagate so the outer loop can surface it.
      throw error
    }
    // Per-probe timeout or transient network error — treat as "not ready yet".
    return false
  } finally {
    clearTimeout(probeTimer)
  }
}

/**
 * Start an OpenCode SDK server bound to loopback, poll until ready.
 *
 * Returns {url, close} on success.
 * Throws if the process exits before becoming ready or the timeout elapses.
 */
export async function startOpencodeServer(options: StartOpencodeServerOptions): Promise<OpencodeServerHandle> {
  const {
    rootDir,
    logger,
    signal,
    hostname = '127.0.0.1',
    port = 54321,
    readyTimeoutMs = 15_000,
    pollIntervalMs = 250,
    spawnFn = nodeSpawn,
    pollReadyFn = defaultPollReady,
  } = options

  const url = `http://${hostname}:${port}`

  logger.info('opencode-server: spawning', {url, rootDir})

  const child = spawnFn('opencode', ['serve', '--hostname', hostname, '--port', String(port)], {
    cwd: rootDir,
    env: process.env,
  })

  // Use an object to hold mutable state — TypeScript does not narrow mutable
  // object properties across await points, preventing false narrowing errors.
  const state: {exited: boolean; exitCode: number | null} = {exited: false, exitCode: null}

  child.on('exit', (code: unknown) => {
    state.exited = true
    state.exitCode = typeof code === 'number' ? code : null
    logger.info('opencode-server: process exited', {code: state.exitCode})
  })

  child.on('error', (err: unknown) => {
    state.exited = true
    const message = err instanceof Error ? err.message : String(err)
    logger.error('opencode-server: spawn error', {message})
  })

  // Abort signal integration
  if (signal !== undefined) {
    signal.addEventListener('abort', () => {
      if (state.exited === false) {
        child.kill('SIGTERM')
      }
    })
  }

  // Poll until ready or timeout
  const deadline = Date.now() + readyTimeoutMs

  while (Date.now() < deadline) {
    if (state.exited === true) {
      throw new Error(`opencode process exited before becoming ready (exit code: ${state.exitCode})`)
    }

    const ready = await pollReadyFn(url, signal)
    if (ready === true) {
      logger.info('opencode-server: ready', {url})
      return {
        url,
        close(): void {
          if (state.exited === false) {
            child.kill('SIGTERM')
          }
        },
      }
    }

    await sleep(pollIntervalMs)
  }

  // Timeout reached — kill and throw.
  // Kill unconditionally (no-op if process already exited).
  child.kill('SIGTERM')
  throw new Error(`opencode server did not become ready within ${readyTimeoutMs}ms`)
}
