import type {Buffer} from 'node:buffer'
import type {ExecAdapter, Logger} from './types.js'
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
  readonly opencodePath: string
  readonly systematicVersion: string
  readonly timeoutMs?: number
}

export interface SystematicPluginInstallResult {
  readonly status: 'installed' | 'failed' | 'timed-out'
  readonly duration: number
}

const emptyConfig = JSON.stringify({plugin: []})

export async function installSystematicPlugin(
  options: SystematicPluginInstallOptions,
): Promise<SystematicPluginInstallResult> {
  const {logger, execAdapter, opencodePath, systematicVersion} = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  const startTime = Date.now()

  logger.info('Installing Systematic plugin', {systematicVersion, timeoutMs})

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let stderrTail = ''
  try {
    const args = ['--pure', 'plugin', `@fro.bot/systematic@${systematicVersion}`, '--global']
    // Scrubbed, not inherited: npm runs lifecycle scripts from a network-fetched package,
    // so the child must not see tokens, API keys, secrets, AWS_*, or INPUT_*.
    const execOptions = {
      env: {
        ...filterAgentEnv(process.env),
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
            execAdapter.exec(opencodePath, args, execOptions),
            new Promise<'timed-out'>(resolve => {
              timeoutId = setTimeout(() => resolve('timed-out'), timeoutMs)
            }),
          ])
        : await execWithTimeout(opencodePath, args, timeoutMs, execOptions)

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
    logger.warning('Systematic plugin install failed', {
      systematicVersion,
      error: toErrorMessage(error),
      duration,
    })
    return {status: 'failed', duration}
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
  }
}
