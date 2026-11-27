import type {Result} from '@bfra.me/es/result'
import {spawnSync} from 'node:child_process'
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {toErrorMessage} from '../shared/errors.js'
import {err, ok} from '../shared/types.js'

/**
 * The `opencode` the agent's shell finds first (#2369).
 *
 * The OpenCode 2.4 CLI, given no endpoint, calls `Service.ensure` and spawns a detached `serve --service` on the same state
 * (`packages/cli/src/services/server-connection.ts`). The Action's own server is `serve --stdio` on a private loopback port,
 * which the CLI cannot discover, so an agent that runs `opencode api get ...` starts a second server that competes with the
 * Action's, that the Action cannot see, and that nothing reaps. 2.4.1 and 2.4.2 offer no supported switch to stop it.
 *
 * So the agent's `PATH` starts with a directory holding this shim. It runs the real binary only for the forms that never
 * touch a server (`--version` and `--help`, and their short and word spellings, as the sole argument): the `ce:connect`
 * skill's host check runs `opencode --version`. Everything else exits 2 with one line on stderr and starts nothing.
 *
 * This is not a security boundary. A model that runs the real binary by its absolute path still can; the threat is the
 * accidental autostart. The agent's own uid is not made unable to write the directory, either, in a run without
 * `isolate-agent`: only a different uid can be kept from it (the sandbox user, and the workspace's agent user).
 */

/** The file name the agent's shell resolves: the command is `opencode`. */
export const OPENCODE_CLI_SHIM_FILE = 'opencode'

/** The exit status of a refused invocation. 2 is the shell's "misuse of a builtin" and is not what the CLI itself exits with. */
export const OPENCODE_CLI_SHIM_EXIT_CODE = 2

/** What a refused invocation writes to stderr, and all it writes anywhere. */
export const OPENCODE_CLI_SHIM_REFUSAL =
  "opencode: this run's OpenCode server is managed by Fro Bot; the CLI cannot start or reach a server here"

/**
 * The forms that reach the real binary, each only as the sole argument. All six print and exit (the CLI prints its version, or
 * its help; `version` and `help` are not subcommands of 2.4.1 and print the help with exit 1). None resolves an endpoint.
 */
export const OPENCODE_CLI_SHIM_ALLOWED_ARGUMENTS: readonly string[] = [
  '--version',
  '-v',
  'version',
  '--help',
  '-h',
  'help',
]

const DIRECTORY_PREFIX = 'fro-bot-opencode-cli-'

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

/** A word for `sh`: single-quoted, so nothing in it is expanded. A quote inside it closes, is escaped, and reopens. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(String.raw`'\''`)}'`
}

/**
 * The shim's text: a plain POSIX `sh` script. `$#` and `$1` are tested together, so an empty argument, no argument and a
 * second argument all fall to the refusal. Throws for a binary path that is not absolute or that holds a control
 * character: such a path is never embedded in a script.
 */
export function buildOpencodeCliShimScript(binaryPath: string): string {
  if (!path.isAbsolute(binaryPath)) {
    throw new Error('The OpenCode binary path for the CLI guard must be absolute')
  }
  if (CONTROL_CHARACTERS.test(binaryPath)) {
    throw new Error('The OpenCode binary path for the CLI guard holds a control character')
  }
  const patterns = OPENCODE_CLI_SHIM_ALLOWED_ARGUMENTS.map(argument => `1:${argument}`).join('|')
  return [
    '#!/bin/sh',
    '# Fro Bot: the OpenCode CLI must not start or reach a server in this run (fro-bot/agent#2369).',
    'case "$#:$1" in',
    `  ${patterns}) exec ${shellQuote(binaryPath)} "$@" ;;`,
    'esac',
    String.raw`printf '%s\n' ${shellQuote(OPENCODE_CLI_SHIM_REFUSAL)} >&2`,
    `exit ${OPENCODE_CLI_SHIM_EXIT_CODE}`,
    '',
  ].join('\n')
}

export interface OpencodeCliShim {
  /** The directory to put first on the agent's `PATH`. Holds one file, `opencode`. */
  readonly directory: string
  /** Removes the directory and the file. Idempotent, and never throws. */
  readonly remove: () => void
}

export interface CreateOpencodeCliShimOptions {
  /** The real OpenCode binary: absolute. */
  readonly binaryPath: string
  /** An existing directory the new one is made under. */
  readonly parentDirectory: string
}

/**
 * Makes a fresh directory under `parentDirectory` (`mkdtemp`: a random name, created exclusively, never through a link) and
 * writes the shim into it. The directory and the file are 0755 and owned by the caller: another user can read and run them
 * and cannot change them. The modes are set exactly, after the umask has had its say.
 *
 * Synchronous on purpose: the server start takes its last decisions with no `await` before the spawn.
 */
export function createOpencodeCliShim(options: CreateOpencodeCliShimOptions): Result<OpencodeCliShim, string> {
  let directory: string | undefined
  try {
    const script = buildOpencodeCliShimScript(options.binaryPath)
    directory = mkdtempSync(path.join(options.parentDirectory, DIRECTORY_PREFIX))
    chmodSync(directory, 0o755)
    const file = path.join(directory, OPENCODE_CLI_SHIM_FILE)
    writeFileSync(file, script, {mode: 0o755, flag: 'wx'})
    chmodSync(file, 0o755)
    const made = directory
    return ok({
      directory: made,
      remove: () => {
        try {
          rmSync(made, {recursive: true, force: true})
        } catch {
          // Already gone, or not ours to remove: the directory holds a script and nothing else.
        }
      },
    })
  } catch (error) {
    if (directory !== undefined) rmSync(directory, {recursive: true, force: true})
    return err(`Could not create the OpenCode CLI guard: ${toErrorMessage(error)}`)
  }
}

/** `existing` with `directory` first and nowhere else: whatever the command lookup found before, it now finds the shim. */
export function prependPathDirectory(directory: string, existing: string | undefined): string {
  const rest = (existing ?? '').split(path.delimiter).filter(entry => entry.length > 0 && entry !== directory)
  return [directory, ...rest].join(path.delimiter)
}

/** The argument a probe passes: any argument outside the allowlist, so the shim refuses it without touching the real binary. */
const PROBE_ARGUMENT = 'api'
const PROBE_TIMEOUT_MS = 5000

/** What a probe run reports, without the process machinery: an exit status (null when none) and what it wrote to stderr. */
export interface CliShimProbeOutcome {
  readonly exitCode: number | null
  readonly stderr: string
}

/**
 * Whether a probe run of the shim did what the shim does: exit 2 with exactly the refusal line. Anything else (a file that
 * cannot be executed, as on a `noexec` mount, a missing interpreter, some other program) means the guard does not work for
 * whoever ran it. The result names the exit status only, never output or a path.
 */
export function readCliShimProbe(outcome: CliShimProbeOutcome): Result<null, string> {
  if (outcome.exitCode === OPENCODE_CLI_SHIM_EXIT_CODE && outcome.stderr.trim() === OPENCODE_CLI_SHIM_REFUSAL) {
    return ok(null)
  }
  return err(`the shim exited ${outcome.exitCode === null ? 'without a status' : outcome.exitCode}, not as a refusal`)
}

/**
 * Runs the shim once with a refused argument, as the identity that will run the server (`identity`, when the spawn drops
 * to a uid and gid; the caller's own otherwise), and reads the result. A directory on a `noexec` mount, or one that identity
 * cannot enter, fails here instead of leaving a PATH entry the agent cannot use. Synchronous, like the creation.
 */
export function probeOpencodeCliShim(
  shimFile: string,
  identity?: {readonly uid: number; readonly gid: number},
): Result<null, string> {
  const ran = spawnSync(shimFile, [PROBE_ARGUMENT], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    env: {},
    stdio: ['ignore', 'ignore', 'pipe'],
    ...(identity === undefined ? {} : {uid: identity.uid, gid: identity.gid}),
  })
  if (ran.error !== undefined) {
    const code = (ran.error as NodeJS.ErrnoException).code
    return err(`the shim could not be run${code === undefined ? '' : ` (${code})`}`)
  }
  return readCliShimProbe({exitCode: ran.status, stderr: ran.stderr})
}
