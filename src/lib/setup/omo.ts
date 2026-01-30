import type {Buffer} from 'node:buffer'

import type {ExecAdapter, Logger, OmoInstallResult} from './types.js'
import {toErrorMessage} from '../../utils/errors.js'

export interface OmoInstallOptions {
  claude?: 'no' | 'yes' | 'max20'
  copilot?: 'no' | 'yes'
  gemini?: 'no' | 'yes'
  openai?: 'no' | 'yes'
  opencodeZen?: 'no' | 'yes'
  zaiCodingPlan?: 'no' | 'yes'
}

export interface OmoInstallDeps {
  logger: Logger
  execAdapter: ExecAdapter
}

/**
 * Install Oh My OpenCode (oMo) plugin in headless mode.
 *
 * Adds Sisyphus agent capabilities to OpenCode with configurable model providers.
 * Uses npx for installation to ensure platform-specific binaries are properly
 * installed via npm's optionalDependencies mechanism.
 *
 * See RFC-011-RESEARCH-SUMMARY.md for details.
 */
export async function installOmo(deps: OmoInstallDeps, options: OmoInstallOptions = {}): Promise<OmoInstallResult> {
  const {logger, execAdapter} = deps
  const {
    claude = 'no',
    copilot = 'no',
    gemini = 'no',
    openai = 'no',
    opencodeZen = 'no',
    zaiCodingPlan = 'no',
  } = options

  logger.info('Installing Oh My OpenCode plugin', {claude, copilot, gemini, openai, opencodeZen, zaiCodingPlan})

  const args = [
    'oh-my-opencode@latest',
    'install',
    '--no-tui',
    `--claude=${claude}`,
    `--copilot=${copilot}`,
    `--gemini=${gemini}`,
    `--openai=${openai}`,
    `--opencode-zen=${opencodeZen}`,
    `--zai-coding-plan=${zaiCodingPlan}`,
  ]

  let output = ''
  try {
    const exitCode = await execAdapter.exec('npx', args, {
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        },
        stderr: (data: Buffer) => {
          output += data.toString()
        },
      },
      silent: true,
      ignoreReturnCode: true,
    })

    if (exitCode !== 0) {
      const errorMsg = `oMo installation returned exit code ${exitCode}`
      logger.error(errorMsg, {output: output.slice(0, 1000)})
      return {installed: false, version: null, error: `${errorMsg}\n${output.slice(0, 500)}`}
    }

    // Extract version from output if available
    const versionMatch = /oh-my-opencode@(\d+\.\d+\.\d+)/i.exec(output)
    const version = versionMatch != null && versionMatch[1] != null ? versionMatch[1] : null

    logger.info('oMo plugin installed', {version})
    return {installed: true, version, error: null}
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    const fullError = output.length > 0 ? `${errorMsg}\nOutput: ${output.slice(0, 500)}` : errorMsg
    logger.error('Failed to install oMo plugin', {error: errorMsg, output: output.slice(0, 500)})
    return {installed: false, version: null, error: `npx oh-my-opencode failed: ${fullError}`}
  }
}

/**
 * Verify oMo plugin is functional.
 *
 * Checks that OpenCode recognizes the plugin by looking for config file.
 */
export async function verifyOmoInstallation(logger: Logger, execAdapter: ExecAdapter): Promise<boolean> {
  try {
    const {stdout} = await execAdapter.getExecOutput('ls', ['-la', '~/.config/opencode/oh-my-opencode.json'], {
      silent: true,
      ignoreReturnCode: true,
    })
    const exists = !stdout.includes('No such file')
    logger.debug('oMo config file check', {exists})
    return exists
  } catch {
    logger.debug('Could not verify oMo installation')
    return false
  }
}
