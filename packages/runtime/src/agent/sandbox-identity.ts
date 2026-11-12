import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import {sleep as defaultSleep} from '../shared/async.js'
import {toErrorMessage} from '../shared/errors.js'
import {err, ok} from '../shared/types.js'

/**
 * The sandbox account for `isolate-agent`: one dedicated, unprivileged local user per run.
 *
 * Every privileged step goes through an injected {@link PrivilegedRun} (the Action wires it to `sudo -n --`), so this
 * module is testable without root. Tool paths are absolute and resolved by the preflight, never from `PATH`.
 *
 * The name is fixed and the account is created per run and deleted at the end. Creation is refused when the account or
 * its group already exists, and an existing account is never adopted, so "every process of this uid" means this run's
 * sandbox and nothing else. Two isolated steps in one job therefore cannot coexist: the second fails here.
 */

export const SANDBOX_ACCOUNT_NAME = 'fro-bot-sandbox'

/** Bound on the kill/verify loop. A stubborn survivor past this makes the run decline persistence and publication. */
export const DEFAULT_SANDBOX_STOP_BOUND_MS = 15_000
const DEFAULT_STOP_POLL_MS = 100

export interface PrivilegedRunResult {
  /** `null` when the command was killed for running past its budget (see `timedOutAfterMs`). */
  readonly exitCode: number | null
  readonly stdout: string
  /** The last 2048 bytes of stderr, when the runner collects it. */
  readonly stderr?: string
  /** Set when the command was killed for running past this many milliseconds. */
  readonly timedOutAfterMs?: number
}

/** The budget of the `useradd` that creates the sandbox account. Pinned by a unit test; a change is a decision. */
export const SANDBOX_ACCOUNT_CREATE_TIMEOUT_MS = 60_000

/** How much of a command's stderr goes into an error message. */
const ERROR_STDERR_CHARS = 300

/**
 * A short, one-line reason a privileged command did not succeed: `timed out after Nms` for a killed one, else its exit
 * code, then the tail of its stderr. Tool output only; commands here never print secrets, and the tail is bounded.
 */
export function describePrivilegedFailure(what: string, result: PrivilegedRunResult): string {
  let how: string
  if (result.timedOutAfterMs !== undefined) how = `timed out after ${result.timedOutAfterMs}ms`
  else if (result.exitCode === null) how = 'did not run to completion'
  else how = `failed (exit ${result.exitCode})`
  const tail = (result.stderr ?? '').replaceAll(/\s+/g, ' ').trim().slice(-ERROR_STDERR_CHARS)
  return tail.length === 0 ? `${what} ${how}` : `${what} ${how}; stderr: ${tail}`
}

/** Runs `argv` as root. `argv[0]` is an absolute path. Never throws for a non-zero exit. */
export type PrivilegedRun = (
  argv: readonly string[],
  options?: {readonly timeoutMs?: number},
) => Promise<PrivilegedRunResult>

export interface SandboxAccount {
  readonly name: string
  readonly uid: number
  readonly gid: number
  readonly home: string
}

export interface SandboxIdentityTools {
  readonly setpriv: string
  readonly useradd: string
  readonly userdel: string
  readonly pkill: string
  readonly pgrep: string
  readonly chmod: string
}

export interface SandboxIdentityDeps {
  readonly run: PrivilegedRun
  /** Reads a text file; null when unreadable. Used for `/etc/passwd` and `/etc/group`. */
  readonly readText: (absolutePath: string) => Promise<string | null>
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly logger: Logger
}

export type SandboxAccountError =
  {readonly kind: 'exists'; readonly message: string} | {readonly kind: 'create-failed'; readonly message: string}

interface PasswdEntry {
  readonly name: string
  readonly uid: number
  readonly gid: number
  readonly home: string
}

function parsePasswd(text: string): readonly PasswdEntry[] {
  const entries: PasswdEntry[] = []
  for (const line of text.split('\n')) {
    const fields = line.split(':')
    if (fields.length < 6) continue
    const [name, , uid, gid, , home] = fields
    const parsedUid = Number.parseInt(uid ?? '', 10)
    const parsedGid = Number.parseInt(gid ?? '', 10)
    if (name === undefined || home === undefined || Number.isNaN(parsedUid) || Number.isNaN(parsedGid)) continue
    entries.push({name, uid: parsedUid, gid: parsedGid, home})
  }
  return entries
}

interface GroupEntry {
  readonly name: string
  readonly gid: number
  readonly members: readonly string[]
}

function parseGroups(text: string): readonly GroupEntry[] {
  const entries: GroupEntry[] = []
  for (const line of text.split('\n')) {
    const fields = line.split(':')
    if (fields.length < 4) continue
    const gid = Number.parseInt(fields[2] ?? '', 10)
    if (fields[0] === undefined || Number.isNaN(gid)) continue
    entries.push({
      name: fields[0],
      gid,
      members: (fields[3] ?? '').split(',').filter(member => member.length > 0),
    })
  }
  return entries
}

/**
 * Creates the account: a system user with its own same-named primary group, no supplementary groups, and a fresh 0700
 * home. The sandbox's uid and gid are whatever `useradd` allocated, read back from `/etc/passwd`.
 */
export async function createSandboxAccount(
  tools: Pick<SandboxIdentityTools, 'chmod' | 'useradd' | 'userdel'>,
  deps: SandboxIdentityDeps,
): Promise<Result<SandboxAccount, SandboxAccountError>> {
  const name = SANDBOX_ACCOUNT_NAME
  const home = `/home/${name}`
  const [passwdText, groupText] = await Promise.all([deps.readText('/etc/passwd'), deps.readText('/etc/group')])
  if (passwdText === null || groupText === null) {
    return err({
      kind: 'create-failed',
      message: 'Could not read /etc/passwd or /etc/group to check the sandbox account',
    })
  }
  if (parsePasswd(passwdText).some(entry => entry.name === name) || parseGroups(groupText).some(g => g.name === name)) {
    return err({
      kind: 'exists',
      message: `The sandbox account "${name}" already exists; refusing to adopt it. Two isolated steps cannot run in one job`,
    })
  }

  const created = await deps.run(
    [
      tools.useradd,
      '--system',
      '--user-group',
      '--no-log-init',
      '--create-home',
      '--home-dir',
      home,
      '--shell',
      '/bin/bash',
      '--comment',
      'fro-bot sandbox',
      name,
    ],
    {timeoutMs: SANDBOX_ACCOUNT_CREATE_TIMEOUT_MS},
  )
  if (created.exitCode !== 0) {
    // For a killed command, say whether the account existed at that moment: "never got as far as creating it" and "created it,
    // then did not exit" are different problems, and the removal below destroys the evidence.
    const presence =
      created.timedOutAfterMs === undefined
        ? ''
        : `; account present at timeout: ${(await accountExists(name, deps)) ? 'yes' : 'no'}`
    // useradd can fail after creating part of the account; remove only what now exists under the name we just checked.
    await removeIfPresent(name, tools, deps)
    return err({
      kind: 'create-failed',
      message: `${describePrivilegedFailure('useradd for the sandbox account', created)}${presence}`,
    })
  }

  const account = await readBackAccount(name, deps)
  if (account === null) {
    await removeIfPresent(name, tools, deps)
    return err({kind: 'create-failed', message: 'The sandbox account was created but could not be verified'})
  }
  const locked = await deps.run([tools.chmod, '0700', account.home])
  if (locked.exitCode !== 0) {
    await deleteSandboxAccount(account, tools, deps)
    return err({kind: 'create-failed', message: 'Could not restrict the sandbox home to mode 0700'})
  }
  deps.logger.info('Sandbox account created', {name, uid: account.uid})
  return ok(account)
}

async function accountExists(name: string, deps: SandboxIdentityDeps): Promise<boolean> {
  const passwdText = await deps.readText('/etc/passwd')
  return passwdText !== null && parsePasswd(passwdText).some(entry => entry.name === name)
}

async function readBackAccount(name: string, deps: SandboxIdentityDeps): Promise<SandboxAccount | null> {
  const [passwdText, groupText] = await Promise.all([deps.readText('/etc/passwd'), deps.readText('/etc/group')])
  if (passwdText === null || groupText === null) return null
  const entries = parsePasswd(passwdText)
  const entry = entries.find(candidate => candidate.name === name)
  if (entry === undefined) return null
  // The uid is the isolation boundary: it must belong to this account alone, and the account must carry no groups
  // beyond its own primary one.
  if (entries.filter(candidate => candidate.uid === entry.uid).length !== 1) return null
  const groups = parseGroups(groupText)
  if (groups.some(group => group.gid !== entry.gid && group.members.includes(name))) return null
  if (groups.filter(group => group.gid === entry.gid).some(group => group.members.some(member => member !== name))) {
    return null
  }
  return {name, uid: entry.uid, gid: entry.gid, home: entry.home}
}

async function removeIfPresent(
  name: string,
  tools: Pick<SandboxIdentityTools, 'userdel'>,
  deps: SandboxIdentityDeps,
): Promise<void> {
  const passwdText = await deps.readText('/etc/passwd')
  if (passwdText !== null && parsePasswd(passwdText).some(entry => entry.name === name)) {
    await deps.run([tools.userdel, '--remove', name])
  }
}

export type SandboxStopOutcome = 'stopped' | 'unconfirmed'

/**
 * Kills every process of the sandbox uid and verifies none remains. `pkill -KILL` and `pgrep` alternate until `pgrep`
 * is empty or the bound passes. The uid is unique to this run, so this catches `setsid`, double-fork and
 * signal-ignoring descendants without tracking a process tree. After `pgrep` reports empty nothing can start another
 * process of the uid: the only parents were the processes just verified gone.
 *
 * `unconfirmed` means the sandbox may still be running; the caller must not read its output or delete the account.
 */
export async function stopSandboxProcesses(
  account: Pick<SandboxAccount, 'uid'>,
  tools: Pick<SandboxIdentityTools, 'pgrep' | 'pkill'>,
  deps: SandboxIdentityDeps,
  options: {readonly boundMs?: number; readonly pollMs?: number} = {},
): Promise<SandboxStopOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const deadline = now() + (options.boundMs ?? DEFAULT_SANDBOX_STOP_BOUND_MS)
  const pollMs = options.pollMs ?? DEFAULT_STOP_POLL_MS
  const uid = String(account.uid)

  for (;;) {
    // Each command gets what is left of the bound and is killed when it runs out; a hung pkill/pgrep proves nothing and
    // the loop ends `unconfirmed` at the deadline instead of hanging the run.
    const remaining = Math.max(1, deadline - now())
    try {
      await deps.run([tools.pkill, '-KILL', '-u', uid], {timeoutMs: remaining})
      const probe = await deps.run([tools.pgrep, '-u', uid], {timeoutMs: Math.max(1, deadline - now())})
      // pgrep: 0 = matched, 1 = nothing matched. Anything else is an error and proves nothing.
      if (probe.exitCode === 1) return 'stopped'
    } catch (error) {
      deps.logger.warning('Sandbox process check failed', {error: toErrorMessage(error)})
    }
    if (now() >= deadline) {
      deps.logger.error('Sandbox processes could not be confirmed gone', {uid: account.uid})
      return 'unconfirmed'
    }
    await sleep(pollMs)
  }
}

export type SandboxDeleteOutcome = 'deleted' | 'failed'

/** Deletes the account and its home. Only call after {@link stopSandboxProcesses} returned `stopped`. */
export async function deleteSandboxAccount(
  account: Pick<SandboxAccount, 'name'>,
  tools: Pick<SandboxIdentityTools, 'userdel'>,
  deps: SandboxIdentityDeps,
): Promise<SandboxDeleteOutcome> {
  const result = await deps.run([tools.userdel, '--remove', account.name])
  if (result.exitCode === 0) return 'deleted'
  // 6 = the account is already gone.
  if (result.exitCode === 6) return 'deleted'
  deps.logger.warning('Sandbox account could not be deleted', {name: account.name, exitCode: result.exitCode})
  return 'failed'
}

/** The fixed privilege drop. Matches `deploy/workspace-entrypoint.sh`, plus empty capability sets. */
export function buildSetprivDropArgs(account: Pick<SandboxAccount, 'gid' | 'uid'>): readonly string[] {
  return [
    `--reuid=${account.uid}`,
    `--regid=${account.gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--bounding-set=-all',
    '--ambient-caps=-all',
  ]
}

/** `argv` to run a command as the sandbox user through the same privileged runner. */
export function buildRunAsSandboxArgv(
  account: Pick<SandboxAccount, 'gid' | 'uid'>,
  tools: Pick<SandboxIdentityTools, 'setpriv'>,
  command: readonly string[],
): readonly string[] {
  return [tools.setpriv, ...buildSetprivDropArgs(account), '--', ...command]
}
