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
 * 4. Bounded respawn: max attempts + total boot budget prevent infinite retry.
 */

import {spawn as nodeSpawnRaw} from 'node:child_process'
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
  /** Process ID — present on real child_process.ChildProcess; may be undefined on test fakes. */
  readonly pid?: number
}

/** Simplified spawn signature for dependency injection. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly detached?: boolean},
) => ChildHandle

/**
 * Thin adapter that wraps node:child_process.spawn to satisfy SpawnFn.
 * ChildProcessWithoutNullStreams has complex overloaded `on` signatures that
 * don't structurally match our minimal ChildHandle.on — this cast is safe
 * because we only use the `exit`, `error`, `kill`, and `pid` surface.
 */
const nodeSpawn: SpawnFn = (command, args, options) =>
  nodeSpawnRaw(command, [...args], options) as unknown as ChildHandle

/**
 * Readiness probe — return true if the server is accepting connections.
 *
 * The optional `probeTimeoutMs` parameter allows the caller to pass a
 * per-probe deadline cap (e.g. the remaining overall deadline) so a single
 * probe cannot overshoot the overall readiness timeout.
 */
export type PollReadyFn = (url: string, signal?: AbortSignal, probeTimeoutMs?: number) => Promise<boolean>

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
  /** How long to wait for the server to become ready. Default: 60000ms. */
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
 * Kill the child's entire process group when a pid is available.
 *
 * When `child.pid` is a safe integer > 1, sends SIGTERM to the whole process
 * group (negative pid = pgid) so no orphaned grandchildren survive a
 * timeout/respawn/shutdown. Falls back to `child.kill('SIGTERM')` when the
 * pid is not a safe integer > 1 (e.g. test fakes that don't expose a pid).
 *
 * SECURITY INVARIANTS:
 * - pid must be > 1: process.kill(-0, …) signals the supervisor's OWN process
 *   group; process.kill(-1, …) broadcasts SIGTERM to every process the user
 *   can reach — both are catastrophic and are explicitly excluded.
 * - No token, secret, or env value is logged here.
 * - Errors from process.kill or child.kill are swallowed (best-effort reap)
 *   so an ESRCH race does not escape and break respawn/degraded handling.
 */
function killChildGroup(child: ChildHandle): void {
  if (Number.isSafeInteger(child.pid) && (child.pid as number) > 1) {
    try {
      process.kill(-(child.pid as number), 'SIGTERM')
    } catch {
      // Best-effort: ESRCH means the child already exited — safe to ignore.
      try {
        child.kill('SIGTERM')
      } catch {
        // Swallow — child is already gone.
      }
    }
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      // Best-effort: child already exited — safe to ignore.
    }
  }
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
    readyTimeoutMs = 60_000,
    pollIntervalMs = 250,
    spawnFn = nodeSpawn,
    // Default: wrap defaultPollReady to thread the per-probe timeout cap through.
    pollReadyFn = async (url: string, sig?: AbortSignal, probeTimeoutMs?: number) =>
      defaultPollReady(url, sig, probeTimeoutMs === undefined ? undefined : {probeTimeoutMs}),
  } = options

  const url = `http://${hostname}:${port}`

  logger.info('opencode-server: spawning', {url, rootDir})

  // detached: true makes the child a process-group leader (pgid = pid) so
  // killChildGroup can reap the whole group on timeout/abort/close.
  const child = spawnFn('opencode', ['serve', '--hostname', hostname, '--port', String(port)], {
    cwd: rootDir,
    env: process.env,
    detached: true,
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

  // Abort signal integration — reap the whole process group on abort.
  if (signal !== undefined) {
    signal.addEventListener('abort', () => {
      if (state.exited === false) {
        killChildGroup(child)
      }
    })
  }

  // Poll until ready or timeout
  const deadline = Date.now() + readyTimeoutMs
  // Default per-probe timeout (3s) — capped to remaining deadline each iteration.
  const defaultProbeTimeoutMs = 3_000

  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // Overall deadline reached — exit before probing.
      break
    }

    if (state.exited === true) {
      throw new Error(`opencode process exited before becoming ready (exit code: ${state.exitCode})`)
    }

    // Cap the per-probe timeout to the remaining deadline so a single probe
    // cannot overshoot the overall readiness timeout. Math.max(1, …) prevents
    // clock jitter from producing a 0 or negative timeout.
    const probeTimeoutMs = Math.max(1, Math.min(defaultProbeTimeoutMs, remaining))
    const ready = await pollReadyFn(url, signal, probeTimeoutMs)
    if (ready === true) {
      logger.info('opencode-server: ready', {url})
      return {
        url,
        close(): void {
          if (state.exited === false) {
            killChildGroup(child)
          }
        },
      }
    }

    await sleep(pollIntervalMs)
  }

  // Timeout reached — reap the whole process group and throw.
  killChildGroup(child)
  throw new Error(`opencode server did not become ready within ${readyTimeoutMs}ms`)
}

/** OpenCode status values (mirrors server.ts OpencodeStatus + degraded). */
export type SupervisedOpencodeStatus = 'starting' | 'ready' | 'down' | 'degraded'

/** Mutable status reference updated by the supervisor. */
export interface SupervisedStatusRef {
  status: SupervisedOpencodeStatus
}

export interface RunSupervisedOpencodeOptions {
  /** Repo root directory passed to opencode serve. */
  readonly rootDir: string
  readonly logger: Logger
  /** Mutable status reference — supervisor writes transitions here. */
  readonly statusRef: SupervisedStatusRef
  /** Optional abort signal — on abort the supervisor stops. */
  readonly signal?: AbortSignal
  /** Hostname to bind. Default: '127.0.0.1' (loopback only). */
  readonly hostname?: string
  /** Port to bind. Default: 54321 (OpenCode default). */
  readonly port?: number
  /**
   * Per-attempt readiness timeout in ms. Each attempt gets a fresh deadline.
   * Default: 60000ms.
   */
  readonly readyTimeoutMs?: number
  /** Poll interval in ms. Default: 250ms. */
  readonly pollIntervalMs?: number
  /**
   * Maximum number of spawn attempts (initial + respawns).
   * Default: 4 (1 initial + 3 respawns).
   */
  readonly maxAttempts?: number
  /**
   * Initial backoff delay in ms before the first respawn.
   * Doubles on each subsequent attempt, capped at maxBackoffMs.
   * Default: 1000ms.
   */
  readonly initialBackoffMs?: number
  /**
   * Maximum backoff delay in ms. Default: 10000ms.
   */
  readonly maxBackoffMs?: number
  /**
   * Minimum uptime in ms after becoming ready before a post-ready exit is
   * treated as a "stable run" and the attempt counter + backoff are reset.
   * This prevents a child that crashes hours after becoming ready from
   * consuming the bounded respawn budget — only RAPID crash loops (exit within
   * stableReadyResetMs of becoming ready) consume the budget.
   * Default: 60000ms.
   */
  readonly stableReadyResetMs?: number
  /** Injected spawn function for testing. Defaults to node:child_process.spawn. */
  readonly spawnFn?: SpawnFn
  /** Injected readiness poll function for testing. */
  readonly pollReadyFn?: PollReadyFn
}

export async function runSupervisedOpencode(options: RunSupervisedOpencodeOptions): Promise<void> {
  const {
    rootDir,
    logger,
    statusRef,
    signal,
    hostname = '127.0.0.1',
    port = 54321,
    readyTimeoutMs = 60_000,
    pollIntervalMs = 250,
    maxAttempts = 4,
    initialBackoffMs = 1_000,
    maxBackoffMs = 10_000,
    stableReadyResetMs = 60_000,
    spawnFn = nodeSpawn,
    // Default: wrap defaultPollReady to thread the per-probe timeout cap through.
    pollReadyFn = async (url: string, sig?: AbortSignal, probeTimeoutMs?: number) =>
      defaultPollReady(url, sig, probeTimeoutMs === undefined ? undefined : {probeTimeoutMs}),
  } = options

  const url = `http://${hostname}:${port}`
  // Mutable attempt counter — can be reset after a stable run (Fix 2).
  let attempt = 1
  let backoffMs = initialBackoffMs

  // Memory-leak fix: register ONE abort handler outside the loop, referencing
  // the current child via a mutable ref. This prevents O(N) listener accumulation
  // on the shared AbortSignal across stable respawns (where attempt resets to 1).
  // The handler is removed in the finally block when the supervisor returns.
  //
  // The same handler also resolves the post-ready wait (stored in postReadyResolve)
  // so we never need a second listener on the signal for that purpose.
  let currentChild: ChildHandle | null = null
  let currentState: {exited: boolean} | null = null
  let postReadyResolve: (() => void) | null = null

  const onAbort = (): void => {
    if (currentChild !== null && currentState !== null && currentState.exited === false) {
      killChildGroup(currentChild)
    }
    // Unblock the post-ready wait if it's active.
    if (postReadyResolve !== null) {
      postReadyResolve()
    }
  }

  if (signal !== undefined) {
    signal.addEventListener('abort', onAbort)
  }

  try {
    while (attempt <= maxAttempts) {
      // Fix 4: stop immediately if the signal was already aborted before this spawn.
      if (signal !== undefined && signal.aborted) {
        return
      }

      // Fail-closed: status is 'starting' (not-ready) before each spawn attempt.
      // This ensures /readyz returns 503 during the kill→respawn transition.
      statusRef.status = 'starting'

      logger.info('opencode-server: supervisor spawning', {url, rootDir, attempt, maxAttempts})

      // detached: true makes the child a process-group leader (pgid = pid) so
      // killChildGroup can reap the whole group on timeout/abort/shutdown.
      const child = spawnFn('opencode', ['serve', '--hostname', hostname, '--port', String(port)], {
        cwd: rootDir,
        env: process.env,
        detached: true,
      })

      // Per-attempt mutable state.
      const state: {exited: boolean; exitCode: number | null; becameReady: boolean} = {
        exited: false,
        exitCode: null,
        becameReady: false,
      }

      // Update the mutable refs so the single top-level onAbort handler targets
      // the current child. This must happen before any await so the handler is
      // always pointing at the live child when abort fires.
      currentChild = child
      currentState = state

      child.on('exit', (code: unknown) => {
        state.exited = true
        state.exitCode = typeof code === 'number' ? code : null
        logger.info('opencode-server: process exited', {code: state.exitCode, attempt})

        // POST-READY EXIT LATCH FIX: if the child exits after we marked it ready,
        // flip status back to not-ready immediately. The outer loop will decide
        // whether to respawn (if attempts remain) or go to degraded.
        if (state.becameReady === true && statusRef.status === 'ready') {
          logger.warn('opencode-server: process exited after becoming ready — flipping to starting', {
            code: state.exitCode,
            attempt,
          })
          statusRef.status = 'starting'
        }
      })

      child.on('error', (err: unknown) => {
        state.exited = true
        const message = err instanceof Error ? err.message : String(err)
        logger.error('opencode-server: spawn error', {message, attempt})
      })

      // Per-attempt readiness loop with a fresh deadline.
      const deadline = Date.now() + readyTimeoutMs
      let becameReady = false
      let readyAt = 0
      // Default per-probe timeout (3s) — capped to remaining deadline each iteration.
      const defaultProbeTimeoutMs = 3_000

      while (true) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          // Overall deadline reached — exit before probing.
          break
        }

        // Fix 4: abort check inside the readiness poll loop.
        if (signal !== undefined && signal.aborted) {
          if (state.exited === false) {
            killChildGroup(child)
          }
          return
        }

        if (state.exited === true) {
          // Process exited before becoming ready — break to respawn logic.
          break
        }

        // Cap the per-probe timeout to the remaining deadline so a single probe
        // cannot overshoot the overall readiness timeout. Math.max(1, …) prevents
        // clock jitter from producing a 0 or negative timeout.
        const probeTimeoutMs = Math.max(1, Math.min(defaultProbeTimeoutMs, remaining))
        const ready = await pollReadyFn(url, signal, probeTimeoutMs)
        if (ready === true) {
          becameReady = true
          readyAt = Date.now()
          state.becameReady = true
          statusRef.status = 'ready'
          logger.info('opencode-server: ready', {url, attempt})
          break
        }

        await sleep(pollIntervalMs)
      }

      if (becameReady === true) {
        // Server is ready. Now wait for it to exit (post-ready monitoring).
        // This is the latch fix: we don't return immediately — we stay in the
        // loop waiting for an unexpected exit so we can flip status and respawn.
        //
        // Memory-leak fix for the post-ready wait: we must NOT add another
        // listener on the shared signal here. Instead, the top-level onAbort
        // handler resolves the wait via the postReadyResolve ref — zero extra
        // listeners on the signal.
        await new Promise<void>(resolve => {
          if (state.exited === true) {
            resolve()
            return
          }
          // Fix 4: also resolve immediately if the signal aborts (the top-level
          // onAbort handler already called killChildGroup and will call
          // postReadyResolve — we just need to register the resolver here).
          postReadyResolve = resolve
          child.on('exit', () => {
            postReadyResolve = null
            resolve()
          })
        })

        // Fix 4: if we were aborted during post-ready monitoring, stop here.
        if (signal !== undefined && signal.aborted) {
          return
        }

        // Fix 2: compute uptime since the child became ready.
        const uptime = Date.now() - readyAt
        const wasStable = uptime >= stableReadyResetMs

        if (wasStable) {
          // Stable run: reset the attempt counter and backoff so only RAPID
          // crash loops consume the bounded budget.
          logger.info('opencode-server: stable run detected — resetting respawn budget', {
            uptime,
            stableReadyResetMs,
            attempt,
          })
          attempt = 1
          backoffMs = initialBackoffMs
        }

        // Child has now exited. Decide whether to respawn.
        if (attempt < maxAttempts) {
          // Respawn: set status to starting BEFORE killing (already exited, but
          // the status flip is the load-bearing invariant).
          statusRef.status = 'starting'
          logger.warn('opencode-server: supervisor respawning after post-ready exit', {
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
            wasStable,
          })
          // Apply backoff before next attempt (abortable — Fix 4).
          if (backoffMs > 0 && (signal === undefined || !signal.aborted)) {
            await sleep(backoffMs, undefined, {signal}).catch(() => {
              // Abort during backoff — stop immediately.
            })
          }
          if (signal !== undefined && signal.aborted) {
            return
          }
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
          attempt++
          continue
        }

        // No attempts remain — terminal degraded state.
        statusRef.status = 'degraded'
        logger.error('opencode-server: supervisor exhausted attempts after post-ready exit', {
          attempt,
          maxAttempts,
        })
        return
      }

      // Did not become ready (timeout or early exit).
      // Reap the whole process group (fail-closed: status is already 'starting').
      if (state.exited === false) {
        killChildGroup(child)
      }

      if (attempt < maxAttempts) {
        logger.warn('opencode-server: supervisor attempt failed, will respawn', {
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          backoffMs,
        })
        // Apply backoff before next attempt (abortable — Fix 4).
        if (backoffMs > 0 && (signal === undefined || !signal.aborted)) {
          await sleep(backoffMs, undefined, {signal}).catch(() => {
            // Abort during backoff — stop immediately.
          })
        }
        if (signal !== undefined && signal.aborted) {
          return
        }
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
        attempt++
        continue
      }

      // All attempts exhausted — terminal degraded state.
      // Clone API (:9100) stays alive; /readyz returns 503.
      statusRef.status = 'degraded'
      logger.error('opencode-server: supervisor exhausted all attempts', {
        attempt,
        maxAttempts,
      })
      return
    }
  } finally {
    // Memory-leak fix: always remove the top-level abort listener when the
    // supervisor returns (whether normally, via abort, or via degraded state).
    if (signal !== undefined) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
