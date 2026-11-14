import type {Result} from '@bfra.me/es/result'
import type {
  OpenCodeV2SandboxLaunch,
  PrivilegedRun,
  SandboxAccount,
  SandboxIdentityDeps,
  SandboxStopOutcome,
} from '@fro-bot/runtime'
import type {
  HandoffDeps,
  HandoffJournal,
  HandoffManifest,
  TakeBackOutcome,
} from '../../services/setup/sandbox-handoff.js'
import type {SandboxToolPaths} from '../../services/setup/sandbox-preflight.js'
import type {ExecAdapter} from '../../services/setup/types.js'
import type {Logger} from '../../shared/logger.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {err, ok} from '@bfra.me/es/result'
import {
  buildRunAsSandboxArgv,
  createAttachmentDirExclusive,
  createSandboxAccount,
  deleteSandboxAccount,
  stopSandboxProcesses,
} from '@fro-bot/runtime'
import {createExecAdapter, holdSignalOwnership} from '../../services/setup/adapters.js'
import {handOff, takeBack} from '../../services/setup/sandbox-handoff.js'
import {toErrorMessage} from '../../shared/errors.js'

/**
 * The `isolate-agent` lifecycle for one run: create the account, hand over what the sandbox needs, launch spec, then
 * (after the server is shut down) stop every sandbox process, take everything back and delete the account.
 *
 * `release()` is the only exit and is idempotent. Whoever calls it first decides the outcome; later callers see the same
 * one. It is called after the server's graceful shutdown on the normal path, and from the run's `finally` on every other
 * path (an exception, a failed start, a cancellation), so no exit leaves a live sandbox behind.
 */

/** A fixed, tool-only `PATH` for the sandbox. The runner's own `PATH` is never used. */
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin'

export interface SandboxPrepareInput {
  /** Provider key files written by the credential step; their directories are handed over. */
  readonly keyFilePaths: readonly string[]
  /** The temp `GH_CONFIG_DIR` the trigger provisioned (provision mode), or null. */
  readonly ghConfigDir: string | null
  /** The run-scoped staging root and the admitted skills tree under it, or null. */
  readonly repoSkills: {readonly stagingRoot: string; readonly admittedDir: string | null} | null
}

export interface SandboxReleaseResult {
  /** `never-started` when no account was created. */
  readonly stop: SandboxStopOutcome | 'never-started'
  readonly restore: 'not-needed' | 'restored' | 'unsafe'
  /** Why `restore` is `unsafe`, or why the stop was unconfirmed. Names a path or a check, never a secret. */
  readonly reason?: string
  /**
   * What became of the key proxy the lifecycle owned; absent when it owned none. `crashed`: it exited before the teardown
   * asked it to, so the run's model requests cannot be trusted to have completed. `unconfirmed` also makes `restore`
   * `unsafe`.
   */
  readonly proxy?: 'crashed' | 'stopped' | 'unconfirmed'
}

/** What the lifecycle needs of the key proxy it owns (`key-proxy-process.ts`). */
export interface OwnedKeyProxy {
  /** Aborts when the proxy exits without being asked to. */
  readonly died: AbortSignal
  /** Idempotent. `unconfirmed` means the exit was not observed. `crashed` means it exited before it was asked to. */
  readonly stop: () => Promise<{
    readonly outcome: 'already-exited' | 'killed' | 'stopped' | 'unconfirmed'
    readonly crashed: boolean
  }>
}

/**
 * What a proxy start reports back. `proxy` is null when it failed. `unconfirmed` is true when it could not confirm that a
 * child it started (or tried to) is gone: the teardown then fails closed.
 */
export interface KeyProxyStartReport<T extends OwnedKeyProxy> {
  readonly proxy: T | null
  readonly unconfirmed: boolean
}

/** What a launch is given: the launch spec for the sandbox user and a signal that aborts when the teardown begins. */
export interface SandboxLaunchContext {
  readonly spec: OpenCodeV2SandboxLaunch
  readonly signal: AbortSignal
}

/**
 * What a launch reports back. `unconfirmed` is true when the launcher could not confirm that the process it started (or
 * tried to) is gone: the teardown then cannot trust a uid sweep and fails closed.
 */
export interface SandboxLaunchReport<T> {
  readonly value: T
  readonly unconfirmed: boolean
}

export interface SandboxLifecycle {
  readonly prepare: (input: SandboxPrepareInput) => Promise<Result<OpenCodeV2SandboxLaunch, string>>
  /**
   * Runs the one operation that creates a process as the sandbox user (port allocation, the privileged spawn, readiness).
   * The attempt is recorded before `spawn` first awaits, and `release` waits for it to settle before it verifies the uid is
   * empty and takes files back, so a launch that is still in flight can never create a process after the verification.
   * Refused (`err`) before `prepare` has succeeded and once `release` has begun.
   */
  readonly launch: <T>(
    spawn: (context: SandboxLaunchContext) => Promise<SandboxLaunchReport<T>>,
  ) => Promise<Result<T, string>>
  readonly release: () => Promise<SandboxReleaseResult>
  /**
   * Starts the key proxy under this lifecycle's ownership. Signal handling is taken before `start` runs and the attempt is
   * recorded before it first awaits, so a signal or a `release` that begins mid-start aborts it (`context.signal`), waits for
   * it, and stops whatever it produced. Works before `prepare` and without it: `release` stops the proxy on every branch,
   * after the sandbox is taken back. Refused (`err`) once the teardown has begun, and for a second proxy. A `start` that
   * throws rejects here, and the teardown then fails closed.
   */
  readonly startKeyProxy: <T extends OwnedKeyProxy>(
    start: (context: {readonly signal: AbortSignal}) => Promise<KeyProxyStartReport<T>>,
  ) => Promise<Result<T | null, string>>
}

/** Longest `release` waits for an in-flight launch to settle after aborting it, before it fails closed as unconfirmed. */
export const LAUNCH_SETTLE_BUDGET_MS = 30_000

/** The slice of `process` the signal handling uses; injectable so the tests need no real signals. */
export interface SignalHost {
  readonly pid: number
  readonly on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
  readonly off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
  readonly kill: (pid: number, signal: 'SIGINT' | 'SIGTERM') => unknown
}

/**
 * Longest a cancellation waits for the sandbox to be stopped and taken back before the process ends anyway. GitHub
 * escalates a cancelled step from SIGINT to SIGTERM and then SIGKILL within about ten seconds, so a longer wait would be
 * cut off. If the take-back does not finish in time the post hook still declines to read or save anything.
 */
export const SIGNAL_TEARDOWN_BUDGET_MS = 10_000

/**
 * What the lifecycle tells the rest of the run about the sandbox, for the process and for the post hook:
 * `pending` from before the account exists until the teardown finishes; `restored` only once the sandbox is verified
 * stopped and its files are back (or it never started); `unsafe` otherwise. Anything but `restored` means the
 * sandbox-writable paths must not be read or published.
 */
export type SandboxRunState = 'pending' | 'restored' | 'unsafe'

export interface SandboxLifecycleOptions {
  readonly tools: SandboxToolPaths
  readonly env: NodeJS.ProcessEnv
  readonly workspacePath: string
  /** The run-scoped response directory, or null when the delivery has none. */
  readonly responseDir: string | null
  /** The run-scoped attachment directory (created here so default ACLs cover files the runner writes later). */
  readonly attachmentDir?: string | null
  readonly logger: Logger
  /** Override for tests and the integration suite; defaults to the real home of the current user. */
  readonly runnerHome?: string
  readonly exec?: ExecAdapter
  readonly deps?: Partial<SandboxLifecycleDeps>
  /** Defaults to the real `process`. */
  readonly signals?: SignalHost
  readonly signalTeardownBudgetMs?: number
  /** Overrides {@link LAUNCH_SETTLE_BUDGET_MS} (tests). */
  readonly launchSettleBudgetMs?: number
  /** Called synchronously with each state change. Must not throw. */
  readonly recordState?: (state: SandboxRunState) => void
}

export interface SandboxLifecycleDeps {
  readonly createAccount: typeof createSandboxAccount
  readonly stop: typeof stopSandboxProcesses
  readonly deleteAccount: typeof deleteSandboxAccount
  readonly handOff: typeof handOff
  readonly takeBack: typeof takeBack
  readonly readText: (absolutePath: string) => Promise<string | null>
  readonly ids: () => {readonly uid: number; readonly gid: number}
}

const defaultDeps: SandboxLifecycleDeps = {
  createAccount: createSandboxAccount,
  stop: stopSandboxProcesses,
  deleteAccount: deleteSandboxAccount,
  handOff,
  takeBack,
  readText: async file => fs.readFile(file, 'utf8').catch(() => null),
  ids: () => ({uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1}),
}

/** A privileged command that takes this long is logged: slow `useradd` or `setfacl` calls are what a hung step looks like. */
const SLOW_PRIVILEGED_COMMAND_MS = 5000
const STDERR_TAIL_BYTES = 2048

/** Applied to a privileged command that names no timeout of its own (`useradd`, `userdel`, `mkdir`, ...). */
export const DEFAULT_PRIVILEGED_TIMEOUT_MS = 60_000

/**
 * The sudo wrapper every privileged step goes through. `argv[0]` is an absolute path resolved by the preflight. Every
 * command runs under a timeout (the caller's, else {@link DEFAULT_PRIVILEGED_TIMEOUT_MS}): on expiry the adapter kills the
 * command's process group and the result is `exitCode: null`, which callers treat as a failure.
 */
export function createPrivilegedRun(
  exec: ExecAdapter,
  sudoPath: string,
  diagnostics: {readonly logger?: Logger; readonly now?: () => number} = {},
): PrivilegedRun {
  const now = diagnostics.now ?? Date.now
  return async (argv, options) => {
    const args = ['-n', '--', ...argv]
    const timeoutMs = options?.timeoutMs ?? DEFAULT_PRIVILEGED_TIMEOUT_MS
    const started = now()
    // Names the tool only: the arguments may carry paths the log should not hold, and the duration is the evidence wanted.
    const noteIfSlow = (): void => {
      const elapsedMs = now() - started
      if (elapsedMs >= SLOW_PRIVILEGED_COMMAND_MS) {
        diagnostics.logger?.warning('A privileged command was slow', {
          tool: path.basename(argv[0] ?? 'command'),
          elapsedMs,
        })
      }
    }
    if (exec.execWithTimeout == null) {
      const output = await exec.getExecOutput(sudoPath, args, {silent: true, ignoreReturnCode: true, cwd: '/'})
      noteIfSlow()
      return {exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr.slice(-STDERR_TAIL_BYTES)}
    }
    const chunks: Buffer[] = []
    let stderrTail = Buffer.alloc(0)
    let processes: string | undefined
    const outcome = await exec.execWithTimeout(sudoPath, args, timeoutMs, {
      cwd: '/',
      onTimeout: snapshot => {
        processes = snapshot
      },
      listeners: {
        stdout: data => chunks.push(data),
        stderr: data => {
          stderrTail = Buffer.concat([stderrTail, data]).subarray(-STDERR_TAIL_BYTES)
        },
      },
    })
    noteIfSlow()
    const stderr = stderrTail.toString('utf8')
    if (outcome === 'timed-out') {
      return {
        exitCode: null,
        stdout: '',
        stderr,
        timedOutAfterMs: timeoutMs,
        ...(processes === undefined ? {} : {processes}),
      }
    }
    return {exitCode: outcome, stdout: Buffer.concat(chunks).toString('utf8'), stderr}
  }
}

/** Resolves true if `promise` settles within `ms`, false otherwise. Clears its timer either way. */
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

function xdgBase(env: NodeJS.ProcessEnv, name: string, fallback: string, home: string): string {
  const value = env[name]
  return value !== undefined && value.length > 0 && path.isAbsolute(value) ? value : path.join(home, fallback)
}

export function createSandboxLifecycle(options: SandboxLifecycleOptions): SandboxLifecycle {
  const {tools, env, logger} = options
  const deps: SandboxLifecycleDeps = {...defaultDeps, ...options.deps}
  const exec = options.exec ?? createExecAdapter()
  const rawRun = createPrivilegedRun(exec, tools.sudo, {logger})
  // A privileged command that outlives its budget is killed, but a kill does not confirm that it stopped (it may be stuck in
  // the kernel, or hold work half done), and it may still be changing what the teardown is about to trust. Any timeout, however
  // the adapter settled it, makes the run unsafe: the account is kept and nothing is called restored.
  const timeouts: {command: string | null} = {command: null}
  const timedOut = (): string | null => timeouts.command
  const run: PrivilegedRun = async (argv, runOptions) => {
    const result = await rawRun(argv, runOptions)
    if (result.timedOutAfterMs !== undefined && timeouts.command === null) {
      timeouts.command = `${path.basename(argv[0] ?? 'command')} timed out after ${result.timedOutAfterMs}ms`
      logger.error('A privileged command timed out; the sandbox run can no longer be trusted', {
        command: timeouts.command,
      })
    }
    return result
  }
  const runnerHome = options.runnerHome ?? env.HOME ?? os.userInfo().homedir

  let account: SandboxAccount | null = null
  let manifest: HandoffManifest | null = null
  let journal: HandoffJournal | null = null
  let released: Promise<SandboxReleaseResult> | undefined
  // The in-flight `prepare`. Teardown waits for it, so a signal can never read a half-built state (no account yet, or no
  // journal for a handoff still running) and cache a release it did not earn.
  let preparing: Promise<unknown> | undefined
  // A signal arrived: preparation stops at its next checkpoint and tears down what exists.
  let cancelled = false
  // Admission to `launch`: closed synchronously by the first `release` (or signal), never reopened.
  let admissionClosed = false
  let launchSpec: OpenCodeV2SandboxLaunch | null = null
  // Every launch attempt in flight, with the controller that aborts it.
  const pendingLaunches = new Map<Promise<unknown>, AbortController>()
  // Set when a launcher could not confirm its own cleanup (or threw): the uid sweep cannot be trusted.
  let launchUnconfirmed = false
  // The key proxy: at most one, started through `startKeyProxy`, stopped last by the teardown.
  let proxy: OwnedKeyProxy | null = null
  let proxyStart: Promise<unknown> | undefined
  let proxyStartController: AbortController | undefined
  let proxyUnconfirmed = false
  // Set once the teardown has taken its decision about the proxy. A proxy that turns up after that is stopped on the spot.
  let proxyTeardownDone = false
  const closeAdmission = (): void => {
    admissionClosed = true
    for (const controller of pendingLaunches.values()) controller.abort()
    proxyStartController?.abort()
  }
  const record = (state: SandboxRunState): void => {
    try {
      options.recordState?.(state)
    } catch (error) {
      logger.warning('Recording the sandbox state failed', {error: toErrorMessage(error)})
    }
  }

  // SIGINT/SIGTERM: stop the sandbox user's processes (which aborts the server and every tool under it) and take its files
  // back before the process ends. Installed before the account exists and removed once release has finished. The exec
  // adapter's own once-handlers also fire on the same signal and re-raise it, so this handler runs at most once.
  const signalHost: SignalHost = options.signals ?? process
  const installedSignalListeners: ['SIGINT' | 'SIGTERM', () => void][] = []
  let signalled = false
  // Held from the first handler until the last is removed: while the sandbox is live this lifecycle decides what a signal
  // does. The exec adapter would otherwise SIGKILL the teardown's own commands on a second signal, and re-raise before the
  // teardown had finished.
  let releaseSignalOwnership: (() => void) | null = null
  const removeSignalHandlers = (): void => {
    releaseSignalOwnership?.()
    releaseSignalOwnership = null
    for (const [signal, listener] of installedSignalListeners.splice(0)) signalHost.off(signal, listener)
  }
  // Bound once `release` is defined below; the handlers only run after `prepare`, so it is always set by then.
  let releaseRef: () => Promise<SandboxReleaseResult> = async () => ({stop: 'never-started', restore: 'not-needed'})
  const onSignal = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (signalled) return
    signalled = true
    cancelled = true
    closeAdmission()
    logger.warning('Received a termination signal; stopping the sandbox before exiting', {signal})
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), options.signalTeardownBudgetMs ?? SIGNAL_TEARDOWN_BUDGET_MS)
    })
    const outcome = await Promise.race([releaseRef().catch(() => 'failed' as const), timedOut])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout' || outcome === 'failed') {
      logger.error('The sandbox was not confirmed stopped and restored before exiting on a signal')
      // The post hook must not read a `pending` left behind as "nothing happened": say outright that it is not restored.
      record('unsafe')
    }
    removeSignalHandlers()
    // The handlers are gone, so this ends the process with the signal's default action.
    signalHost.kill(signalHost.pid, signal)
  }
  const installSignalHandlers = (): void => {
    if (installedSignalListeners.length > 0) return
    releaseSignalOwnership = holdSignalOwnership()
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const listener = (): void => {
        onSignal(signal).catch(() => undefined)
      }
      installedSignalListeners.push([signal, listener])
      signalHost.on(signal, listener)
    }
  }

  const identityDeps = (): SandboxIdentityDeps => ({run, readText: deps.readText, logger})
  const handoffDeps = (): HandoffDeps => ({
    run,
    tools: {
      setfacl: tools.setfacl,
      getfacl: tools.getfacl,
      find: tools.find,
      chown: tools.chown,
      chmod: tools.chmod,
      git: tools.git,
    },
    logger,
  })

  /** Stops the key proxy, if the lifecycle owns one, and says what became of it. */
  const stopProxy = async (): Promise<'crashed' | 'none' | 'stopped' | 'unconfirmed'> => {
    proxyTeardownDone = true
    if (proxy === null) return proxyUnconfirmed ? 'unconfirmed' : 'none'
    try {
      const result = await proxy.stop()
      if (result.outcome === 'unconfirmed' || proxyUnconfirmed) return 'unconfirmed'
      logger.info('Key proxy stopped', {exitConfirmed: true})
      return result.crashed ? 'crashed' : 'stopped'
    } catch (error) {
      logger.error('Stopping the key proxy threw', {error: toErrorMessage(error)})
      return 'unconfirmed'
    }
  }

  const releaseSandbox = async (): Promise<SandboxReleaseResult> => {
    if (account === null) {
      // No account was recorded, but a `useradd` that timed out may have made one: that is not "nothing happened".
      if (timedOut() !== null) {
        return {stop: 'never-started', restore: 'unsafe', reason: `${timedOut()}; the account was not removed`}
      }
      return {stop: 'never-started', restore: 'not-needed'}
    }
    const stop = await deps.stop(account, tools, identityDeps())
    if (timedOut() !== null) {
      return {
        stop: 'unconfirmed',
        restore: 'unsafe',
        reason: `${timedOut()}; a killed command is not known to have stopped, so the account is kept and nothing is taken back`,
      }
    }
    if (launchUnconfirmed) {
      // Best effort above; but the launcher itself could not say its child is gone, so nothing may be trusted: no take-back,
      // and the account is kept (a live uid must not lose its account).
      return {
        stop: 'unconfirmed',
        restore: 'unsafe',
        reason: 'the process launch could not confirm its server was stopped; the sandbox output cannot be trusted',
      }
    }
    if (stop === 'unconfirmed') {
      // Nothing below may run: the sandbox could still be writing.
      return {
        stop,
        restore: 'unsafe',
        reason: 'the sandbox user still had running processes after the kill bound; its output cannot be trusted',
      }
    }
    let restore: TakeBackOutcome = {status: 'restored'}
    if (manifest !== null && journal !== null) restore = await deps.takeBack(manifest, journal, handoffDeps())
    if (restore.status === 'unsafe') logger.error('Sandbox take-back was unsafe', {reason: restore.reason})
    const timedOutDuringTakeBack = timedOut()
    if (timedOutDuringTakeBack !== null) {
      // Whatever take-back concluded: a command it ran was killed and is not known to have stopped, and it may still be
      // changing the files or the account. Keep the account. Its own reason (a timeout it named, say) is the one worth
      // reporting; ours covers a take-back that did not notice.
      return {
        stop,
        restore: 'unsafe',
        reason:
          restore.status === 'unsafe'
            ? restore.reason
            : `${timedOutDuringTakeBack} during the take-back; a killed command is not known to have stopped, so the account is kept`,
      }
    }
    // The stop is confirmed, so nothing runs as this uid any more: the account goes whether or not the files came back.
    const deleted = await deps.deleteAccount(account, tools, identityDeps())
    if (deleted === 'failed')
      logger.warning('The sandbox account could not be deleted; the VM is torn down after the job')
    if (restore.status === 'unsafe') return {stop, restore: 'unsafe', reason: restore.reason}
    const timedOutDuringDelete = timedOut()
    if (timedOutDuringDelete !== null) {
      return {stop, restore: 'unsafe', reason: `${timedOutDuringDelete} while the account was being removed`}
    }
    logger.info('Sandbox stopped and restored', {uid: account.uid})
    return {stop, restore: 'restored'}
  }

  /** The sandbox teardown, then the proxy: the sandbox's own requests are over before the proxy goes. */
  const doRelease = async (): Promise<SandboxReleaseResult> => {
    let sandbox: SandboxReleaseResult
    let proxyStatus: Awaited<ReturnType<typeof stopProxy>>
    try {
      sandbox = await releaseSandbox()
    } finally {
      // A throw from the sandbox teardown must not leave the proxy running.
      proxyStatus = await stopProxy()
    }
    if (proxyStatus === 'none') return sandbox
    if (proxyStatus === 'unconfirmed') {
      logger.error('The key proxy exit could not be confirmed; the run can no longer be trusted')
      return {
        ...sandbox,
        restore: 'unsafe',
        reason: sandbox.reason ?? 'the key proxy exit could not be confirmed, so the run cannot be trusted',
        proxy: 'unconfirmed',
      }
    }
    return {...sandbox, proxy: proxyStatus}
  }

  /** The one teardown. Memoized; never waits for `prepare`, so `prepare` itself can use it to roll back. */
  const releaseNow = async (): Promise<SandboxReleaseResult> => {
    released ??= doRelease()
      .catch((error: unknown): SandboxReleaseResult => {
        const reason = toErrorMessage(error)
        logger.error('Sandbox release threw', {error: reason})
        return {stop: account === null ? 'never-started' : 'unconfirmed', restore: 'unsafe', reason}
      })
      .then(result => {
        record(result.restore === 'unsafe' ? 'unsafe' : 'restored')
        return result
      })
      .finally(() => {
        // A signal in flight removes them itself, after the teardown it is waiting on.
        if (!signalled) removeSignalHandlers()
      })
    return released
  }

  /**
   * Public teardown. Admission closes synchronously, before anything is awaited. Then it waits for the in-flight preparation
   * and launch to reach a stopping point (aborting the launch), so the stop and the take-back run on the real state.
   */
  const release = async (): Promise<SandboxReleaseResult> => {
    closeAdmission()
    return (async () => {
      if (preparing !== undefined) await preparing.catch(() => undefined)
      if (pendingLaunches.size > 0) {
        const settled = await settlesWithin(
          Promise.allSettled([...pendingLaunches.keys()]),
          options.launchSettleBudgetMs ?? LAUNCH_SETTLE_BUDGET_MS,
        )
        if (!settled) {
          launchUnconfirmed = true
          logger.error('A sandbox launch did not settle after it was aborted; the teardown fails closed')
        }
      }
      if (proxyStart !== undefined) {
        const settled = await settlesWithin(
          proxyStart.catch(() => undefined),
          options.launchSettleBudgetMs ?? LAUNCH_SETTLE_BUDGET_MS,
        )
        if (!settled) {
          proxyUnconfirmed = true
          logger.error('The key proxy start did not settle after it was aborted; the teardown fails closed')
        }
      }
      return releaseNow()
    })()
  }

  const launch: SandboxLifecycle['launch'] = async spawn => {
    // Everything up to the registration below is synchronous: a release that starts after this call sees the attempt.
    if (admissionClosed || cancelled || launchSpec === null || account === null) {
      return err('the sandbox is not accepting a launch (not prepared, or the teardown has begun)')
    }
    const controller = new AbortController()
    const report = (async (): Promise<Result<unknown, string>> => {
      try {
        const done = await spawn({spec: launchSpec, signal: controller.signal})
        if (done.unconfirmed) launchUnconfirmed = true
        return ok(done.value)
      } catch (error) {
        // Whether it started something before throwing is unknown.
        launchUnconfirmed = true
        throw error
      }
    })()
    pendingLaunches.set(report, controller)
    try {
      return (await report) as Result<never, string>
    } finally {
      pendingLaunches.delete(report)
    }
  }

  const startKeyProxy: SandboxLifecycle['startKeyProxy'] = async start => {
    // Everything up to the registration below is synchronous: a release that starts after this call sees the attempt.
    if (admissionClosed || cancelled || proxyStart !== undefined) {
      return err('the sandbox is not accepting a key proxy (the teardown has begun, or one is already running)')
    }
    // Signal ownership before the spawn: from here a signal reaches the teardown, which stops the proxy.
    installSignalHandlers()
    const controller = new AbortController()
    proxyStartController = controller
    const attempt = (async () => {
      try {
        const report = await start({signal: controller.signal})
        if (report.unconfirmed) proxyUnconfirmed = true
        if (report.proxy === null) return null
        if (proxyTeardownDone) {
          // The release gave up waiting for this start (the run is already `unsafe`), and it was ready after all: nothing
          // may be left running, and the caller is not handed a proxy it must not use.
          logger.error('The key proxy became ready after the teardown; stopping it')
          await report.proxy.stop().catch((error: unknown) => {
            logger.error('Stopping the late key proxy threw', {error: toErrorMessage(error)})
          })
          return null
        }
        proxy = report.proxy
        return report.proxy
      } catch (error) {
        // Whether it started something before throwing is unknown.
        proxyUnconfirmed = true
        throw error
      }
    })()
    proxyStart = attempt
    return ok(await attempt)
  }

  releaseRef = release

  const prepare = async (input: SandboxPrepareInput): Promise<Result<OpenCodeV2SandboxLaunch, string>> => {
    if (cancelled || released !== undefined) return err('isolate-agent setup was cancelled before it started')
    record('pending')
    preparing = prepareInner(input)
    return preparing as Promise<Result<OpenCodeV2SandboxLaunch, string>>
  }

  async function prepareInner(input: SandboxPrepareInput): Promise<Result<OpenCodeV2SandboxLaunch, string>> {
    try {
      installSignalHandlers()
      const created = await deps.createAccount(tools, identityDeps())
      if (!created.success) {
        // A creation that timed out left the account in place; run the teardown so the state is `unsafe`, not `pending`.
        return timedOut() === null ? err(created.error.message) : await failAndRelease(created.error.message)
      }
      account = created.data
      if (cancelled) return await failAndRelease('isolate-agent setup was cancelled by a signal')

      const runnerTemp = env.RUNNER_TEMP
      if (runnerTemp === undefined || runnerTemp.length === 0) {
        return await failAndRelease('RUNNER_TEMP is required for isolate-agent')
      }
      const ids = deps.ids()
      const dataBase = xdgBase(env, 'XDG_DATA_HOME', '.local/share', runnerHome)
      const configBase = xdgBase(env, 'XDG_CONFIG_HOME', '.config', runnerHome)
      const cacheBase = xdgBase(env, 'XDG_CACHE_HOME', '.cache', runnerHome)
      const stateBase = xdgBase(env, 'XDG_STATE_HOME', '.local/state', runnerHome)

      const handedOver = new Set<string>([
        path.join(dataBase, 'opencode'),
        path.join(configBase, 'opencode'),
        path.join(cacheBase, 'opencode'),
        path.join(stateBase, 'opencode'),
        ...input.keyFilePaths.map(file => path.dirname(file)),
      ])
      if (options.responseDir !== null) handedOver.add(options.responseDir)
      if (input.ghConfigDir !== null) handedOver.add(input.ghConfigDir)

      const readable = new Set<string>()
      if (options.attachmentDir != null) {
        await createAttachmentDirExclusive(options.attachmentDir)
        readable.add(options.attachmentDir)
      }
      if (input.repoSkills?.admittedDir != null) readable.add(input.repoSkills.admittedDir)

      manifest = {
        ids: {runnerUid: ids.uid, runnerGid: ids.gid, sandboxUid: account.uid, sandboxGid: account.gid},
        runnerHome,
        runnerTemp,
        workspace: options.workspacePath,
        handedOver: [...handedOver],
        readable: [...readable],
        traverseOnly: input.repoSkills?.admittedDir == null ? [] : [input.repoSkills.stagingRoot],
        tighten: [runnerTemp, path.join(runnerTemp, '_runner_file_commands')],
      }
      if (cancelled) return await failAndRelease('isolate-agent setup was cancelled by a signal')
      const handed = await deps.handOff(manifest, handoffDeps())
      if (!handed.success) {
        // handOff already rolled back what it recorded. The journal is not kept; release only stops and deletes.
        manifest = null
        return await failAndRelease(handed.error)
      }
      journal = handed.data
      if (cancelled) return await failAndRelease('isolate-agent setup was cancelled by a signal')

      const sandboxTmp = path.join(account.home, 'tmp')
      await runAsSandbox([tools.mkdir, '-m', '0700', sandboxTmp])
      await writeSandboxGitConfig(options.workspacePath)

      const spec: OpenCodeV2SandboxLaunch = {
        sudoPath: tools.sudo,
        setprivPath: tools.setpriv,
        envPath: tools.env,
        account,
        path: SANDBOX_PATH,
        tmpdir: sandboxTmp,
        xdg: {data: dataBase, config: configBase, cache: cacheBase, state: stateBase},
        ...(input.ghConfigDir === null ? {} : {extraEnv: {GH_CONFIG_DIR: input.ghConfigDir}}),
      }
      launchSpec = spec
      return ok(spec)
    } catch (error) {
      return failAndRelease(`Sandbox setup failed: ${toErrorMessage(error)}`)
    }
  }

  async function failAndRelease(message: string): Promise<Result<never, string>> {
    const outcome = await releaseNow()
    const suffix = outcome.restore === 'unsafe' ? ` (cleanup incomplete: ${outcome.reason ?? 'unknown'})` : ''
    return err(`${message}${suffix}`)
  }

  /** `command[0]` is an absolute tool path. */
  async function runAsSandbox(command: readonly string[]): Promise<void> {
    if (account === null) throw new Error('no sandbox account')
    const result = await run(buildRunAsSandboxArgv(account, tools, command))
    if (result.exitCode !== 0) {
      throw new Error(`${path.basename(command[0] ?? 'command')} as the sandbox failed (exit ${result.exitCode})`)
    }
  }

  /** `safe.directory` for the checkout (owned by the runner) and the identity setup configured for the runner. */
  async function writeSandboxGitConfig(workspace: string): Promise<void> {
    if (account === null) return
    const gitConfig = path.join(account.home, '.gitconfig')
    const set = async (key: string, value: string): Promise<void> => {
      await runAsSandbox([tools.git, 'config', '--file', gitConfig, '--add', key, value])
    }
    await set('safe.directory', workspace)
    for (const key of ['user.name', 'user.email']) {
      const value = await exec.getExecOutput(tools.git, ['config', '--global', '--get', key], {
        silent: true,
        ignoreReturnCode: true,
      })
      if (value.exitCode === 0 && value.stdout.trim().length > 0) await set(key, value.stdout.trim())
    }
  }

  // False from the moment a signal begins the teardown (not when it ends), so a caller about to spawn the server sees it.
  return {prepare, launch, release, startKeyProxy}
}
