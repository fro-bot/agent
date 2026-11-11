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
import {createExecAdapter} from '../../services/setup/adapters.js'
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
}

export interface SandboxLifecycle {
  readonly prepare: (input: SandboxPrepareInput) => Promise<Result<OpenCodeV2SandboxLaunch, string>>
  readonly release: () => Promise<SandboxReleaseResult>
  /** True once an account exists and until `release` has finished. */
  readonly isActive: () => boolean
}

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

/** Applied to a privileged command that names no timeout of its own (`useradd`, `userdel`, `mkdir`, ...). */
export const DEFAULT_PRIVILEGED_TIMEOUT_MS = 60_000

/**
 * The sudo wrapper every privileged step goes through. `argv[0]` is an absolute path resolved by the preflight. Every
 * command runs under a timeout (the caller's, else {@link DEFAULT_PRIVILEGED_TIMEOUT_MS}): on expiry the adapter kills the
 * command's process group and the result is `exitCode: null`, which callers treat as a failure.
 */
export function createPrivilegedRun(exec: ExecAdapter, sudoPath: string): PrivilegedRun {
  return async (argv, options) => {
    const args = ['-n', '--', ...argv]
    const timeoutMs = options?.timeoutMs ?? DEFAULT_PRIVILEGED_TIMEOUT_MS
    if (exec.execWithTimeout == null) {
      const output = await exec.getExecOutput(sudoPath, args, {silent: true, ignoreReturnCode: true, cwd: '/'})
      return {exitCode: output.exitCode, stdout: output.stdout}
    }
    const chunks: Buffer[] = []
    const outcome = await exec.execWithTimeout(sudoPath, args, timeoutMs, {
      cwd: '/',
      listeners: {stdout: data => chunks.push(data)},
    })
    if (outcome === 'timed-out') return {exitCode: null, stdout: ''}
    return {exitCode: outcome, stdout: Buffer.concat(chunks).toString('utf8')}
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
  const run = createPrivilegedRun(exec, tools.sudo)
  const runnerHome = options.runnerHome ?? env.HOME ?? os.userInfo().homedir

  let account: SandboxAccount | null = null
  let manifest: HandoffManifest | null = null
  let journal: HandoffJournal | null = null
  let released: Promise<SandboxReleaseResult> | undefined
  let active = false

  // SIGINT/SIGTERM: stop the sandbox user's processes (which aborts the server and every tool under it) and take its files
  // back before the process ends. Installed before the account exists and removed once release has finished. The exec
  // adapter's own once-handlers also fire on the same signal and re-raise it, so this handler runs at most once.
  const signalHost: SignalHost = options.signals ?? process
  const installedSignalListeners: ['SIGINT' | 'SIGTERM', () => void][] = []
  let signalled = false
  const removeSignalHandlers = (): void => {
    for (const [signal, listener] of installedSignalListeners.splice(0)) signalHost.off(signal, listener)
  }
  // Bound once `release` is defined below; the handlers only run after `prepare`, so it is always set by then.
  let releaseRef: () => Promise<SandboxReleaseResult> = async () => ({stop: 'never-started', restore: 'not-needed'})
  const onSignal = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (signalled) return
    signalled = true
    logger.warning('Received a termination signal; stopping the sandbox before exiting', {signal})
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), options.signalTeardownBudgetMs ?? SIGNAL_TEARDOWN_BUDGET_MS)
    })
    const outcome = await Promise.race([releaseRef().catch(() => 'failed' as const), timedOut])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout' || outcome === 'failed') {
      logger.error('The sandbox was not confirmed stopped and restored before exiting on a signal')
    }
    removeSignalHandlers()
    // The handlers are gone, so this ends the process with the signal's default action.
    signalHost.kill(signalHost.pid, signal)
  }
  const installSignalHandlers = (): void => {
    if (installedSignalListeners.length > 0) return
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
    },
    logger,
  })

  const doRelease = async (): Promise<SandboxReleaseResult> => {
    if (account === null) return {stop: 'never-started', restore: 'not-needed'}
    const stop = await deps.stop(account, tools, identityDeps())
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
    // The stop is confirmed, so nothing runs as this uid any more: the account goes whether or not the files came back.
    const deleted = await deps.deleteAccount(account, tools, identityDeps())
    if (deleted === 'failed')
      logger.warning('The sandbox account could not be deleted; the VM is torn down after the job')
    if (restore.status === 'unsafe') return {stop, restore: 'unsafe', reason: restore.reason}
    logger.info('Sandbox stopped and restored', {uid: account.uid})
    return {stop, restore: 'restored'}
  }

  const release = async (): Promise<SandboxReleaseResult> => {
    released ??= doRelease()
      .catch((error: unknown): SandboxReleaseResult => {
        const reason = toErrorMessage(error)
        logger.error('Sandbox release threw', {error: reason})
        return {stop: account === null ? 'never-started' : 'unconfirmed', restore: 'unsafe', reason}
      })
      .finally(() => {
        active = false
        // A signal in flight removes them itself, after the teardown it is waiting on.
        if (!signalled) removeSignalHandlers()
      })
    return released
  }

  releaseRef = release

  const prepare = async (input: SandboxPrepareInput): Promise<Result<OpenCodeV2SandboxLaunch, string>> => {
    try {
      installSignalHandlers()
      const created = await deps.createAccount(tools, identityDeps())
      if (!created.success) return err(created.error.message)
      account = created.data
      active = true

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
      const handed = await deps.handOff(manifest, handoffDeps())
      if (!handed.success) {
        // handOff already rolled back what it recorded. The journal is not kept; release only stops and deletes.
        manifest = null
        return await failAndRelease(handed.error)
      }
      journal = handed.data

      const sandboxTmp = path.join(account.home, 'tmp')
      await runAsSandbox([tools.mkdir, '-m', '0700', sandboxTmp])
      await writeSandboxGitConfig(options.workspacePath)

      return ok({
        sudoPath: tools.sudo,
        setprivPath: tools.setpriv,
        envPath: tools.env,
        account,
        path: SANDBOX_PATH,
        tmpdir: sandboxTmp,
        xdg: {data: dataBase, config: configBase, cache: cacheBase, state: stateBase},
        ...(input.ghConfigDir === null ? {} : {extraEnv: {GH_CONFIG_DIR: input.ghConfigDir}}),
      })
    } catch (error) {
      return failAndRelease(`Sandbox setup failed: ${toErrorMessage(error)}`)
    }
  }

  async function failAndRelease(message: string): Promise<Result<never, string>> {
    const outcome = await release()
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

  return {prepare, release, isActive: () => active}
}
