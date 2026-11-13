import type {Buffer} from 'node:buffer'
import type {ChildProcess} from 'node:child_process'
import type {Result} from '@bfra.me/es/result'
import type {KeyProxyProtocol, KeyProxyProviderConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {err, ok} from '@bfra.me/es/result'
import {buildKeyProxyUpstream, encodeKeyProxyConfig, parseKeyProxyChildLine} from '@fro-bot/runtime'

/**
 * Runs the key proxy as a child process and supervises it.
 *
 * The child (`dist/key-proxy.js`) holds the provider keys; this module holds only the child handle and the run's
 * placeholder. The keys, the upstream map and the placeholder reach the child as one framed config on its stdin, which
 * then stays open: closing it is how the child is told to stop, and also how it learns the Action is gone.
 *
 * SECURITY INVARIANTS:
 * 1. The child gets an empty environment, no arguments but its script, and no key anywhere but its stdin.
 * 2. The exit watcher is registered at spawn, before the child can be declared ready. An exit that this module did not
 *    ask for is latched as a crash and aborts `died`, however late it comes.
 * 3. `stop` marks the stop as intentional before it closes stdin, closes stdin, allows a short grace, then kills the
 *    process group and confirms the exit. A child whose exit cannot be confirmed is reported `unconfirmed`, never stopped.
 * 4. Nothing the child writes is logged or quoted: a start failure carries a fixed kind and message.
 */

/** How to run the child. Production is `process.execPath` and the bundle's `key-proxy.js`; tests inject their own. */
export interface KeyProxyLauncher {
  readonly command: string
  readonly args: readonly string[]
}

/** The production launcher: this bundle's sibling `key-proxy.js`. Only meaningful in the bundled Action. */
export function defaultKeyProxyLauncher(): KeyProxyLauncher {
  return {command: process.execPath, args: [fileURLToPath(new URL('./key-proxy.js', import.meta.url))]}
}

/** One provider the proxy serves: the resolved plan plus its real key. */
export interface KeyProxyProviderInput {
  readonly providerId: string
  readonly key: string
  readonly baseUrl: string | null
  readonly protocols: readonly KeyProxyProtocol[]
}

export interface KeyProxyProcessTimeouts {
  /** From spawn to the ready line. */
  readonly readyMs: number
  /** After stdin closes, before the process group is killed. */
  readonly exitGraceMs: number
  /** After SIGKILL, to observe the exit. */
  readonly killConfirmMs: number
}

const DEFAULT_TIMEOUTS: KeyProxyProcessTimeouts = {readyMs: 10_000, exitGraceMs: 2000, killConfirmMs: 2000}

export interface StartKeyProxyProcessOptions {
  readonly providers: readonly KeyProxyProviderInput[]
  readonly logger: Logger
  /** Defaults to {@link defaultKeyProxyLauncher}. */
  readonly launcher?: KeyProxyLauncher
  readonly timeouts?: Partial<KeyProxyProcessTimeouts>
  readonly signal?: AbortSignal
  /**
   * Test seams. Nothing here is reachable from an Action input, an environment variable or `opencode-config`: only code
   * that calls this function can set them.
   */
  readonly testing?: {readonly upstreamCa?: string}
  readonly deps?: {readonly killGroup?: (pid: number, signal: NodeJS.Signals) => void}
}

export type KeyProxyStartErrorKind =
  'aborted' | 'bad-ready' | 'child-error' | 'exited-early' | 'invalid-providers' | 'ready-timeout' | 'spawn-failed'

export interface KeyProxyStartError {
  readonly kind: KeyProxyStartErrorKind
  /** Names a provider id or a fixed reason. Never a key, a path or anything the child printed. */
  readonly message: string
  /** Set when the failed start could not confirm the child exited. */
  readonly cleanup?: 'unconfirmed'
}

export type KeyProxyStopOutcome = 'already-exited' | 'killed' | 'stopped' | 'unconfirmed'

export interface KeyProxyStopResult {
  readonly outcome: KeyProxyStopOutcome
  /** The child exited before this module asked it to. */
  readonly crashed: boolean
}

export interface KeyProxyProcess {
  readonly pid: number
  readonly port: number
  /** The per-run credential the sandboxed server presents. Not a real key. */
  readonly placeholder: string
  /** The `baseURL` for a provider: `http://127.0.0.1:<port>/<providerId>`. */
  readonly baseUrl: (providerId: string) => string
  /** Aborts when the child exits without being asked to. Latched. */
  readonly died: AbortSignal
  readonly crashed: () => boolean
  /** Closes stdin, then kills and confirms. Idempotent: later calls return the first result. */
  readonly stop: () => Promise<KeyProxyStopResult>
}

const MAX_READY_LINE_BYTES = 4096

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    // Already gone.
  }
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true as const), timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function buildProviderConfigs(
  inputs: readonly KeyProxyProviderInput[],
): Result<readonly KeyProxyProviderConfig[], KeyProxyStartError> {
  const configs: KeyProxyProviderConfig[] = []
  for (const input of inputs) {
    const upstream = buildKeyProxyUpstream({
      providerId: input.providerId,
      baseUrl: input.baseUrl,
      protocols: input.protocols,
    })
    if (!upstream.success) {
      return err({kind: 'invalid-providers', message: `Provider "${input.providerId}": ${upstream.error}`})
    }
    configs.push({id: input.providerId, key: input.key, origin: upstream.data.origin, routes: upstream.data.routes})
  }
  return ok(configs)
}

export async function startKeyProxyProcess(
  options: StartKeyProxyProcessOptions,
): Promise<Result<KeyProxyProcess, KeyProxyStartError>> {
  const {logger} = options
  const timeouts: KeyProxyProcessTimeouts = {...DEFAULT_TIMEOUTS, ...options.timeouts}
  const launcher = options.launcher ?? defaultKeyProxyLauncher()
  const killGroup = options.deps?.killGroup ?? killProcessGroup

  const providers = buildProviderConfigs(options.providers)
  if (!providers.success) return err(providers.error)

  const placeholder = randomBytes(32).toString('base64url')
  const frame = encodeKeyProxyConfig({
    version: 1,
    placeholder,
    providers: providers.data,
    ...(options.testing?.upstreamCa === undefined ? {} : {ca: options.testing.upstreamCa}),
  })

  let child: ChildProcess
  try {
    child = spawn(launcher.command, [...launcher.args], {
      env: {},
      cwd: '/',
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    })
  } catch {
    return err({kind: 'spawn-failed', message: 'The key proxy could not be started'})
  }

  const died = new AbortController()
  const state: {
    exit: {code: number | null; signal: NodeJS.Signals | null} | null
    stopping: boolean
    crashed: boolean
  } = {exit: null, stopping: false, crashed: false}

  // Registered now, before anything can declare the child ready: an exit at any later point is seen.
  const exited = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => {
      state.exit = {code, signal}
      if (!state.stopping) {
        state.crashed = true
        died.abort(new Error('The key proxy exited unexpectedly'))
      }
      resolve()
    })
  })
  const spawnFailure = new Promise<'spawn-failed'>(resolve => {
    child.once('error', () => resolve('spawn-failed'))
  })
  child.stdin?.on('error', () => undefined)

  const terminate = async (): Promise<KeyProxyStopOutcome> => {
    state.stopping = true
    if (state.exit !== null) return 'already-exited'
    try {
      child.stdin?.end()
    } catch {
      // The pipe is already closed; the exit wait decides.
    }
    if (await settlesWithin(exited, timeouts.exitGraceMs)) return 'stopped'
    if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
    if (await settlesWithin(exited, timeouts.killConfirmMs)) return 'killed'
    logger.error('The key proxy exit could not be confirmed after SIGKILL')
    return 'unconfirmed'
  }

  const failStart = async (error: KeyProxyStartError): Promise<Result<never, KeyProxyStartError>> => {
    const outcome = await terminate()
    logger.warning('The key proxy did not start', {kind: error.kind, cleanup: outcome})
    return err(outcome === 'unconfirmed' ? {...error, cleanup: 'unconfirmed'} : error)
  }

  if (child.pid === undefined) {
    await spawnFailure
    state.stopping = true
    return err({kind: 'spawn-failed', message: 'The key proxy could not be started'})
  }
  const pid = child.pid

  type Ready = {readonly kind: 'ready'; readonly port: number} | {readonly kind: 'bad'} | {readonly kind: 'error'}
  const ready = new Promise<Ready>(resolve => {
    let buffered = ''
    let decided = false
    child.stdout?.on('data', (chunk: Buffer) => {
      // After the first line this still drains stdout, so a full pipe never blocks the child.
      if (decided) return
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline === -1) {
        if (buffered.length > MAX_READY_LINE_BYTES) {
          decided = true
          resolve({kind: 'bad'})
        }
        return
      }
      decided = true
      const line = parseKeyProxyChildLine(buffered.slice(0, newline))
      if (line.kind === 'ready') resolve({kind: 'ready', port: line.port})
      else resolve({kind: line.kind === 'error' ? 'error' : 'bad'})
    })
  })

  child.stdin?.write(frame, () => undefined)

  let abortListener: (() => void) | undefined
  const aborted = new Promise<'aborted'>(resolve => {
    if (options.signal === undefined) return
    if (options.signal.aborted) {
      resolve('aborted')
      return
    }
    abortListener = () => resolve('aborted')
    options.signal.addEventListener('abort', abortListener, {once: true})
  })
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const readyTimeout = new Promise<'timeout'>(resolve => {
    readyTimer = setTimeout(() => resolve('timeout'), timeouts.readyMs)
  })

  let first: Ready | 'aborted' | 'exited' | 'spawn-failed' | 'timeout'
  try {
    first = await Promise.race([ready, exited.then(() => 'exited' as const), spawnFailure, aborted, readyTimeout])
  } finally {
    clearTimeout(readyTimer)
    if (abortListener !== undefined) options.signal?.removeEventListener('abort', abortListener)
  }

  if (first === 'aborted') return failStart({kind: 'aborted', message: 'The key proxy start was cancelled'})
  if (first === 'exited') return failStart({kind: 'exited-early', message: 'The key proxy exited before it was ready'})
  if (first === 'spawn-failed') {
    return failStart({kind: 'spawn-failed', message: 'The key proxy could not be started'})
  }
  if (first === 'timeout') {
    return failStart({kind: 'ready-timeout', message: 'The key proxy did not become ready in time'})
  }
  if (first.kind === 'error') {
    return failStart({kind: 'child-error', message: 'The key proxy refused its configuration or could not listen'})
  }
  if (first.kind === 'bad') {
    return failStart({kind: 'bad-ready', message: 'The key proxy printed an unexpected start-up line'})
  }
  const {port} = first

  logger.info('Key proxy started', {providers: options.providers.map(provider => provider.providerId), pid})

  let stopped: Promise<KeyProxyStopResult> | undefined
  return ok({
    pid,
    port,
    placeholder,
    baseUrl: providerId => `http://127.0.0.1:${port}/${providerId}`,
    died: died.signal,
    crashed: () => state.crashed,
    stop: async () => {
      stopped ??= terminate().then(outcome => ({outcome, crashed: state.crashed}))
      return stopped
    },
  })
}
