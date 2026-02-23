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
 * Uses bunx to download and run the installer ephemerally. Platform-specific
 * binaries are resolved automatically via npm's optionalDependencies mechanism.
 *
 * This function runs on every invocation (even on cache hits) to ensure
 * configuration values like provider settings are always up to date.
 *
 * See RFC-011-RESEARCH-SUMMARY.md for details.
 */
export async function installOmo(
  version: string,
  deps: OmoInstallDeps,
  options: OmoInstallOptions = {},
): Promise<OmoInstallResult> {
  const {logger, execAdapter} = deps
  const {
    claude = 'no',
    copilot = 'no',
    gemini = 'no',
    openai = 'no',
    opencodeZen = 'no',
    zaiCodingPlan = 'no',
  } = options

  logger.info('Installing Oh My OpenCode plugin', {
    version,
    claude,
    copilot,
    gemini,
    openai,
    opencodeZen,
    zaiCodingPlan,
  })

  let output = ''
  const args = [
    `oh-my-opencode@${version}`,
    'install',
    '--no-tui',
    `--claude=${claude}`,
    `--copilot=${copilot}`,
    `--gemini=${gemini}`,
    `--openai=${openai}`,
    `--opencode-zen=${opencodeZen}`,
    `--zai-coding-plan=${zaiCodingPlan}`,
  ]

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
      const errorMsg = `bunx oh-my-opencode install returned exit code ${exitCode}`
      logger.error(errorMsg, {output: output.slice(0, 1000)})
      return {installed: false, version: null, error: `${errorMsg}\n${output.slice(0, 500)}`}
    }
    const versionMatch = /oh-my-opencode@(\d+\.\d+\.\d+)/i.exec(output)
    const detectedVersion = versionMatch != null && versionMatch[1] != null ? versionMatch[1] : version
    logger.info('oMo plugin installed', {version: detectedVersion})
    return {installed: true, version: detectedVersion, error: null}
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    const fullError = output.length > 0 ? `${errorMsg}\nOutput: ${output.slice(0, 500)}` : errorMsg
    logger.error('Failed to run oMo installer', {error: errorMsg, output: output.slice(0, 500)})
    return {installed: false, version: null, error: `bunx oh-my-opencode install failed: ${fullError}`}
  }
}

export async function verifyOmoInstallation(logger: Logger, execAdapter: ExecAdapter): Promise<boolean> {
  try {
    // bunx runs ephemerally so the binary won't be in PATH — verify config file only
    const configResult = await execAdapter.getExecOutput('ls', ['-la', '~/.config/opencode/oh-my-opencode.json'], {
      silent: true,
      ignoreReturnCode: true,
    })
    const configExists = !configResult.stdout.includes('No such file')

    logger.debug('oMo verification', {configExists, verified: configExists})
    return configExists
  } catch {
    logger.debug('Could not verify oMo installation')
    return false
  }
}
