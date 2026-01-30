import type {Buffer} from 'node:buffer'

import type {ExecAdapter, Logger, OmoInstallResult, ToolCacheAdapter} from './types.js'
import {toErrorMessage} from '../../utils/errors.js'

import {installBun, isBunAvailable} from './bun.js'

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
  toolCache: ToolCacheAdapter
  addPath: (inputPath: string) => void
}

/**
 * Install Oh My OpenCode (oMo) plugin in headless mode.
 *
 * Adds Sisyphus agent capabilities to OpenCode with configurable model providers.
 * Automatically installs Bun runtime if not available, since oh-my-opencode
 * is built with `--target bun` and requires Bun runtime.
 *
 * See RFC-011-RESEARCH-SUMMARY.md for details.
 */
export async function installOmo(deps: OmoInstallDeps, options: OmoInstallOptions = {}): Promise<OmoInstallResult> {
  const {logger, execAdapter, toolCache, addPath} = deps
  const {
    claude = 'no',
    copilot = 'no',
    gemini = 'no',
    openai = 'no',
    opencodeZen = 'no',
    zaiCodingPlan = 'no',
  } = options

  logger.info('Installing Oh My OpenCode plugin', {claude, copilot, gemini, openai, opencodeZen, zaiCodingPlan})

  // Ensure Bun is available (install if needed)
  const bunAvailable = await isBunAvailable(execAdapter)
  if (!bunAvailable) {
    logger.info('Bun not found, installing...')
    try {
      await installBun(logger, toolCache, execAdapter, addPath)
    } catch (error) {
      const errorMsg = toErrorMessage(error)
      logger.error('Failed to install Bun runtime', {error: errorMsg})
      return {installed: false, version: null, error: `Bun installation failed: ${errorMsg}`}
    }
  }

  const args = [
    'oh-my-opencode',
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
    const exitCode = await execAdapter.exec('bunx', args, {
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
    return {installed: false, version: null, error: `bunx oh-my-opencode failed: ${fullError}`}
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
