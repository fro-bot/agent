import type {Result} from '@bfra.me/es/result'
import type {
  GateDeps,
  LaunchAdmission,
  OpenCodeV2SandboxLaunch,
  OpenCodeV2SandboxView,
  PrivilegedRun,
  SandboxAccount,
  SandboxIdentityDeps,
  SandboxNamespaceTools,
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
import type {LifecycleSpan} from '../../shared/lifecycle-tracer.js'
import type {Logger} from '../../shared/logger.js'
import {Buffer} from 'node:buffer'
import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {err, ok} from '@bfra.me/es/result'
import {
  admitLaunch,
  buildRunAsSandboxArgv,
  createAttachmentDirExclusive,
  createOpencodeCliShim,
  createSandboxAccount,
  deleteSandboxAccount,
  GATE_ERR_FILE,
  GATE_GO_FILE,
  GATE_NS_FILE,
  isWithin,
  OPENCODE_CLI_SHIM_FILE,
  parseMountInfo,
  prependPathDirectory,
  readCliShimProbe,
  SANDBOX_VIEW_TEMP_MOUNTS,
  stopLaunch,
  stopSandboxProcesses,
  validateViewPolicy,
} from '@fro-bot/runtime'
import {createExecAdapter, holdSignalOwnership} from '../../services/setup/adapters.js'
import {handOff, takeBack} from '../../services/setup/sandbox-handoff.js'
import {ACTIONS_DIR_NAME} from '../../services/setup/sandbox-preflight.js'
import {
  resolveToolRoots,
  toolCacheEnv,
  type ToolRootInput,
  type ToolRootResult,
} from '../../services/setup/sandbox-tool-roots.js'
import {buildSandboxPath} from '../../services/setup/sandbox-toolchain-path.js'
import {isProcessAlive} from '../../services/setup/sandbox-view-probe.js'
import {markRunCancelled, startCancellationCleanups} from '../../shared/cancellation.js'
import {toErrorMessage} from '../../shared/errors.js'
import {freeText} from '../../shared/lifecycle-tracer.js'

/**
 * The `isolate-agent` lifecycle for one run: create the account, hand over what the sandbox needs, launch spec, then
 * (after the server is shut down) stop every sandbox process, take everything back and delete the account.
 *
 * `release()` is the only exit and is idempotent. Whoever calls it first decides the outcome; later callers see the same
 * one. It is called after the server's graceful shutdown on the normal path, and from the run's `finally` on every other
 * path (an exception, a failed start, a cancellation), so no exit leaves a live sandbox behind.
 */

/**
 * The origin git is pushing to: `GITHUB_SERVER_URL` (set by the runner, `https://github.com` or a GHES host), else
 * github.com. `null` when it is set but is not an http(s) URL, so no host is guessed.
 */
function gitServerOrigin(serverUrl: string | undefined): string | null {
  const raw = serverUrl === undefined || serverUrl.length === 0 ? 'https://github.com' : serverUrl
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

export interface SandboxPrepareInput {
  /** Provider key files written by the credential step; their directories are handed over. */
  readonly keyFilePaths: readonly string[]
  /** The temp `GH_CONFIG_DIR` the trigger provisioned (provision mode), or null. */
  readonly ghConfigDir: string | null
  /** The run-scoped staging root and the admitted skills tree under it, or null. */
  readonly repoSkills: {readonly stagingRoot: string; readonly admittedDir: string | null} | null
  /** The lifecycle trace's isolation handoff span: a tool location or a PATH directory left out is an event on it. */
  readonly traceSpan?: LifecycleSpan
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
  /**
   * Called with the pid of the launcher the moment it is spawned. The launcher's privileged part outlives its own signals, so
   * the teardown finds the launch's mount namespace from this pid and kills every member of it.
   */
  readonly noteSpawn: (pid: number) => void
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
  /**
   * Registers a stop the signal teardown runs beside the sandbox's own, inside the same budget (`SIGNAL_TEARDOWN_BUDGET_MS`),
   * for a process the run owns that the lifecycle does not: the trace relay. A cancellation ends the process without running
   * `run.ts`'s `finally`, so without this the relay would be left to notice its stdin closing. It is a bounded extra, not part
   * of the teardown's outcome: it never changes what the sandbox reports, a throw or a rejection is swallowed, and one that
   * outlasts the budget is cut off with the rest. A normal `release` does not call it (the run stops the process itself), and
   * it takes no part in the key proxy's slot. Registered after a signal began, it runs at once. Registering installs the signal
   * handlers (like `startKeyProxy`) unless the teardown has begun, so a stop can be registered before the process it owns is
   * spawned and still be reached by a signal.
   */
  readonly registerSignalStop: (stop: () => Promise<unknown>) => void
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

/** The trace's part of a cancellation: the spans still open end as cancelled, and the export starts beside the teardown. */
export interface SandboxSignalTrace {
  /** Ends the spans still open as cancelled. Synchronous; a throw is ignored. */
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM') => void
  /** Starts the export with the given bound. Shared with normal completion, so it must be idempotent. Never awaited by the teardown. */
  readonly flush: (options: {readonly boundMs: number}) => Promise<unknown>
}

/**
 * Longest the export runs once a signal arrives. It runs beside the teardown and inside its window: the process is re-raised when
 * the teardown settles, whether or not the export has, so this only bounds the exporter's own work.
 */
export const SIGNAL_TRACE_FLUSH_BOUND_MS = 5_000

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
  /**
   * The runner's `PATH` from the very start of the run, before setup prepended anything to it (`core.addPath`). The agent's
   * `PATH` is built from this value alone: the live environment's is never read here. Required, so a caller cannot forget it.
   */
  readonly runnerPath: string | undefined
  /**
   * The directory of the OpenCode binary the Action itself resolved (setup's `core.addPath` put it on the live `PATH`, after
   * `runnerPath` was captured). Appended to the very end of the agent's `PATH`, so the agent's shell has `opencode` when
   * nothing else provides it and never shadows a tool from an earlier step. Null or absent when the path is unknown.
   */
  readonly opencodeDirectory?: string | null
  /**
   * The OpenCode binary itself (absolute). The agent's `PATH` starts with a guard directory whose `opencode` runs this binary
   * for `--version` and `--help` only and refuses everything else, so the agent's CLI cannot autostart a second server
   * (fro-bot/agent#2369). Null or absent when the path is unknown: the run then has no guard, and says so.
   */
  readonly opencodeBinaryPath?: string | null
  /** The run-scoped response directory, or null when the delivery has none. */
  readonly responseDir: string | null
  /** The run-scoped attachment directory (created here so default ACLs cover files the runner writes later). */
  readonly attachmentDir?: string | null
  /**
   * The `agent-state-home` input, already resolved: an absolute directory strictly inside the checkout. It becomes the
   * agent's `XDG_STATE_HOME`, handed over and taken back like the other handed-over directories. Null or absent keeps the
   * state root in the agent's own home. Checked again in `prepare`, which refuses anything else before it creates anything.
   */
  readonly agentStateHome?: string | null
  readonly logger: Logger
  /** Override for tests and the integration suite; defaults to the real home of the current user. */
  readonly runnerHome?: string
  readonly exec?: ExecAdapter
  readonly deps?: Partial<SandboxLifecycleDeps>
  /** Defaults to the real `process`. */
  readonly signals?: SignalHost
  /**
   * What the run's lifecycle trace does when a signal reaches this sandbox's handler: the only cancellation that sends a trace.
   * A run without `isolate-agent` has no handler of this kind, so it ends as it always did and sends no lifecycle trace.
   */
  readonly signalTrace?: SandboxSignalTrace
  readonly signalTeardownBudgetMs?: number
  /** Overrides {@link LAUNCH_SETTLE_BUDGET_MS} (tests). */
  readonly launchSettleBudgetMs?: number
  /** Called synchronously with each state change. Must not throw. */
  readonly recordState?: (state: SandboxRunState) => void
  /** The Node and the builder bundle that build the read-only view. Defaults to the Action's own Node and `sandbox-view.js`. */
  readonly viewLauncher?: {readonly nodePath: string; readonly builderPath: string}
}

export interface SandboxLifecycleDeps {
  readonly createAccount: typeof createSandboxAccount
  readonly stop: typeof stopSandboxProcesses
  readonly deleteAccount: typeof deleteSandboxAccount
  readonly handOff: typeof handOff
  readonly takeBack: typeof takeBack
  readonly readText: (absolutePath: string) => Promise<string | null>
  readonly ids: () => {readonly uid: number; readonly gid: number}
  /**
   * A fresh, empty directory under `runnerTemp` for the view's root and for the gates of its launches (`gateRoot`), and
   * how to remove it once every namespace is gone. Only the runner and root can write there.
   */
  readonly createViewRoot: (runnerTemp: string) => Promise<{
    readonly newRoot: string
    readonly gateRoot: string
    readonly remove: () => Promise<void>
  }>
  /** One launch's gate directory under `gateRoot`: where the gate reports its namespace id and waits for the go-ahead. */
  readonly createGate: (gateRoot: string) => {readonly dir: string; readonly remove: () => Promise<void>}
  /** The host's `/proc/self/mountinfo`. */
  readonly readMountInfo: () => Promise<string>
  readonly gateFiles: Pick<GateDeps, 'readHostNamespace' | 'readText' | 'writeText'>
  readonly admit: typeof admitLaunch
  readonly stopLaunch: typeof stopLaunch
  readonly isProcessAlive: (pid: number) => boolean
  /** True when the path is an existing directory (following links), for the agent's `PATH`. */
  readonly isDirectory: (directory: string) => boolean
  /** The path with every link resolved, or null when it can't be resolved. */
  readonly realpath: (target: string) => Promise<string | null>
  /** Which of the supported tool install roots (bun, pnpm) the sandbox may read. */
  readonly resolveToolRoots: (input: ToolRootInput) => Promise<ToolRootResult>
  /** What is at `target`, without following a link: nothing, a link (and where it points), or something else. */
  readonly inspectEntry: (target: string) => Promise<EntryFound>
  /**
   * Removes `target` only if it is a symlink to exactly `expected`: never a file or a directory, and never a link that points
   * anywhere else. `left` means something else is there and was not touched.
   */
  readonly removeLink: (target: string, expected: string) => Promise<'absent' | 'left' | 'removed'>
  /** The guard for the agent's `opencode` command (fro-bot/agent#2369): a fresh runner-owned directory holding one script. */
  readonly createCliShim: typeof createOpencodeCliShim
}

/** What `inspectEntry` found. `unreadable` is anything but a clean "no such entry" (a file where a parent should be, say). */
export type EntryFound =
  | {readonly kind: 'absent'}
  | {readonly kind: 'symlink'; readonly target: string}
  | {readonly kind: 'directory' | 'other' | 'unreadable'}

const defaultDeps: SandboxLifecycleDeps = {
  createAccount: createSandboxAccount,
  stop: stopSandboxProcesses,
  deleteAccount: deleteSandboxAccount,
  handOff,
  takeBack,
  readText: async file => fs.readFile(file, 'utf8').catch(() => null),
  ids: () => ({uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1}),
  createViewRoot: async runnerTemp => {
    const directory = await fs.mkdtemp(path.join(runnerTemp, 'fro-bot-view-'))
    const newRoot = path.join(directory, 'root')
    const gateRoot = path.join(directory, 'gates')
    await fs.mkdir(newRoot)
    await fs.mkdir(gateRoot)
    return {
      newRoot,
      gateRoot,
      // Plain `rmdir`, never recursive: the new root was a mount point of a namespace that is gone, and nothing may be
      // deleted through a mount that might still exist.
      remove: async () => {
        await fs.rmdir(gateRoot)
        await fs.rmdir(newRoot)
        await fs.rmdir(directory)
      },
    }
  },
  // Synchronous: the launch registers its attempt and calls the spawn without yielding, so a release cannot slip in between.
  createGate: gateRoot => {
    const dir = fsSync.mkdtempSync(path.join(gateRoot, 'g-'))
    return {
      dir,
      // The gate's own files, by name. The id file belongs to root: the runner removes it as the owner of the directory.
      remove: async () => {
        for (const name of [GATE_NS_FILE, GATE_GO_FILE, GATE_ERR_FILE]) await fs.rm(path.join(dir, name), {force: true})
        await fs.rmdir(dir)
      },
    }
  },
  readMountInfo: async () => fs.readFile('/proc/self/mountinfo', 'utf8'),
  gateFiles: {
    readText: async file => fs.readFile(file, 'utf8').catch(() => null),
    // `wx`: the go-ahead is created once and never overwritten.
    writeText: async (file, content) => fs.writeFile(file, content, {flag: 'wx', mode: 0o600}),
    readHostNamespace: async () => fs.readlink('/proc/self/ns/mnt').catch(() => null),
  },
  admit: admitLaunch,
  stopLaunch,
  isProcessAlive,
  isDirectory: directory => fsSync.statSync(directory, {throwIfNoEntry: false})?.isDirectory() === true,
  realpath: async target => fs.realpath(target).catch(() => null),
  resolveToolRoots: async input => resolveToolRoots(input),
  inspectEntry: async target => {
    let stats
    try {
      stats = await fs.lstat(target)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {kind: 'absent'} : {kind: 'unreadable'}
    }
    if (stats.isSymbolicLink()) {
      const linked = await fs.readlink(target).catch(() => null)
      return linked === null ? {kind: 'unreadable'} : {kind: 'symlink', target: linked}
    }
    return {kind: stats.isDirectory() ? 'directory' : 'other'}
  },
  removeLink: async (target, expected) => {
    const stats = await fs.lstat(target).catch(() => null)
    if (stats === null) return 'absent'
    if (!stats.isSymbolicLink() || (await fs.readlink(target)) !== expected) return 'left'
    await fs.unlink(target)
    return 'removed'
  },
  createCliShim: createOpencodeCliShim,
}

/** Where the view's old root is moved before it is unmounted. An empty directory on every supported image. */
const VIEW_PUT_OLD = '/mnt'

/** Longest the runner waits for a launch's gate to report its namespace. Shorter than the gate's own bound. */
const GATE_ADMIT_BOUND_MS = 10_000
/** Ticks of 0.1 s the gate waits for the go-ahead: 20 s at least, so it outlasts the runner's wait. */
const GATE_TICKS = 200
/** Longest the teardown waits for the launcher itself to be gone once its namespace is. */
const LAUNCHER_EXIT_BOUND_MS = 3000

/** A privileged command that takes this long is logged: slow `useradd` or `setfacl` calls are what a hung step looks like. */
const SLOW_PRIVILEGED_COMMAND_MS = 5000
const STDERR_TAIL_BYTES = 2048
/**
 * Install locations a caller may set for tools the agent runs. Each is passed to the agent only when it names a directory
 * the agent can enter, so a location under the runner's home or temp directory leaves the tool's own default in place.
 */
const TOOL_LOCATION_VARIABLES = ['PLAYWRIGHT_BROWSERS_PATH', 'UV_PYTHON_INSTALL_DIR', 'MISE_DATA_DIR'] as const

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
  // The agent's `PATH` is built from the runner's as captured at the start of the run, before setup added the Action's own
  // OpenCode directory. The trusted runner-side `PATH`s (trusted git, `TRUSTED_TOOL_DIRS`) are separate and unchanged.
  const {runnerPath} = options
  const opencodeDirectory = options.opencodeDirectory ?? null
  const opencodeBinaryPath = options.opencodeBinaryPath ?? null
  const viewLauncher = options.viewLauncher ?? {
    nodePath: process.execPath,
    builderPath: fileURLToPath(new URL('./sandbox-view.js', import.meta.url)),
  }
  const namespaceTools: SandboxNamespaceTools = {pkill: tools.pkill, pgrep: tools.pgrep, lsns: tools.lsns}

  let account: SandboxAccount | null = null
  let manifest: HandoffManifest | null = null
  // The granted tool install roots of this run, kept out of the view's own bind list.
  let toolRoots: ReadonlySet<string> = new Set()
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
  // Every launcher spawned under `launch`, with the admission that started the moment it was spawned: the runner reads the
  // launch's namespace id from its gate and gives the go-ahead, or does not.
  const launches: {
    readonly pid: number
    readonly gateDir: string
    readonly admission: Promise<LaunchAdmission>
  }[] = []
  // The gate directories created for launches, removed with the view's root once every namespace is confirmed empty.
  const gateRemovers: (() => Promise<void>)[] = []
  // The view's root directory, removed once the namespace is confirmed empty.
  let viewRoot: {readonly gateRoot: string; readonly remove: () => Promise<void>} | null = null
  // The key proxy: at most one, started through `startKeyProxy`, stopped last by the teardown.
  let proxy: OwnedKeyProxy | null = null
  let proxyStart: Promise<unknown> | undefined
  let proxyStartController: AbortController | undefined
  let proxyUnconfirmed = false
  // Set once the teardown has taken its decision about the proxy. A proxy that turns up after that is stopped on the spot.
  let proxyTeardownDone = false
  // The `opencode` link this lifecycle made inside `agentStateHome` (where it is, and where it points), removed once the files
  // are back. Set only after the link command succeeded, so an entry this run did not make is never recorded. Null when none.
  let agentStateLink: {readonly path: string; readonly target: string} | null = null
  // The directory holding the agent's `opencode` guard (fro-bot/agent#2369), removed once the files are back. Null when none.
  let cliShim: {readonly directory: string; readonly remove: () => void} | null = null
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
  // Extra stops the signal teardown runs beside the sandbox's (the trace relay's). Not part of the teardown's outcome.
  const signalStops: (() => Promise<unknown>)[] = []
  // The running extra stops of an active signal teardown, those started late included. Never rejects.
  const signalStopRuns: Promise<void>[] = []
  /** Resolves once every stop run so far has settled, including any added while it waits. */
  const settleSignalStops = async (): Promise<void> => {
    let waited = 0
    while (waited < signalStopRuns.length) {
      const batch = signalStopRuns.slice(waited)
      waited += batch.length
      await Promise.all(batch)
    }
  }
  /** Runs one extra stop. Never rejects and never throws: a failing extra stop must not touch the sandbox teardown. */
  const runSignalStop = async (stop: () => Promise<unknown>): Promise<void> => {
    try {
      await stop()
    } catch {
      // The sandbox's own teardown decides the outcome; an extra stop that failed has nothing to add.
    }
  }
  /**
   * Starts the export one turn of the event loop later, so the teardown's first steps are on their way before its CPU work. What
   * the export does after that is the tracer's: it prepares a span per turn of the event loop and, from the signal, only for a
   * fixed budget (`cancel` starts it), so the teardown's timers and subprocess results are never queued behind a batch.
   */
  const startTraceExport = async (trace: SandboxSignalTrace): Promise<void> => {
    try {
      await new Promise<void>(resolve => {
        setImmediate(resolve)
      })
      await trace.flush({boundMs: SIGNAL_TRACE_FLUSH_BOUND_MS})
    } catch {
      // An export never changes how a cancelled run ends.
    }
  }
  const onSignal = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (signalled) return
    signalled = true
    cancelled = true
    // The run is cancelled from this line, synchronously: every irreversible write checks the flag at the point of submission.
    markRunCancelled()
    try {
      options.signalTrace?.onSignal(signal)
    } catch {
      // Tracing never changes how a cancelled run stops.
    }
    closeAdmission()
    logger.warning('Received a termination signal; stopping the sandbox before exiting', {signal})
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), options.signalTeardownBudgetMs ?? SIGNAL_TEARDOWN_BUDGET_MS)
    })
    // The extra stops start now, beside the sandbox teardown, so both fit the one budget. What the run holds that a pending read
    // could otherwise strand (a review receipt) is given back with them.
    signalStopRuns.push(...signalStops.map(runSignalStop), ...startCancellationCleanups())
    const releasing = releaseRef().catch(() => 'failed' as const)
    // The export starts beside the teardown and is never waited for: the process is re-raised when the teardown settles, exactly
    // when it always was, and what has not reached the collector by then is lost.
    if (options.signalTrace !== undefined) startTraceExport(options.signalTrace).catch(() => undefined)
    const outcome = await Promise.race([releasing, timedOut])
    // Whatever budget is left is theirs too, those registered while the teardown ran included; the sandbox's outcome above
    // is decided without them. With none registered there is nothing to wait for and nothing new on this path.
    if (signalStopRuns.length > 0) await Promise.race([settleSignalStops(), timedOut])
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

  /** Waits for the launcher to exit, polling `isProcessAlive`. */
  const launcherGone = async (pid: number, boundMs: number): Promise<boolean> => {
    const deadline = Date.now() + boundMs
    while (deps.isProcessAlive(pid)) {
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return true
  }

  /**
   * Stops and confirms every launch spawned under `launch`, whether or not its launcher is alive. Null when none is left;
   * else why one could not be confirmed. The launcher's exit is never the confirmation: a group kill of `sudo` leaves its
   * root child running, out of the runner's reach. What confirms a launch is `stopLaunch`: the namespace it was admitted
   * under, or, for a launch whose id was never captured (and which therefore never got the go-ahead), its gate processes.
   */
  const stopLaunches = async (): Promise<string | null> => {
    let problem: string | null = null
    for (const launched of launches) {
      let admission: LaunchAdmission
      try {
        admission = await launched.admission
      } catch {
        admission = {kind: 'refused', host: null, reason: 'no-id'}
      }
      const stopStarted = Date.now()
      const outcome = await deps.stopLaunch(
        {gateDir: launched.gateDir, admission},
        namespaceTools,
        identityDeps(),
        deps.gateFiles,
      )
      if (outcome !== 'stopped') {
        problem ??= 'a launch could not be confirmed stopped: its namespace or its gate still had processes'
        continue
      }
      logger.info('Sandbox launch namespace stopped', {confirmed: true, elapsedMs: Date.now() - stopStarted})
      // The launcher is a process of the launch too (the runner cannot signal it): it exits once its child has.
      if (!(await launcherGone(launched.pid, LAUNCHER_EXIT_BOUND_MS))) {
        await run([tools.pkill, '-KILL', '-g', String(launched.pid)])
        if (!(await launcherGone(launched.pid, LAUNCHER_EXIT_BOUND_MS))) problem ??= 'the launcher did not exit'
      }
    }
    return problem
  }

  const removeViewRoot = async (): Promise<void> => {
    const current = viewRoot
    viewRoot = null
    try {
      for (const remove of gateRemovers.splice(0)) await remove()
      await current?.remove()
    } catch (error) {
      logger.warning('The read-only view directory could not be removed', {error: toErrorMessage(error)})
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
    // Every process of the launch, whatever its uid, is a member of the launch's mount namespace: kill them and confirm the
    // namespace is empty first. The uid sweep below cannot see a root process, and the runner cannot signal one.
    const namespace = await stopLaunches()
    const stop = await deps.stop(account, tools, identityDeps())
    if (timedOut() !== null) {
      return {
        stop: 'unconfirmed',
        restore: 'unsafe',
        reason: `${timedOut()}; a killed command is not known to have stopped, so the account is kept and nothing is taken back`,
      }
    }
    if (namespace !== null) {
      return {
        stop: 'unconfirmed',
        restore: 'unsafe',
        reason: `${namespace}; the sandbox output cannot be trusted, so the account is kept and nothing is taken back`,
      }
    }
    await removeViewRoot()
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
    // Only from a restored tree: the link is ours, in a directory that is the runner's again. After an unsafe take-back the
    // tree is not trusted and nothing in it is touched.
    if (restore.status === 'restored' && agentStateLink !== null) {
      const link = agentStateLink
      agentStateLink = null
      try {
        const removed = await deps.removeLink(link.path, link.target)
        if (removed === 'left') {
          logger.warning('The opencode entry in the agent state directory is not the link this run made; it was left', {
            path: link.path,
          })
        }
      } catch (error) {
        logger.warning('The opencode link in the agent state directory could not be removed', {
          error: toErrorMessage(error),
        })
      }
    }
    // Same rule as the link: from a restored tree only. The guard is the runner's own, written and never writable by the sandbox.
    if (restore.status === 'restored' && cliShim !== null) {
      const guard = cliShim
      cliShim = null
      guard.remove()
    }
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
        const prepared = launchSpec
        const root = viewRoot
        if (prepared === null || root === null || prepared.view === undefined) {
          return err('the sandbox has no read-only view to launch into')
        }
        // This launch's own gate, made before anything is spawned. A failure here has started nothing.
        let gate: ReturnType<SandboxLifecycleDeps['createGate']>
        try {
          gate = deps.createGate(root.gateRoot)
        } catch (error) {
          logger.warning('The launch gate directory could not be created', {error: toErrorMessage(error)})
          return err('isolate-agent could not create the gate directory of its launch')
        }
        gateRemovers.push(gate.remove)
        const spec: OpenCodeV2SandboxLaunch = {
          ...prepared,
          view: {...prepared.view, gate: {...prepared.view.gate, dir: gate.dir}},
        }
        const done = await spawn({
          spec,
          signal: controller.signal,
          noteSpawn: pid => {
            launches.push({
              pid,
              gateDir: gate.dir,
              admission: deps.admit(
                pid,
                gate.dir,
                {...deps.gateFiles, isAlive: deps.isProcessAlive},
                {isClosed: () => admissionClosed || cancelled, boundMs: GATE_ADMIT_BOUND_MS},
              ),
            })
          },
        })
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
    const stateHome = options.agentStateHome ?? null
    if (stateHome !== null) {
      // The input parser guarantees this. Checked again where the directory is handed over, before an account exists.
      const insideCheckout =
        path.isAbsolute(stateHome) && stateHome !== options.workspacePath && isWithin(options.workspacePath, stateHome)
      if (!insideCheckout) return err('agent-state-home must be an absolute directory inside the checkout')
      // Before an account exists or anything is handed over: an entry already there that is not this run's own to replace is
      // the user's, and refusing now leaves it untouched.
      const entryProblem = await prepareStateEntry(stateHome)
      if (entryProblem !== null) return err(entryProblem)
      if (cancelled || released !== undefined) return err('isolate-agent setup was cancelled before it started')
    }
    record('pending')
    preparing = prepareInner(input)
    return preparing as Promise<Result<OpenCodeV2SandboxLaunch, string>>
  }

  /** The runner's own `<XDG_STATE_HOME>/opencode`: where the agent's `opencode` state entry has to lead. */
  const runnerOpencodeState = (): string =>
    path.join(xdgBase(env, 'XDG_STATE_HOME', '.local/state', runnerHome), 'opencode')

  /**
   * Decides what may sit at `<agent-state-home>/opencode` before anything is changed. Null when it is fine (nothing there,
   * the runner's real directory itself, or a stale link of ours, which is removed here, by the runner, in a directory it
   * still owns); else why not. Anything else there (a file, a directory, a link elsewhere) belongs to the user.
   */
  async function prepareStateEntry(stateHome: string): Promise<string | null> {
    const entry = path.join(stateHome, 'opencode')
    const target = runnerOpencodeState()
    // The runner's `XDG_STATE_HOME` is the state home: this is the handed-over directory itself, and no link is made.
    if (entry === target) return null
    const found = await deps.inspectEntry(entry)
    if (found.kind === 'absent') return null
    if (found.kind === 'symlink' && found.target === target) {
      // What a crashed run of this Action leaves behind, and only that: a link to the runner's own opencode state.
      return (await deps.removeLink(entry, target)) === 'left'
        ? `agent-state-home: ${entry} changed while it was being checked`
        : null
    }
    const what =
      found.kind === 'symlink'
        ? `a link to ${found.target}`
        : `${found.kind === 'directory' ? 'a directory' : 'not a link'}`
    return (
      `agent-state-home: ${entry} already exists and is ${what}, but the Action links the agent's OpenCode state there ` +
      `(to ${target}). Move it away, or set the runner's XDG_STATE_HOME to the agent-state-home so that entry is the real directory`
    )
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
      const stateHome = options.agentStateHome ?? null
      if (stateHome !== null) handedOver.add(stateHome)
      if (options.responseDir !== null) handedOver.add(options.responseDir)
      if (input.ghConfigDir !== null) handedOver.add(input.ghConfigDir)

      const readable = new Set<string>()
      if (options.attachmentDir != null) {
        await createAttachmentDirExclusive(options.attachmentDir)
        readable.add(options.attachmentDir)
      }
      if (input.repoSkills?.admittedDir != null) readable.add(input.repoSkills.admittedDir)

      // Install roots of bun and pnpm under the runner home: read and execute for the sandbox, so the tools on its `PATH`
      // resolve. Decided from the same `PATH` the agent gets.
      if (opencodeDirectory === null) {
        logger.debug('OpenCode directory is unknown; the agent PATH does not get it', {})
      }
      const agentPath = buildSandboxPath(runnerPath, deps.isDirectory, opencodeDirectory)
      // The guard (#2369) is made now, so the handoff grants the sandbox read and execute on it like any other read grant.
      // No server runs without it: a failure here fails the preparation.
      if (opencodeBinaryPath === null) {
        logger.warning('The OpenCode binary path is unknown; the agent gets no OpenCode CLI guard', {})
      } else {
        const made = deps.createCliShim({binaryPath: opencodeBinaryPath, parentDirectory: runnerTemp})
        if (!made.success)
          return await failAndRelease(`isolate-agent could not make its OpenCode CLI guard: ${made.error}`)
        cliShim = made.data
        readable.add(made.data.directory)
      }
      const installRoots = await deps.resolveToolRoots({
        runnerHome,
        runnerUid: ids.uid,
        agentPath,
        runnerTemp,
        actionsDir: path.join(path.dirname(path.resolve(runnerTemp)), ACTIONS_DIR_NAME),
        workspace: options.workspacePath,
        writableRoots: [...handedOver, account.home],
      })
      logger.info('Sandbox tool roots', {granted: installRoots.granted, skipped: installRoots.skipped})
      toolRoots = new Set(installRoots.granted)
      for (const root of installRoots.granted) readable.add(root)

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
      // The runner's own runtime directory (`/run/user/<uid>`) is not the agent's; tools that keep sockets there need one.
      const runtimeDir = path.join(account.home, '.run')
      await runAsSandbox([tools.mkdir, '-m', '0700', runtimeDir])
      const agentXdg = await createAgentXdg(
        account.home,
        {
          data: path.join(dataBase, 'opencode'),
          config: path.join(configBase, 'opencode'),
          cache: path.join(cacheBase, 'opencode'),
          state: path.join(stateBase, 'opencode'),
        },
        stateHome,
      )
      await writeSandboxGitConfig(options.workspacePath, input.ghConfigDir !== null)
      const view = await buildView(manifest, account, runnerTemp)
      if (!view.success) return await failAndRelease(view.error)

      // A tool location is passed as its resolved path, so no link has to be followed in the view, and only when that
      // path is still there: outside the view's private temp mounts, or under a root the view binds back.
      const {policy} = view.data
      const boundRoots = [...policy.writable, ...policy.readOnly]
      const toolLocations: (readonly [string, string])[] = []
      for (const name of TOOL_LOCATION_VARIABLES) {
        const value = env[name]
        if (value === undefined || !path.isAbsolute(value)) continue
        const resolved = await deps.realpath(value)
        const visible =
          resolved !== null &&
          (!SANDBOX_VIEW_TEMP_MOUNTS.some(mount => isWithin(mount.path, resolved)) ||
            boundRoots.some(root => isWithin(root, resolved)))
        toolLocations.push([name, visible ? resolved : ''])
      }
      // First on the PATH, ahead of everything the runner and the OpenCode directory provide.
      const guardedPath = cliShim === null ? agentPath : prependPathDirectory(cliShim.directory, agentPath)
      const reachable = await reachableDirectories([
        ...guardedPath.split(path.delimiter),
        ...toolLocations.flatMap(([, resolved]) => (resolved === '' ? [] : [resolved])),
      ])
      // A guard the account cannot enter would be dropped from the PATH below, and the agent would run without it.
      if (cliShim !== null && !reachable.has(cliShim.directory)) {
        return await failAndRelease('isolate-agent: the sandbox user cannot enter its OpenCode CLI guard directory')
      }
      // And it must run: a `noexec` RUNNER_TEMP (or any mount the sandbox user cannot execute from) would leave an entry on the
      // PATH that only fails. Run it once as the sandbox user with an argument it refuses. A guard that does not run is left
      // off the PATH with one warning, and the run goes on without it, as it did before the guard existed.
      let guardRuns = cliShim !== null
      if (cliShim !== null) {
        const ran = await run(
          buildRunAsSandboxArgv(account, tools, [path.join(cliShim.directory, OPENCODE_CLI_SHIM_FILE), 'api']),
        )
        const read = readCliShimProbe({exitCode: ran.exitCode, stderr: ran.stderr ?? ''})
        if (!read.success) {
          guardRuns = false
          logger.warning(
            'The OpenCode CLI guard cannot run as the sandbox user, so the agent PATH is left without it',
            {
              reason: read.error,
            },
          )
        }
      }
      const launchPath = reachablePath(guardRuns ? guardedPath : agentPath, reachable, input.traceSpan)
      const passedToolLocations = Object.fromEntries(toolLocations.filter(([, resolved]) => reachable.has(resolved)))
      const droppedToolLocations = toolLocations
        .filter(([, resolved]) => !reachable.has(resolved))
        .map(([name]) => name)
      if (droppedToolLocations.length > 0) {
        logger.info('Tool locations the agent cannot use were not passed to it', {names: droppedToolLocations})
        input.traceSpan?.addEvent('tool-locations.dropped', {names: droppedToolLocations.join(',')})
      }

      const extraEnv: Record<string, string> = {
        ...(input.ghConfigDir === null ? {} : {GH_CONFIG_DIR: input.ghConfigDir}),
        // The checkout is the runner's, so git needs it trusted. Set in the environment as well as `~/.gitconfig`, because
        // tests commonly turn off the global and system config files and keep the environment.
        // `<checkout>/*` trusts every repository under it (git 2.45.3 or later; older git ignores the entry), for the clones a
        // runner step made there: they are the runner's, and only the checkout itself was trusted before.
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: options.workspacePath,
        GIT_CONFIG_KEY_1: 'safe.directory',
        GIT_CONFIG_VALUE_1: path.join(options.workspacePath, '*'),
        XDG_RUNTIME_DIR: runtimeDir,
        ...passedToolLocations,
        ...toolCacheEnv(installRoots.granted, runnerHome, account.home),
      }
      const spec: OpenCodeV2SandboxLaunch = {
        sudoPath: tools.sudo,
        setprivPath: tools.setpriv,
        envPath: tools.env,
        account,
        path: launchPath,
        view: view.data,
        tmpdir: sandboxTmp,
        xdg: agentXdg,
        ...(Object.keys(extraEnv).length === 0 ? {} : {extraEnv}),
      }
      launchSpec = spec
      return ok(spec)
    } catch (error) {
      return failAndRelease(`Sandbox setup failed: ${toErrorMessage(error)}`)
    }
  }

  /**
   * The read-only view of the launch: writable roots are the checkout, every handed-over directory and the account's home;
   * read-only inputs are what the manifest only lets the account read. The policy is checked against the host's mount table
   * here, before anything is launched, and again by the builder, which is the authority.
   */
  async function buildView(
    handed: HandoffManifest,
    sandboxAccount: SandboxAccount,
    runnerTemp: string,
  ): Promise<Result<OpenCodeV2SandboxView, string>> {
    const root = await deps.createViewRoot(runnerTemp).catch((error: unknown) => {
      logger.warning('The read-only view root could not be created', {error: toErrorMessage(error)})
      return null
    })
    if (root === null) return err('isolate-agent could not create the root directory of its read-only view')
    viewRoot = root
    const policy = {
      newRoot: root.newRoot,
      putOld: VIEW_PUT_OLD,
      tools: {mount: tools.mount, umount: tools.umount},
      // A handed-over directory inside the checkout (`agent-state-home`) is already under the checkout's writable mount.
      writable: [
        ...new Set([
          handed.workspace,
          ...handed.handedOver.filter(dir => !isWithin(handed.workspace, dir)),
          sandboxAccount.home,
        ]),
      ],
      // The tool install roots are left out: everything under `/` is already read-only in the view, and the grant only
      // adds permission to read and execute, so binding them again would add nothing but a way to refuse a launch.
      readOnly: [...new Set([...handed.readable, ...handed.traverseOnly])].filter(root => !toolRoots.has(root)),
      runnerHome,
      actionsDir: path.join(path.dirname(path.resolve(runnerTemp)), ACTIONS_DIR_NAME),
    }
    let mounts: ReturnType<typeof parseMountInfo>
    try {
      mounts = parseMountInfo(await deps.readMountInfo())
    } catch {
      return err('isolate-agent could not read the host mount table to check its read-only view')
    }
    if (!mounts.success) return err(`isolate-agent could not read the host mount table: ${mounts.error}`)
    const checked = validateViewPolicy(policy, mounts.data)
    if (!checked.success) return err(`isolate-agent cannot build its read-only view: ${checked.error}`)
    return ok({
      unsharePath: tools.unshare,
      shPath: tools.sh,
      pivotRootPath: tools.pivot_root,
      umountPath: tools.umount,
      nodePath: viewLauncher.nodePath,
      builderPath: viewLauncher.builderPath,
      policy,
      // `dir` is each launch's own gate directory, made under `gateRoot` when the launch starts.
      gate: {dir: root.gateRoot, readlinkPath: tools.readlink, sleepPath: tools.sleep, ticks: GATE_TICKS},
    })
  }

  async function failAndRelease(message: string): Promise<Result<never, string>> {
    const outcome = await releaseNow()
    const suffix = outcome.restore === 'unsafe' ? ` (cleanup incomplete: ${outcome.reason ?? 'unknown'})` : ''
    return err(`${message}${suffix}`)
  }

  /**
   * The agent's own XDG roots, in its home, so every tool it runs can keep caches and state there. Each root's `opencode`
   * entry links to the handed-over runner directory, where the server's database, logs and config live and which
   * take-back and the cache save read directly. Created as the account in its new, empty home.
   *
   * With an `agent-state-home` the state root is that directory instead (already handed over, so the sandbox owns it). The
   * `opencode` entry still has to reach the runner's session storage, so the link is made inside it, after `prepare` has
   * refused anything of the user's already there and removed a stale link of ours. It is removed once the files are back. When the
   * runner's own `<state>/opencode` already is `<state home>/opencode` (the runner's `XDG_STATE_HOME` is the state home) the
   * real directory is already where the agent looks, and a link would point at itself.
   */
  async function createAgentXdg(
    home: string,
    opencode: Readonly<Record<'data' | 'config' | 'cache' | 'state', string>>,
    stateHome: string | null,
  ): Promise<Readonly<Record<'data' | 'config' | 'cache' | 'state', string>>> {
    const roots = {
      data: path.join(home, '.local', 'share'),
      config: path.join(home, '.config'),
      cache: path.join(home, '.cache'),
      state: stateHome ?? path.join(home, '.local', 'state'),
    } as const
    await runAsSandbox([
      tools.mkdir,
      '-p',
      '-m',
      '0700',
      roots.data,
      roots.config,
      roots.cache,
      ...(stateHome === null ? [roots.state] : []),
    ])
    for (const kind of ['data', 'config', 'cache'] as const) {
      await runAsSandbox([tools.ln, '-sT', opencode[kind], path.join(roots[kind], 'opencode')])
    }
    const stateEntry = path.join(roots.state, 'opencode')
    if (stateHome === null) {
      await runAsSandbox([tools.ln, '-sT', opencode.state, stateEntry])
    } else if (stateEntry !== opencode.state) {
      // No `-f`: `prepare` already refused or removed whatever was there, so an entry that appears since is not ours to replace
      // and the command fails. Recorded only once it succeeded, so teardown removes nothing this run did not make.
      await runAsSandbox([tools.ln, '-sT', opencode.state, stateEntry])
      agentStateLink = {path: stateEntry, target: opencode.state}
    }
    return roots
  }

  /**
   * The `PATH` entries the account can search, in order. A directory it can't enter (one under the runner home that no
   * grant covers) turns a missing command into "permission denied", so it is left out. Checked as the account, after the
   * handoff's grants.
   */
  async function reachableDirectories(candidates: readonly string[]): Promise<ReadonlySet<string>> {
    if (account === null) throw new Error('no sandbox account')
    const result = await run(
      buildRunAsSandboxArgv(account, tools, [
        tools.sh,
        '-c',
        String.raw`for d do if [ -d "$d" ] && [ -x "$d" ]; then printf "%s\n" "$d"; fi; done`,
        'sh',
        ...candidates,
      ]),
    )
    if (result.exitCode !== 0) throw new Error(`checking the sandbox PATH failed (exit ${result.exitCode})`)
    return new Set(result.stdout.split('\n').filter(line => line.length > 0))
  }

  function reachablePath(candidate: string, reachable: ReadonlySet<string>, traceSpan?: LifecycleSpan): string {
    const dirs = candidate.split(path.delimiter)
    const dropped = dirs.filter(dir => !reachable.has(dir))
    if (dropped.length > 0) {
      logger.info('Sandbox PATH left out directories the agent cannot enter', {dropped})
      // The directory names come from the runner's PATH, which is outside input: free text, scrubbed and capped at export.
      traceSpan?.addEvent('path.dropped', {
        count: String(dropped.length),
        entries: freeText(dropped.join(path.delimiter), 'path-entries'),
      })
    }
    return dirs.filter(dir => reachable.has(dir)).join(path.delimiter)
  }

  /** `command[0]` is an absolute tool path. */
  async function runAsSandbox(command: readonly string[]): Promise<void> {
    if (account === null) throw new Error('no sandbox account')
    const result = await run(buildRunAsSandboxArgv(account, tools, command))
    if (result.exitCode !== 0) {
      throw new Error(`${path.basename(command[0] ?? 'command')} as the sandbox failed (exit ${result.exitCode})`)
    }
  }

  /**
   * `safe.directory` for the checkout (owned by the runner) and every repository under it (git 2.45.3 or later; older git
   * ignores the second entry), and the identity setup configured for the runner. In provision
   * mode (the sandbox holds a `gh` config), also a credential helper so the model's `git push` authenticates.
   */
  async function writeSandboxGitConfig(workspace: string, provisioned: boolean): Promise<void> {
    if (account === null) return
    const gitConfig = path.join(account.home, '.gitconfig')
    const set = async (key: string, value: string): Promise<void> => {
      await runAsSandbox([tools.git, 'config', '--file', gitConfig, '--add', key, value])
    }
    await set('safe.directory', workspace)
    await set('safe.directory', path.join(workspace, '*'))
    for (const key of ['user.name', 'user.email']) {
      const value = await exec.getExecOutput(tools.git, ['config', '--global', '--get', key], {
        silent: true,
        ignoreReturnCode: true,
      })
      if (value.exitCode === 0 && value.stdout.trim().length > 0) await set(key, value.stdout.trim())
    }
    if (!provisioned) return

    // `actions/checkout` runs with `persist-credentials: false` under isolation, so git has no credential of its own. `gh auth
    // git-credential` answers git from the `gh` token in `GH_CONFIG_DIR`, which the sandbox already holds (handed over and
    // named in the server environment) and uses for `gh pr create`. It exposes nothing new. The helper lives in the sandbox
    // user's global gitconfig, not in the checkout's `.git/config`, so the snapshot audit of that file is not involved. When
    // the credential is withheld there is no gh config and this block does not run.
    const origin = gitServerOrigin(env.GITHUB_SERVER_URL)
    if (origin === null) {
      logger.warning(
        'GITHUB_SERVER_URL is not a usable URL; the sandbox gets no git credential helper (git push will fail)',
      )
      return
    }
    const helperKey = `credential.${origin}.helper`
    // The empty value first: it drops any helper an outer config named for this host, so `gh` is the only one asked.
    await set(helperKey, '')
    await set(helperKey, `!${tools.gh} auth git-credential`)
  }

  // False from the moment a signal begins the teardown (not when it ends), so a caller about to spawn the server sees it.
  const registerSignalStop = (stop: () => Promise<unknown>): void => {
    if (signalled) {
      // The teardown is running or over: start it now, and let a teardown still waiting count it against its budget.
      signalStopRuns.push(runSignalStop(stop))
      return
    }
    // Signal ownership before the caller spawns anything, the same rule `startKeyProxy` follows: the trace relay starts before
    // the server, the key proxy and the account, so without this a signal in that window reaches no handler of ours and the
    // process ends with a child still starting. Not once the teardown has begun or finished: nothing would remove them.
    if (!admissionClosed && !cancelled && released === undefined) installSignalHandlers()
    signalStops.push(stop)
  }

  return {prepare, launch, release, startKeyProxy, registerSignalStop}
}
