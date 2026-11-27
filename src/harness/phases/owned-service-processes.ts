import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import process from 'node:process'

/**
 * Test support for the real-binary suites that check the agent's `opencode` cannot start a second server (#2369).
 *
 * Those suites run on shared hosts, where unrelated OpenCode services (`serve --service`) may be running. A command line
 * match proves nothing about who started a process, so nothing here ever signals one it cannot prove it owns:
 *
 * - a non-isolated run: the process's own environment names the test's temporary `XDG_STATE_HOME`. The CLI's autostart
 *   inherits the agent shell's environment, so a service the test's agent started carries that value, and an unrelated one
 *   cannot (the directory is made for the test and its name is random);
 * - an isolated run: the process belongs to the sandbox test account's uid. The account is made for the run, and the
 *   lifecycle stops everything it owns at release, so no signal is needed there at all.
 *
 * A process whose environment cannot be read is not proven to be owned, and is left alone.
 */

export const SERVICE_NEEDLE = 'serve --service'

/** What the scan reports: `spawnSync`'s own result shape, narrowed to what is read. */
export interface ScanOutcome {
  readonly status: number | null
  readonly stdout: string
  readonly error?: Error | undefined
}

function runPgrep(args: readonly string[]): ScanOutcome {
  return spawnSync('pgrep', [...args], {encoding: 'utf8'})
}

/**
 * The ids of every process whose command line contains `needle`, from `pgrep -f`. Not evidence of ownership.
 *
 * `pgrep` exits 0 with matches and 1 with none. Anything else (a bad pattern, a fatal error, a kill by signal, no `pgrep`)
 * is a scan that did not happen, and reading it as "no service" would let a test pass without having looked, so it throws.
 */
export function listMatchingProcesses(
  needle: string = SERVICE_NEEDLE,
  uid?: number,
  scan: (args: readonly string[]) => ScanOutcome = runPgrep,
): readonly number[] {
  const found = scan([...(uid === undefined ? [] : ['-u', String(uid)]), '-f', needle])
  if (found.error !== undefined || (found.status !== 0 && found.status !== 1)) {
    const code = found.error === undefined ? undefined : (found.error as NodeJS.ErrnoException).code
    throw new Error(
      `pgrep failed, so the process scan did not run (${found.status === null ? `no status${code === undefined ? '' : `, ${code}`}` : `exit ${found.status}`})`,
    )
  }
  return found.stdout
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}

/**
 * A process's environment as `NAME=value` entries, or null when it cannot be read (it exited, or belongs to someone else).
 * `/proc/<pid>/environ` on Linux, `ps eww` on macOS (which prints the environment after the command line, space separated).
 */
export function readProcessEnvironment(pid: number): readonly string[] | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(entry => entry.length > 0)
  } catch {
    // Not Linux, or not readable: fall through to ps.
  }
  const printed = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], {encoding: 'utf8'})
  if (printed.status !== 0 || printed.stdout.trim().length === 0) return null
  return printed.stdout.trim().split(/\s+/)
}

/** Whether the process's environment names exactly this `XDG_STATE_HOME`. False when it cannot be read: never assumed. */
export function ownsState(
  pid: number,
  stateHome: string,
  read: (pid: number) => readonly string[] | null = readProcessEnvironment,
): boolean {
  if (stateHome.length === 0) return false
  return read(pid)?.includes(`XDG_STATE_HOME=${stateHome}`) === true
}

/** The matching processes that provably belong to the run whose agent state is `stateHome`. Never an unrelated one. */
export function findServicesOwnedByState(
  stateHome: string,
  deps: {
    readonly list?: (needle: string) => readonly number[]
    readonly read?: (pid: number) => readonly string[] | null
  } = {},
): readonly number[] {
  const list = deps.list ?? (needle => listMatchingProcesses(needle))
  return list(SERVICE_NEEDLE).filter(pid => ownsState(pid, stateHome, deps.read))
}

/** The matching processes of a sandbox test account. Refuses a uid that is root or the caller's own: it would not be the account's. */
export function findServicesOfAccount(uid: number): readonly number[] {
  if (!Number.isInteger(uid) || uid <= 0 || uid === process.getuid?.()) return []
  return listMatchingProcesses(SERVICE_NEEDLE, uid)
}

/** Signals processes the caller has already proven to be its own. Takes only what `findServicesOwnedByState` returned. */
export function killOwnedServices(owned: readonly number[]): void {
  for (const pid of owned) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}
