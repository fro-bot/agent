import type {Result} from '@bfra.me/es/result'
import type {SessionClient} from '../session/index.js'
import type {Logger} from '../shared/logger.js'
import type {SetupAdapter, SetupInputs} from './setup-adapter.js'
import type {EnsureOpenCodeResult} from './types.js'
import net from 'node:net'
import process from 'node:process'
import {createOpencode} from '@opencode-ai/sdk'
import {
  DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS,
  DEFAULT_SERVER_READINESS_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_QUIESCE_POLL_INTERVAL_MS,
  DEFAULT_SHUTDOWN_QUIESCE_TIMEOUT_MS,
} from '../shared/constants.js'
import {toErrorMessage} from '../shared/errors.js'
import {err, ok} from '../shared/types.js'
import {withScrubbedEnv} from './with-scrubbed-env.js'

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

// The subset of net.Socket that isPortOpen depends on. Narrowed to an interface (rather
// than importing net.Socket directly into the signature) so tests can inject a fake that
// deterministically exercises the setTimeout branch -- a real socket only reaches that
// branch by actually hanging for `timeoutMs`, which depends on real network/OS behavior
// (a black-holed address may instead fail fast with ECONNREFUSED/ENETUNREACH in a
// sandboxed CI network, silently skipping the very branch a test aims to pin) and is slow
// even when it works.
export interface QuiescenceProbeSocket {
  readonly once: (event: 'connect' | 'error', listener: (error?: Error) => void) => void
  readonly setTimeout: (ms: number, onTimeout: () => void) => void
  readonly destroy: () => void
  readonly removeAllListeners: () => void
}

function defaultConnect(hostname: string, port: number): QuiescenceProbeSocket {
  return net.connect({host: hostname, port})
}

// Best-effort liveness probe for the OpenCode child, used only by shutdown() below.
// Resolves true while something answers a TCP connect on the given host/port, false the
// instant the connection is refused (or otherwise errors) -- which, for a port this
// process itself bound moments earlier via pickFreePort/createOpencode, only happens once
// the process holding it has actually exited and the OS has reclaimed the socket.
//
// Bounded by its own socket timeout (`timeoutMs`, one poll interval's worth) rather than
// relying solely on `connect`/`error` firing: a connection attempt that neither succeeds
// nor is refused -- a firewalled port, a host that silently drops SYNs -- would otherwise
// never settle this promise, which would stall waitForServerQuiescence's do/while loop
// forever despite its own `timeoutMs` parameter. A timeout here resolves `true` ("still
// open as far as this attempt could tell"), NOT `false`: every other unknown this change
// introduces resolves pessimistically (verifyDatabaseUsable defaults to usable: true only
// for a *recognized-safe* throw shape; isStructuralCorruptionError defaults to false unless
// SQLite positively says otherwise), and "connection attempt inconclusive" must default to
// "cannot confirm the child exited", not to a manufactured `quiesced: true`. Resolving
// `true` here means the do/while loop simply keeps polling on the next interval; the outer
// `waitForServerQuiescence` deadline is what eventually produces an honest `quiesced:
// false` if the port genuinely never stops answering -- the cost of that correctness is
// that a genuinely inconclusive probe now rides out the full outer timeout budget
// (`DEFAULT_SHUTDOWN_QUIESCE_TIMEOUT_MS`, 5000ms as of writing) instead of returning after
// a single poll interval; this is one server per run and bounded, so it is an acceptable,
// intended trade, not a regression, but a future change to either constant should account
// for it deliberately rather than rediscovering it. `finish` is guarded against running
// twice so a `timeout` that fires and a subsequent `error` from the torn-down socket cannot
// both resolve the same promise. `destroy()` runs before `removeAllListeners()`, not after:
// removing the `error` listener first would leave a socket that is mid-connect (and may
// still emit `error` as a side effect of being destroyed) with no listener attached, which
// Node treats as an uncaught exception.
export async function isPortOpen(
  hostname: string,
  port: number,
  timeoutMs: number,
  connect: (hostname: string, port: number) => QuiescenceProbeSocket = defaultConnect,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const socket = connect(hostname, port)
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      socket.removeAllListeners()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => finish(true))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * Polls `url`'s listening port until connections start being refused (the child has
 * exited and the OS reclaimed the socket) or `timeoutMs` elapses, whichever comes first.
 *
 * This exists because the SDK gives the harness nothing else to wait on: `createOpencode`
 * (`@opencode-ai/sdk` dist/index.js) returns only `{client, server: {url, close}}` --
 * `close()` itself (dist/server.js) calls `stop(proc)`, i.e. `proc.kill()`, on a child
 * process object that is never exposed to the caller. There is no pid, no exit event, no
 * awaitable handle. Port-liveness is the best boundary reachable without patching the SDK.
 *
 * Not a proof of quiescence: a timeout here means the child's fate is genuinely unknown,
 * not that it is still running, and a small window remains even on `quiesced: true` (the OS
 * can reclaim a listening socket slightly before or after in-flight I/O the process was
 * doing at exit finishes). It is a large, measured improvement over the previous fire-and-
 * forget `close()` — which returned before the signal was even delivered — not a guarantee.
 */
export async function waitForServerQuiescence(
  url: string,
  timeoutMs: number = DEFAULT_SHUTDOWN_QUIESCE_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_SHUTDOWN_QUIESCE_POLL_INTERVAL_MS,
  connect: (hostname: string, port: number) => QuiescenceProbeSocket = defaultConnect,
): Promise<ShutdownResult> {
  let hostname: string
  let port: number
  try {
    const parsed = new URL(url)
    hostname = parsed.hostname
    port = Number(parsed.port)
  } catch {
    // Cannot parse the server's own URL - nothing to poll. Report unconfirmed rather than
    // throwing out of a cleanup path; the caller treats this the same as a timeout.
    return {quiesced: false}
  }

  // A URL with no explicit port (parsed.port === '') yields 0 here, and connecting to port
  // 0 errors immediately -- isPortOpen would report "closed" on the first attempt without
  // having checked anything real, turning a malformed URL into a false quiesced: true.
  // bootstrapOpenCodeServer always pins an explicit port and rejects a URL mismatch before
  // a handle is ever returned (see the check above acquiredServer/server.url), so this is
  // unreachable in practice; guarded here so that invariant is enforced in code, not left
  // as an assumption about what callers happen to pass.
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return {quiesced: false}
  }

  const deadline = Date.now() + timeoutMs
  do {
    const stillOpen = await isPortOpen(hostname, port, pollIntervalMs, connect)
    if (!stillOpen) {
      return {quiesced: true}
    }
    await delay(pollIntervalMs)
  } while (Date.now() < deadline)

  return {quiesced: false}
}

// Picks a free ephemeral port by binding to port 0, reading the assigned
// port, then releasing it. There is an inherent TOCTOU window between close()
// here and the child's own bind inside createOpencode — a concurrent process
// could grab the same port first. This is accepted: createOpencode's failure
// path (existing catch below) already surfaces that as a bootstrap error.
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to determine ephemeral port'))
        return
      }
      const {port} = address
      server.close(closeError => {
        if (closeError != null) {
          reject(closeError)
          return
        }
        resolve(port)
      })
    })
  })
}

/**
 * Outcome of `OpenCodeServerHandle.shutdown()`. `quiesced: true` means the server's port
 * stopped accepting connections within the wait budget, which only happens once the child
 * process has actually exited. `quiesced: false` means the budget elapsed without that
 * happening -- the child's fate is unknown (still running, dying slowly, or the port check
 * itself failed), and any checkpoint attempted right after should not be read as running
 * against a guaranteed-quiet database.
 */
export interface ShutdownResult {
  readonly quiesced: boolean
}

export interface OpenCodeServerHandle {
  readonly client: SessionClient
  readonly server: {readonly url: string; close: () => void}
  readonly shutdown: () => Promise<ShutdownResult>
}

// Outcome of a single readiness-probe attempt. 'timeout'/'aborted' name the abort family
// (AbortSignal.timeout() vs. the caller's own deadline) and are never retried -- both are
// fatal, and which message they produce is decided by the caller reading `signal.aborted`
// once, immediately after this resolves. 'transport' covers everything else (ECONNRESET, a
// socket hangup, a synchronous throw from the client) -- a local-loopback blip, not
// evidence the instance is stuck, so the caller retries it once before treating it as fatal.
type ReadinessProbeOutcome =
  | {readonly kind: 'ready'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'aborted'}
  | {readonly kind: 'transport'; readonly error: unknown}

async function attemptReadinessProbe(
  client: SessionClient,
  workspacePath: string,
  outerSignal: AbortSignal,
  readinessTimeoutMs: number,
  logger: Logger,
): Promise<ReadinessProbeOutcome> {
  // Classified by which signal actually fired, not by the rejection's name/type: a fetch
  // implementation's abort surface is not a stable contract (undici's streaming teardown
  // can wrap an abort as a TypeError with the real signal on `.cause`), and name-sniffing
  // that misreads an abort as a transport fault burns a full retry budget before failing
  // anyway -- the same mislabeling this classification exists to prevent, running the
  // other direction. Held locally so the catch can check both without re-deriving them.
  const timeoutSignal = AbortSignal.timeout(readinessTimeoutMs)
  try {
    const probe = await client.session.list({
      query: {directory: workspacePath},
      signal: AbortSignal.any([outerSignal, timeoutSignal]),
    })
    // A response.error here is a server answer, not a probe failure -- it proves
    // instance bootstrap completed.
    if (probe.error != null) {
      logger.debug('OpenCode readiness probe answered with an error body (server is ready)', {
        error: String(probe.error),
      })
    }
    return {kind: 'ready'}
  } catch (probeError) {
    // Checked in this order because if both fired, the outer deadline is the cause that
    // matters to the caller -- a cancelled run, not a stall this instance is responsible for.
    if (outerSignal.aborted) return {kind: 'aborted'}
    if (timeoutSignal.aborted) return {kind: 'timeout'}
    return {kind: 'transport', error: probeError}
  }
}

export async function bootstrapOpenCodeServer(
  signal: AbortSignal,
  logger: Logger,
  workspacePath: string,
  timeoutMs: number = DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS,
  readinessTimeoutMs: number = DEFAULT_SERVER_READINESS_TIMEOUT_MS,
): Promise<Result<OpenCodeServerHandle, Error>> {
  const startedAt = Date.now()
  // Time spent inside createOpencode specifically — the only window timeoutMs governs.
  let budgetedMs: number | null = null
  // Captured as soon as a server handle exists so the catch block can close it on any
  // failure that occurs after acquisition (e.g. a throw between obtaining the handle
  // and returning it) rather than leaking the child to the SDK's abort binding alone.
  let acquiredServer: {readonly url: string; close: () => void} | undefined
  try {
    const port = await pickFreePort()
    const pinnedUrl = `http://127.0.0.1:${port}`
    // Set the URL before spawn so the child (and the bundled session-tools
    // file tool inside it) captures it via env at spawn time. FRO_BOT_OPENCODE_URL
    // is allowlisted by filterAgentEnv, so it survives the scrub below. This var
    // is intentionally NOT reverted after bootstrap: it remains set in the
    // harness process too, which is harmless and aids debugging.
    process.env.FRO_BOT_OPENCODE_URL = pinnedUrl
    const spawnOptions = {signal, hostname: '127.0.0.1', port, timeout: timeoutMs}
    // Measured separately from the total: timeoutMs bounds this call alone, so comparing
    // it against time that also covers port acquisition would misreport the real margin.
    // Keeping both also separates a slow port bind from slow server init, which are
    // different faults on a contended runner.
    const spawnStartedAt = Date.now()
    const opencode = await withScrubbedEnv(async () => createOpencode(spawnOptions), logger)
    budgetedMs = Date.now() - spawnStartedAt
    const {client, server} = opencode
    acquiredServer = server
    if (server.url !== pinnedUrl) {
      // The child server (and the bundled session-tools file tool running inside it)
      // already captured pinnedUrl via FRO_BOT_OPENCODE_URL at spawn time. If the actual
      // bound URL differs, that env var is now stale and the file tool will talk to the
      // wrong server — updating the parent's env here would not fix that. Treat this as
      // a genuine bootstrap fault instead of papering over it.
      server.close()
      return err(new Error(`OpenCode server URL mismatch: pinned ${pinnedUrl} but server bound to ${server.url}`))
    }
    // createOpencode resolving means the listener bound, not that per-directory instance
    // bootstrap finished. Force it here with a bound so a blocked instance fails by name
    // instead of on the harness's first real request. Must be instance-scoped: a global
    // route answers while bootstrap is still blocked. session.list is read-only and the
    // harness issues it moments later anyway.
    const readinessStartedAt = Date.now()
    let outcome = await attemptReadinessProbe(client, workspacePath, signal, readinessTimeoutMs, logger)
    if (outcome.kind === 'transport') {
      // A transport failure against 127.0.0.1 (ECONNRESET, a socket hangup, a synchronous
      // client throw) is a local blip, not evidence the instance is stuck -- one immediate
      // retry before treating it as fatal.
      logger.warning('OpenCode readiness probe failed (retrying once)', {error: toErrorMessage(outcome.error)})
      outcome = await attemptReadinessProbe(client, workspacePath, signal, readinessTimeoutMs, logger)
    }
    if (outcome.kind !== 'ready') {
      // Read once, immediately after the last attempt settles and before any cleanup --
      // waitForServerQuiescence below can run for up to its own timeout budget, and a
      // second read afterward could catch a deadline that fired during cleanup, mislabeling
      // a genuine stall as a cancellation.
      const cancelledByOuterDeadline = signal.aborted
      const probeReadinessMs = Date.now() - readinessStartedAt
      logger.warning('OpenCode readiness probe failed', {
        outcome: outcome.kind,
        error: outcome.kind === 'transport' ? toErrorMessage(outcome.error) : undefined,
        readinessTimeoutMs,
        readinessMs: probeReadinessMs,
        cancelledByOuterDeadline,
      })
      server.close()
      const quiesced = await waitForServerQuiescence(server.url)
      logger.debug('OpenCode server quiesced after readiness-probe failure', {quiesced: quiesced.quiesced})
      if (outcome.kind === 'transport') {
        return err(
          new Error(
            `OpenCode server is listening but the readiness request failed twice against the ` +
              `local server: ${toErrorMessage(outcome.error)}`,
          ),
        )
      }
      // The outer `signal` is the caller's execution deadline, not this function's own
      // budget. If it fired while the probe was in flight, the probe never got a real
      // chance to answer -- that is a cancelled run, not evidence of a stalled server.
      if (cancelledByOuterDeadline) {
        return err(
          new Error('OpenCode server bootstrap cancelled by the execution deadline during the readiness probe'),
        )
      }
      return err(
        new Error(
          `OpenCode server is listening but did not answer an instance-scoped request within ` +
            `${readinessTimeoutMs}ms per attempt (${probeReadinessMs}ms total probe time) — instance bootstrap is blocked`,
        ),
      )
    }
    const readinessMs = Date.now() - readinessStartedAt
    const elapsedMs = Date.now() - startedAt
    logger.debug('OpenCode server bootstrapped', {url: server.url, timeoutMs, budgetedMs, readinessMs, elapsedMs})
    return ok({
      client,
      server,
      // Sends the kill signal via server.close(), then waits (bounded, best-effort) for
      // the child's port to stop answering before returning. See waitForServerQuiescence
      // above for why a port poll is the best available boundary and what quiesced: false
      // does and does not mean.
      shutdown: async () => {
        server.close()
        return waitForServerQuiescence(server.url)
      },
    })
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    const message = toErrorMessage(error)
    // budgetedMs is null when the failure happened before or inside the spawn; a null
    // here with elapsedMs at roughly timeoutMs is the signature of a budget timeout,
    // while a null with a much smaller elapsedMs points at port acquisition instead.
    logger.warning('Failed to bootstrap OpenCode server', {error: message, timeoutMs, budgetedMs, elapsedMs})
    // Defensive cleanup: if a handle was acquired before the failure, do not leave the
    // child's fate to the SDK's abort binding alone. Best-effort, matching the convention
    // this module's own checkpoint/integrity probes use for their close() calls
    // (checkpoint.ts, integrity.ts): this function's entire contract is to return a
    // Result rather than reject, and close() throwing here is the one path that would
    // otherwise turn a bootstrap failure into a rejection instead of an err().
    try {
      acquiredServer?.close()
    } catch {
      // best effort — the original failure is already captured in the err() returned below
    }
    return err(new Error(`Server bootstrap failed: ${message}`))
  }
}

export interface EnsureOpenCodeOptions {
  readonly logger: Logger
  readonly opencodeVersion: string
  readonly githubToken: string
  readonly authJson: string
  readonly enableOmo: boolean
  readonly omoVersion: string
  readonly systematicVersion: string
  readonly omoProviders: SetupInputs['omoProviders']
  readonly opencodeConfig: string | null
  readonly systematicConfig: string | null
  readonly enableOmoSlim: boolean
  readonly omoSlimVersion: string
  readonly omoSlimPreset: SetupInputs['omoSlimPreset']
  readonly credential: SetupInputs['credential']
}

export async function ensureOpenCodeAvailable(
  options: EnsureOpenCodeOptions,
  setupAdapter: SetupAdapter,
): Promise<EnsureOpenCodeResult> {
  const {logger, opencodeVersion} = options
  const existingPath = process.env.OPENCODE_PATH ?? null
  const check = await setupAdapter.verifyOpenCodeAvailable(existingPath, logger)

  if (check.available && check.version != null) {
    logger.info('OpenCode already available', {version: check.version})
    return {path: existingPath ?? 'opencode', version: check.version, didSetup: false}
  }

  logger.info('OpenCode not found, running auto-setup', {requestedVersion: opencodeVersion})
  const setupInputs: SetupInputs = {
    opencodeVersion,
    authJson: options.authJson,
    appId: null,
    privateKey: null,
    opencodeConfig: options.opencodeConfig,
    systematicConfig: options.systematicConfig,
    omoConfig: null,
    enableOmo: options.enableOmo,
    omoVersion: options.omoVersion,
    systematicVersion: options.systematicVersion,
    omoProviders: options.omoProviders,
    enableOmoSlim: options.enableOmoSlim,
    omoSlimVersion: options.omoSlimVersion,
    omoSlimPreset: options.omoSlimPreset,
    credential: options.credential,
  }
  const setupResult = await setupAdapter.runSetup(setupInputs, options.githubToken)
  if (setupResult == null) {
    throw new Error('Auto-setup failed: runSetup returned null')
  }

  // These take different halves of the same install on purpose. `addToPath` wants the directory;
  // OPENCODE_PATH is read back as an executable — by `verifyOpenCodeAvailable` above, by
  // @fro.bot/harness's `resolveBinary()`, and by every child that inherits it (filterAgentEnv
  // allows the OPENCODE_ prefix through). Assigning the directory here made all three exec it.
  setupAdapter.addToPath(setupResult.opencodePath)
  process.env.OPENCODE_PATH = setupResult.opencodeBinaryPath
  // Log both halves: the whole failure mode here is "which of these two strings got exported",
  // so a recurrence should be diagnosable from the run log alone.
  logger.info('Auto-setup completed', {
    version: setupResult.opencodeVersion,
    path: setupResult.opencodePath,
    binaryPath: setupResult.opencodeBinaryPath,
  })
  return {path: setupResult.opencodeBinaryPath, version: setupResult.opencodeVersion, didSetup: true}
}
