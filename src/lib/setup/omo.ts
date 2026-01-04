import type {Buffer} from 'node:buffer'

import type {ExecAdapter, Logger, OmoInstallResult} from './types.js'

export interface OmoInstallOptions {
  claude?: 'no' | 'yes' | 'max20'
  chatgpt?: 'no' | 'yes'
  gemini?: 'no' | 'yes'
}

/**
 * Install Oh My OpenCode (oMo) plugin in headless mode.
 *
 * Adds Sisyphus agent capabilities to OpenCode with configurable model providers.
 *
 * NOTE: oh-my-opencode is Bun-targeted with native bindings and cannot be
 * imported as a library. Must use npx/bunx to run as CLI tool.
 * See RFC-011-RESEARCH-SUMMARY.md for details.
 */
export async function installOmo(
  logger: Logger,
  execAdapter: ExecAdapter,
  options: OmoInstallOptions = {},
): Promise<OmoInstallResult> {
  const {claude = 'max20', chatgpt = 'no', gemini = 'no'} = options

  logger.info('Installing Oh My OpenCode plugin', {claude, chatgpt, gemini})

  const args = [
    'oh-my-opencode',
    'install',
    '--no-tui',
    `--claude=${claude}`,
    `--chatgpt=${chatgpt}`,
    `--gemini=${gemini}`,
  ]

  try {
    let output = ''
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
