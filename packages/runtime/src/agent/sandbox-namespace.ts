import type {SandboxIdentityDeps, SandboxIdentityTools} from './sandbox-identity.js'
import {sleep as defaultSleep} from '../shared/async.js'
import {toErrorMessage} from '../shared/errors.js'

/**
 * Admitting, killing and confirming the members of a launch's private mount namespace.
 *
 * Under `isolate-agent` every process of the launch (the privileged builder, the shells of the exec chain, the server and
 * everything its tools start) is a member of one mount namespace. The runner can signal only `sudo`, so a process group
 * kill leaves the rest running, and the uid sweep cannot see root processes. Membership of the namespace is the handle that
 * covers all of them, whatever their uid, session or group.
 *
 * The launcher's exit proves nothing about its children: a group kill of `sudo` orphans a root child the runner cannot
 * signal. So a launch must be known before it may run. The first step of the chain (the gate) writes the id of its own
 * mount namespace to a file in a directory only the runner and root can write, then waits for a go-ahead file naming that
 * id. The runner reads and validates the id, keeps it, and only then writes the go-ahead. A launch whose id the runner
 * never captured never gets past the gate, and the gate exits on its own bound.
 *
 * Every command is a privileged argv run through the injected {@link SandboxIdentityDeps.run}.
 */

export type SandboxNamespaceTools = Pick<SandboxIdentityTools, 'pgrep' | 'pkill'> & {readonly lsns: string}

/** The files of a gate directory. The gate script and the runner side agree on these names. */
export const GATE_NS_FILE = 'ns'
export const GATE_GO_FILE = 'go'

export interface LaunchNamespace {
  /** The inode number of the launch's mount namespace. */
  readonly id: string
  /** The runner's own (host) mount namespace. Never signalled. */
  readonly host: string
}

export type LaunchAdmission =
  /** The id was captured and validated and the go-ahead written. */
  | {readonly kind: 'admitted'; readonly namespace: LaunchNamespace}
  /** The id was captured but no go-ahead was given: the teardown began, or the launcher was already gone. */
  | {readonly kind: 'held'; readonly namespace: LaunchNamespace; readonly reason: 'closed' | 'launcher-gone'}
  /** No usable id: no go-ahead was given, so the chain cannot have gone past the gate. */
  | {
      readonly kind: 'refused'
      readonly host: string | null
      readonly reason: 'closed' | 'host-id' | 'host-unreadable' | 'invalid-id' | 'no-id'
    }

export type NamespaceStopOutcome = 'stopped' | 'unconfirmed'

export interface GateDeps {
  /** Reads a text file; null when it is missing or unreadable. */
  readonly readText: (absolutePath: string) => Promise<string | null>
  readonly writeText: (absolutePath: string, content: string) => Promise<void>
  /** The runner's own `/proc/self/ns/mnt` link text, e.g. `mnt:[4026531841]`; null when unreadable. */
  readonly readHostNamespace: () => Promise<string | null>
  readonly isAlive: (pid: number) => boolean
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_ADMIT_BOUND_MS = 10_000
const DEFAULT_ADMIT_POLL_MS = 20
const DEFAULT_STOP_BOUND_MS = 15_000
const DEFAULT_STOP_POLL_MS = 100
/** One command's own ceiling inside a longer bound. */
const COMMAND_CEILING_MS = 10_000

/** `mnt:[4026532399]` to `4026532399`; null for anything else. */
export function parseNamespaceId(text: string | null): string | null {
  if (text === null) return null
  const match = /^mnt:\[(\d{1,20})\]$/.exec(text.trim())
  return match?.[1] ?? null
}

type GateRead =
  | {readonly kind: 'absent'}
  | {readonly kind: 'invalid'}
  | {readonly kind: 'host'}
  | {readonly kind: 'captured'; readonly namespace: LaunchNamespace}

/** What the gate wrote, judged against the runner's own namespace. An empty file is a write in progress: absent. */
export async function readGateNamespace(
  gateDir: string,
  host: string,
  deps: Pick<GateDeps, 'readText'>,
): Promise<GateRead> {
  const text = await deps.readText(`${gateDir}/${GATE_NS_FILE}`)
  if (text === null || text.trim().length === 0) return {kind: 'absent'}
  const id = parseNamespaceId(text)
  if (id === null) return {kind: 'invalid'}
  if (id === host) return {kind: 'host'}
  return {kind: 'captured', namespace: {id, host}}
}

/**
 * Waits for the gate to report its namespace and gives the go-ahead once the id is valid and differs from the runner's.
 * `isClosed` is read immediately before the write: a go-ahead is never given after the teardown began. When the id was
 * captured but no go-ahead was given, the result still carries the namespace, so the teardown can stop it.
 */
export async function admitLaunch(
  launcherPid: number,
  gateDir: string,
  deps: GateDeps,
  options: {readonly isClosed: () => boolean; readonly boundMs?: number; readonly pollMs?: number},
): Promise<LaunchAdmission> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const deadline = now() + (options.boundMs ?? DEFAULT_ADMIT_BOUND_MS)
  const pollMs = options.pollMs ?? DEFAULT_ADMIT_POLL_MS

  const host = parseNamespaceId(await deps.readHostNamespace().catch(() => null))
  if (host === null) return {kind: 'refused', host: null, reason: 'host-unreadable'}

  for (;;) {
    const read = await readGateNamespace(gateDir, host, deps).catch((): GateRead => ({kind: 'absent'}))
    if (read.kind === 'invalid') return {kind: 'refused', host, reason: 'invalid-id'}
    if (read.kind === 'host') return {kind: 'refused', host, reason: 'host-id'}
    if (read.kind === 'captured') {
      const {namespace} = read
      if (options.isClosed()) return {kind: 'held', namespace, reason: 'closed'}
      if (!deps.isAlive(launcherPid)) return {kind: 'held', namespace, reason: 'launcher-gone'}
      try {
        await deps.writeText(`${gateDir}/${GATE_GO_FILE}`, `mnt:[${namespace.id}]\n`)
      } catch {
        return {kind: 'held', namespace, reason: 'closed'}
      }
      return {kind: 'admitted', namespace}
    }
    if (options.isClosed()) return {kind: 'refused', host, reason: 'closed'}
    if (!deps.isAlive(launcherPid) || now() >= deadline) return {kind: 'refused', host, reason: 'no-id'}
    await sleep(pollMs)
  }
}

/** The members of the namespace by the listing: namespace id to the lowest pid in it. Null when the listing is unusable. */
async function listNamespaces(
  tools: SandboxNamespaceTools,
  deps: SandboxIdentityDeps,
  timeoutMs: number,
  host: string,
): Promise<ReadonlyMap<string, number> | null> {
  const listing = await deps.run([tools.lsns, '-n', '-t', 'mnt', '-o', 'NS,PID'], {timeoutMs})
  if (listing.exitCode !== 0) return null
  const rows = new Map<string, number>()
  for (const line of listing.stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    // One row that cannot be read may be the launch's own: the whole listing is unusable.
    if (match?.[1] === undefined || match[2] === undefined) return null
    rows.set(match[1], Number.parseInt(match[2], 10))
  }
  // The runner's own namespace always has processes: a listing without it is cut short, and the absence of the launch's
  // namespace from it proves nothing.
  return rows.has(host) ? rows : null
}

/**
 * Kills the members of the namespace and confirms none remains, in the shape of `stopSandboxProcesses`: list, kill, list
 * again until the namespace is absent from the listing or the bound passes. An absent namespace has no members, so the
 * private mounts are gone with it. `unconfirmed` means a member may still be running.
 */
export async function stopLaunchNamespace(
  namespace: LaunchNamespace,
  tools: SandboxNamespaceTools,
  deps: SandboxIdentityDeps,
  options: {readonly boundMs?: number; readonly pollMs?: number} = {},
): Promise<NamespaceStopOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const deadline = now() + (options.boundMs ?? DEFAULT_STOP_BOUND_MS)
  const pollMs = options.pollMs ?? DEFAULT_STOP_POLL_MS

  // Signalling the host namespace would kill the runner.
  if (namespace.id === namespace.host) {
    deps.logger.error('Refusing to stop a namespace that is the host namespace')
    return 'unconfirmed'
  }

  for (;;) {
    const budget = Math.max(1, Math.min(COMMAND_CEILING_MS, deadline - now()))
    try {
      const rows = await listNamespaces(tools, deps, budget, namespace.host)
      if (rows !== null) {
        const member = rows.get(namespace.id)
        if (member === undefined) return 'stopped'
        if (member > 1) {
          // Reference the lowest living member: `pkill --ns` against a dead pid matches nothing.
          await deps.run([tools.pkill, '-KILL', '--ns', String(member), '--nslist', 'mnt'], {
            timeoutMs: Math.max(1, Math.min(COMMAND_CEILING_MS, deadline - now())),
          })
        }
      }
    } catch (error) {
      deps.logger.warning('Stopping the launch namespace failed', {error: toErrorMessage(error)})
    }
    if (now() >= deadline) {
      deps.logger.error('The launch namespace could not be confirmed empty', {namespace: namespace.id})
      return 'unconfirmed'
    }
    await sleep(pollMs)
  }
}

/**
 * An extended regular expression that matches `text` literally, written so that it does not match its own text. The
 * runner's `sudo pkill -f <pattern>` carries the pattern in its own argv, and `pgrep -f` would otherwise count it. The
 * first alphanumeric character is put in a bracket: `/[h]ome/x` matches `/home/x` but not `/[h]ome/x`.
 */
export function selfExcludingPattern(text: string): string {
  let bracketed = false
  let pattern = ''
  for (const char of text) {
    if (!bracketed && /[A-Z0-9]/i.test(char)) {
      pattern += `[${char}]`
      bracketed = true
    } else if (/[\\^$.|?*+()[\]{}]/.test(char)) {
      pattern += `\\${char}`
    } else {
      pattern += char
    }
  }
  return pattern
}

/**
 * Kills every process whose command line carries the gate directory, then confirms none does. The gate directory is unique
 * to one launch and only the gate shell (and the `sudo` that launched it) carry it: this reaches a launch whose id was never
 * captured, which the namespace cannot. Confirmation needs positive evidence: `pgrep -c` prints `0` and exits 1 for no
 * match, so a `sudo` that failed to run is not read as an empty answer.
 */
export async function stopGateProcesses(
  gateDir: string,
  tools: Pick<SandboxNamespaceTools, 'pgrep' | 'pkill'>,
  deps: SandboxIdentityDeps,
  options: {readonly boundMs?: number; readonly pollMs?: number} = {},
): Promise<NamespaceStopOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const deadline = now() + (options.boundMs ?? DEFAULT_STOP_BOUND_MS)
  const pollMs = options.pollMs ?? DEFAULT_STOP_POLL_MS
  const pattern = selfExcludingPattern(gateDir)

  for (;;) {
    const budget = (): {readonly timeoutMs: number} => ({
      timeoutMs: Math.max(1, Math.min(COMMAND_CEILING_MS, deadline - now())),
    })
    try {
      await deps.run([tools.pkill, '-KILL', '-f', '--', pattern], budget())
      const count = await deps.run([tools.pgrep, '-c', '-f', '--', pattern], budget())
      if (count.exitCode === 1 && count.stdout.trim() === '0') return 'stopped'
    } catch (error) {
      deps.logger.warning('Stopping the gate processes failed', {error: toErrorMessage(error)})
    }
    if (now() >= deadline) {
      deps.logger.error('The processes at the launch gate could not be confirmed gone')
      return 'unconfirmed'
    }
    await sleep(pollMs)
  }
}

/**
 * Stops everything of one launch and confirms it, whether or not its launcher is alive. The rule:
 *
 * - An id was captured (at admission, or by a last read of the gate file now): stop the namespace and confirm it is gone
 *   from the listing. The launcher's state does not matter.
 * - No id was captured: no go-ahead was ever given, so the chain cannot be past the gate. The only process it can have is
 *   the gate shell (or the launcher), found by the gate directory in its command line: kill it and confirm none is left.
 *
 * A launcher that exited is never itself the confirmation.
 */
export async function stopLaunch(
  launch: {readonly gateDir: string; readonly admission: LaunchAdmission},
  tools: SandboxNamespaceTools,
  deps: SandboxIdentityDeps,
  gate: Pick<GateDeps, 'readText'>,
  options: {readonly boundMs?: number; readonly pollMs?: number} = {},
): Promise<NamespaceStopOutcome> {
  const {admission} = launch
  let namespace = admission.kind === 'refused' ? null : admission.namespace
  if (namespace === null && admission.kind === 'refused' && admission.host !== null) {
    try {
      const late = await readGateNamespace(launch.gateDir, admission.host, gate)
      if (late.kind === 'captured') namespace = late.namespace
    } catch {
      // Treated as no id: the gate directory kill below still applies.
    }
  }
  if (namespace !== null) return stopLaunchNamespace(namespace, tools, deps, options)
  return stopGateProcesses(launch.gateDir, tools, deps, options)
}
