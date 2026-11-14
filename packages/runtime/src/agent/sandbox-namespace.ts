import type {PrivilegedRunResult, SandboxIdentityDeps, SandboxIdentityTools} from './sandbox-identity.js'
import {sleep as defaultSleep} from '../shared/async.js'
import {toErrorMessage} from '../shared/errors.js'

/**
 * Finding, killing and confirming the members of a launch's private mount namespace.
 *
 * Under `isolate-agent` every process of the launch (the privileged builder, the shells of the exec chain, the server and
 * everything its tools start) is a member of one mount namespace. The runner can signal only `sudo`, so a process group
 * kill leaves the rest running, and the uid sweep cannot see root processes. Membership of the namespace is the handle that
 * covers all of them, whatever their uid, session or group.
 *
 * Measured on both hosted images (see the plan's "Settled by Unit 1"): the launcher's direct child is the first process in
 * the new namespace and `lsns -p` reads its id; `pkill -KILL --ns <member> --nslist mnt` kills every member in one round.
 * A kill needs a living member as its reference. `pgrep --ns` against a dead reference answers "no match", which looks
 * like an empty namespace, so confirmation reads the namespace listing instead.
 *
 * Every command is a privileged argv run through the injected {@link SandboxIdentityDeps.run}.
 */

export type SandboxNamespaceTools = Pick<SandboxIdentityTools, 'pgrep' | 'pkill'> & {readonly lsns: string}

export interface LaunchNamespace {
  /** The inode number of the launch's mount namespace. */
  readonly id: string
  /** The launcher's child: the first process seen in the namespace. It may be dead by the time of the stop. */
  readonly member: number
  /** The launcher's own (host) mount namespace. Never signalled. */
  readonly host: string
}

export type LaunchNamespaceLookup =
  | {readonly kind: 'found'; readonly namespace: LaunchNamespace}
  /** The launcher exited before a new namespace was seen: nothing of the launch can be left. */
  | {readonly kind: 'launch-gone'}
  /** The launcher is alive and its namespace could not be identified in time. */
  | {readonly kind: 'unidentified'}

export type NamespaceStopOutcome = 'stopped' | 'unconfirmed'

const DEFAULT_FIND_BOUND_MS = 10_000
const DEFAULT_FIND_POLL_MS = 50
const DEFAULT_STOP_BOUND_MS = 15_000
const DEFAULT_STOP_POLL_MS = 100
/** One command's own ceiling inside a longer bound. */
const COMMAND_CEILING_MS = 10_000

function firstNumber(result: PrivilegedRunResult): string | null {
  if (result.exitCode !== 0) return null
  const match = /^\s*(\d+)\s*$/m.exec(result.stdout)
  return match?.[1] ?? null
}

/**
 * Polls for the namespace of the launcher's child, until the child is in a namespace other than the launcher's, the
 * launcher is gone, or the bound passes. The child is in the host namespace until `unshare` has run, so equal ids are
 * not an answer yet.
 */
export async function findLaunchNamespace(
  launchPid: number,
  tools: SandboxNamespaceTools,
  deps: SandboxIdentityDeps,
  options: {
    readonly isAlive: (pid: number) => boolean
    readonly boundMs?: number
    readonly pollMs?: number
  },
): Promise<LaunchNamespaceLookup> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const deadline = now() + (options.boundMs ?? DEFAULT_FIND_BOUND_MS)
  const pollMs = options.pollMs ?? DEFAULT_FIND_POLL_MS
  const budget = (): {readonly timeoutMs: number} => ({
    timeoutMs: Math.max(1, Math.min(COMMAND_CEILING_MS, deadline - now())),
  })
  const namespaceOf = async (pid: number | string): Promise<string | null> =>
    firstNumber(await deps.run([tools.lsns, '-n', '-t', 'mnt', '-o', 'NS', '-p', String(pid)], budget()))

  for (;;) {
    try {
      const children = await deps.run([tools.pgrep, '-P', String(launchPid)], budget())
      const host = await namespaceOf(launchPid)
      if (children.exitCode === 0 && host !== null) {
        for (const line of children.stdout.split('\n')) {
          const child = Number.parseInt(line.trim(), 10)
          if (!Number.isInteger(child) || child <= 1) continue
          const id = await namespaceOf(child)
          if (id !== null && id !== host) return {kind: 'found', namespace: {id, member: child, host}}
        }
      }
    } catch (error) {
      deps.logger.warning('Looking up the launch namespace failed', {error: toErrorMessage(error)})
    }
    if (!options.isAlive(launchPid)) return {kind: 'launch-gone'}
    if (now() >= deadline) return {kind: 'unidentified'}
    await sleep(pollMs)
  }
}

/** The members of the namespace by the listing: namespace id to the lowest pid in it. Null when the listing is unusable. */
async function listNamespaces(
  tools: SandboxNamespaceTools,
  deps: SandboxIdentityDeps,
  timeoutMs: number,
): Promise<ReadonlyMap<string, number> | null> {
  const listing = await deps.run([tools.lsns, '-n', '-t', 'mnt', '-o', 'NS,PID'], {timeoutMs})
  if (listing.exitCode !== 0) return null
  const rows = new Map<string, number>()
  for (const line of listing.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) rows.set(match[1], Number.parseInt(match[2], 10))
  }
  // The host's own namespace is always listed: an empty listing is a failure, not an empty answer.
  return rows.size === 0 ? null : rows
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
      const rows = await listNamespaces(tools, deps, budget)
      if (rows !== null) {
        const member = rows.get(namespace.id)
        if (member === undefined) return 'stopped'
        if (member > 1) {
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
