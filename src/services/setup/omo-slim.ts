import type {Buffer} from 'node:buffer'

import type {OmoSlimPreset} from '../../shared/types.js'
import type {ExecAdapter, Logger, OmoInstallResult} from './types.js'

import {toErrorMessage} from '../../shared/errors.js'

/**
 * Install Oh My OpenCode Slim plugin in headless mode.
 *
 * Adds orchestrator agent capabilities to OpenCode with a single preset-based configuration.
 * Uses bunx to download and run the installer ephemerally. No --skip-auth flag (unlike oMo).
 * No telemetry environment variables to export.
 *
 * This function runs on every invocation to ensure configuration is always up to date.
 */
export async function installOmoSlim(
  version: string,
  deps: {logger: Logger; execAdapter: ExecAdapter},
  preset: OmoSlimPreset,
): Promise<OmoInstallResult> {
  const {logger, execAdapter} = deps

  logger.info('Installing Oh My OpenCode Slim plugin', {version, preset})

  let output = ''
  const args = [`oh-my-opencode-slim@${version}`, 'install', '--no-tui', '--reset', `--preset=${preset}`]

  try {
    const exitCode = await execAdapter.exec('bunx', args, {
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        },
        stderr: (data: Buffer) => {
          output += data.toString()
        },
      },
      ignoreReturnCode: true,
    })
    if (exitCode !== 0) {
      const errorMsg = `bunx oh-my-opencode-slim install returned exit code ${exitCode}`
      logger.error(errorMsg, {output: output.slice(0, 1000)})
      return {installed: false, version: null, error: `${errorMsg}\n${output.slice(0, 500)}`}
    }
    const versionMatch = /oh-my-opencode-slim@(\d+\.\d+\.\d+)/i.exec(output)
    const detectedVersion = versionMatch != null && versionMatch[1] != null ? versionMatch[1] : version
    logger.info('OMO Slim plugin installed', {version: detectedVersion})
    return {installed: true, version: detectedVersion, error: null}
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    const fullError = output.length > 0 ? `${errorMsg}\nOutput: ${output.slice(0, 500)}` : errorMsg
    logger.error('Failed to run OMO Slim installer', {error: errorMsg, output: output.slice(0, 500)})
    return {installed: false, version: null, error: `bunx oh-my-opencode-slim install failed: ${fullError}`}
  }
}

export async function verifyOmoSlimInstallation(logger: Logger, execAdapter: ExecAdapter): Promise<boolean> {
  try {
    // bunx runs ephemerally so the binary won't be in PATH — verify config file only
    const configResult = await execAdapter.getExecOutput('ls', ['-la', '~/.config/opencode/oh-my-opencode-slim.json'], {
      silent: true,
      ignoreReturnCode: true,
    })
    const configExists = !configResult.stdout.includes('No such file')

    logger.debug('OMO Slim verification', {configExists, verified: configExists})
    return configExists
  } catch {
    logger.debug('Could not verify OMO Slim installation')
    return false
  }
}
