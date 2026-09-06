import type {Buffer} from 'node:buffer'
import type {ExecAdapter, Logger} from './types.js'
import {constants} from 'node:fs'
import {access, lstat, readdir, stat} from 'node:fs/promises'
import {dirname} from 'node:path'
import process from 'node:process'
import {filterAgentEnv} from '@fro-bot/runtime'
import {toErrorMessage} from '../../shared/errors.js'

// Clears the 181-370s tail measured on the server-side install this replaces. A shorter
// budget would time out on slow-but-valid installs and hand them straight back to the
// unbounded path. Healthy installs finish in seconds.
const DEFAULT_INSTALL_TIMEOUT_MS = 420_000
const STDERR_TAIL_LIMIT = 2_000

export interface SystematicPluginInstallOptions {
  readonly logger: Logger
  readonly execAdapter: ExecAdapter
  /** The OpenCode executable, not its install directory — this value is spawned directly. */
  readonly opencodeBinaryPath: string
  readonly systematicVersion: string
  readonly timeoutMs?: number
}

export interface SystematicPluginInstallResult {
  readonly status: 'installed' | 'failed' | 'timed-out'
  readonly duration: number
}

const emptyConfig = JSON.stringify({plugin: []})
const MAX_LISTED_ENTRIES = 10

// Matched on the error message, not a type assertion on the caught value -- spawn failures
// from both @actions/exec and a plain Node ENOENT/EACCES rejection carry the code in the
// message text (e.g. "spawn opencode ENOENT").
function isSpawnPathError(message: string): boolean {
  return message.includes('ENOENT') || message.includes('EACCES')
}

// Narrowed rather than asserted: a rejected fs call carries `code`, but the caught value is
// `unknown` and this runs where a wrong assumption would throw inside a catch.
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

// Runs inside a catch block for a spawn failure -- must never throw. Every filesystem call is
// wrapped so a diagnosis failure degrades to a short fallback string instead of masking the
// original error.
export async function diagnoseBinaryPath(binaryPath: string): Promise<string> {
  try {
    let stats = null
    let statError
    try {
      stats = await stat(binaryPath)
    } catch (error) {
      statError = errorCode(error)
    }

    if (stats === null) {
      // stat follows symlinks, so a dangling link lands here despite the entry existing. Probe
      // with lstat first, or the message reports the path missing and then lists it among the
      // parent's contents -- a diagnosis that argues with itself is worse than none.
      let linkStats = null
      try {
        linkStats = await lstat(binaryPath)
      } catch {
        linkStats = null
      }

      if (linkStats !== null && linkStats.isSymbolicLink()) {
        return 'path is a symbolic link whose target does not exist'
      }

      // Only ENOENT means absent. Every other stat failure -- a parent that is readable but not
      // searchable being the reachable one -- leaves existence unknown, and everything below
      // this line assumes the path is gone.
      if (statError !== 'ENOENT') {
        return `path could not be examined (${statError ?? 'unknown error'})`
      }

      const parentDir = dirname(binaryPath)
      try {
        const entries = await readdir(parentDir)
        const shown = entries.slice(0, MAX_LISTED_ENTRIES)
        const truncated = entries.length > MAX_LISTED_ENTRIES ? ` (truncated, ${entries.length} total)` : ''
        return `path does not exist; parent directory ${parentDir} contains: ${shown.join(', ')}${truncated}`
      } catch (error) {
        // Absence is already established above, so both arms state it. Reachable with a
        // searchable-but-unreadable parent, which answers stat and refuses readdir.
        const code = errorCode(error)
        return code === 'ENOENT'
          ? `path does not exist; parent directory ${parentDir} does not exist either`
          : `path does not exist; parent directory ${parentDir} is not readable (${code ?? 'unknown error'})`
      }
    }

    if (stats.isDirectory()) {
      return 'resolved path is a directory, not an executable'
    }

    try {
      await access(binaryPath, constants.X_OK)
      return 'path exists and is an executable file'
    } catch {
      return 'path exists but is not executable by the current user'
    }
  } catch {
    return 'diagnosis unavailable'
  }
}

export async function installSystematicPlugin(
  options: SystematicPluginInstallOptions,
): Promise<SystematicPluginInstallResult> {
  const {logger, execAdapter, opencodeBinaryPath, systematicVersion} = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  const startTime = Date.now()

  logger.info('Installing Systematic plugin', {systematicVersion, timeoutMs, opencodeBinaryPath})

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let stderrTail = ''
  try {
    const args = ['--pure', 'plugin', `@fro.bot/systematic@${systematicVersion}`, '--global']
    // Scrubbed, not inherited: npm runs lifecycle scripts from a network-fetched package,
    // so the child must not see tokens, API keys, secrets, AWS_*, or INPUT_*.
    const execOptions = {
      env: {
        ...filterAgentEnv(process.env),
        // Keep the child's config load off the checked-out repository and off the CI plugin
        // list. These do NOT protect the global config file from the patch step -- that reads
        // the file directly and no-ops by package-name match. Not a guard; do not remove as one.
        OPENCODE_CONFIG_CONTENT: emptyConfig,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      },
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stderr: (data: Buffer) => {
          stderrTail = `${stderrTail}${data.toString()}`.slice(-STDERR_TAIL_LIMIT)
        },
      },
    } as const
    const execWithTimeout = execAdapter.execWithTimeout
    const result =
      execWithTimeout === undefined
        ? await Promise.race<number | 'timed-out'>([
            execAdapter.exec(opencodeBinaryPath, args, execOptions),
            new Promise<'timed-out'>(resolve => {
              timeoutId = setTimeout(() => resolve('timed-out'), timeoutMs)
            }),
          ])
        : await execWithTimeout(opencodeBinaryPath, args, timeoutMs, execOptions)

    const duration = Date.now() - startTime
    if (result === 'timed-out') {
      logger.warning('Systematic plugin install timed out', {systematicVersion, timeoutMs, duration})
      return {status: 'timed-out', duration}
    }

    if (result === 0) {
      logger.info('Systematic plugin install complete', {systematicVersion, duration})
      return {status: 'installed', duration}
    }

    logger.warning('Systematic plugin install failed', {
      systematicVersion,
      exitCode: result,
      duration,
      stderr: stderrTail,
    })
    return {status: 'failed', duration}
  } catch (error) {
    const duration = Date.now() - startTime
    const message = toErrorMessage(error)
    const pathDiagnosis = isSpawnPathError(message) ? await diagnoseBinaryPath(opencodeBinaryPath) : undefined
    logger.warning('Systematic plugin install failed', {
      systematicVersion,
      error: message,
      duration,
      // A rejection can arrive after the child has already written output -- the adapter's
      // 'error' handler fires independently of what was streamed. The exit-code branch reports
      // the tail; dropping it here would discard the one thing the diagnosis cannot explain.
      ...(stderrTail.length > 0 ? {stderr: stderrTail} : {}),
      ...(pathDiagnosis === undefined ? {} : {pathDiagnosis}),
    })
    return {status: 'failed', duration}
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
  }
}
