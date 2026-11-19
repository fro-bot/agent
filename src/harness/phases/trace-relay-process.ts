import type {Buffer} from 'node:buffer'
import type {ChildProcess} from 'node:child_process'
import type {Result} from '@bfra.me/es/result'
import type {TraceRelayBatchCounts, TraceRelayHeader, TraceRelayPluginCounts} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {spawn} from 'node:child_process'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {err, ok} from '@bfra.me/es/result'
import {encodeTraceRelayConfig, parseTraceRelayChildLine, parseTraceRelayConfig} from '@fro-bot/runtime'

/**
 * Runs the trace relay as a child process and supervises it, fail-soft.
 *
 * The child (`dist/trace-relay.js`) holds the collector credential; this module holds only the child handle. The URL and
 * the credential headers reach the child as one framed config on its stdin, which then stays open: closing it is how the
 * child is told to stop (and how it learns the Action is gone). The child prints one ready line, and one report line with
 * its batch counts after stdin closes.
 *
 * Unlike the key proxy, the relay is optional: tracing never fails a run. A start failure, a ready timeout or a later
 * crash logs one warning with a fixed reason and nothing else happens. No abort signal is exposed, so nothing can join the
 * relay's death to the server's lifetime or to the run's persistence decision.
 *
 * SECURITY INVARIANTS:
 * 1. The child gets an empty environment, no arguments but its script, and no credential anywhere but its stdin. The
 *    credential and the URL are never kept in the returned handle, and never logged.
 * 2. The exit watcher is registered at spawn. An exit this module did not ask for, after the start succeeded, is latched as
 *    a crash and logged once, however late it comes.
 * 3. `stop` marks the stop as intentional before it closes stdin, closes stdin, allows a short grace, then kills the
 *    process group and confirms the exit. A child whose exit cannot be confirmed is reported `unconfirmed`, never stopped.
 * 4. Nothing the child writes is logged or quoted: every log line is fixed text, with a fixed reason or numeric counts.
 */

/** How to run the child. Production is `process.execPath` and the bundle's `trace-relay.js`; tests inject their own. */
export interface TraceRelayLauncher {
  readonly command: string
  readonly args: readonly string[]
}

/** The production launcher: this bundle's sibling `trace-relay.js`. Only meaningful in the bundled Action. */
export function defaultTraceRelayLauncher(): TraceRelayLauncher {
  return {command: process.execPath, args: [fileURLToPath(new URL('./trace-relay.js', import.meta.url))]}
}

/**
 * Where the relay sends batches, already validated by whoever turned tracing on (the Action's input parsing). It is
 * validated again here and in the child, so a caller that skipped the rules cannot reach the network with them.
 */
export interface TraceRelayConfig {
  readonly url: string
  readonly headers: readonly TraceRelayHeader[]
}

export interface TraceRelayProcessTimeouts {
  /** From spawn to the ready line. */
  readonly readyMs: number
  /** After stdin closes, before the process group is killed. */
  readonly exitGraceMs: number
  /** After SIGKILL, to observe the exit. */
  readonly killConfirmMs: number
  /** For the bundle check to answer; past it the check counts as failed. */
  readonly bundleCheckMs: number
}

/** Longest the bundle check may hold up the server start. A filesystem walk takes milliseconds; this only bounds a hang. */
export const TRACE_RELAY_BUNDLE_CHECK_TIMEOUT_MS = 3000

const DEFAULT_TIMEOUTS: TraceRelayProcessTimeouts = {
  readyMs: 5000,
  exitGraceMs: 2000,
  killConfirmMs: 2000,
  bundleCheckMs: TRACE_RELAY_BUNDLE_CHECK_TIMEOUT_MS,
}

/** After the exit, longest to wait for the child's stdout to drain, so its report line is read. */
const STDOUT_DRAIN_MS = 500

export interface StartTraceRelayProcessOptions {
  readonly config: TraceRelayConfig
  readonly logger: Logger
  /** Defaults to {@link defaultTraceRelayLauncher}. */
  readonly launcher?: TraceRelayLauncher
  readonly timeouts?: Partial<TraceRelayProcessTimeouts>
  /**
   * Whether the relay bundle is fit to run (`checkTraceRelayBundle`). Asked once, after the config is accepted and before
   * anything is spawned; false, or a throw, starts nothing and warns once with a fixed reason. Left out, nothing is asked,
   * which is for tests that inject their own launcher.
   */
  readonly bundleCheck?: () => Promise<boolean>
  readonly deps?: {readonly killGroup?: (pid: number, signal: NodeJS.Signals) => void}
}

export type TraceRelayStartErrorKind =
  | 'bad-ready'
  | 'bundle-invalid'
  | 'child-error'
  | 'credential-over-http'
  | 'exited-early'
  | 'invalid-config'
  | 'ready-timeout'
  | 'spawn-failed'

export interface TraceRelayStartError {
  /** A fixed reason. Never a URL, a header, a path or anything the child printed. */
  readonly kind: TraceRelayStartErrorKind
  /** Set when the failed start could not confirm the child exited. */
  readonly cleanup?: 'unconfirmed'
}

export type TraceRelayStopOutcome = 'already-exited' | 'killed' | 'stopped' | 'unconfirmed'

export interface TraceRelayStopResult {
  readonly outcome: TraceRelayStopOutcome
  /** What the relay counted, or `incomplete` when it was killed, crashed, printed no report, or the server was killed. */
  readonly counts: TraceRelayBatchCounts | 'incomplete'
  /**
   * The span totals the plugin itself reported in its counts header (the last valid value the relay saw), as numbers. Absent
   * when the plugin never sent one and whenever the count is incomplete. Untrusted: it is what a loopback sender said.
   */
  readonly pluginReported?: TraceRelayPluginCounts
}

export interface TraceRelayStopOptions {
  /** The server was killed rather than stopped, so its plugin may not have flushed its last batch: counts cannot be complete. */
  readonly serverKilled?: boolean
}

export interface TraceRelayProcess {
  readonly pid: number
  /** The loopback port the plugin's exporter posts to: `http://127.0.0.1:<port>/v1/traces`. */
  readonly port: number
  /** The child exited without being asked to, after it was ready. Latched. */
  readonly crashed: () => boolean
  /** Closes stdin, reads the report, then kills and confirms. Idempotent, never rejects: later calls return the first result. */
  readonly stop: (options?: TraceRelayStopOptions) => Promise<TraceRelayStopResult>
}

const MAX_LINE_BYTES = 4096

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    // Already gone.
  }
}

/**
 * Runs the bundle check inside its own `try`, so a synchronous throw and a rejection are the same failed check, and bounds it,
 * so a check that never settles cannot hold up the server start. True only when it answered true in time.
 */
async function runBundleCheck(check: () => Promise<boolean>, boundMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), boundMs)
    })
    return (await Promise.race([check(), timedOut])) === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
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

export async function startTraceRelayProcess(
  options: StartTraceRelayProcessOptions,
): Promise<Result<TraceRelayProcess, TraceRelayStartError>> {
  const {logger} = options
  const timeouts: TraceRelayProcessTimeouts = {...DEFAULT_TIMEOUTS, ...options.timeouts}
  const launcher = options.launcher ?? defaultTraceRelayLauncher()
  const killGroup = options.deps?.killGroup ?? killProcessGroup

  const warnNotStarted = (kind: TraceRelayStartErrorKind): void => {
    logger.warning('The trace relay did not start; this run is not traced', {reason: kind})
  }

  const parsed = parseTraceRelayConfig({version: 1, url: options.config.url, headers: options.config.headers})
  if (!parsed.success) {
    // The parser's fixed code is the reason: a credential over plain http is told apart from a malformed config.
    warnNotStarted(parsed.error)
    return err({kind: parsed.error})
  }
  let frame: Buffer
  try {
    frame = encodeTraceRelayConfig(parsed.data)
  } catch {
    warnNotStarted('invalid-config')
    return err({kind: 'invalid-config'})
  }

  if (options.bundleCheck !== undefined) {
    // The bundle is optional for the Action as a whole, so it is checked only now that a relay is about to start.
    const usable = await runBundleCheck(options.bundleCheck, timeouts.bundleCheckMs)
    if (!usable) {
      warnNotStarted('bundle-invalid')
      return err({kind: 'bundle-invalid'})
    }
  }

  let child: ChildProcess
  try {
    child = spawn(launcher.command, [...launcher.args], {
      env: {},
      cwd: '/',
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    })
  } catch {
    warnNotStarted('spawn-failed')
    return err({kind: 'spawn-failed'})
  }

  const state: {
    exit: {code: number | null; signal: NodeJS.Signals | null} | null
    stopping: boolean
    started: boolean
    crashed: boolean
    report: TraceRelayBatchCounts | null
    plugin: TraceRelayPluginCounts | null
  } = {exit: null, stopping: false, started: false, crashed: false, report: null, plugin: null}

  // Registered now, before anything can declare the child ready: an exit at any later point is seen.
  const exited = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => {
      state.exit = {code, signal}
      if (!state.stopping && state.started) {
        state.crashed = true
        logger.warning('Trace relay exited unexpectedly; spans for the rest of the run are not exported', {
          reason: 'crashed',
        })
      }
      resolve()
    })
  })
  const closed = new Promise<void>(resolve => {
    child.once('close', () => resolve())
  })
  const spawnFailure = new Promise<'spawn-failed'>(resolve => {
    child.once('error', () => resolve('spawn-failed'))
  })
  child.stdin?.on('error', () => undefined)

  const terminate = async (): Promise<TraceRelayStopOutcome> => {
    state.stopping = true
    if (state.exit !== null) return 'already-exited'
    try {
      child.stdin?.end()
    } catch {
      // The pipe is already closed; the exit wait decides.
    }
    if (await settlesWithin(exited, timeouts.exitGraceMs)) {
      await settlesWithin(closed, STDOUT_DRAIN_MS)
      return 'stopped'
    }
    if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
    if (await settlesWithin(exited, timeouts.killConfirmMs)) return 'killed'
    logger.error('The trace relay exit could not be confirmed after SIGKILL')
    return 'unconfirmed'
  }

  const failStart = async (kind: TraceRelayStartErrorKind): Promise<Result<never, TraceRelayStartError>> => {
    const outcome = await terminate()
    warnNotStarted(kind)
    return err(outcome === 'unconfirmed' ? {kind, cleanup: 'unconfirmed'} : {kind})
  }

  if (child.pid === undefined) {
    await spawnFailure
    state.stopping = true
    warnNotStarted('spawn-failed')
    return err({kind: 'spawn-failed'})
  }
  const pid = child.pid

  type Ready = {readonly kind: 'ready'; readonly port: number} | {readonly kind: 'bad'} | {readonly kind: 'error'}
  const ready = new Promise<Ready>(resolve => {
    let buffered = ''
    let decided = false
    child.stdout?.on('data', (chunk: Buffer) => {
      // Stdout is drained for the child's whole life, so a full pipe never blocks it.
      buffered += chunk.toString('utf8')
      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline === -1) {
          if (buffered.length > MAX_LINE_BYTES) {
            buffered = ''
            if (!decided) {
              decided = true
              resolve({kind: 'bad'})
            }
          }
          return
        }
        const line = parseTraceRelayChildLine(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        if (!decided) {
          decided = true
          if (line.kind === 'ready') resolve({kind: 'ready', port: line.port})
          else resolve({kind: line.kind === 'error' ? 'error' : 'bad'})
        } else if (line.kind === 'report') {
          state.report = line.counts
          state.plugin = line.plugin ?? null
        }
      }
    })
  })

  child.stdin?.write(frame, () => undefined)

  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const readyTimeout = new Promise<'timeout'>(resolve => {
    readyTimer = setTimeout(() => resolve('timeout'), timeouts.readyMs)
  })

  let first: Ready | 'exited' | 'spawn-failed' | 'timeout'
  try {
    first = await Promise.race([ready, exited.then(() => 'exited' as const), spawnFailure, readyTimeout])
  } finally {
    clearTimeout(readyTimer)
  }

  if (first === 'exited') return failStart('exited-early')
  if (first === 'spawn-failed') return failStart('spawn-failed')
  if (first === 'timeout') return failStart('ready-timeout')
  if (first.kind === 'error') return failStart('child-error')
  if (first.kind === 'bad') return failStart('bad-ready')
  const {port} = first

  state.started = true
  logger.info('Trace relay started', {pid})

  let stopped: Promise<TraceRelayStopResult> | undefined
  const stopOnce = async (stopOptions: TraceRelayStopOptions): Promise<TraceRelayStopResult> => {
    try {
      const outcome = await terminate()
      // A child that left on its own is never complete, whatever it printed first: it was not stopped by the plan, so what it
      // reported cannot be taken as the run's whole count.
      const complete =
        (outcome === 'stopped' || outcome === 'already-exited') && !state.crashed && stopOptions.serverKilled !== true
      const counts = complete && state.report !== null ? state.report : 'incomplete'
      if (counts === 'incomplete') {
        logger.info('Trace relay stopped', {countIncomplete: true})
        return {outcome, counts}
      }
      // The plugin's own totals ride beside the relay's counts, under a name that says who reported them.
      const pluginReported =
        state.plugin === null
          ? undefined
          : {exportedSpans: state.plugin.exportedSpans, droppedSpans: state.plugin.droppedSpans}
      // Labelled for what each number is. `acknowledged`: the collector answered 2xx, which is not proof every span was stored
      // (a partial-success body is never read). The plugin's totals are as of the last batch it sent, not the run's end.
      logger.info('Trace relay stopped', {
        acknowledged: counts.delivered,
        retry: counts.retry,
        dropped: counts.dropped,
        ...(pluginReported === undefined ? {} : {pluginReportedAtLastBatch: pluginReported}),
      })
      return {outcome, counts, ...(pluginReported === undefined ? {} : {pluginReported})}
    } catch {
      return {outcome: 'unconfirmed', counts: 'incomplete'}
    }
  }
  return ok({
    pid,
    port,
    crashed: () => state.crashed,
    stop: async stopOptions => {
      stopped ??= stopOnce(stopOptions ?? {})
      return stopped
    },
  })
}
