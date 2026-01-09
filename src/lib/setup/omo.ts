import type {Buffer} from 'node:buffer'

import type {ExecAdapter, Logger, OmoInstallResult, ToolCacheAdapter} from './types.js'
import {installBun, isBunAvailable} from './bun.js'

export interface OmoInstallOptions {
  claude?: 'no' | 'yes' | 'max20'
  chatgpt?: 'no' | 'yes'
  gemini?: 'no' | 'yes'
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
  const {claude = 'no', chatgpt = 'no', gemini = 'no'} = options

  logger.info('Installing Oh My OpenCode plugin', {claude, chatgpt, gemini})

  // Ensure Bun is available (install if needed)
  const bunAvailable = await isBunAvailable(execAdapter)
  if (!bunAvailable) {
    logger.info('Bun not found, installing...')
    try {
      await installBun(logger, toolCache, execAdapter, addPath)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to install Bun runtime', {error: errorMsg})
      return {installed: false, version: null, error: `Bun installation failed: ${errorMsg}`}
    }
  }

  const args = [
    'x',
    'oh-my-opencode',
    'install',
    '--no-tui',
    `--claude=${claude}`,
    `--chatgpt=${chatgpt}`,
    `--gemini=${gemini}`,
  ]

  try {
    let output = ''
    const exitCode = await execAdapter.exec('bun', args, {
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        },
        stderr: (data: Buffer) => {
          output += data.toString()
        },
      },
    })

    if (exitCode !== 0) {
      const errorMsg = `oMo installation returned exit code ${exitCode}`
      logger.warning(errorMsg, {output: output.slice(0, 500)})
      return {installed: false, version: null, error: errorMsg}
    }

    // Extract version from output if available
    const versionMatch = /oh-my-opencode@(\d+\.\d+\.\d+)/i.exec(output)
    const version = versionMatch != null && versionMatch[1] != null ? versionMatch[1] : null

    logger.info('oMo plugin installed', {version})
    return {installed: true, version, error: null}
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to install oMo plugin', {error: errorMsg})
    return {installed: false, version: null, error: errorMsg}
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
