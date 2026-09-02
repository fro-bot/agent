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
  DEFAULT_SHUTDOWN_QUIESCE_POLL_INTERVAL_MS,
  DEFAULT_SHUTDOWN_QUIESCE_TIMEOUT_MS,
} from '../shared/constants.js'
import {err, ok} from '../shared/types.js'
import {withScrubbedEnv} from './with-scrubbed-env.js'

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

// Best-effort liveness probe for the OpenCode child, used only by shutdown() below.
// Resolves true while something answers a TCP connect on the given host/port, false the
// instant the connection is refused (or otherwise errors) -- which, for a port this
// process itself bound moments earlier via pickFreePort/createOpencode, only happens once
// the process holding it has actually exited and the OS has reclaimed the socket.
async function isPortOpen(hostname: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({host: hostname, port})
    const finish = (result: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
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

  const deadline = Date.now() + timeoutMs
  do {
    const stillOpen = await isPortOpen(hostname, port)
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

export async function bootstrapOpenCodeServer(
  signal: AbortSignal,
  logger: Logger,
  timeoutMs: number = DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS,
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
    const elapsedMs = Date.now() - startedAt
    logger.debug('OpenCode server bootstrapped', {url: server.url, timeoutMs, budgetedMs, elapsedMs})
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
    const message = error instanceof Error ? error.message : String(error)
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

  setupAdapter.addToPath(setupResult.opencodePath)
  process.env.OPENCODE_PATH = setupResult.opencodePath
  logger.info('Auto-setup completed', {version: setupResult.opencodeVersion, path: setupResult.opencodePath})
  return {path: setupResult.opencodePath, version: setupResult.opencodeVersion, didSetup: true}
}
