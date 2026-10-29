import type {ChildProcess} from 'node:child_process'
import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import net from 'node:net'
import process from 'node:process'
import {sleep} from '../shared/async.js'
import {toErrorMessage} from '../shared/errors.js'
import {err, ok} from '../shared/types.js'
import {filterAgentEnv} from './filter-env.js'

/**
 * Spawn, authenticate to, gate and shut down a stock OpenCode V2 server (`serve --stdio`).
 *
 * A sibling of `bootstrapOpenCodeServer` in `server.ts`, which stays untouched for V1. Raw HTTP with a few
 * minimal response parsers: only the endpoints this lifecycle needs, no SDK dependency.
 *
 * Facts this module is built on, all measured against v2.2.0 (probe results P1, P10, P11, P13, P15):
 * - `--stdio` exits when stdin closes, and exits after about 150 ms if stdin is `ignore`, so stdin is a held pipe.
 * - Without `--port` upstream binds 4096 and increments, so the port is always explicit.
 * - `GET /api/info` answers 200 while plugins are still activating. `GET /api/agent` answers 503
 *   ("Location plugins did not finish activating") until they finish, so readiness gates on `/api/agent`.
 * - Nothing upstream bounds a hung plugin activation. Every wait here has its own bound.
 * - A failed plugin leaves the server up and shows only as `state.status: 'failed'` in `GET /api/plugin`, whose
 *   error string carries paths and a stack. Only ids and statuses are ever reported here.
 * - Every 401 has the same body, so a 401 is reported as an auth failure and never retried.
 * - A stdin close or SIGTERM keeps an in-flight turn's execution claim (the shutdown reason is not `user`), and
 *   the next server may resume it. An interrupt over HTTP carries reason `user` and releases the claim, so
 *   shutdown interrupts first and closes stdin second.
 * - `{interrupted: false}` is ambiguous (idle, or the turn is not yet admitted), so it is never read as a stop.
 *   A stop needs the session to be absent from `GET /api/session/active` after an `{interrupted: true}` reply.
 */

export interface OpenCodeV2Timeouts {
  /** Time from spawn to the `{url}` line on stdout. Upstream boots in well under a second; this covers a cold runner. */
  readonly listenTimeoutMs: number
  /** Time for `GET /api/info` to answer 200. */
  readonly infoTimeoutMs: number
  /**
   * Time for `GET /api/agent` to stop answering 503. Covers a hung plugin activation, which upstream never
   * bounds (P10). Plugins are installed before the spawn, so a healthy activation takes seconds.
   */
  readonly agentReadyTimeoutMs: number
  /** Time, after `/api/agent` is ready, for every expected plugin to be listed active. The list is final by then. */
  readonly pluginGateTimeoutMs: number
  /** Cap on a single gate or shutdown request, so one unanswered request cannot consume a whole phase. */
  readonly requestTimeoutMs: number
  readonly pollIntervalMs: number
  /** Time for interrupted sessions to leave `GET /api/session/active`. Measured interrupts land in under 30 ms. */
  readonly interruptSettleTimeoutMs: number
  /** Time for the process to exit after stdin closes. Measured 10 to 150 ms. */
  readonly exitTimeoutMs: number
  /** Time to observe the exit after SIGKILL. */
  readonly killConfirmTimeoutMs: number
}

export const DEFAULT_OPENCODE_V2_TIMEOUTS: OpenCodeV2Timeouts = {
  listenTimeoutMs: 30_000,
  infoTimeoutMs: 15_000,
  agentReadyTimeoutMs: 120_000,
  pluginGateTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  pollIntervalMs: 100,
  interruptSettleTimeoutMs: 10_000,
  exitTimeoutMs: 5000,
  killConfirmTimeoutMs: 2000,
}

export type OpenCodeV2StartErrorKind =
  | 'aborted'
  | 'auth-failed'
  | 'exited-early'
  | 'invalid-options'
  | 'listen-timeout'
  | 'not-ready'
  | 'plugin-gate'
  | 'secret-registration-failed'
  | 'spawn-failed'
  | 'url-mismatch'

export type OpenCodeV2ExitOutcome = 'already-exited' | 'forced' | 'graceful' | 'unconfirmed'

export interface OpenCodeV2ExitInfo {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface OpenCodeV2PluginProblem {
  readonly id: string
  readonly status: 'absent' | 'failed'
}

/** A failed start. `message` never carries the password or a plugin's error text. */
export interface OpenCodeV2StartError {
  readonly kind: OpenCodeV2StartErrorKind
  readonly message: string
  /** Exit code of a child that died before it was ready. */
  readonly exitCode?: number | null
  /** Set for `plugin-gate`. */
  readonly plugins?: readonly OpenCodeV2PluginProblem[]
  /** What happened to the child on the way out of the failed start. */
  readonly cleanup?: OpenCodeV2ExitOutcome
}

export interface OpenCodeV2ShutdownOptions {
  /** Sessions this run owns. Each is interrupted, with reason `user`, before stdin closes. */
  readonly ownedSessionIds?: readonly string[]
}

export interface OpenCodeV2ShutdownResult {
  readonly interrupts: {
    /** Got `{interrupted: true}` and then left the active list. */
    readonly stopped: readonly string[]
    /** Never got `{interrupted: true}` and are not active: idle, or not admitted yet. Not a confirmed stop. */
    readonly notRunning: readonly string[]
    /** Still active at the bound, or the state could not be read. */
    readonly unconfirmed: readonly string[]
  }
  readonly exit: {readonly outcome: OpenCodeV2ExitOutcome} & OpenCodeV2ExitInfo
}

export interface OpenCodeV2ServerHandle {
  /** Always `http://127.0.0.1:<port>` on the port passed to the child. */
  readonly url: string
  readonly pid: number
  /** The location every gate request targeted. */
  readonly directory: string
  /** `fetch` against the server with Authorization and `x-opencode-directory` set. `path` is relative to `url`. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  /** For a proxy that injects the credential per request. A function, so serialising the handle cannot leak it. */
  readonly authorizationHeader: () => string
  /** Resolves on the process exit event. Never rejects. */
  readonly exited: Promise<OpenCodeV2ExitInfo>
  /**
   * Marks a session as owned by this run. Owned sessions are interrupted before stdin closes on every shutdown
   * path, including the caller's abort signal, which cannot carry ids of its own. Register a session as soon as it
   * exists.
   */
  readonly registerOwnedSession: (sessionId: string) => void
  /**
   * Interrupts owned sessions (registered ones plus `ownedSessionIds`), closes stdin and confirms the exit.
   * Idempotent and shared with the abort path: later calls return the first result, and ids that arrive after
   * the first call or after an abort are not interrupted.
   */
  readonly shutdown: (options?: OpenCodeV2ShutdownOptions) => Promise<OpenCodeV2ShutdownResult>
}

export interface OpenCodeV2Deps {
  /** Signal the child's process group. Default: `process.kill(-pid, signal)`. */
  readonly killGroup: (pid: number, signal: NodeJS.Signals) => void
}

export interface StartOpenCodeV2ServerOptions {
  /** The verified stock binary. */
  readonly binaryPath: string
  /** Child working directory, and the location the readiness and plugin gates ask about. */
  readonly directory: string
  /** Plugin ids that must be listed `active`. Empty skips the plugin gate. */
  readonly expectedPluginIds: readonly string[]
  /** Becomes `OPENCODE_CONFIG_CONTENT`. When absent the child gets none, whatever the parent environment holds. */
  readonly config?: Readonly<Record<string, unknown>>
  /** Source environment, scrubbed through `filterAgentEnv`. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Default: a free loopback port picked here. */
  readonly port?: number
  /**
   * Run the child as this uid and gid (POSIX). The workspace service is root and the server must not be. Both or
   * neither: when the spawn cannot take the identity it fails (`spawn-failed`), never falling back to the caller's.
   */
  readonly uid?: number
  readonly gid?: number
  readonly timeouts?: Partial<OpenCodeV2Timeouts>
  /**
   * The caller's deadline, honoured for the server's whole life. Aborting during startup fails the start. Aborting
   * afterwards runs the handle's `shutdown`. The signal governs the child only: shutdown's own requests use a bound
   * of their own, so an aborted signal never disables the owned-session interrupts.
   */
  readonly signal?: AbortSignal
  /**
   * Called with the generated password before the child is spawned, so the host can mask it
   * (`core.setSecret` in the Action). A throw fails the start, closed.
   */
  readonly maskSecret?: (value: string) => void
  readonly deps?: Partial<OpenCodeV2Deps>
}

const LOOPBACK = '127.0.0.1'
const BASIC_USERNAME = 'opencode'
const REDACTED = '[REDACTED]'
const MAX_STDOUT_LINE_BYTES = 64 * 1024

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // A negative pid addresses the group. The child is spawned detached, so the group is the server plus
    // everything its tools started, and a forced stop leaves no stragglers.
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    // Already gone.
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, LOOPBACK, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to determine an ephemeral port'))
        return
      }
      const {port} = address
      server.close(closeError => (closeError == null ? resolve(port) : reject(closeError)))
    })
  })
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535
}

/** Resolves true if `promise` settles before `ms`, false otherwise. Clears its timer either way. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true as const), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

interface ChildState {
  readonly process: ChildProcess
  readonly exited: Promise<OpenCodeV2ExitInfo>
  /** Set by the exit event; null while running. */
  exit: OpenCodeV2ExitInfo | null
}

function trackChild(child: ChildProcess): ChildState {
  const state: ChildState = {
    process: child,
    exit: null,
    exited: new Promise(resolve => {
      child.once('exit', (code, signal) => {
        state.exit = {code, signal}
        resolve({code, signal})
      })
    }),
  }
  return state
}

/**
 * Closes stdin, then escalates to SIGKILL on the process group, and reports what was observed. Used by
 * shutdown and by every failed-start path, so no failure leaves a server behind.
 */
async function terminateChild(
  state: ChildState,
  timeouts: OpenCodeV2Timeouts,
  deps: OpenCodeV2Deps,
  logger: Logger,
): Promise<{readonly outcome: OpenCodeV2ExitOutcome} & OpenCodeV2ExitInfo> {
  if (state.exit !== null) return {outcome: 'already-exited', ...state.exit}
  const pid = state.process.pid
  try {
    state.process.stdin?.end()
  } catch {
    // The pipe is already closed; the exit wait below decides what happens next.
  }
  if (await settlesWithin(state.exited, timeouts.exitTimeoutMs)) {
    const exit = await state.exited
    return {outcome: 'graceful', ...exit}
  }
  logger.warning('OpenCode V2 server did not exit after stdin closed; killing its process group', {
    pid,
    exitTimeoutMs: timeouts.exitTimeoutMs,
  })
  if (pid !== undefined) deps.killGroup(pid, 'SIGKILL')
  if (await settlesWithin(state.exited, timeouts.killConfirmTimeoutMs)) {
    const exit = await state.exited
    return {outcome: 'forced', ...exit}
  }
  logger.error('OpenCode V2 server exit could not be confirmed after SIGKILL', {pid})
  return {outcome: 'unconfirmed', code: null, signal: null}
}

type RequestOutcome =
  {readonly kind: 'response'; readonly status: number; readonly body: unknown} | {readonly kind: 'unreachable'}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface PluginEntry {
  readonly id: string | undefined
  readonly status: 'active' | 'failed' | 'unknown'
}

/** `GET /api/plugin` is `{location, data: Plugin.Info[]}`; `Plugin.Info.state` is `active` or `failed` (schema/src/plugin.ts:45-46). */
function parsePluginList(body: unknown): readonly PluginEntry[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null
  return body.data.map((entry: unknown): PluginEntry => {
    if (!isRecord(entry)) return {id: undefined, status: 'unknown'}
    const status = isRecord(entry.state) ? entry.state.status : undefined
    return {
      id: typeof entry.id === 'string' ? entry.id : undefined,
      status: status === 'active' || status === 'failed' ? status : 'unknown',
    }
  })
}

/** `GET /api/session/active` is `{data: Record<SessionID, {type}>}` (protocol/src/groups/session.ts:220). */
function parseActiveSessions(body: unknown): ReadonlySet<string> | null {
  if (!isRecord(body) || !isRecord(body.data)) return null
  return new Set(Object.keys(body.data))
}

function isInterrupted(body: unknown): boolean {
  return isRecord(body) && body.interrupted === true
}

/** Which expected ids are not active. Matching is by id, never by presence of any entry (P13). */
function classifyExpectedPlugins(
  expected: readonly string[],
  entries: readonly PluginEntry[],
): readonly OpenCodeV2PluginProblem[] {
  const problems: OpenCodeV2PluginProblem[] = []
  for (const id of expected) {
    const matching = entries.filter(entry => entry.id === id)
    if (matching.some(entry => entry.status === 'failed')) problems.push({id, status: 'failed'})
    else if (!matching.some(entry => entry.status === 'active')) problems.push({id, status: 'absent'})
  }
  return problems
}

function pluginGateError(problems: readonly OpenCodeV2PluginProblem[]): OpenCodeV2StartError {
  // Ids and statuses only. A failed plugin's `state.error` holds absolute paths and a stack trace (P13).
  const named = problems.map(problem => `${problem.id} (${problem.status})`).join(', ')
  return startError('plugin-gate', `Required OpenCode plugin(s) not active: ${named}`, {plugins: problems})
}

function startError(
  kind: OpenCodeV2StartErrorKind,
  message: string,
  extra: Partial<OpenCodeV2StartError> = {},
): OpenCodeV2StartError {
  return {kind, message, ...extra}
}

export async function startOpenCodeV2Server(
  options: StartOpenCodeV2ServerOptions,
  logger: Logger,
): Promise<Result<OpenCodeV2ServerHandle, OpenCodeV2StartError>> {
  const timeouts: OpenCodeV2Timeouts = {...DEFAULT_OPENCODE_V2_TIMEOUTS, ...options.timeouts}
  const deps: OpenCodeV2Deps = {killGroup: killProcessGroup, ...options.deps}
  const {signal} = options

  if (options.port !== undefined && !isValidPort(options.port)) {
    return err(startError('invalid-options', 'The OpenCode V2 server port is out of range'))
  }
  // A uid without a gid would keep the caller's group, which is half a privilege drop.
  if ((options.uid === undefined) !== (options.gid === undefined)) {
    return err(startError('invalid-options', 'The OpenCode V2 server uid and gid must be given together'))
  }

  // Per spawn, never reused and never logged. 256 random bits.
  const password = randomBytes(32).toString('base64url')
  const authorization = `Basic ${Buffer.from(`${BASIC_USERNAME}:${password}`).toString('base64')}`
  const scrub = (text: string): string => text.split(password).join(REDACTED)

  try {
    options.maskSecret?.(password)
  } catch (error) {
    return err(
      startError(
        'secret-registration-failed',
        `Could not register the server password for masking: ${scrub(toErrorMessage(error))}`,
      ),
    )
  }

  let port: number
  try {
    port = options.port ?? (await pickFreePort())
  } catch (error) {
    return err(
      startError('spawn-failed', `Could not pick a port for the OpenCode V2 server: ${scrub(toErrorMessage(error))}`),
    )
  }
  const expectedUrl = `http://${LOOPBACK}:${port}`

  // Scrubbed first, then the spawn-owned values on top. The password is added after the filter on purpose:
  // `filterAgentEnv` drops anything ending in `_PASSWORD`, so it can only reach the child through here.
  const childEnv: NodeJS.ProcessEnv = {...filterAgentEnv(options.env ?? process.env)}
  delete childEnv.OPENCODE_CONFIG_CONTENT
  if (options.config !== undefined) childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(options.config)
  childEnv.OPENCODE_PASSWORD = password
  // Project config can re-allow what the CI config denies (P4/P6); it is never read.
  childEnv.OPENCODE_DISABLE_PROJECT_CONFIG = '1'
  // A self-update would replace the digest-verified binary mid-run.
  childEnv.OPENCODE_DISABLE_AUTOUPDATE = '1'

  let child: ChildProcess
  try {
    child = spawn(options.binaryPath, ['serve', '--stdio', '--hostname', LOOPBACK, '--port', String(port)], {
      cwd: options.directory,
      env: childEnv,
      // A held pipe: with 'ignore' the server exits after about 150 ms (P15). stderr is not captured because the
      // server may echo config content, which can hold provider credentials.
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
      ...(options.uid === undefined ? {} : {uid: options.uid}),
      ...(options.gid === undefined ? {} : {gid: options.gid}),
    })
  } catch (error) {
    // Node throws synchronously for a uid or gid the process may not take (EPERM). The password is in the env
    // that was passed, so only the code is reported.
    const code = (error as NodeJS.ErrnoException).code
    const failure = startError(
      'spawn-failed',
      `Failed to spawn the OpenCode V2 binary${code === undefined ? '' : ` (${code})`}`,
    )
    logger.warning('OpenCode V2 server start failed', {kind: failure.kind})
    return err(failure)
  }
  const state = trackChild(child)
  // The server closing its end of the pipe at exit raises EPIPE on a late write; there is nothing to do about it.
  child.stdin?.on('error', () => undefined)

  const spawnFailure = new Promise<OpenCodeV2StartError>(resolve => {
    child.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      resolve(
        startError('spawn-failed', `Failed to spawn the OpenCode V2 binary${code === undefined ? '' : ` (${code})`}`),
      )
    })
  })

  if (child.pid === undefined) {
    // A child that never spawned has no pid and no exit event to wait for.
    const failure = await spawnFailure
    logger.warning('OpenCode V2 server start failed', {kind: failure.kind})
    return err(failure)
  }
  const pid = child.pid

  const fail = async (error: OpenCodeV2StartError): Promise<Result<OpenCodeV2ServerHandle, OpenCodeV2StartError>> => {
    const cleanup = (await terminateChild(state, timeouts, deps, logger)).outcome
    logger.warning('OpenCode V2 server start failed', {kind: error.kind, cleanup, exitCode: error.exitCode})
    return err({...error, cleanup})
  }

  const aborted = (): OpenCodeV2StartError =>
    startError('aborted', 'OpenCode V2 server start was cancelled by the caller')

  // --- The listening line ---------------------------------------------------------------------------------
  const listening = new Promise<string>(resolve => {
    let buffered = ''
    let found = false
    child.stdout?.on('data', (chunk: Buffer) => {
      // After the url line this still drains stdout, so a full pipe never blocks the server.
      if (found) return
      buffered += chunk.toString('utf8')
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const parsed = parseJson(line)
        if (isRecord(parsed) && typeof parsed.url === 'string') {
          found = true
          resolve(parsed.url)
          return
        }
        newline = buffered.indexOf('\n')
      }
      if (buffered.length > MAX_STDOUT_LINE_BYTES) buffered = ''
    })
  })

  let onAbort: (() => void) | undefined
  const abortPromise = new Promise<'aborted'>(resolve => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve('aborted')
      return
    }
    onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, {once: true})
  })

  // A timer that is always cleared, so a successful start leaves nothing pending.
  let listenTimer: NodeJS.Timeout | undefined
  const listenTimeout = new Promise<'timeout'>(resolve => {
    listenTimer = setTimeout(() => resolve('timeout'), timeouts.listenTimeoutMs)
  })
  let reportedUrl: string
  try {
    const first = await Promise.race([
      listening.then(url => ({tag: 'url' as const, url})),
      state.exited.then(exit => ({tag: 'exit' as const, exit})),
      spawnFailure.then(error => ({tag: 'spawn-error' as const, error})),
      abortPromise.then(() => ({tag: 'abort' as const})),
      listenTimeout.then(() => ({tag: 'timeout' as const})),
    ])
    if (first.tag === 'spawn-error') return await fail(first.error)
    if (first.tag === 'abort') return await fail(aborted())
    if (first.tag === 'exit') {
      return await fail(
        startError('exited-early', `The OpenCode V2 server exited before it was listening (code ${first.exit.code})`, {
          exitCode: first.exit.code,
        }),
      )
    }
    if (first.tag === 'timeout') {
      return await fail(
        startError(
          'listen-timeout',
          `The OpenCode V2 server printed no listening line within ${timeouts.listenTimeoutMs}ms`,
        ),
      )
    }
    reportedUrl = first.url
  } finally {
    clearTimeout(listenTimer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }

  // The child bound the port it was told to. Anything else means the readiness requests below would reach a
  // different server than the one this process spawned.
  if (reportedUrl !== expectedUrl) {
    return fail(
      startError('url-mismatch', `The OpenCode V2 server reported an unexpected address; expected ${expectedUrl}`),
    )
  }
  logger.info('OpenCode V2 server is listening', {url: expectedUrl, pid})

  // --- Requests ---------------------------------------------------------------------------------------------
  const locationHeader = encodeURIComponent(options.directory)

  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('authorization', authorization)
    headers.set('x-opencode-directory', locationHeader)
    return fetch(`${expectedUrl}${path}`, {...init, headers})
  }

  /** One request bounded by `requestTimeoutMs` and by `governing`, when given. */
  const boundedRequest = async (
    path: string,
    init: RequestInit,
    governing: AbortSignal | undefined,
  ): Promise<RequestOutcome> => {
    const timeout = AbortSignal.timeout(timeouts.requestTimeoutMs)
    try {
      const response = await send(path, {
        ...init,
        signal: governing === undefined ? timeout : AbortSignal.any([governing, timeout]),
      })
      const body = parseJson(await response.text())
      return {kind: 'response', status: response.status, body}
    } catch {
      // Refused, reset, timed out or aborted. The caller reads `signal.aborted` and the exit state to tell which.
      return {kind: 'unreachable'}
    }
  }

  /** Startup requests: governed by the caller's signal. */
  const request = async (path: string, init: RequestInit = {}): Promise<RequestOutcome> =>
    boundedRequest(path, init, signal)

  type PollDecision<T> =
    | {readonly kind: 'done'; readonly value: T}
    | {readonly kind: 'fail'; readonly error: OpenCodeV2StartError}
    | {readonly kind: 'retry'; readonly note: string}

  /** Retries `attempt` until it decides, the child dies, the caller aborts or `timeoutMs` passes. */
  const poll = async <T>(
    timeoutMs: number,
    attempt: () => Promise<PollDecision<T>>,
    onTimeout: (lastNote: string) => OpenCodeV2StartError,
  ): Promise<{readonly ok: true; readonly value: T} | {readonly ok: false; readonly error: OpenCodeV2StartError}> => {
    const deadline = Date.now() + timeoutMs
    let lastNote = 'no response'
    for (;;) {
      if (signal?.aborted === true) return {ok: false, error: aborted()}
      if (state.exit !== null) {
        return {
          ok: false,
          error: startError('exited-early', `The OpenCode V2 server exited during startup (code ${state.exit.code})`, {
            exitCode: state.exit.code,
          }),
        }
      }
      const decision = await attempt()
      if (decision.kind === 'done') return {ok: true, value: decision.value}
      if (decision.kind === 'fail') return {ok: false, error: decision.error}
      lastNote = decision.note
      if (Date.now() >= deadline) return {ok: false, error: onTimeout(lastNote)}
      await sleep(timeouts.pollIntervalMs)
    }
  }

  const unauthorized = (): OpenCodeV2StartError =>
    startError(
      'auth-failed',
      'The OpenCode V2 server rejected the credentials generated for this spawn (HTTP 401); it may not be the server that was just spawned',
    )

  // --- Gate 1: /api/info (the server is up and accepts our credentials) --------------------------------------
  const info = await poll<true>(
    timeouts.infoTimeoutMs,
    async () => {
      const outcome = await request('/api/info')
      if (outcome.kind === 'unreachable') return {kind: 'retry', note: 'unreachable'}
      if (outcome.status === 401) return {kind: 'fail', error: unauthorized()}
      return outcome.status === 200 ? {kind: 'done', value: true} : {kind: 'retry', note: `HTTP ${outcome.status}`}
    },
    note =>
      startError(
        'not-ready',
        `The OpenCode V2 server did not answer /api/info within ${timeouts.infoTimeoutMs}ms (${note})`,
      ),
  )
  if (!info.ok) return fail(info.error)

  // --- Gate 2: /api/agent (plugin activation finished). /api/info answers 200 before this (P10). -------------
  const agents = await poll<true>(
    timeouts.agentReadyTimeoutMs,
    async () => {
      const outcome = await request('/api/agent')
      if (outcome.kind === 'unreachable') return {kind: 'retry', note: 'unreachable'}
      if (outcome.status === 401) return {kind: 'fail', error: unauthorized()}
      return outcome.status === 200 ? {kind: 'done', value: true} : {kind: 'retry', note: `HTTP ${outcome.status}`}
    },
    note =>
      startError(
        'not-ready',
        `OpenCode V2 plugins did not finish activating within ${timeouts.agentReadyTimeoutMs}ms (/api/agent: ${note})`,
      ),
  )
  if (!agents.ok) return fail(agents.error)

  // --- Gate 3: expected plugins are listed active ----------------------------------------------------------
  if (options.expectedPluginIds.length > 0) {
    let lastProblems: readonly OpenCodeV2PluginProblem[] = options.expectedPluginIds.map(id => ({id, status: 'absent'}))
    const gate = await poll<true>(
      timeouts.pluginGateTimeoutMs,
      async () => {
        const outcome = await request('/api/plugin')
        if (outcome.kind === 'unreachable') return {kind: 'retry', note: 'unreachable'}
        if (outcome.status === 401) return {kind: 'fail', error: unauthorized()}
        const entries = outcome.status === 200 ? parsePluginList(outcome.body) : null
        if (entries === null) return {kind: 'retry', note: `HTTP ${outcome.status}`}
        const problems = classifyExpectedPlugins(options.expectedPluginIds, entries)
        lastProblems = problems
        if (problems.length === 0) return {kind: 'done', value: true}
        // A listed failure is final: activation already finished, so waiting changes nothing.
        if (problems.some(problem => problem.status === 'failed'))
          return {kind: 'fail', error: pluginGateError(problems)}
        return {kind: 'retry', note: 'expected plugins not active yet'}
      },
      () => pluginGateError(lastProblems),
    )
    if (!gate.ok) return fail(gate.error)
  }

  // --- Shutdown -----------------------------------------------------------------------------------------------
  // Teardown requests never use the caller's signal: after a cancellation it is already aborted, and cleanup
  // is exactly when the server must still be reachable. Each is bounded by `requestTimeoutMs` and by the
  // interrupt-settle bound, a signal created when the interrupt round starts.
  const readActiveSessions = async (cleanup: AbortSignal): Promise<ReadonlySet<string> | null> => {
    const outcome = await boundedRequest('/api/session/active', {}, cleanup)
    return outcome.kind === 'response' && outcome.status === 200 ? parseActiveSessions(outcome.body) : null
  }

  const interruptOwnedSessions = async (ids: readonly string[]): Promise<OpenCodeV2ShutdownResult['interrupts']> => {
    if (ids.length === 0) return {stopped: [], notRunning: [], unconfirmed: []}
    const deadline = Date.now() + timeouts.interruptSettleTimeoutMs
    const cleanup = AbortSignal.timeout(timeouts.interruptSettleTimeoutMs)
    const remaining = new Set(ids)
    const interrupted = new Set<string>()
    const stopped: string[] = []
    const notRunning: string[] = []

    // POST /api/session/:id/interrupt carries reason `user`, which releases the execution claim (P11).
    const interrupt = async (id: string): Promise<void> => {
      const outcome = await boundedRequest(
        `/api/session/${encodeURIComponent(id)}/interrupt`,
        {method: 'POST'},
        cleanup,
      )
      if (outcome.kind === 'response' && outcome.status === 200 && isInterrupted(outcome.body)) interrupted.add(id)
    }

    await Promise.all(ids.map(interrupt))
    for (;;) {
      const active = await readActiveSessions(cleanup)
      if (active !== null) {
        for (const id of [...remaining]) {
          if (active.has(id)) continue
          remaining.delete(id)
          if (interrupted.has(id)) stopped.push(id)
          else notRunning.push(id)
        }
        if (remaining.size === 0) break
      }
      if (Date.now() >= deadline) break
      // Still active: a reply of `interrupted:false` may only mean the turn was not admitted yet (P1), so ask again.
      if (active !== null) await Promise.all([...remaining].map(interrupt))
      await sleep(timeouts.pollIntervalMs)
    }
    return {stopped, notRunning, unconfirmed: [...remaining]}
  }

  const runShutdown = async (ownedSessionIds: readonly string[]): Promise<OpenCodeV2ShutdownResult> => {
    // A dead server cannot be asked anything. Any claim it left is the pre-spawn clear's job.
    const interrupts =
      state.exit === null
        ? await interruptOwnedSessions(ownedSessionIds)
        : {stopped: [], notRunning: [], unconfirmed: [...ownedSessionIds]}
    const exit = await terminateChild(state, timeouts, deps, logger)
    logger.info('OpenCode V2 server shut down', {
      outcome: exit.outcome,
      exitCode: exit.code,
      owned: ownedSessionIds.length,
      stopped: interrupts.stopped.length,
      notRunning: interrupts.notRunning.length,
      unconfirmed: interrupts.unconfirmed.length,
    })
    return {interrupts, exit}
  }

  // A cancellation that landed between the last gate and here has nothing to shut down yet: fail the start.
  if (signal?.aborted === true) return fail(aborted())

  const ownedSessionIds = new Set<string>()
  let shutdownResult: Promise<OpenCodeV2ShutdownResult> | undefined
  const shutdown = async (shutdownOptions?: OpenCodeV2ShutdownOptions): Promise<OpenCodeV2ShutdownResult> => {
    shutdownResult ??= runShutdown([...new Set([...ownedSessionIds, ...(shutdownOptions?.ownedSessionIds ?? [])])])
    return shutdownResult
  }

  // The caller's signal keeps governing the child for its whole life: an abort runs the same shared shutdown.
  if (signal !== undefined) {
    const onLifetimeAbort = (): void => {
      logger.info('OpenCode V2 server stopping: the caller aborted', {pid})
      shutdown().catch((error: unknown) => {
        logger.error('OpenCode V2 server shutdown after abort failed', {error: scrub(toErrorMessage(error))})
      })
    }
    signal.addEventListener('abort', onLifetimeAbort, {once: true})
    state.exited.then(
      () => signal.removeEventListener('abort', onLifetimeAbort),
      () => undefined,
    )
  }

  return ok({
    url: expectedUrl,
    pid,
    directory: options.directory,
    fetch: send,
    authorizationHeader: () => authorization,
    exited: state.exited,
    registerOwnedSession: sessionId => {
      ownedSessionIds.add(sessionId)
    },
    shutdown,
  })
}
