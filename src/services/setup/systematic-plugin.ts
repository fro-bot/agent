import type {ExecAdapter, Logger} from './types.js'
import process from 'node:process'
import {toErrorMessage} from '../../shared/errors.js'

const DEFAULT_INSTALL_TIMEOUT_MS = 120_000

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
  try {
    const args = ['--pure', 'plugin', `@fro.bot/systematic@${systematicVersion}`, '--global']
    const execOptions = {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
        ),
        OPENCODE_CONFIG_CONTENT: emptyConfig,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      },
      ignoreReturnCode: true,
      silent: true,
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

    logger.warning('Systematic plugin install failed', {systematicVersion, exitCode: result, duration})
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
