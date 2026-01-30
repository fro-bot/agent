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
 * Uses global npm install to ensure platform-specific binaries are properly
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

  let output = ''

  // Step 1: Install oh-my-opencode globally (ensures platform binary is installed)
  try {
    const installExitCode = await execAdapter.exec('npm', ['install', '-g', 'oh-my-opencode@latest'], {
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

    if (installExitCode !== 0) {
      const errorMsg = `npm install -g oh-my-opencode returned exit code ${installExitCode}`
      logger.error(errorMsg, {output: output.slice(0, 1000)})
      return {installed: false, version: null, error: `${errorMsg}\n${output.slice(0, 500)}`}
    }

    logger.debug('oh-my-opencode package installed globally')
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    const fullError = output.length > 0 ? `${errorMsg}\nOutput: ${output.slice(0, 500)}` : errorMsg
    logger.error('Failed to install oh-my-opencode package', {error: errorMsg, output: output.slice(0, 500)})
    return {installed: false, version: null, error: `npm install -g failed: ${fullError}`}
  }

  // Step 2: Run the oh-my-opencode installer
  const installerArgs = [
    'install',
    '--no-tui',
    `--claude=${claude}`,
    `--copilot=${copilot}`,
    `--gemini=${gemini}`,
    `--openai=${openai}`,
    `--opencode-zen=${opencodeZen}`,
    `--zai-coding-plan=${zaiCodingPlan}`,
  ]

  output = ''
  try {
    const exitCode = await execAdapter.exec('oh-my-opencode', installerArgs, {
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
      const errorMsg = `oh-my-opencode install returned exit code ${exitCode}`
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
    logger.error('Failed to run oMo installer', {error: errorMsg, output: output.slice(0, 500)})
    return {installed: false, version: null, error: `oh-my-opencode install failed: ${fullError}`}
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
