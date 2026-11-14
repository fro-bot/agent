import type {Buffer} from 'node:buffer'
import type {
  GateDeps,
  LaunchAdmission,
  NamespaceStopOutcome,
  OpenCodeV2SandboxView,
  PrivilegedRun,
  SandboxIdentityDeps,
} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {SandboxToolPaths} from './sandbox-preflight.js'
import type {ExecAdapter} from './types.js'
import {spawn} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {
  admitLaunch,
  buildSandboxViewChain,
  buildSetprivDropArgs,
  GATE_GO_FILE,
  GATE_NS_FILE,
  stopLaunch,
} from '@fro-bot/runtime'
import {toErrorMessage} from '../../shared/errors.js'

/**
 * The preflight's capability probe for the read-only view: it runs the real builder and the real launch chain over a
 * throwaway fixture, as root inside a private mount namespace, and gives one pass or fail with one message. It proves what
 * the host can do. The launch-time verification of the real roots stays the authority.
 *
 * The fixture is two directories of the runner's temp directory: `allowed` is the one declared root, `sealed` is not
 * declared. Inside the view the probe script checks, as root, that a write to `sealed` is refused with EROFS (root has no
 * permission denial to hide behind, so only the mount can refuse it) and that a write to `allowed` works; then it drops to
 * `nobody` and checks the drop and a write to the private `/tmp`.
 */

export interface ProbeFixture {
  readonly dir: string
  readonly newRoot: string
  /** The launch's gate directory: where the gate reports its namespace id and waits for the go-ahead. */
  readonly gate: string
  readonly allowed: string
  readonly sealed: string
}

export type ViewProbeResult = {readonly ok: true} | {readonly ok: false; readonly message: string}

export interface ViewProbeInput {
  readonly tools: SandboxToolPaths
  /** The Action's own Node. */
  readonly nodePath: string
  /** `dist/sandbox-view.js` of the published install. */
  readonly builderPath: string
  readonly runnerHome: string
  readonly actionsDir: string
  readonly nobody: {readonly uid: number; readonly gid: number}
}

export interface ProbeLaunchResult {
  /** `null` when the process could not be spawned. */
  readonly pid: number | null
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdout: string
}

export interface SandboxViewProbeDeps {
  readonly makeFixture: () => Promise<ProbeFixture>
  readonly removeFixture: (fixture: ProbeFixture) => Promise<void>
  /** Runs one command with a deadline. On a timeout it has already tried to kill the launcher's process group. */
  readonly launch: (
    command: string,
    args: readonly string[],
    options: {readonly timeoutMs: number; readonly onSpawn: (pid: number) => void},
  ) => Promise<ProbeLaunchResult>
  /** Started the moment the launcher's pid exists: reads the gate's namespace id and gives the go-ahead. */
  readonly admit: (pid: number, gateDir: string) => Promise<LaunchAdmission>
  /** Stops and confirms everything of the launch, by its namespace or, with no id captured, by its gate directory. */
  readonly stopLaunch: (gateDir: string, admission: LaunchAdmission) => Promise<NamespaceStopOutcome>
  readonly isAlive: (pid: number) => boolean
  readonly logger: Logger
}

/** A probe takes a few hundred milliseconds on the hosted images. */
export const VIEW_PROBE_TIMEOUT_MS = 15_000
const SETTLE_MS = 3000
/** Ticks of 0.1 s the gate waits for the go-ahead: it normally gets it within milliseconds. */
const PROBE_GATE_TICKS = 100
const SETTLE_POLL_MS = 50

/**
 * Exit 10: a write outside the declared roots was not refused with EROFS. 11: a write to the declared root failed. Then it
 * drops and runs {@link NOBODY_SCRIPT}. `true > file` (not `: > file`) so a failed redirect returns instead of ending the shell.
 */
const ROOT_SCRIPT =
  'e=$( { true > "$1"; } 2>&1 ); case "$e" in *"Read-only file system"*) ;; *) exit 10;; esac; ' +
  'true > "$2" || exit 11; shift 2; exec "$@"'
/** Exit 12: no write to the private `/tmp`. 13: not the unprivileged uid. */
const NOBODY_SCRIPT =
  'true > "$1" || exit 12; while read -r key value rest; do [ "$key" = "Uid:" ] && [ "$value" != "$2" ] && exit 13; done < /proc/self/status; exit 0'

function describeFailure(result: ProbeLaunchResult): string {
  if (result.timedOut) return 'the read-only view probe timed out'
  const stage = /"view":"failed","stage":"([a-z]{1,16})"/.exec(result.stdout)?.[1]
  switch (result.exitCode) {
    case 10:
      return 'the read-only view probe found a write outside the declared roots that was not refused'
    case 11:
      return 'the read-only view probe found that a write to the declared root was refused'
    case 12:
      return 'the read-only view probe found no writable private temp directory'
    case 13:
      return 'the read-only view probe did not run as the unprivileged user'
    case 70:
    case 71:
    case 72:
      return 'the read-only view probe could not pass its launch gate'
    case null:
    default:
      return stage === undefined
        ? `the read-only view probe failed (exit ${result.exitCode ?? 'none'})`
        : `the read-only view could not be built (stage ${stage})`
  }
}

export async function probeSandboxView(
  input: ViewProbeInput,
  deps: SandboxViewProbeDeps,
  options: {readonly settleMs?: number} = {},
): Promise<ViewProbeResult> {
  const fail = (message: string): ViewProbeResult => ({ok: false, message})
  let fixture: ProbeFixture
  try {
    fixture = await deps.makeFixture()
  } catch (error) {
    deps.logger.debug('The view probe fixture could not be created', {error: toErrorMessage(error)})
    return fail('the read-only view probe could not create its fixture in the runner temp directory')
  }

  let removable = true
  try {
    const {tools} = input
    const view: OpenCodeV2SandboxView = {
      unsharePath: tools.unshare,
      shPath: tools.sh,
      pivotRootPath: tools.pivot_root,
      umountPath: tools.umount,
      nodePath: input.nodePath,
      builderPath: input.builderPath,
      gate: {dir: fixture.gate, readlinkPath: tools.readlink, sleepPath: tools.sleep, ticks: PROBE_GATE_TICKS},
      policy: {
        newRoot: fixture.newRoot,
        putOld: '/mnt',
        tools: {mount: tools.mount, umount: tools.umount},
        writable: [fixture.allowed],
        readOnly: [],
        runnerHome: input.runnerHome,
        actionsDir: input.actionsDir,
      },
    }
    const command = [
      tools.sh,
      '-c',
      ROOT_SCRIPT,
      'sh',
      `${fixture.sealed}/probe`,
      `${fixture.allowed}/probe`,
      tools.setpriv,
      ...buildSetprivDropArgs(input.nobody),
      '--',
      tools.sh,
      '-c',
      NOBODY_SCRIPT,
      'sh',
      '/tmp/fro-bot-view-probe',
      String(input.nobody.uid),
    ]

    let admission: Promise<LaunchAdmission> | undefined
    const launched = await deps.launch(tools.sudo, ['-n', '--', ...buildSandboxViewChain(view, command)], {
      timeoutMs: VIEW_PROBE_TIMEOUT_MS,
      onSpawn: pid => {
        admission = deps
          .admit(pid, fixture.gate)
          .catch((): LaunchAdmission => ({kind: 'refused', host: null, reason: 'no-id'}))
      },
    })
    if (launched.pid === null) return fail('the read-only view probe could not be started')

    // The probe's own launch is stopped and confirmed the way the teardown confirms a launch, pass or fail, and a launcher
    // that has exited is not the confirmation: with no id captured, the gate's processes are killed and counted.
    const stopped = await confirmStopped(launched.pid, fixture.gate, await admission, deps, options.settleMs)
    if (!stopped) {
      removable = false
      return fail('the read-only view probe could not be confirmed stopped')
    }
    return launched.exitCode === 0 && !launched.timedOut ? {ok: true} : fail(describeFailure(launched))
  } finally {
    // Nothing is deleted while a member of the probe's namespace may still be running.
    if (removable) {
      await deps.removeFixture(fixture).catch((error: unknown) => {
        deps.logger.debug('The view probe fixture could not be removed', {error: toErrorMessage(error)})
      })
    }
  }
}

async function confirmStopped(
  pid: number,
  gateDir: string,
  admission: LaunchAdmission | undefined,
  deps: SandboxViewProbeDeps,
  settleMs = SETTLE_MS,
): Promise<boolean> {
  const outcome = await deps.stopLaunch(gateDir, admission ?? {kind: 'refused', host: null, reason: 'no-id'})
  if (outcome !== 'stopped') return false
  // The launcher itself exits once its child has; the runner cannot signal it, so it is waited for.
  const deadline = Date.now() + settleMs
  while (deps.isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS))
  }
  return true
}

/** True while a process with this pid exists. A process the runner may not signal still exists (`EPERM`). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function createPrivilegedRunFromExec(exec: ExecAdapter, sudo: string): PrivilegedRun {
  return async (argv, runOptions) => {
    const args = ['-n', '--', ...argv]
    const timeoutMs = runOptions?.timeoutMs ?? 10_000
    if (exec.execWithTimeout === undefined) {
      const output = await exec.getExecOutput(sudo, args, {silent: true, ignoreReturnCode: true, cwd: '/'})
      return {exitCode: output.exitCode, stdout: output.stdout}
    }
    let stdout = ''
    const outcome = await exec.execWithTimeout(sudo, args, timeoutMs, {
      cwd: '/',
      listeners: {
        stdout: data => {
          stdout += data.toString('utf8')
        },
      },
    })
    if (outcome === 'timed-out') return {exitCode: null, stdout: '', timedOutAfterMs: timeoutMs}
    return {exitCode: outcome, stdout}
  }
}

/** Runs the command detached with its stdout captured, bounded in time and size. A timeout tries to kill its group. */
async function launchWithDeadline(
  command: string,
  args: readonly string[],
  options: {readonly timeoutMs: number; readonly onSpawn: (pid: number) => void},
): Promise<ProbeLaunchResult> {
  return new Promise(resolve => {
    let stdout = ''
    let timedOut = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (result: ProbeLaunchResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
        cwd: '/',
        env: {PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C'},
      })
    } catch {
      settle({pid: null, exitCode: null, timedOut: false, stdout: ''})
      return
    }
    const pid = child.pid
    if (pid === undefined) {
      child.once('error', () => settle({pid: null, exitCode: null, timedOut: false, stdout: ''}))
      return
    }
    options.onSpawn(pid)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString('utf8')
    })
    child.once('error', () => settle({pid, exitCode: null, timedOut, stdout}))
    child.once('exit', code => settle({pid, exitCode: code, timedOut, stdout}))
    timer = setTimeout(() => {
      timedOut = true
      try {
        // The runner may not be allowed to signal what runs as root: this is best effort, the namespace stop decides.
        process.kill(-pid, 'SIGKILL')
      } catch {
        // Not permitted, or already gone.
      }
      // The exit may never arrive for a root process: do not wait for it.
      setTimeout(() => settle({pid, exitCode: null, timedOut: true, stdout}), 2000).unref()
    }, options.timeoutMs)
  })
}

async function readNobody(): Promise<{readonly uid: number; readonly gid: number} | null> {
  try {
    for (const line of (await fs.readFile('/etc/passwd', 'utf8')).split('\n')) {
      const fields = line.split(':')
      if (fields[0] !== 'nobody') continue
      const uid = Number.parseInt(fields[2] ?? '', 10)
      const gid = Number.parseInt(fields[3] ?? '', 10)
      return Number.isInteger(uid) && Number.isInteger(gid) ? {uid, gid} : null
    }
  } catch {
    // Unreadable: no probe.
  }
  return null
}

/** The production probe: the runner's real temp directory, `sudo`, and the real builder from the published install. */
export function createViewProbe(options: {
  readonly exec: ExecAdapter
  readonly logger: Logger
  readonly env: NodeJS.ProcessEnv
  /** The directory of the running bundle, which holds `sandbox-view.js`. */
  readonly bundleDir: string | null
}): (tools: SandboxToolPaths) => Promise<ViewProbeResult> {
  return async tools => {
    const fail = (message: string): ViewProbeResult => ({ok: false, message})
    const runnerTemp = options.env.RUNNER_TEMP
    if (options.bundleDir === null) return fail('the location of the view builder could not be determined')
    if (runnerTemp === undefined || runnerTemp.length === 0) return fail('RUNNER_TEMP is not set')
    const nobody = await readNobody()
    if (nobody === null) return fail('the unprivileged account `nobody` could not be read')

    const run = createPrivilegedRunFromExec(options.exec, tools.sudo)
    const identityDeps: SandboxIdentityDeps = {run, readText: async () => null, logger: options.logger}
    const namespaceTools = {pkill: tools.pkill, pgrep: tools.pgrep, lsns: tools.lsns}
    const gateDeps: GateDeps = {
      readText: async file => fs.readFile(file, 'utf8').catch(() => null),
      writeText: async (file, content) => fs.writeFile(file, content, {flag: 'wx', mode: 0o600}),
      readHostNamespace: async () => fs.readlink('/proc/self/ns/mnt').catch(() => null),
      isAlive: isProcessAlive,
    }
    const deps: SandboxViewProbeDeps = {
      makeFixture: async () => {
        const dir = await fs.mkdtemp(path.join(runnerTemp, 'fro-bot-view-probe-'))
        const fixture = {
          dir,
          newRoot: path.join(dir, 'root'),
          gate: path.join(dir, 'gate'),
          allowed: path.join(dir, 'allowed'),
          sealed: path.join(dir, 'sealed'),
        }
        for (const directory of [fixture.newRoot, fixture.gate, fixture.allowed, fixture.sealed]) {
          await fs.mkdir(directory)
        }
        return fixture
      },
      removeFixture: async fixture => {
        // Plain directories and files only. The new root was a mount point in a namespace that is gone, so it is empty.
        await fs.rm(fixture.allowed, {recursive: true, force: true})
        await fs.rm(fixture.sealed, {recursive: true, force: true})
        for (const name of [GATE_NS_FILE, GATE_GO_FILE]) await fs.rm(path.join(fixture.gate, name), {force: true})
        await fs.rmdir(fixture.gate)
        await fs.rmdir(fixture.newRoot)
        await fs.rmdir(fixture.dir)
      },
      launch: launchWithDeadline,
      admit: async (pid, gateDir) => admitLaunch(pid, gateDir, gateDeps, {isClosed: () => false}),
      stopLaunch: async (gateDir, admission) =>
        stopLaunch({gateDir, admission}, namespaceTools, identityDeps, gateDeps),
      isAlive: isProcessAlive,
      logger: options.logger,
    }
    return probeSandboxView(
      {
        tools,
        nodePath: process.execPath,
        builderPath: path.join(options.bundleDir, 'sandbox-view.js'),
        runnerHome: options.env.HOME ?? '/home/runner',
        actionsDir: path.join(path.dirname(path.resolve(runnerTemp)), '_actions'),
        nobody,
      },
      deps,
    )
  }
}
